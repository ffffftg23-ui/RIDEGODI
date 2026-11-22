/**
 * App.js — RideGodi v3
 * Sniff tab now shows a list of nearby MOOV bikes — sam picks the one he wants.
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView,
  Platform, Pressable, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TextInput, View, Vibration,
} from 'react-native';

import { loadBikeDB, lookupBike } from './app/bikedb';
import { requestBLEPermissions, waitForBLEReady, scanForBike, unlockBike } from './app/ble';
import { destroyManager } from './app/blemanager';
import { scanForMoovDevices, sniffDevice } from './app/sniffer';
import { getCustomBikes, saveCustomBike, deleteCustomBike, lookupCustomBike } from './app/customdb';

const PHASE = Object.freeze({
  IDLE:'IDLE', SCANNING:'SCANNING', PICKING:'PICKING',
  CONNECTING:'CONNECTING', WATCHING:'WATCHING',
  CAPTURED:'CAPTURED', DONE:'DONE', ERROR:'ERROR',
});
const TABS = ['Unlock','Sniff','My Bikes'];

export default function App() {
  const [tab, setTab]         = useState(0);
  const [dbReady, setDbReady] = useState(false);
  const [dbSize, setDbSize]   = useState(0);

  useEffect(() => {
    loadBikeDB().then((m) => { setDbReady(true); setDbSize(m.size); }).catch(() => {});
    return () => destroyManager();
  }, []);

  return (
    <SafeAreaView style={s.root}>
      <StatusBar barStyle="light-content" backgroundColor="#0a0a0a" />
      <View style={s.header}>
        <Text style={s.title}>RideGodi</Text>
        <Text style={s.sub}>{dbReady ? `${dbSize} bikes in DB` : 'loading…'}</Text>
      </View>
      <View style={s.tabBar}>
        {TABS.map((t,i) => (
          <Pressable key={t} style={[s.tabBtn, tab===i && s.tabActive]} onPress={() => setTab(i)}>
            <Text style={[s.tabText, tab===i && s.tabTextActive]}>{t}</Text>
          </Pressable>
        ))}
      </View>
      {tab === 0 && <UnlockTab dbReady={dbReady} />}
      {tab === 1 && <SniffTab onSaved={() => setTab(2)} />}
      {tab === 2 && <MyBikesTab />}
    </SafeAreaView>
  );
}

// ─── Unlock Tab ───────────────────────────────────────────────────────────────

function UnlockTab({ dbReady }) {
  const [bikeId, setBikeId] = useState('');
  const [found, setFound]   = useState(null);
  const [phase, setPhase]   = useState(PHASE.IDLE);
  const [status, setStatus] = useState('');
  const stopRef             = useRef(null);

  const handleCheck = useCallback(async () => {
    Keyboard.dismiss();
    const id = bikeId.trim().toUpperCase();
    if (!id) return;
    let bike = lookupBike(id);
    if (!bike) {
      const c = await lookupCustomBike(id);
      if (c) bike = { id: c.id, mac: c.deviceId, key: c.keyHex };
    }
    if (bike) { setFound(bike); setPhase(PHASE.CAPTURED); setStatus(`${bike.id} found ✓`); }
    else { setFound(null); setPhase(PHASE.IDLE); setStatus(`"${id}" not found — sniff it first`); }
  }, [bikeId]);

  const handleUnlock = useCallback(async () => {
    if (!found) return;
    const granted = await requestBLEPermissions();
    if (!granted) { setStatus('Bluetooth permission denied'); setPhase(PHASE.ERROR); return; }
    const ready = await waitForBLEReady(4000);
    if (!ready) { setStatus('Bluetooth is off'); setPhase(PHASE.ERROR); return; }
    setPhase(PHASE.SCANNING); setStatus('Scanning…');
    stopRef.current = scanForBike({
      targetMac: found.mac,
      onFound: async (device) => {
        setPhase(PHASE.CONNECTING);
        try {
          await unlockBike(device, found.key, (s) => setStatus(s));
          setPhase(PHASE.DONE);
          Vibration.vibrate([0,100,80,100]);
        } catch (e) { setStatus(`Error: ${e.message}`); setPhase(PHASE.ERROR); }
      },
      onError: (e) => { setStatus(e.message); setPhase(PHASE.ERROR); },
    });
  }, [found]);

  const reset = () => { stopRef.current?.(); setFound(null); setBikeId(''); setPhase(PHASE.IDLE); setStatus(''); };
  const isWorking = phase === PHASE.SCANNING || phase === PHASE.CONNECTING;

  return (
    <KeyboardAvoidingView style={s.flex} behavior={Platform.OS==='ios'?'padding':'height'}>
      <View style={s.padded}>
        <View style={s.row}>
          <TextInput style={s.input} placeholder="Bike ID from the frame"
            placeholderTextColor="#555" value={bikeId} onChangeText={setBikeId}
            autoCapitalize="characters" autoCorrect={false} returnKeyType="search"
            onSubmitEditing={handleCheck} editable={!isWorking} />
          <Pressable style={[s.btn, s.btnOrange, (!dbReady||isWorking)&&s.btnDisabled]}
            onPress={handleCheck} disabled={!dbReady||isWorking}>
            <Text style={s.btnText}>Check</Text>
          </Pressable>
        </View>
        {!!status && (
          <View style={[s.statusBox, phaseColor(phase)]}>
            {isWorking && <ActivityIndicator color="#fff" size="small" style={{marginRight:8}} />}
            <Text style={s.statusText}>{status}</Text>
          </View>
        )}
        {phase === PHASE.CAPTURED && found && (
          <Pressable style={[s.btn, s.btnGreen, s.btnFull]} onPress={handleUnlock}>
            <Text style={s.btnText}>🔓  Unlock  {found.id}</Text>
          </Pressable>
        )}
        {(phase===PHASE.DONE||phase===PHASE.ERROR) && (
          <Pressable style={[s.btn, s.btnGray, s.btnFull]} onPress={reset}>
            <Text style={s.btnText}>Reset</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

// ─── Sniff Tab ────────────────────────────────────────────────────────────────

function SniffTab({ onSaved }) {
  const [phase, setPhase]       = useState(PHASE.IDLE);
  const [status, setStatus]     = useState('');
  const [devices, setDevices]   = useState([]);   // [{id,name,rssi}]
  const [captured, setCaptured] = useState(null);
  const [bikeId, setBikeId]     = useState('');
  const cancelRef               = useRef(null);

  const handleScan = useCallback(async () => {
    const granted = await requestBLEPermissions();
    if (!granted) { setStatus('Bluetooth permission denied'); setPhase(PHASE.ERROR); return; }
    const ready = await waitForBLEReady(4000);
    if (!ready) { setStatus('Bluetooth is off'); setPhase(PHASE.ERROR); return; }

    setDevices([]);
    setCaptured(null);
    setBikeId('');
    setPhase(PHASE.SCANNING);
    setStatus('Scanning for MOOV bikes nearby…');

    cancelRef.current = scanForMoovDevices({
      onDeviceFound: (dev) => {
        setDevices((prev) => {
          if (prev.find((d) => d.id === dev.id)) return prev;
          return [...prev, dev].sort((a,b) => b.rssi - a.rssi); // strongest signal first
        });
      },
      onDone: () => {
        setPhase(PHASE.PICKING);
        setStatus('');
      },
      onError: (e) => { setStatus(e.message); setPhase(PHASE.ERROR); },
      scanDuration: 8000,
    });
  }, []);

  const handlePick = useCallback((dev) => {
    setPhase(PHASE.CONNECTING);
    cancelRef.current = sniffDevice({
      deviceId:   dev.id,
      deviceName: dev.name,
      onStatus:   (s) => setStatus(s),
      onCapture:  (data) => {
        setCaptured(data);
        setPhase(PHASE.CAPTURED);
        setStatus('Key captured! Enter the bike frame ID and save.');
        Vibration.vibrate([0,100,80,200]);
      },
      onError: (e) => { setStatus(e.message); setPhase(PHASE.ERROR); },
    });
  }, []);

  const handleSave = useCallback(async () => {
    const id = bikeId.trim().toUpperCase();
    if (!id) { Alert.alert('Enter bike ID','Type the ID from the frame sticker'); return; }
    if (!captured) return;
    await saveCustomBike({ id, deviceId: captured.deviceId, name: captured.name, keyHex: captured.keyHex });
    setPhase(PHASE.DONE);
    setStatus(`"${id}" saved to My Bikes.`);
    onSaved();
  }, [bikeId, captured, onSaved]);

  const reset = () => {
    cancelRef.current?.();
    setPhase(PHASE.IDLE); setStatus('');
    setDevices([]); setCaptured(null); setBikeId('');
  };

  const isWorking = phase === PHASE.SCANNING || phase === PHASE.CONNECTING || phase === PHASE.WATCHING;

  return (
    <ScrollView style={s.flex} contentContainerStyle={s.padded} keyboardShouldPersistTaps="handled">

      {/* instructions */}
      <View style={s.instructBox}>
        <Text style={s.instructText}>
          {'1. Tap Scan — finds all MOOV bikes nearby\n2. Pick the bike you want from the list\n3. Open Ridemovi and unlock that bike\n4. App captures the key automatically\n5. Enter the frame ID → Save'}
        </Text>
      </View>

      {/* scan button */}
      {(phase===PHASE.IDLE || phase===PHASE.ERROR) && (
        <Pressable style={[s.btn, s.btnOrange, s.btnFull]} onPress={handleScan}>
          <Text style={s.btnText}>🔍  Scan for Bikes</Text>
        </Pressable>
      )}

      {/* scanning spinner */}
      {phase === PHASE.SCANNING && (
        <View style={[s.statusBox, {backgroundColor:'#1a2e4d'}]}>
          <ActivityIndicator color="#fff" size="small" style={{marginRight:8}} />
          <Text style={s.statusText}>{status}</Text>
        </View>
      )}

      {/* device list — shown during scan and after */}
      {devices.length > 0 && (phase===PHASE.SCANNING || phase===PHASE.PICKING) && (
        <View style={s.deviceList}>
          <Text style={s.deviceListTitle}>
            {phase===PHASE.SCANNING ? `Found ${devices.length} bike${devices.length>1?'s':''} — scanning…` : `Found ${devices.length} bike${devices.length>1?'s':''} — tap to pick`}
          </Text>
          {devices.map((dev) => (
            <Pressable
              key={dev.id}
              style={[s.deviceRow, phase===PHASE.PICKING && s.deviceRowPickable]}
              onPress={() => phase===PHASE.PICKING && handlePick(dev)}
              disabled={phase!==PHASE.PICKING}
            >
              <View style={s.deviceInfo}>
                <Text style={s.deviceName}>{dev.name}</Text>
                <Text style={s.deviceSub}>Signal: {signalBars(dev.rssi)}  {dev.rssi} dBm</Text>
              </View>
              {phase===PHASE.PICKING && (
                <Text style={s.deviceArrow}>Tap →</Text>
              )}
            </Pressable>
          ))}
        </View>
      )}

      {/* connecting / watching status */}
      {(phase===PHASE.CONNECTING || phase===PHASE.WATCHING) && (
        <View style={[s.statusBox, {backgroundColor:'#1a2e4d'}]}>
          <ActivityIndicator color="#fff" size="small" style={{marginRight:8}} />
          <Text style={s.statusText}>{status}</Text>
        </View>
      )}

      {/* error */}
      {phase===PHASE.ERROR && !!status && (
        <View style={[s.statusBox, {backgroundColor:'#4d1a1a'}]}>
          <Text style={s.statusText}>{status}</Text>
        </View>
      )}

      {/* captured — save form */}
      {phase===PHASE.CAPTURED && captured && (
        <View style={s.captureBox}>
          <Text style={s.captureLabel}>Key captured ✓</Text>
          <Text style={s.captureKey}>{captured.keyHex}</Text>
          <Text style={s.captureLabel}>Device: {captured.name}</Text>
          <TextInput
            style={[s.input,{marginTop:12}]}
            placeholder="Bike ID from the frame sticker"
            placeholderTextColor="#555"
            value={bikeId} onChangeText={setBikeId}
            autoCapitalize="characters" autoCorrect={false}
          />
          <Pressable style={[s.btn, s.btnGreen, s.btnFull, {marginTop:10}]} onPress={handleSave}>
            <Text style={s.btnText}>💾  Save to My Bikes</Text>
          </Pressable>
        </View>
      )}

      {/* done */}
      {phase===PHASE.DONE && (
        <View style={[s.statusBox,{backgroundColor:'#1a4d2e'}]}>
          <Text style={s.statusText}>{status}</Text>
        </View>
      )}

      {/* reset */}
      {(phase===PHASE.DONE||phase===PHASE.ERROR||phase===PHASE.CAPTURED) && (
        <Pressable style={[s.btn, s.btnGray, s.btnFull]} onPress={reset}>
          <Text style={s.btnText}>Sniff Another</Text>
        </Pressable>
      )}

    </ScrollView>
  );
}

