/**
 * ble.js — React Native / Expo, react-native-ble-plx ^3.x
 *
 * Handles:
 *   - BLE permission request (iOS + Android 12+)
 *   - Scanning for MOOV* advertised devices
 *   - Connecting and writing the unlock characteristic
 *
 * Unlock characteristic UUID (Mobike / RideMovis electric series):
 *   Service:        6e400001-5fe1-46a8-9330-9b4670ca5106  (Nordic UART variant)
 *   Unlock char:    6e40ff02-5fe1-46a8-9330-9b4670ca5106
 *   Write type:     WithResponse (writeWithResponse)
 *
 * The electric TS and new-gen bikes still use this same Nordic UART
 * derived service; only the key payload differs (already in bikes.txt).
 *
 * iOS note: CoreBluetooth never exposes MAC addresses to apps.
 *           We match the target bike by scanning for local name prefix
 *           "MOOV" instead, then filter by proximity / first found.
 *           If multiple MOOV devices are in range, the user should be
 *           standing next to their target — first RSSI-sorted result wins.
 */

import { BleManager, State } from 'react-native-ble-plx';
import { getManager } from './blemanager';
import { Platform, PermissionsAndroid } from 'react-native';

const UNLOCK_CHAR_UUID = '6e40ff02-5fe1-46a8-9330-9b4670ca5106';
const SCAN_TIMEOUT_MS  = 12000;
const MOOV_NAME_PREFIX = 'MOOV';

// uses shared BleManager from blemanager.js

/** Destroy the manager (call on app unmount if needed) */
// use destroyManager() from blemanager.js instead

// ─── Permissions ────────────────────────────────────────────────────────────

/**
 * Request BLE + location permissions.
 * Returns true if all granted, false otherwise.
 */
export async function requestBLEPermissions() {
  if (Platform.OS === 'ios') {
    // iOS permissions are declared in Info.plist (app.json plugin).
    // The system prompt fires automatically on first BleManager use.
    // Nothing to do here — return true and let the OS handle it.
    return true;
  }

  // Android 12+ needs BLUETOOTH_SCAN and BLUETOOTH_CONNECT.
  // Older Android needs ACCESS_FINE_LOCATION.
  const toRequest =
    Platform.Version >= 31
      ? [
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
        ]
      : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];

  const results = await PermissionsAndroid.requestMultiple(toRequest);
  return Object.values(results).every(
    (r) => r === PermissionsAndroid.RESULTS.GRANTED
  );
}

// ─── BLE state check ────────────────────────────────────────────────────────

/** Waits up to 3s for BLE to be powered on. Returns true/false. */
export function waitForBLEReady(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const m = getManager();
    const sub = m.onStateChange((state) => {
      if (state === State.PoweredOn) {
        sub.remove();
        resolve(true);
      }
    }, true);
    setTimeout(() => {
      sub.remove();
      resolve(false);
    }, timeoutMs);
  });
}

// ─── Scan ────────────────────────────────────────────────────────────────────

/**
 * Scan for MOOV* BLE devices.
 *
 * @param {object} opts
 * @param {string|null}  opts.targetMac     Android: exact MAC to match (colon-formatted)
 * @param {function}     opts.onFound       Called with device object when match found
 * @param {function}     opts.onError       Called with Error on scan failure
 * @param {number}       [opts.timeout]     ms before auto-stop (default SCAN_TIMEOUT_MS)
 * @returns {function}  stopScan — call to cancel before timeout
 */
export function scanForBike({ targetMac, onFound, onError, timeout = SCAN_TIMEOUT_MS }) {
  const m = getManager();
  let stopped = false;

  const timer = setTimeout(() => {
    if (!stopped) {
      stopped = true;
      m.stopDeviceScan();
      onError(new Error('Scan timed out — no MOOV device found nearby'));
    }
  }, timeout);

  m.startDeviceScan(
    null,          // scan all service UUIDs
    { allowDuplicates: false },
    (error, device) => {
      if (error) {
        stopped = true;
        clearTimeout(timer);
        onError(error);
        return;
      }

      const name = device?.localName ?? device?.name ?? '';
      const isMovv = name.toUpperCase().startsWith(MOOV_NAME_PREFIX);

      // Android: match by MAC. iOS: match by name prefix (first found, best RSSI)
      const isTarget =
        Platform.OS === 'android'
          ? isMovv && targetMac && device.id?.toUpperCase() === targetMac.toUpperCase()
          : isMovv;

      if (isTarget && !stopped) {
        stopped = true;
        clearTimeout(timer);
        m.stopDeviceScan();
        onFound(device);
      }
    }
  );

  return () => {
    if (!stopped) {
      stopped = true;
      clearTimeout(timer);
      m.stopDeviceScan();
    }
  };
}

// ─── Connect + Unlock ────────────────────────────────────────────────────────

/**
 * Connect to device, discover services, write unlock payload.
 *
 * @param {object} device        Device from react-native-ble-plx
 * @param {string} hexKey        Hex string from bikes.txt (no spaces)
 * @param {function} onStatus    Called with string status messages
 * @returns {Promise<void>}      Resolves on successful write; rejects on error
 */
export async function unlockBike(device, hexKey, onStatus) {
  onStatus('Connecting…');

  let connected;
  try {
    connected = await device.connect({ autoConnect: false, requestMTU: 23 });
  } catch (e) {
    throw new Error(`Connection failed: ${e.message}`);
  }

  try {
    onStatus('Discovering services…');
    const discovered = await connected.discoverAllServicesAndCharacteristics();

    // Confirm the unlock char exists before writing
    const chars = await discovered.characteristicsForService(
      '6e400001-5fe1-46a8-9330-9b4670ca5106'
    ).catch(() => null);

    if (!chars) {
      // Some firmware versions don't advertise the full service UUID during scan.
      // Try writing directly — the char UUID alone is enough.
    }

    onStatus('Writing unlock payload…');

    // Key is a hex string; BLE plx expects base64
    const payloadBase64 = hexToBase64(hexKey);

    await discovered.writeCharacteristicWithResponseForService(
      '6e400001-5fe1-46a8-9330-9b4670ca5106',
      UNLOCK_CHAR_UUID,
      payloadBase64
    );

    onStatus('Unlocked! Hop on. 🛴');
  } finally {
    // Always disconnect — don't leave GATT handle open
    await connected.cancelConnection().catch(() => {});
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToBase64(hex) {
  // "6b55f8ef…" → Uint8Array → base64
  const bytes = new Uint8Array(hex.match(/.{1,2}/g).map((b) => parseInt(b, 16)));
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}
