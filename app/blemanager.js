/**
 * blemanager.js — singleton BleManager
 * Shared by ble.js and sniffer.js so only one instance exists.
 */
import { BleManager } from 'react-native-ble-plx';

let _manager = null;

export function getManager() {
  if (!_manager) _manager = new BleManager();
  return _manager;
}

export function destroyManager() {
  _manager?.destroy();
  _manager = null;
}