// ─── My Bikes Tab ─────────────────────────────────────────────────────────────

function MyBikesTab() {
  const [bikes, setBikes]   = useState([]);
  const [phase, setPhase]   = useState(PHASE.IDLE);
  const [status, setStatus] = useState('');
  const stopRef             = useRef(null);

  useEffect(() => { refresh(); }, []);
  const refresh = async () => setBikes(await getCustomBikes());

  const handleUnlock = useCallback(async (bike) => {
    const granted = await requestBLEPermissions();
    if (!granted) { setStatus('Bluetooth permission denied'); setPhase(PHASE.ERROR); return; }
    const ready = await waitForBLEReady(4000);
    if (!ready) { setStatus('Bluetooth is off'); setPhase(PHASE.ERROR); return; }
    setPhase(PHASE.SCANNING); setStatus(`Scanning for ${bike.id}…`);
    stopRef.current = scanForBike({
      targetMac: bike.deviceId,
      onFound: async (device) => {
        setPhase(PHASE.CONNECTING);
        try {
          await unlockBike(device, bike.keyHex, (s) => setStatus(s));
          setPhase(PHASE.DONE);
          Vibration.vibrate([0,100,80,100]);
        } catch (e) { setStatus(`Error: ${e.message}`); setPhase(PHASE.ERROR); }
      },
      onError: (e) => { setStatus(e.message); setPhase(PHASE.ERROR); },
    });
  }, []);

  const handleDelete = (bike) => {
    Alert.alert('Delete', `Remove ${bike.id}?`, [
      { text: 'Cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteCustomBike(bike.id); refresh(); } },
    ]);
  };

  const reset = () => { stopRef.current?.(); setPhase(PHASE.IDLE); setStatus(''); };
  const isWorking = phase===PHASE.SCANNING || phase===PHASE.CONNECTING;

  return (
    <View style={s.flex}>
      {!!status && (
        <View style={[s.statusBox, phaseColor(phase), {margin:12}]}>
          {isWorking && <ActivityIndicator color="#fff" size="small" style={{marginRight:8}} />}
          <Text style={s.statusText}>{status}</Text>
        </View>
      )}
      {(phase===PHASE.DONE||phase===PHASE.ERROR) && (
        <Pressable style={[s.btn, s.btnGray, {margin:12}]} onPress={reset}>
          <Text style={s.btnText}>Reset</Text>
        </Pressable>
      )}
      {bikes.length===0 ? (
        <View style={s.empty}>
          <Text style={s.emptyText}>{'No saved bikes yet.\nUse the Sniff tab to capture one.'}</Text>
        </View>
      ) : (
        <ScrollView style={s.flex}>
          {bikes.map((bike) => (
            <View key={bike.id} style={s.bikeRow}>
              <View style={s.bikeInfo}>
                <Text style={s.bikeId}>{bike.id}</Text>
                <Text style={s.bikeSub}>{bike.name ?? bike.deviceId}</Text>
              </View>
              <Pressable style={[s.btn, s.btnGreen, {paddingHorizontal:14}, isWorking&&s.btnDisabled]}
                onPress={() => handleUnlock(bike)} disabled={isWorking}>
                <Text style={s.btnText}>🔓</Text>
              </Pressable>
              <Pressable style={[s.btn, s.btnRed, {paddingHorizontal:14, marginLeft:6}]}
                onPress={() => handleDelete(bike)}>
                <Text style={s.btnText}>✕</Text>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function phaseColor(phase) {
  switch (phase) {
    case PHASE.DONE:        return { backgroundColor: '#1a4d2e' };
    case PHASE.ERROR:       return { backgroundColor: '#4d1a1a' };
    case PHASE.SCANNING:
    case PHASE.CONNECTING:
    case PHASE.WATCHING:    return { backgroundColor: '#1a2e4d' };
    default:                return { backgroundColor: '#2a2a2a' };
  }
}

function signalBars(rssi) {
  if (rssi >= -60) return '████';
  if (rssi >= -70) return '███░';
  if (rssi >= -80) return '██░░';
  return '█░░░';
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  root:             { flex:1, backgroundColor:'#0a0a0a' },
  flex:             { flex:1 },
  header:           { paddingHorizontal:20, paddingTop:16, paddingBottom:10, borderBottomWidth:1, borderBottomColor:'#1e1e1e' },
  title:            { fontSize:30, fontWeight:'800', color:'#ff8c00', letterSpacing:1 },
  sub:              { fontSize:11, color:'#555', marginTop:1 },
  tabBar:           { flexDirection:'row', borderBottomWidth:1, borderBottomColor:'#1e1e1e' },
  tabBtn:           { flex:1, paddingVertical:12, alignItems:'center' },
  tabActive:        { borderBottomWidth:2, borderBottomColor:'#ff8c00' },
  tabText:          { color:'#666', fontSize:13, fontWeight:'600' },
  tabTextActive:    { color:'#ff8c00' },
  padded:           { padding:16 },
  row:              { flexDirection:'row', gap:10, alignItems:'center', marginBottom:12 },
  input:            { flex:1, backgroundColor:'#1a1a1a', color:'#fff', borderRadius:10, paddingHorizontal:14, paddingVertical:12, fontSize:14, borderWidth:1, borderColor:'#333', fontFamily: Platform.OS==='ios'?'Courier New':'monospace' },
  btn:              { paddingHorizontal:18, paddingVertical:12, borderRadius:10, alignItems:'center', justifyContent:'center' },
  btnOrange:        { backgroundColor:'#ff8c00' },
  btnGreen:         { backgroundColor:'#1f7a3a' },
  btnGray:          { backgroundColor:'#333' },
  btnRed:           { backgroundColor:'#7a1f1f' },
  btnDisabled:      { opacity:0.4 },
  btnFull:          { marginVertical:6 },
  btnText:          { color:'#fff', fontWeight:'700', fontSize:14 },
  statusBox:        { flexDirection:'row', alignItems:'center', padding:12, borderRadius:10, marginBottom:10 },
  statusText:       { color:'#fff', fontSize:13, flex:1 },
  instructBox:      { backgroundColor:'#111', borderRadius:10, padding:14, marginBottom:14 },
  instructText:     { color:'#888', fontSize:13, lineHeight:22 },
  deviceList:       { backgroundColor:'#111', borderRadius:10, marginBottom:12, overflow:'hidden' },
  deviceListTitle:  { color:'#ff8c00', fontSize:12, fontWeight:'700', padding:12, borderBottomWidth:1, borderBottomColor:'#1e1e1e' },
  deviceRow:        { padding:14, borderBottomWidth:1, borderBottomColor:'#1a1a1a', flexDirection:'row', alignItems:'center' },
  deviceRowPickable:{ backgroundColor:'#161616' },
  deviceInfo:       { flex:1 },
  deviceName:       { color:'#fff', fontSize:15, fontWeight:'700' },
  deviceSub:        { color:'#555', fontSize:11, marginTop:3, fontFamily: Platform.OS==='ios'?'Courier New':'monospace' },
  deviceArrow:      { color:'#ff8c00', fontSize:13, fontWeight:'700' },
  captureBox:       { backgroundColor:'#111', borderRadius:10, padding:14, marginTop:10 },
  captureLabel:     { color:'#888', fontSize:11, marginBottom:4 },
  captureKey:       { color:'#4a9', fontFamily: Platform.OS==='ios'?'Courier New':'monospace', fontSize:12, marginBottom:8 },
  bikeRow:          { flexDirection:'row', alignItems:'center', padding:14, borderBottomWidth:1, borderBottomColor:'#1a1a1a' },
  bikeInfo:         { flex:1 },
  bikeId:           { color:'#fff', fontSize:15, fontWeight:'700' },
  bikeSub:          { color:'#555', fontSize:11, marginTop:2 },
  empty:            { flex:1, alignItems:'center', justifyContent:'center', padding:40 },
  emptyText:        { color:'#444', fontSize:14, textAlign:'center', lineHeight:22 },
});
