import { db } from "./firebase";
import {
  doc, getDoc, setDoc, deleteDoc, onSnapshot, serverTimestamp,
} from "firebase/firestore";

/* ============================================================
   Shared data layer. Two collections:
   - icMeta/index        → { list: [{id, name, type, savedAt}] }
   - icIncidents/{id}     → the full incident blob
   Every browser that loads this site reads/writes the same
   Firestore project, so all users see the same board in real
   time via onSnapshot listeners (no polling needed).
   ============================================================ */

export async function loadIndex() {
  const snap = await getDoc(doc(db, "icMeta", "index"));
  return snap.exists() ? snap.data().list || [] : [];
}

export async function saveIndex(list) {
  await setDoc(doc(db, "icMeta", "index"), { list });
}

export async function loadIncidentBlob(id) {
  const snap = await getDoc(doc(db, "icIncidents", id));
  return snap.exists() ? snap.data() : null;
}

export async function saveIncidentBlob(id, blob) {
  await setDoc(doc(db, "icIncidents", id), { ...blob, _serverWrite: serverTimestamp() });
  return true;
}

export async function deleteIncidentBlob(id) {
  await deleteDoc(doc(db, "icIncidents", id));
}

// PIN config — { pinHash } stored at icMeta/config. Client-side gate
// only (see PinGate.jsx); Firestore rules stay open, so this deters a
// casually-shared link but is not a security boundary on its own.
export async function loadPinConfig() {
  const snap = await getDoc(doc(db, "icMeta", "config"));
  return snap.exists() ? snap.data() : null;
}

export async function savePinConfig(cfg) {
  await setDoc(doc(db, "icMeta", "config"), cfg);
}

// Real-time listener for the currently open incident. Calls onChange
// with the latest blob whenever it changes in Firestore, including
// changes made by other users. Returns an unsubscribe function.
export function watchIncident(id, onChange) {
  return onSnapshot(doc(db, "icIncidents", id), (snap) => {
    if (snap.exists()) onChange(snap.data());
  });
}

// Real-time listener for the incident index (the library list).
export function watchIndex(onChange) {
  return onSnapshot(doc(db, "icMeta", "index"), (snap) => {
    onChange(snap.exists() ? snap.data().list || [] : []);
  });
}
