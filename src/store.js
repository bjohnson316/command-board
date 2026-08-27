import { db } from "./firebase";
import {
  doc, getDoc, setDoc, deleteDoc, onSnapshot, serverTimestamp,
  collection, getDocs,
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
  try {
    const snap = await getDoc(doc(db, "icMeta", "index"));
    return snap.exists() ? snap.data().list || [] : [];
  } catch {
    // No cached copy and no network (e.g. very first launch on a
    // device that's never been online) — degrade to an empty list
    // rather than leaving the app stuck on a loading screen.
    return [];
  }
}

export async function saveIndex(list) {
  await setDoc(doc(db, "icMeta", "index"), { list });
}

export async function loadIncidentBlob(id) {
  try {
    const snap = await getDoc(doc(db, "icIncidents", id));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

export async function saveIncidentBlob(id, blob) {
  await setDoc(doc(db, "icIncidents", id), { ...blob, _serverWrite: serverTimestamp() });
  return true;
}

export async function deleteIncidentBlob(id) {
  await deleteDoc(doc(db, "icIncidents", id));
}

// PIN config — { pinHash, archivePinHash } stored at icMeta/config.
// Client-side gate only (see PinGate.jsx); Firestore rules stay open,
// so this deters a casually-shared link but is not a security boundary
// on its own. merge:true so setting one field never wipes the other.
export async function loadPinConfig() {
  try {
    const snap = await getDoc(doc(db, "icMeta", "config"));
    return snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}

export async function savePinConfig(cfg) {
  await setDoc(doc(db, "icMeta", "config"), cfg, { merge: true });
}

// Canned Units / Objectives — board-wide quick-pick lists so common
// apparatus IDs and standard objectives don't need retyping on every
// incident. Shared across all incidents (not per-incident), since
// "Engine 21" is the same unit regardless of which incident it's on.
export async function loadPresets() {
  try {
    const snap = await getDoc(doc(db, "icMeta", "presets"));
    return snap.exists() ? snap.data() : { units: [], objectives: [] };
  } catch {
    return { units: [], objectives: [] };
  }
}

export async function savePresets(presets) {
  await setDoc(doc(db, "icMeta", "presets"), presets, { merge: true });
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

// Attachments — each one is its own document in a subcollection under
// its incident (icIncidents/{id}/attachments/{attId}), NOT a field on
// the incident blob itself. Firestore caps a document at 1MB total;
// keeping every attachment separate means multiple files don't share
// (and blow) that budget the way a single array field would.
export async function loadAttachments(incidentId) {
  try {
    const snap = await getDocs(collection(db, "icIncidents", incidentId, "attachments"));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    return [];
  }
}

export async function saveAttachment(incidentId, attachmentId, data) {
  await setDoc(doc(db, "icIncidents", incidentId, "attachments", attachmentId), data);
}

export async function deleteAttachment(incidentId, attachmentId) {
  await deleteDoc(doc(db, "icIncidents", incidentId, "attachments", attachmentId));
}

// Firestore doesn't cascade-delete subcollections when the parent
// document goes away — orphaned attachment docs would otherwise sit
// there invisibly forever. Called before deleting an incident.
export async function deleteAllAttachments(incidentId) {
  const items = await loadAttachments(incidentId);
  await Promise.all(items.map(a => deleteAttachment(incidentId, a.id)));
}
