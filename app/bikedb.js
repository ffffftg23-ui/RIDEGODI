/**
 * bikedb.js — React Native / Expo
 * Loads bikes.txt (bundled asset) and exposes lookup by bike ID.
 *
 * bikes.txt format (one entry per line):
 *   BIKEID MACADDRESS(no colons) HEXKEY
 *   e.g.  IB12A03447 CE127BE0A43B 6b55f8efb85037d4748da079e7efca55
 *
 * MAC is stored without colons in the source; we insert them on parse
 * so react-native-ble-plx gets "CE:12:7B:E0:A4:3B" on Android.
 * On iOS, BLE devices are addressed by UUID assigned by CoreBluetooth —
 * we match on advertised local name ("MOOV*") instead.
 */

import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system';

// Map<string, { id: string, mac: string, key: string }>
let bikeMap = null;

function insertColons(raw) {
  // "CE127BE0A43B" → "CE:12:7B:E0:A4:3B"
  return raw.match(/.{1,2}/g).join(':').toUpperCase();
}

export async function loadBikeDB() {
  if (bikeMap !== null) return bikeMap;

  // require() the asset so Metro bundles it; getLocalUriAsync extracts it
  const [asset] = await Asset.loadAsync(require('../assets/bikes.txt'));
  const uri = asset.localUri ?? asset.uri;
  const text = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  bikeMap = new Map();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [rawId, rawMac, key] = parts;
    const id = rawId.toUpperCase();
    bikeMap.set(id, {
      id,
      mac: insertColons(rawMac),   // used on Android
      key: key.trim(),
    });
  }

  return bikeMap;
}

/** Returns { id, mac, key } or null */
export function lookupBike(id) {
  if (!bikeMap) throw new Error('BikeDB not loaded yet — await loadBikeDB() first');
  return bikeMap.get(id.toUpperCase()) ?? null;
}
