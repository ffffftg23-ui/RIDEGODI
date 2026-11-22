/**
 * sniffer.js — passive BLE monitor with device picker
 *
 * Two-phase flow:
 *   Phase 1 — scanForMoovDevices: scans and returns all MOOV* devices found
 *             caller shows a list, user picks one
 *   Phase 2 — sniffDevice: connects to the chosen device and watches for
 *             the unlock write, captures the key
 */

import { getManager } from './blemanager';

const UNLOCK_SERVICE = '6e400001-5fe1-46a8-9330-9b4670ca5106';
const UNLOCK_CHAR    = '6e40ff02-5fe1-46a8-9330-9b4670ca5106';
const MOOV_PREFIX    = 'MOOV';
const SNIFF_TIMEOUT  = 60000; // 60s for sam to unlock in Ridemovi

/**
 * Phase 1 — scan and collect all MOOV devices nearby.
 * Calls onDeviceFound each time a new one appears.
 * Scans for scanDuration ms then auto-stops.
 *
 * @param {function} onDeviceFound  called with { id, name, rssi } per device
 * @param {function} onDone         called when scan finishes (timeout)
 * @param {function} onError        called with Error on failure
 * @param {number}   scanDuration   ms to scan (default 8000)
 * @returns {function}              stopScan()
 */
export function scanForMoovDevices({
  onDeviceFound,
  onDone,
  onError,
  scanDuration = 8000,
}) {
  const m = getManager();
  const seen = new Map(); // id → true, dedupe
  let stopped = false;

  const timer = setTimeout(() => {
    if (!stopped) {
      stopped = true;
      m.stopDeviceScan();
      onDone();
    }
  }, scanDuration);

  m.startDeviceScan(null, { allowDuplicates: false }, (err, device) => {
    if (stopped) return;
    if (err) {
      stopped = true;
      clearTimeout(timer);
      m.stopDeviceScan();
      onError(err);
      return;
    }

    const name = device?.localName ?? device?.name ?? '';
    if (!name.toUpperCase().startsWith(MOOV_PREFIX)) return;
    if (seen.has(device.id)) return;
    seen.set(device.id, true);

    onDeviceFound({
      id:   device.id,
      name: name,
      rssi: device.rssi ?? 0,
    });
  });

  return () => {
    if (!stopped) {
      stopped = true;
      clearTimeout(timer);
      m.stopDeviceScan();
    }
  };
}

/**
 * Phase 2 — connect to a specific device and watch for the unlock write.
 * Sam picks the device from the list, then unlocks in Ridemovi.
 *
 * @param {string}   deviceId    device.id from scanForMoovDevices
 * @param {string}   deviceName  for display only
 * @param {function} onStatus    string status updates
 * @param {function} onCapture   { deviceId, name, keyHex }
 * @param {function} onError     Error
 * @returns {function}           cancel()
 */
export function sniffDevice({ deviceId, deviceName, onStatus, onCapture, onError }) {
  const m = getManager();
  let cancelled = false;
  let connectedDevice = null;
  let subscription = null;
  let captureTimer = null;

  const cancel = () => {
    cancelled = true;
    captureTimer && clearTimeout(captureTimer);
    subscription?.remove();
    connectedDevice?.cancelConnection().catch(() => {});
  };

  (async () => {
    onStatus(`Connecting to ${deviceName}…`);

    try {
      connectedDevice = await m.connectToDevice(deviceId, { autoConnect: false });
    } catch (e) {
      if (!cancelled) onError(new Error(`Connect failed: ${e.message}`));
      return;
    }

    if (cancelled) { connectedDevice.cancelConnection().catch(() => {}); return; }

    onStatus('Discovering services…');
    try {
      await connectedDevice.discoverAllServicesAndCharacteristics();
    } catch (e) {
      if (!cancelled) onError(new Error(`Service discovery failed: ${e.message}`));
      cancel();
      return;
    }

    if (cancelled) return;

    onStatus('Ready ✓ — now open Ridemovi and unlock this bike');

    captureTimer = setTimeout(() => {
      if (!cancelled) {
        cancel();
        onError(new Error('Timed out — did you unlock in Ridemovi?'));
      }
    }, SNIFF_TIMEOUT);

    // subscribe to notifications — bike echoes the write back
    try {
      subscription = connectedDevice.monitorCharacteristicForService(
        UNLOCK_SERVICE,
        UNLOCK_CHAR,
        (charErr, characteristic) => {
          if (cancelled) return;
          if (charErr) {
            // notification failed — fall back to polling
            clearTimeout(captureTimer);
            pollForKey(connectedDevice, deviceId, deviceName, onStatus, onCapture, onError, cancel);
            return;
          }
          if (!characteristic?.value) return;
          const keyHex = base64ToHex(characteristic.value);
          if (keyHex.length < 8) return;

          clearTimeout(captureTimer);
          subscription?.remove();
          onStatus(`Got it!`);
          onCapture({ deviceId, name: deviceName, keyHex });
          connectedDevice.cancelConnection().catch(() => {});
        }
      );
    } catch (_) {
      clearTimeout(captureTimer);
      pollForKey(connectedDevice, deviceId, deviceName, onStatus, onCapture, onError, cancel);
    }
  })();

  return cancel;
}

// ─── Polling fallback ─────────────────────────────────────────────────────────

async function pollForKey(connectedDevice, deviceId, deviceName, onStatus, onCapture, onError, cancel) {
  onStatus('Watching… unlock in Ridemovi now');
  let lastVal = null;
  const deadline = Date.now() + SNIFF_TIMEOUT;

  while (Date.now() < deadline) {
    await sleep(500);
    try {
      const char = await connectedDevice.readCharacteristicForService(
        UNLOCK_SERVICE, UNLOCK_CHAR
      );
      if (!char?.value) continue;
      const hex = base64ToHex(char.value);
      if (hex.length < 8 || hex === lastVal) continue;
      lastVal = hex;
      onStatus('Got it!');
      onCapture({ deviceId, name: deviceName, keyHex: hex });
      connectedDevice.cancelConnection().catch(() => {});
      return;
    } catch (_) {}
  }

  cancel();
  onError(new Error('Timed out — did you unlock in Ridemovi?'));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function base64ToHex(b64) {
  const binary = atob(b64);
  return Array.from(binary)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
