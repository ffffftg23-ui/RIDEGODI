# RideGodi — React Native / Expo rebuild

Rewrite of the original Kivy/Android app.  
Targets **iOS** (Expo dev client on iPhone) + Android.  
Stack: React Native 0.74, Expo 51, `react-native-ble-plx` ^3.x.

---

## Why not plain Expo Go?

`react-native-ble-plx` is a **native module** (wraps CoreBluetooth on iOS,
BluetoothGatt on Android). Plain Expo Go does not bundle native modules it
doesn't ship. You need a **custom dev client** or a bare build.

---

## Quickstart (iPhone — dev build via EAS, no Xcode required)

```bash
# 1. Install deps
npm install

# 2. Install expo-dev-client
npx expo install expo-dev-client

# 3. Log into EAS (free tier works)
npx eas-cli login

# 4. Configure EAS project (one time)
npx eas build:configure

# 5. Build dev client for iOS (builds in EAS cloud, no Mac needed)
npx eas build --profile development --platform ios

# 6. Install the .ipa via EAS link on your iPhone (or TestFlight)

# 7. Start the dev server
npx expo start --dev-client

# 8. Open the EAS-built app on iPhone → scan QR → JS loads over WiFi
```

---

## Quickstart (Xcode — if you have a Mac)

```bash
npm install
npx expo install expo-dev-client
npx expo run:ios   # builds locally, installs on connected iPhone
npx expo start --dev-client
```

---

## Quickstart (Android)

```bash
npm install
npx expo install expo-dev-client
npx expo run:android   # needs ADB + Android SDK
npx expo start --dev-client
```

---

## File layout

```
ridegodi/
├── App.js              — main UI + state machine
├── app.json            — Expo config, BLE entitlements, permissions
├── package.json
├── babel.config.js
├── assets/
│   └── bikes.txt       — 3179 bikes: ID MAC KEY (space-separated)
└── app/
    ├── bikedb.js       — loads + parses bikes.txt asset at runtime
    └── ble.js          — BLE permissions, scan, GATT write unlock
```

---

## Updating the bike DB

Drop a new `bikes.txt` into `assets/` (same format: `ID MAC KEY` per line)
and rebuild. No code changes needed.

---

## iOS Bluetooth notes

CoreBluetooth does **not** expose MAC addresses to apps (privacy sandboxing
since iOS 13). The app matches bikes by advertised local name prefix `MOOV`.
On Android the full MAC match works as before.

If multiple MOOV bikes are in Bluetooth range, stand close to yours — the
scan picks the first device found (they advertise in short bursts; proximity
matters).

---

## Unlock characteristic

| Field | Value |
|---|---|
| Service UUID | `6e400001-5fe1-46a8-9330-9b4670ca5106` |
| Write char UUID | `6e40ff02-5fe1-46a8-9330-9b4670ca5106` |
| Write type | With response |
| Payload | 16-byte hex key from `bikes.txt`, col 3 |

Works on Mobike electric TS and new-gen RideMovis — same GATT profile,
different keys (all in `bikes.txt`).
