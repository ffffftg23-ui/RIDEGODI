/**
 * customdb.js — user-captured bikes, persisted via AsyncStorage
 *
 * Stored as JSON array under key 'custom_bikes'.
 * Each entry: { id, deviceId, name, keyHex, addedAt }
 *
 * id is user-supplied bike frame ID (from the frame sticker).
 * deviceId is iOS CoreBluetooth UUID or Android MAC.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'custom_bikes';

export async function getCustomBikes() {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export async function saveCustomBike({ id, deviceId, name, keyHex }) {
  const bikes = await getCustomBikes();
  // overwrite if same id already saved
  const idx = bikes.findIndex((b) => b.id.toUpperCase() === id.toUpperCase());
  const entry = {
    id: id.toUpperCase(),
    deviceId,
    name,
    keyHex,
    addedAt: new Date().toISOString(),
  };
  if (idx >= 0) bikes[idx] = entry;
  else bikes.push(entry);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(bikes));
  return entry;
}

export async function deleteCustomBike(id) {
  const bikes = await getCustomBikes();
  const filtered = bikes.filter((b) => b.id.toUpperCase() !== id.toUpperCase());
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(filtered));
}

/** Lookup by frame ID across custom bikes */
export async function lookupCustomBike(id) {
  const bikes = await getCustomBikes();
  return bikes.find((b) => b.id.toUpperCase() === id.toUpperCase()) ?? null;
}
