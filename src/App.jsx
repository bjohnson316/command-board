import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Radio, Truck, HeartPulse, ClipboardList, Users, Save,
  Printer, Plus, X, Clock, ChevronRight, Trash2, Download,
  FolderOpen, AlertTriangle, Shield, CheckCircle2, ArrowRightLeft, Lock, GripVertical,
  Archive, RotateCcw, Layers, Star, Paperclip, FileText, Image as ImageIcon, KeyRound, Settings, Sun, Moon,
  Map as MapIcon, Crosshair
} from "lucide-react";
import {
  loadIndex, saveIndex, loadIncidentBlobFresh, saveIncidentBlob,
  deleteIncidentBlob, watchIncident, loadPinConfig, savePinConfig,
  loadPresets, savePresets,
  loadAttachments, saveAttachment, deleteAttachment, deleteAllAttachments,
} from "./store";
import { COLORS, KFD_PATCH_DATA_URI, THEME_CSS } from "./theme";
import PinGate from "./PinGate.jsx";
import { sha256 } from "./pin";
import L from "leaflet";
import "leaflet-draw";
import "leaflet/dist/leaflet.css";
import "leaflet-draw/dist/leaflet.draw.css";
// Leaflet's default marker icon paths break under Vite's bundling
// (a well-known Leaflet + bundler issue — it expects to find its
// icon images relative to a script-tag URL that doesn't exist here).
// Pointing the default icon at CDN-hosted copies of the same images
// sidesteps that entirely rather than fighting Vite's asset pipeline.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

/* ============================================================
   DESIGN TOKENS
   Command-board aesthetic: dark tactical ground, stencil-style
   display type (apparatus lettering), high-contrast NIMS-style
   status colors, monospace for all time/ID data.
   ============================================================ */

const STATUS_FLOW = ["Staging", "Assigned", "Working", "Rehab", "Out of Service", "Released"];
const STATUS_COLOR = {
  Staging: COLORS.amber,
  Assigned: COLORS.blue,
  Working: COLORS.orange,
  Rehab: COLORS.teal,
  "Out of Service": COLORS.slate,
  Released: COLORS.faint,
};
const INCIDENT_TYPES = [
  { v: "Structure Fire", c: COLORS.red },
  { v: "Wildland Fire", c: COLORS.teal },
  { v: "Hazmat", c: "#8B5CF6" },
  { v: "MCI / EMS", c: COLORS.blue },
  { v: "All-Hazard / Other", c: COLORS.slate },
];
const RESOURCE_KINDS = [
  "Engine", "Ladder/Truck", "Tender/Tanker", "Brush Truck", "Rescue",
  "Ambulance/Medic", "Hazmat Unit", "Command Vehicle", "Air Unit",
  "Dozer/Heavy Equip", "Hand Crew", "Law Enforcement", "Other",
];
const CG_POSITIONS = [
  "Incident Commander", "Deputy IC", "Safety Officer",
  "Public Information Officer", "Liaison Officer",
];
const SECTION_CHIEFS = [
  "Operations Section Chief", "Planning Section Chief",
  "Logistics Section Chief", "Finance/Admin Section Chief",
];

/* ============================================================
   ORG CHART DATA MODEL
   A tree, matching the FEMA ICS org chart's actual shape: IC at
   the top, Command Staff (Safety/PIO/Liaison) and the four Section
   Chiefs reporting to IC, and each Section Chief able to expand
   downward into Branches -> Divisions/Groups -> further sub-units,
   arbitrarily deep. This replaced an earlier flat/fixed-position
   model (org.positions + org.divisions) that couldn't represent
   that structure or be expanded — normalizeOrg() below migrates any
   data saved under the old shape so nothing is lost.
   ============================================================ */
function blankOrg() {
  return {
    ic: "", deputyIc: "",
    commandStaff: [
      { id: uid(), title: "Safety Officer", name: "" },
      { id: uid(), title: "Public Information Officer", name: "" },
      { id: uid(), title: "Liaison Officer", name: "" },
    ],
    sections: SECTION_CHIEFS.map(title => ({ id: uid(), title, name: "", children: [] })),
  };
}

function normalizeOrg(org) {
  if (!org) return blankOrg();
  if (org.sections) {
    // Already the current shape — fill in anything defensively missing.
    return { ic: org.ic || "", deputyIc: org.deputyIc || "", commandStaff: org.commandStaff || [], sections: org.sections || [] };
  }
  // Old shape: { positions: { [fixedTitle]: name }, divisions: [{id,name,supervisor}] }
  const positions = org.positions || {};
  const divisions = org.divisions || [];
  return {
    ic: positions["Incident Commander"] || "",
    deputyIc: positions["Deputy IC"] || "",
    commandStaff: [
      { id: uid(), title: "Safety Officer", name: positions["Safety Officer"] || "" },
      { id: uid(), title: "Public Information Officer", name: positions["Public Information Officer"] || "" },
      { id: uid(), title: "Liaison Officer", name: positions["Liaison Officer"] || "" },
    ],
    sections: SECTION_CHIEFS.map(title => ({
      id: uid(),
      title,
      name: positions[title] || "",
      // Old divisions/groups had no section of their own — they were
      // implicitly under Operations, so that's where they land here.
      children: title === "Operations Section Chief"
        ? divisions.map(d => ({ id: d.id || uid(), title: d.name || "Division/Group", name: d.supervisor || "", children: [] }))
        : [],
    })),
  };
}

// Recursive tree edits — operate on the `sections` array by node id,
// wherever that node actually lives in the nesting.
function updateOrgNode(sections, nodeId, patch) {
  return sections.map(node => {
    if (node.id === nodeId) return { ...node, ...patch };
    if (node.children && node.children.length) return { ...node, children: updateOrgNode(node.children, nodeId, patch) };
    return node;
  });
}
function deleteOrgNode(sections, nodeId) {
  return sections
    .filter(node => node.id !== nodeId)
    .map(node => node.children && node.children.length ? { ...node, children: deleteOrgNode(node.children, nodeId) } : node);
}
function addOrgChild(sections, parentId, child) {
  return sections.map(node => {
    if (node.id === parentId) return { ...node, children: [...(node.children || []), child] };
    if (node.children && node.children.length) return { ...node, children: addOrgChild(node.children, parentId, child) };
    return node;
  });
}

// Flattened views for consumers that just need a summary list, not the
// visual tree — the PDF export and the "Current Organization" summary
// on the full ICS-201 form.
function flattenOrgFilled(org) {
  const out = [];
  if (org.ic) out.push({ title: "Incident Commander", name: org.ic });
  if (org.deputyIc) out.push({ title: "Deputy IC", name: org.deputyIc });
  org.commandStaff.forEach(cs => { if (cs.name) out.push({ title: cs.title, name: cs.name }); });
  const walk = (node, depth) => {
    if (node.name) out.push({ title: node.title, name: node.name, depth });
    (node.children || []).forEach(c => walk(c, depth + 1));
  };
  org.sections.forEach(s => walk(s, 0));
  return out;
}
// Every node's title, at any depth — used to populate the
// Division/Group picker on ICS-215A regardless of which section a
// division was added under.
function flattenOrgTitles(org) {
  const out = [];
  const walk = (node) => { if (node.title) out.push(node.title); (node.children || []).forEach(walk); };
  org.sections.forEach(walk);
  return out;
}


const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const nowISO = () => new Date().toISOString();
const fmtTime = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
const fmtClock = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString() : "—";
const elapsed = (iso, now) => {
  if (!iso) return "—";
  let s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
};
const fmtDuration = (ms) => {
  let s = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(s / 3600)).padStart(2, "0");
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const sec = String(s % 60).padStart(2, "0");
  return `${h}:${m}:${sec}`;
};
// Duration of the status immediately before the current one, read from
// the resource's history — e.g. how long it was Working right before
// it was moved to Rehab.
const priorPeriod = (history) => {
  if (!history || history.length < 2) return null;
  const cur = history[history.length - 1];
  const prev = history[history.length - 2];
  return { status: prev.status, ms: new Date(cur.at).getTime() - new Date(prev.at).getTime() };
};

function blankIncident() {
  return {
    id: uid(),
    name: "",
    number: "",
    type: "Structure Fire",
    location: "",
    icName: "",
    preparedBy: "",
    prepPosition: "",
    prepSignature: "",
    prepDateTime: "",
    dateInitiated: "",
    timeInitiated: "",
    timeTerminated: "",
    dateTerminated: "",
    opStart: nowISO(),
    pausedElapsedMs: 0,
    wind: "",
    temp: "",
    rh: "",
    conditions: "",
    situation: "",
    safetyMessage: "",
    objectives: [""],
    actionsLog: [],
    resourceOrders: [],
    mapSketch: "",
    strategyOffensive: false,
    strategyDefensive: false,
    strategyTransitional: false,
    strategyInvestigative: false,
  };
}

// Older saved incidents may only have the single combined "weather"
// field from before it was split into Wind/Temp/RH/Conditions — carry
// that text into Conditions once, rather than silently losing it.
function normalizeIncident(inc) {
  if (!inc) return blankIncident();
  const hasNewFields = inc.wind || inc.temp || inc.rh || inc.conditions;
  const migrated = (!hasNewFields && inc.weather)
    ? { ...inc, wind: "", temp: "", rh: "", conditions: inc.weather }
    : { wind: "", temp: "", rh: "", conditions: "", ...inc };
  // Fill in fields added when ICS-201 was rebuilt to match the official
  // form exactly (Date/Time Initiated, expanded Prepared By, the
  // Actions/Tactics log, and the Resource Order-tracking table).
  return {
    prepPosition: "", prepSignature: "", prepDateTime: "",
    dateInitiated: "", timeInitiated: "", timeTerminated: "", dateTerminated: "",
    actionsLog: [], resourceOrders: [], mapSketch: "",
    strategyOffensive: false, strategyDefensive: false, strategyTransitional: false, strategyInvestigative: false,
    pausedElapsedMs: 0,
    ...migrated,
  };
}

// Default shapes for the newer ICS Forms (208 / 208 HM / 209 / 206) —
// factory functions so each call returns a fresh object/array, not a
// shared reference, since 206 in particular holds mutable arrays.
function defaultIcs208() {
  return { opFrom: "", opTo: "", message: "", siteSafetyPlanRequired: "No", siteSafetyPlanLocation: "", preparedBy: "", position: "", signature: "", dateTime: "" };
}
function defaultIcs208HM() {
  return {
    dateTime: "", opFrom: "", opTo: "",
    incidentLocation: "",
    orgIC: "", orgHMGroupSupervisor: "", orgTechSpecialist: "",
    orgSafetyOfficer: "", orgEntryLeader: "", orgSiteAccessControlLeader: "",
    orgAsstSafetyOfficerHM: "", orgDeconLeader: "", orgSafeRefugeAreaMgr: "",
    orgEnvironmentalHealth: "", orgOther1: "", orgOther2: "",
    entryTeam: [1, 2, 3, 4].map(n => ({ id: uid(), label: `Entry ${n}`, name: "", ppeLevel: "" })),
    deconTeam: [1, 2, 3, 4].map(n => ({ id: uid(), label: `Decon ${n}`, name: "", ppeLevel: "" })),
    materials: [], materialsComment: "",
    lelInstruments: "", o2Instruments: "", toxicityInstruments: "", radiologicalInstruments: "", monitoringComment: "",
    standardDecon: "Yes", deconComment: "",
    commandFreq: "", tacticalFreq: "", entryFreq: "",
    medicalMonitoring: "Yes", medicalTreatmentInPlace: "Yes", medicalComment: "",
    siteMapWeather: false, siteMapCommandPost: false, siteMapZones: false, siteMapAssemblyAreas: false, siteMapEscapeRoutes: false, siteMapOther: false, siteMapNotes: "",
    entryObjectives: "",
    sopModifications: "No", sopComment: "",
    emergencyProcedures: "",
    asstSafetyOfficerSignature: "", safetyBriefingTime: "",
    hmGroupSupervisorSignature: "", incidentCommanderSignature: "",
  };
}
function defaultIcs209() {
  const statusRow = () => ({ period: "", total: "" });
  return {
    reportVersion: "Initial", reportNumber: "",
    icAgency: "", icAgencyOrg: "", imTeam: "",
    startDate: "", startTime: "", startTimeZone: "CST",
    sizeArea: "", percentContained: "",
    definition: "", complexityLevel: "",
    opFrom: "", opTo: "",
    preparedByName: "", preparedByPosition: "", preparedDateTime: "",
    submittedDateTime: "", submittedTimeZone: "",
    approvedByName: "", approvedByPosition: "", approvedBySignature: "",
    sentTo: "",
    state: "", county: "", city: "", unitOther: "", jurisdiction: "", ownership: "",
    longitude: "", latitude: "", usng: "", legalDescription: "", shortLocation: "", utm: "", geospatialNote: "",
    significantEvents: "", primaryMaterials: "", damageOther: "",
    structural: {
      singleResidences: { threatened: "", damaged: "", destroyed: "" },
      nonresidential: { threatened: "", damaged: "", destroyed: "" },
      otherMinor: { threatened: "", damaged: "", destroyed: "" },
      other: { threatened: "", damaged: "", destroyed: "" },
    },
    publicStatus: Object.fromEntries(["fatalities", "injuries", "trapped", "missing", "evacuated", "shelterInPlace", "tempShelters", "massImmunizations", "requireImmunizations", "quarantine"].map(k => [k, statusRow()])),
    responderStatus: Object.fromEntries(["fatalities", "injuries", "trapped", "missing", "shelterInPlace", "receivedImmunizations", "requireImmunizations", "quarantine"].map(k => [k, statusRow()])),
    threatRemarks: "",
    threatFlags: Object.fromEntries(["noLikelyThreat", "potentialFutureThreat", "massNotificationsInProgress", "massNotificationsCompleted", "noEvacImminent", "planningForEvac", "planningForShelterInPlace", "evacInProgress", "shelterInPlaceInProgress", "repopulationInProgress", "massImmunizationInProgress", "massImmunizationComplete", "quarantineInProgress", "areaRestrictionInEffect"].map(k => [k, false])),
    weatherConcerns: "",
    projectedActivity: { h12: "", h24: "", h48: "", h72: "", after72: "" },
    strategicObjectives: "",
    threatSummaryTimeframes: { h12: "", h24: "", h48: "", h72: "", after72: "" },
    resourceNeeds: { h12: "", h24: "", h48: "", h72: "", after72: "" },
    strategicDiscussion: "",
    plannedActions: "",
    projectedFinalSize: "",
    completionDate: "",
    demobStartDate: "",
    costsToDate: "",
    finalCostEstimate: "",
    remarks: "",
    resourceCommitments: [],
    cooperatingOrgs: "",
  };
}
function defaultIcs206() {
  return { aidStations: [], ambulances: [], hospitals: [], procedures: "", aviationAssets: false, preparedBy: "", preparedSignature: "", approvedBy: "", approvedSignature: "", dateTime: "" };
}
// Drawn map annotations (fire perimeter, hazard zones, staging areas,
// points of interest, etc.) — stored as a standard GeoJSON
// FeatureCollection, the format Leaflet's draw plugin natively reads
// and writes, so no translation layer is needed between what's drawn
// and what's saved/synced.
function defaultMapData() {
  return { type: "FeatureCollection", features: [] };
}

// mapData is stored in Firestore as a JSON STRING, not as a nested
// object — Firestore rejects any field containing a directly nested
// array (an array inside another array with no object in between),
// and GeoJSON's own coordinate format is exactly that for anything
// beyond a single point: a LineString's coordinates look like
// [[lng,lat],[lng,lat],...], a Polygon's are nested one level deeper
// still. A marker's [lng,lat] is flat and saved fine, which is why
// drop-pins synced while every multi-point shape (freehand lines,
// polygons, rectangles, leaflet-draw's own polyline tool) silently
// failed to save at all — the write was throwing, uncaught, which
// left the sync indicator stuck rather than showing an error.
// Storing the whole thing as one opaque string sidesteps the
// restriction entirely; parseMapData handles a missing field, an
// already-parsed object (e.g. from startNew's blank template), or a
// JSON string, so it's safe regardless of which shape it's given.
function parseMapData(raw) {
  if (!raw) return defaultMapData();
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return defaultMapData(); }
  }
  return raw;
}

// A text label on the map is a marker with a DivIcon rendering the
// text directly (styled like a sticky note, not a location pin) —
// used both when placing a new label and when reconstructing a saved
// one on load (see the pointToLayer logic in TabMapping).
function makeTextIcon(text) {
  const esc = String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return L.divIcon({
    className: "cb-map-text-label",
    html: `<div style="background:#fff;color:#191C1F;border:1.5px solid #96690F;border-radius:4px;padding:3px 7px;font:600 12px 'IBM Plex Sans',sans-serif;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.4);">${esc}</div>`,
    iconSize: null, // let the content size itself rather than clipping to a fixed box
    iconAnchor: [8, 8],
  });
}

function defaultComms() {
  return {
    dateTimePrepared: "", opFrom: "", opTo: "", specialInstructions: "",
    preparedBy: "", signature: "", dateTime: "",
    rows: [],
  };
}
// Older saved incidents stored comms as a plain array of channel rows
// (before the header/footer fields were added to match the official
// ICS-205 form) — migrate that shape into the new object instead of
// letting `.rows` calls fail on an array.
function normalizeComms(raw) {
  if (!raw) return defaultComms();
  if (Array.isArray(raw)) {
    return {
      ...defaultComms(),
      rows: raw.map(r => ({
        id: r.id || uid(), zoneGroup: "", chNum: "", func: r.func || "Command",
        channelName: r.channel || "", assignment: r.assignment || "",
        rxFreq: r.rx || "", rxTone: "", txFreq: r.tx || "", txTone: "",
        mode: r.mode === "Analog" ? "A" : r.mode === "Digital" ? "D" : r.mode === "Mixed" ? "M" : (r.mode || "D"),
        remarks: r.remarks || "",
      })),
    };
  }
  return { ...defaultComms(), ...raw };
}

/* ============================================================
   SMALL UI PRIMITIVES
   ============================================================ */
function Field({ label, children, wide }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5, gridColumn: wide ? "1 / -1" : undefined }}>
      <span style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace" }}>{label}</span>
      {children}
    </label>
  );
}

const inputStyle = {
  background: COLORS.panel2,
  border: `1px solid ${COLORS.line}`,
  borderRadius: 4,
  color: COLORS.text,
  padding: "8px 10px",
  fontSize: 14,
  fontFamily: "'IBM Plex Sans', sans-serif",
  outline: "none",
};
function TextInput(props) {
  return <input {...props} style={{ ...inputStyle, ...(props.style || {}) }} />;
}
function TextArea(props) {
  return <textarea {...props} style={{ ...inputStyle, resize: "vertical", minHeight: 70, ...(props.style || {}) }} />;
}
function Select({ children, ...props }) {
  return <select {...props} style={{ ...inputStyle, ...(props.style || {}) }}>{children}</select>;
}

function Btn({ children, onClick, kind = "ghost", icon: Icon, style, type = "button", disabled, title }) {
  const base = {
    display: "inline-flex", alignItems: "center", gap: 7,
    padding: "8px 13px", borderRadius: 4, fontSize: 13, fontWeight: 600,
    fontFamily: "'IBM Plex Sans', sans-serif", cursor: disabled ? "not-allowed" : "pointer",
    border: `1px solid ${COLORS.line}`, letterSpacing: "0.02em",
    opacity: disabled ? 0.5 : 1,
  };
  const kinds = {
    ghost: { background: "transparent", color: COLORS.text },
    solid: { background: COLORS.red, color: "#fff", border: `1px solid ${COLORS.red}` },
    subtle: { background: COLORS.panel2, color: COLORS.text },
    danger: { background: "transparent", color: COLORS.dangerText, border: `1px solid ${COLORS.dangerBorder}` },
  };
  return (
    <button type={type} disabled={disabled} onClick={onClick} title={title} style={{ ...base, ...kinds[kind], ...style }}>
      {Icon && <Icon size={14} />}{children}
    </button>
  );
}

function Panel({ title, icon: Icon, right, children, style }) {
  return (
    <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 6, overflow: "hidden", ...style }}>
      {title && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "11px 16px", borderBottom: `1px solid ${COLORS.line}`, background: COLORS.panel2 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "'Oswald', sans-serif", letterSpacing: "0.05em", textTransform: "uppercase", fontSize: 13, color: COLORS.text }}>
            {Icon && <Icon size={15} color={COLORS.amber} />}{title}
          </div>
          {right}
        </div>
      )}
      <div style={{ padding: 16 }}>{children}</div>
    </div>
  );
}

/* ============================================================
   TAB: ICS-201 INCIDENT BRIEFING
   ============================================================ */
function Tab201({ incident, setIncident, resources, objectivePresets, onSavePreset }) {
  const updateObjective = (i, val) => {
    const next = [...incident.objectives]; next[i] = val;
    setIncident({ ...incident, objectives: next });
  };
  const addObjective = () => setIncident({ ...incident, objectives: [...incident.objectives, ""] });
  const removeObjective = (i) => setIncident({ ...incident, objectives: incident.objectives.filter((_, idx) => idx !== i) });

  const addAction = () => setIncident({ ...incident, actionsLog: [...incident.actionsLog, { id: uid(), time: "", actions: "" }] });
  const updateAction = (id, patch) => setIncident({ ...incident, actionsLog: incident.actionsLog.map(a => a.id === id ? { ...a, ...patch } : a) });
  const removeAction = (id) => setIncident({ ...incident, actionsLog: incident.actionsLog.filter(a => a.id !== id) });

  const counts = STATUS_FLOW.map(s => ({ status: s, n: resources.filter(r => r.status === s).length }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Tactical Worksheet" icon={ClipboardList}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Incident Name"><TextInput value={incident.name} onChange={e => setIncident({ ...incident, name: e.target.value })} placeholder="e.g. County Rd 411 Structure" /></Field>
          <Field label="Incident Number"><TextInput value={incident.number} onChange={e => setIncident({ ...incident, number: e.target.value })} placeholder="Dispatch / CAD #" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
          <Field label="Date Initiated"><TextInput type="date" value={incident.dateInitiated} onChange={e => setIncident({ ...incident, dateInitiated: e.target.value })} /></Field>
          <Field label="Time Initiated"><TextInput type="time" value={incident.timeInitiated} onChange={e => setIncident({ ...incident, timeInitiated: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
          <Field label="Date Terminated"><TextInput type="date" value={incident.dateTerminated} onChange={e => setIncident({ ...incident, dateTerminated: e.target.value })} /></Field>
          <Field label="Time Terminated"><TextInput type="time" value={incident.timeTerminated} onChange={e => setIncident({ ...incident, timeTerminated: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
          <Field label="Incident Type">
            <Select value={incident.type} onChange={e => setIncident({ ...incident, type: e.target.value })}>
              {INCIDENT_TYPES.map(t => <option key={t.v} value={t.v}>{t.v}</option>)}
            </Select>
          </Field>
          <Field label="Location"><TextInput value={incident.location} onChange={e => setIncident({ ...incident, location: e.target.value })} placeholder="Address / cross streets / lat-long" /></Field>
          <Field label="Incident Commander"><TextInput value={incident.icName} onChange={e => setIncident({ ...incident, icName: e.target.value })} /></Field>
        </div>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 4px" }}>Field Conditions (not on official form — quick reference)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 14 }}>
          <Field label="Wind"><TextInput value={incident.wind} onChange={e => setIncident({ ...incident, wind: e.target.value })} placeholder="8 mph SW" /></Field>
          <Field label="Temp"><TextInput value={incident.temp} onChange={e => setIncident({ ...incident, temp: e.target.value })} placeholder="72°F" /></Field>
          <Field label="RH"><TextInput value={incident.rh} onChange={e => setIncident({ ...incident, rh: e.target.value })} placeholder="45%" /></Field>
          <Field label="Conditions"><TextInput value={incident.conditions} onChange={e => setIncident({ ...incident, conditions: e.target.value })} placeholder="Clear, smoke visible..." /></Field>
        </div>

        <div style={{ marginTop: 14 }}>
          <Field label="Situation Summary and Health and Safety Briefing" wide>
            <TextArea value={incident.situation} onChange={e => setIncident({ ...incident, situation: e.target.value })} style={{ minHeight: 90 }}
              placeholder="Recognize potential incident health and safety hazards and note measures taken to protect responders (remove hazard, PPE, warn people)..." />
          </Field>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 8 }}>Current and Planned Objectives</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {incident.objectives.map((o, i) => {
              const isNewObjective = o.trim() && !objectivePresets.includes(o.trim());
              return (
                <div key={i} style={{ display: "flex", gap: 8 }}>
                  <span style={{ width: 22, textAlign: "right", color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, paddingTop: 9 }}>{i + 1}.</span>
                  <TextInput list="objective-presets" value={o} onChange={e => updateObjective(i, e.target.value)} style={{ flex: 1 }} placeholder="Objective..." />
                  {isNewObjective && (
                    <button onClick={() => onSavePreset(o.trim())} title="Save as a quick-pick objective for next time" style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 4, color: COLORS.amber, cursor: "pointer", padding: "0 8px" }}>
                      <Star size={14} />
                    </button>
                  )}
                  <Btn kind="danger" onClick={() => removeObjective(i)}><Trash2 size={14} /></Btn>
                </div>
              );
            })}
            <datalist id="objective-presets">{objectivePresets.map(p => <option key={p} value={p} />)}</datalist>
            <Btn kind="subtle" icon={Plus} onClick={addObjective} style={{ alignSelf: "flex-start" }}>Add Objective</Btn>
          </div>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 8 }}>Current and Planned Actions, Strategies, and Tactics</div>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 12 }}>
            {[["strategyOffensive", "Offensive"], ["strategyDefensive", "Defensive"], ["strategyTransitional", "Transitional"], ["strategyInvestigative", "Investigative"]].map(([key, label]) => (
              <label key={key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13 }}>
                <input type="checkbox" checked={incident[key]} onChange={e => setIncident({ ...incident, [key]: e.target.checked })} style={{ width: 16, height: 16 }} />
                {label}
              </label>
            ))}
          </div>
          {incident.actionsLog.map(a => (
            <div key={a.id} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
              <TextInput type="time" value={a.time} onChange={e => updateAction(a.id, { time: e.target.value })} style={{ width: 130 }} />
              <TextInput value={a.actions} onChange={e => updateAction(a.id, { actions: e.target.value })} placeholder="Actions..." style={{ flex: 1 }} />
              <button onClick={() => removeAction(a.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button>
            </div>
          ))}
          <Btn kind="subtle" icon={Plus} onClick={addAction} style={{ marginTop: 4 }}>Add Entry</Btn>
        </div>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "18px 0 8px" }}>
          Current Organization — see the Org Chart tab (Incident Commander(s), Section Chiefs, Safety Officer, PIO, Liaison Officer)
        </div>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "18px 0 8px" }}>Prepared By</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
          <Field label="Name"><TextInput value={incident.preparedBy} onChange={e => setIncident({ ...incident, preparedBy: e.target.value })} /></Field>
          <Field label="Position / Title"><TextInput value={incident.prepPosition} onChange={e => setIncident({ ...incident, prepPosition: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={incident.prepSignature} onChange={e => setIncident({ ...incident, prepSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Date / Time"><TextInput type="datetime-local" value={incident.prepDateTime} onChange={e => setIncident({ ...incident, prepDateTime: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="Resource Board Status" icon={Truck}>
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${STATUS_FLOW.length}, 1fr)`, gap: 10 }}>
          {counts.map(c => (
            <div key={c.status} style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: "10px 8px", textAlign: "center" }}>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 28, color: STATUS_COLOR[c.status] }}>{c.n}</div>
              <div style={{ fontSize: 10.5, color: COLORS.muted, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 2 }}>{c.status}</div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: RESOURCE STATUS BOARD
   ============================================================ */
// Rename/move/delete for the Department -> Unit hierarchy. Renaming
// uses an uncontrolled input that commits on blur/Enter rather than
// saving on every keystroke — a rename is a single deliberate edit,
// not something that needs a write per character typed.
// Reusable rename/delete/reorder/add UI for a simple flat list —
// shared by the Assignments and Types tabs below, which need
// identical behavior and differ only in their data and labels.
// Drag-to-reorder for a plain list, built on Pointer Events (not native
// HTML5 drag-and-drop, which is unreliable on touch devices) — same
// approach already used for the Resource Board columns. Reorders live
// as you drag over other rows, then commits the final order on release
// via onReorderFull(newFullArray), rather than one write per swap.
function DragReorderList({ items, keyFn, onReorderFull, renderItem }) {
  const [dragKey, setDragKey] = useState(null);
  const [liveOrder, setLiveOrder] = useState(items);
  const itemRefs = useRef({});
  const liveOrderRef = useRef(items);

  useEffect(() => { if (!dragKey) { setLiveOrder(items); liveOrderRef.current = items; } }, [items, dragKey]);
  useEffect(() => { liveOrderRef.current = liveOrder; }, [liveOrder]);

  useEffect(() => {
    if (!dragKey) return;
    const handleMove = (e) => {
      const order = liveOrderRef.current;
      const idx = order.findIndex(it => keyFn(it) === dragKey);
      if (idx === -1) return;
      // insertBeforeIdx = the position, in the ORIGINAL (pre-removal)
      // array, before which the dragged item should land — found by
      // the first row whose midpoint the pointer is above. Defaults to
      // the very end if the pointer is below every row.
      let insertBeforeIdx = order.length;
      for (let i = 0; i < order.length; i++) {
        const el = itemRefs.current[keyFn(order[i])];
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        if (e.clientY < rect.top + rect.height / 2) { insertBeforeIdx = i; break; }
      }
      // Removing the dragged item first shifts every index after it
      // down by one — so if the target position is after the source,
      // it must be adjusted by -1 to land correctly in the now-shorter
      // array. Skipping this produces an off-by-one: dropping into a
      // row's top half would land the item one slot too far down.
      if (insertBeforeIdx !== idx && insertBeforeIdx !== idx + 1) {
        const next = [...order];
        const [moved] = next.splice(idx, 1);
        const insertAt = insertBeforeIdx > idx ? insertBeforeIdx - 1 : insertBeforeIdx;
        next.splice(insertAt, 0, moved);
        setLiveOrder(next);
      }
    };
    const handleUp = () => {
      setDragKey(null);
      onReorderFull(liveOrderRef.current);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragKey]);

  return liveOrder.map((item, i) => {
    const k = keyFn(item);
    const dragHandleProps = {
      onPointerDown: (e) => { e.preventDefault(); setDragKey(k); },
      style: { cursor: "grab", touchAction: "none" },
    };
    return (
      <div key={k} ref={el => { itemRefs.current[k] = el; }} style={{ opacity: dragKey === k ? 0.4 : 1 }}>
        {renderItem(item, i, dragHandleProps)}
      </div>
    );
  });
}

function FlatListManager({ items, onRename, onDelete, onReorder, onAdd, addLabel, addPlaceholder, emptyLabel }) {
  const [adding, setAdding] = useState(false);
  const [newValue, setNewValue] = useState("");
  const commitNew = () => {
    const name = newValue.trim();
    if (name) onAdd(name);
    setAdding(false);
    setNewValue("");
  };
  return (
    <div>
      {items.length === 0 && <div style={{ color: COLORS.faint, fontSize: 13, marginBottom: 12 }}>{emptyLabel}</div>}
      <DragReorderList items={items} keyFn={item => item} onReorderFull={onReorder} renderItem={(item, i, dragHandleProps) => (
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 8 }}>
          <span {...dragHandleProps} title="Drag to reorder" style={{ ...dragHandleProps.style, color: COLORS.faint, flexShrink: 0 }}><GripVertical size={15} /></span>
          <TextInput key={item} defaultValue={item}
            onBlur={e => { const v = e.target.value.trim(); if (v && v !== item) onRename(item, v); }}
            onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
            style={{ flex: 1, fontSize: 12.5 }} />
          <button onClick={() => onDelete(item)} title="Delete" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button>
        </div>
      )} />
      {adding ? (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder={addPlaceholder} style={{ flex: 1 }}
            onKeyDown={e => { if (e.key === "Enter") commitNew(); if (e.key === "Escape") setAdding(false); }} />
          <Btn kind="solid" onClick={commitNew} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
          <button onClick={() => setAdding(false)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
        </div>
      ) : (
        <Btn kind="subtle" icon={Plus} onClick={() => { setAdding(true); setNewValue(""); }}>{addLabel}</Btn>
      )}
    </div>
  );
}



// Single management modal for everything the Check In Resource form
// pulls from — Departments & Units, Assignments/Divisions, and
// Resource Types — organized as tabs rather than three separate
// buttons/modals, since they're all "manage the resource picker" in
// one place.
function ManageResourcesModal({
  departments, onRenameDept, onDeleteDept, onReorderDept, onRenameUnit, onDeleteUnit, onMoveUnit, onReorderUnit, onAddDepartment, onAddUnitUnderDepartment,
  assignments, onRenameAssignment, onDeleteAssignment, onReorderAssignment, onAddAssignment,
  resourceKinds, onRenameKind, onDeleteKind, onReorderKind, onAddKind,
  onClose,
}) {
  const [subTab, setSubTab] = useState("departments"); // departments | assignments | kinds
  const [addingDeptFor, setAddingDeptFor] = useState(false);
  const [addingUnitFor, setAddingUnitFor] = useState(null); // deptId or null
  const [newValue, setNewValue] = useState("");

  const commitNewDept = () => {
    const name = newValue.trim();
    if (name) onAddDepartment(name);
    setAddingDeptFor(false);
    setNewValue("");
  };
  const commitNewUnit = (deptId) => {
    const name = newValue.trim();
    if (name) onAddUnitUnderDepartment(deptId, name);
    setAddingUnitFor(null);
    setNewValue("");
  };

  const SUB_TABS = [
    { k: "departments", label: "Departments & Units" },
    { k: "assignments", label: "Assignments" },
    { k: "kinds", label: "Resource Types" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 65 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 560, maxHeight: "84vh", overflowY: "auto", padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 15 }}>Manage Resources</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>
        </div>

        <div style={{ display: "flex", gap: 6, marginBottom: 16, borderBottom: `1px solid ${COLORS.line}`, paddingBottom: 10 }}>
          {SUB_TABS.map(t => (
            <button key={t.k} onClick={() => setSubTab(t.k)} style={{
              background: subTab === t.k ? COLORS.panel2 : "transparent",
              border: `1px solid ${subTab === t.k ? COLORS.amber : COLORS.line}`,
              color: subTab === t.k ? COLORS.text : COLORS.muted,
              borderRadius: 5, padding: "6px 11px", fontSize: 12, cursor: "pointer",
            }}>{t.label}</button>
          ))}
        </div>

        {subTab === "departments" && (
          <>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
              Edit a name and click away (or press Enter) to rename it. Drag the grip to reorder, or use the dropdown next to a unit to move it to a different department.
            </div>

            {departments.length === 0 && <div style={{ color: COLORS.faint, fontSize: 13, marginBottom: 12 }}>No departments yet.</div>}

            <DragReorderList items={departments} keyFn={d => d.id} onReorderFull={onReorderDept} renderItem={(d, di, deptDragProps) => (
              <div style={{ marginBottom: 14, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 12 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
                  <span {...deptDragProps} title="Drag to reorder" style={{ ...deptDragProps.style, color: COLORS.faint, flexShrink: 0 }}><GripVertical size={16} /></span>
                  <TextInput key={d.id + d.name} defaultValue={d.name}
                    onBlur={e => { const v = e.target.value.trim(); if (v && v !== d.name) onRenameDept(d.id, v); }}
                    onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                    style={{ flex: 1, fontWeight: 600 }} />
                  <button onClick={() => onDeleteDept(d.id)} title="Delete department (and its units)" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={15} /></button>
                </div>

                <DragReorderList items={d.units} keyFn={u => u} onReorderFull={(newUnits) => onReorderUnit(d.id, newUnits)} renderItem={(u, ui, unitDragProps) => (
                  <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, paddingLeft: 14 }}>
                    <span {...unitDragProps} title="Drag to reorder" style={{ ...unitDragProps.style, color: COLORS.faint, flexShrink: 0 }}><GripVertical size={14} /></span>
                    <TextInput key={d.id + u} defaultValue={u}
                      onBlur={e => { const v = e.target.value.trim(); if (v && v !== u) onRenameUnit(d.id, u, v); }}
                      onKeyDown={e => { if (e.key === "Enter") e.target.blur(); }}
                      style={{ flex: 1, fontSize: 12.5 }} />
                    {departments.length > 1 && (
                      <Select value={d.id} onChange={e => { if (e.target.value !== d.id) onMoveUnit(d.id, u, e.target.value); }} style={{ width: 140, fontSize: 12 }} title="Move to department">
                        {departments.map(dd => <option key={dd.id} value={dd.id}>{dd.name}</option>)}
                      </Select>
                    )}
                    <button onClick={() => onDeleteUnit(d.id, u)} title="Delete unit" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={13} /></button>
                  </div>
                )} />

                {addingUnitFor === d.id ? (
                  <div style={{ display: "flex", gap: 6, paddingLeft: 14, marginTop: 6 }}>
                    <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="New unit name" style={{ flex: 1, fontSize: 12.5 }}
                      onKeyDown={e => { if (e.key === "Enter") commitNewUnit(d.id); if (e.key === "Escape") setAddingUnitFor(null); }} />
                    <Btn kind="solid" onClick={() => commitNewUnit(d.id)} style={{ padding: "5px 9px", fontSize: 12 }}>Add</Btn>
                    <button onClick={() => setAddingUnitFor(null)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={13} /></button>
                  </div>
                ) : (
                  <Btn kind="subtle" icon={Plus} onClick={() => { setAddingUnitFor(d.id); setNewValue(""); }} style={{ marginTop: 6, marginLeft: 14, padding: "4px 8px", fontSize: 11.5 }}>Add Unit</Btn>
                )}
              </div>
            )} />

            {addingDeptFor ? (
              <div style={{ display: "flex", gap: 6 }}>
                <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="New department name" style={{ flex: 1 }}
                  onKeyDown={e => { if (e.key === "Enter") commitNewDept(); if (e.key === "Escape") setAddingDeptFor(false); }} />
                <Btn kind="solid" onClick={commitNewDept} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
                <button onClick={() => setAddingDeptFor(false)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
              </div>
            ) : (
              <Btn kind="subtle" icon={Plus} onClick={() => { setAddingDeptFor(true); setNewValue(""); }}>Add Department</Btn>
            )}
          </>
        )}

        {subTab === "assignments" && (
          <>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
              Edit a name and click away (or press Enter) to rename it. Use the arrows to reorder.
            </div>
            <FlatListManager
              items={assignments} onRename={onRenameAssignment} onDelete={onDeleteAssignment} onReorder={onReorderAssignment} onAdd={onAddAssignment}
              addLabel="Add Assignment" addPlaceholder="New assignment" emptyLabel="None yet." />
          </>
        )}

        {subTab === "kinds" && (
          <>
            <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 14, lineHeight: 1.5 }}>
              Edit a name and click away (or press Enter) to rename it. Use the arrows to reorder.
            </div>
            <FlatListManager
              items={resourceKinds} onRename={onRenameKind} onDelete={onDeleteKind} onReorder={onReorderKind} onAdd={onAddKind}
              addLabel="Add Resource Type" addPlaceholder="New resource type" emptyLabel="None yet." />
          </>
        )}
      </div>
    </div>
  );
}

function ResourceForm({ onAdd, departments, onAddDepartment, onAddUnitUnderDepartment, assignmentPresets, onSaveAssignmentPreset, resourceKindPresets }) {
  const [f, setF] = useState({ label: "", kind: resourceKindPresets[0] || "", personnel: 1, assignment: "" });
  const [deptId, setDeptId] = useState("");
  const [addingField, setAddingField] = useState(null); // null | "department" | "unit" | "assignment"
  const [newValue, setNewValue] = useState("");

  const selectedDept = departments.find(d => d.id === deptId) || null;

  const submit = () => {
    if (!f.label.trim()) return;
    onAdd({ id: uid(), label: f.label.trim(), kind: f.kind, department: selectedDept ? selectedDept.name : "", personnel: Number(f.personnel) || 1, assignment: f.assignment, status: "Staging", statusSince: nowISO(), checkIn: nowISO(), notes: "", history: [{ status: "Staging", at: nowISO() }] });
    setF({ label: "", kind: f.kind, personnel: 1, assignment: "" });
  };

  const startAdding = (field) => { setAddingField(field); setNewValue(""); };
  const confirmAdd = () => {
    const name = newValue.trim();
    if (!name) return;
    if (addingField === "department") {
      const id = onAddDepartment(name);
      setDeptId(id);
      setF(prev => ({ ...prev, label: "" }));
    } else if (addingField === "unit") {
      onAddUnitUnderDepartment(deptId, name);
      setF(prev => ({ ...prev, label: name }));
    } else {
      onSaveAssignmentPreset(name);
      setF(prev => ({ ...prev, assignment: name }));
    }
    setAddingField(null);
    setNewValue("");
  };

  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <Field label="Department">
        {addingField === "department" ? (
          <div style={{ display: "flex", gap: 4 }}>
            <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="e.g. Sanger FD" style={{ width: 150 }}
              onKeyDown={e => { if (e.key === "Enter") confirmAdd(); if (e.key === "Escape") setAddingField(null); }} />
            <Btn kind="solid" onClick={confirmAdd} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
            <button onClick={() => setAddingField(null)} title="Cancel" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
          </div>
        ) : (
          <Select value={deptId} onChange={e => {
            if (e.target.value === "__add_new__") startAdding("department");
            else { setDeptId(e.target.value); setF(prev => ({ ...prev, label: "" })); }
          }} style={{ width: 160 }}>
            <option value="">Select department...</option>
            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            <option value="__add_new__">+ Add Department</option>
          </Select>
        )}
      </Field>
      <Field label="Unit / Resource ID">
        {addingField === "unit" ? (
          <div style={{ display: "flex", gap: 4 }}>
            <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="e.g. Brush 581" style={{ width: 150 }}
              onKeyDown={e => { if (e.key === "Enter") confirmAdd(); if (e.key === "Escape") setAddingField(null); }} />
            <Btn kind="solid" onClick={confirmAdd} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
            <button onClick={() => setAddingField(null)} title="Cancel" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
          </div>
        ) : (
          <Select value={f.label} disabled={!selectedDept} onChange={e => {
            if (e.target.value === "__add_new__") startAdding("unit");
            else setF({ ...f, label: e.target.value });
          }} style={{ width: 200 }} title={!selectedDept ? "Select a department first" : undefined}>
            <option value="">{selectedDept ? "Select a unit..." : "Select department first..."}</option>
            {selectedDept && selectedDept.units.map(u => <option key={u} value={u}>{u}</option>)}
            {selectedDept && <option value="__add_new__">+ Add Unit</option>}
          </Select>
        )}
      </Field>
      <Field label="Type">
        <Select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })} style={{ width: 150 }}>
          {resourceKindPresets.map(k => <option key={k} value={k}>{k}</option>)}
        </Select>
      </Field>
      <Field label="Personnel"><TextInput type="number" min="0" value={f.personnel} onChange={e => setF({ ...f, personnel: e.target.value })} style={{ width: 80 }} /></Field>
      <Field label="Assignment / Division">
        {addingField === "assignment" ? (
          <div style={{ display: "flex", gap: 4 }}>
            <TextInput autoFocus value={newValue} onChange={e => setNewValue(e.target.value)} placeholder="New assignment" style={{ width: 150 }}
              onKeyDown={e => { if (e.key === "Enter") confirmAdd(); if (e.key === "Escape") setAddingField(null); }} />
            <Btn kind="solid" onClick={confirmAdd} style={{ padding: "6px 9px", fontSize: 12 }}>Add</Btn>
            <button onClick={() => setAddingField(null)} title="Cancel" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={14} /></button>
          </div>
        ) : (
          <Select value={f.assignment} onChange={e => {
            if (e.target.value === "__add_new__") startAdding("assignment");
            else setF({ ...f, assignment: e.target.value });
          }} style={{ width: 180 }}>
            <option value="">Select assignment...</option>
            {assignmentPresets.map(a => <option key={a} value={a}>{a}</option>)}
            <option value="__add_new__">+ Add Assignment</option>
          </Select>
        )}
      </Field>
      <Btn kind="solid" icon={Plus} onClick={submit}>Check In</Btn>
    </div>
  );
}

function ResourceCard({ r, onMove, onUpdate, onRemove, now, dragProps, isDragging }) {
  const [editing, setEditing] = useState(false);
  const nextOptions = STATUS_FLOW.filter(s => s !== r.status);
  // Once released, the timer stops accruing — freeze it at the moment
  // of release instead of continuing to tick against real time.
  const cardNow = r.status === "Released" ? new Date(r.statusSince).getTime() : now;
  // While in Rehab, also surface how long the resource was Working
  // right before it came in — a static duration, not a live timer.
  const prior = r.status === "Rehab" ? priorPeriod(r.history) : null;
  return (
    <div style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderLeft: `3px solid ${STATUS_COLOR[r.status]}`, borderRadius: 5, padding: 10, marginBottom: 8, opacity: isDragging ? 0.35 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
          <span
            {...dragProps}
            title="Drag to move"
            style={{ cursor: "grab", touchAction: "none", color: COLORS.faint, marginTop: 2, flexShrink: 0 }}
          >
            <GripVertical size={14} />
          </span>
          <div>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, fontSize: 14 }}>{r.label}</div>
            <div style={{ fontSize: 11.5, color: COLORS.muted }}>{r.kind} · {r.personnel} pers.</div>
            {r.department && <div style={{ fontSize: 10.5, color: COLORS.faint }}>{r.department}</div>}
          </div>
        </div>
        <button onClick={() => onRemove(r.id)} title="Remove" style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><X size={13} /></button>
      </div>
      {r.assignment && <div style={{ fontSize: 11.5, color: COLORS.amber, marginTop: 4 }}>→ {r.assignment}</div>}
      {prior && (
        <div style={{ fontSize: 10.5, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", marginTop: 6 }}>
          {prior.status} before rehab: {fmtDuration(prior.ms)}
        </div>
      )}
      <div style={{ fontSize: 10.5, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", marginTop: prior ? 2 : 6 }}>
        {r.status === "Rehab" ? "in rehab " : "in status "}{elapsed(r.statusSince, cardNow)}
      </div>
      {editing ? (
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          <TextInput placeholder="Assignment / Division" defaultValue={r.assignment} onBlur={e => onUpdate(r.id, { assignment: e.target.value })} />
          <TextArea placeholder="Notes" defaultValue={r.notes} onBlur={e => onUpdate(r.id, { notes: e.target.value })} style={{ minHeight: 44 }} />
          <Btn kind="subtle" onClick={() => setEditing(false)}>Done</Btn>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
          <Select value="" onChange={e => { if (e.target.value) onMove(r.id, e.target.value); }} style={{ fontSize: 12, padding: "5px 7px" }}>
            <option value="">Move to...</option>
            {nextOptions.map(s => <option key={s} value={s}>{s}</option>)}
          </Select>
          <Btn kind="ghost" onClick={() => setEditing(true)} style={{ padding: "5px 8px", fontSize: 12 }}>Edit</Btn>
        </div>
      )}
    </div>
  );
}

function TabResources({ resources, setResources, now, departments, onAddDepartment, onAddUnitUnderDepartment, onRenameDepartment, onDeleteDepartment, onReorderDepartment, onRenameUnit, onDeleteUnit, onMoveUnit, onReorderUnit, assignmentPresets, onSaveAssignmentPreset, onRenameAssignment, onDeleteAssignment, onReorderAssignment, resourceKindPresets, onAddResourceKind, onRenameResourceKind, onDeleteResourceKind, onReorderResourceKind }) {
  // Drag state lives here (not per-card) since the floating preview and
  // column highlight need to render across the whole board. Built on
  // the Pointer Events API + elementFromPoint rather than native HTML5
  // drag-and-drop, because HTML5 DnD is unreliable on touch devices —
  // this app needs to work on iPads and phones, not just desktop mice.
  const [drag, setDrag] = useState(null); // { id, x, y, overStatus }
  const [showManageResources, setShowManageResources] = useState(false);

  const addResource = (r) => setResources([r, ...resources]);
  const removeResource = (id) => setResources(resources.filter(r => r.id !== id));
  const moveResource = (id, status) => setResources(resources.map(r => r.id === id ? { ...r, status, statusSince: nowISO(), history: [...r.history, { status, at: nowISO() }] } : r));
  const updateResource = (id, patch) => setResources(resources.map(r => r.id === id ? { ...r, ...patch } : r));

  const columnStatusAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    const colEl = el && el.closest("[data-column-status]");
    return colEl ? colEl.getAttribute("data-column-status") : null;
  };

  const handlePointerDown = (r, e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({ id: r.id, x: e.clientX, y: e.clientY, overStatus: r.status });
  };
  const handlePointerMove = (e) => {
    setDrag(d => d ? { ...d, x: e.clientX, y: e.clientY, overStatus: columnStatusAt(e.clientX, e.clientY) } : d);
  };
  const endDrag = (e, commit) => {
    setDrag(d => {
      if (d && commit) {
        const target = columnStatusAt(e.clientX, e.clientY);
        if (target && target !== resources.find(r => r.id === d.id)?.status) moveResource(d.id, target);
      }
      return null;
    });
  };

  const draggingResource = drag ? resources.find(r => r.id === drag.id) : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Check In Resource" icon={Truck} right={
        <Btn kind="subtle" icon={Settings} onClick={() => setShowManageResources(true)} style={{ padding: "6px 10px", fontSize: 12 }}>Manage Resources</Btn>
      }>
        <ResourceForm onAdd={addResource} departments={departments} onAddDepartment={onAddDepartment} onAddUnitUnderDepartment={onAddUnitUnderDepartment} assignmentPresets={assignmentPresets} onSaveAssignmentPreset={onSaveAssignmentPreset} resourceKindPresets={resourceKindPresets} />
      </Panel>
      {showManageResources && (
        <ManageResourcesModal
          departments={departments} onRenameDept={onRenameDepartment} onDeleteDept={onDeleteDepartment} onReorderDept={onReorderDepartment}
          onRenameUnit={onRenameUnit} onDeleteUnit={onDeleteUnit} onMoveUnit={onMoveUnit} onReorderUnit={onReorderUnit}
          onAddDepartment={onAddDepartment} onAddUnitUnderDepartment={onAddUnitUnderDepartment}
          assignments={assignmentPresets} onRenameAssignment={onRenameAssignment} onDeleteAssignment={onDeleteAssignment}
          onReorderAssignment={onReorderAssignment} onAddAssignment={onSaveAssignmentPreset}
          resourceKinds={resourceKindPresets} onRenameKind={onRenameResourceKind} onDeleteKind={onDeleteResourceKind}
          onReorderKind={onReorderResourceKind} onAddKind={onAddResourceKind}
          onClose={() => setShowManageResources(false)}
        />
      )}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${STATUS_FLOW.length}, minmax(160px, 1fr))`, gap: 10, overflowX: "auto" }}>
        {STATUS_FLOW.map(status => {
          const items = resources.filter(r => r.status === status);
          const isOver = drag && drag.overStatus === status && drag.id && resources.find(r => r.id === drag.id)?.status !== status;
          return (
            <div key={status} data-column-status={status} style={{
              background: COLORS.panel, border: `1px solid ${isOver ? STATUS_COLOR[status] : COLORS.line}`,
              borderTop: `3px solid ${STATUS_COLOR[status]}`, borderRadius: 6, padding: 10, minHeight: 200,
              boxShadow: isOver ? `0 0 0 2px ${STATUS_COLOR[status]}` : "none", transition: "box-shadow 0.1s",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 12.5 }}>{status}</span>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: COLORS.muted }}>{items.length}</span>
              </div>
              {items.length === 0 && <div style={{ fontSize: 12, color: COLORS.faint, padding: "10px 2px" }}>No resources</div>}
              {items.map(r => (
                <ResourceCard key={r.id} r={r} onMove={moveResource} onUpdate={updateResource} onRemove={removeResource} now={now}
                  isDragging={drag && drag.id === r.id}
                  dragProps={{
                    onPointerDown: (e) => handlePointerDown(r, e),
                    onPointerMove: handlePointerMove,
                    onPointerUp: (e) => endDrag(e, true),
                    onPointerCancel: (e) => endDrag(e, false),
                  }}
                />
              ))}
            </div>
          );
        })}
      </div>
      {drag && draggingResource && (
        <div style={{
          position: "fixed", left: drag.x + 14, top: drag.y - 16, width: 150, pointerEvents: "none", zIndex: 200,
          background: COLORS.panel2, border: `2px solid ${STATUS_COLOR[draggingResource.status]}`, borderRadius: 5,
          padding: 8, boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
        }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600, fontSize: 13 }}>{draggingResource.label}</div>
          <div style={{ fontSize: 10.5, color: COLORS.muted }}>{draggingResource.kind}</div>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   TAB: ORG CHART / COMMAND STRUCTURE
   ============================================================ */
// A single box in the org chart — title (usually fixed, but editable
// for command-staff and expanded nodes so new positions can be named
// anything) plus the name of whoever holds it.
function OrgBox({ title, name, onTitleChange, onNameChange, onDelete, onAddChild, titleEditable, isRoot }) {
  return (
    <div style={{
      background: isRoot ? COLORS.panel2 : COLORS.panel, border: `1.5px solid ${isRoot ? COLORS.amber : COLORS.line}`,
      borderRadius: 6, padding: "8px 10px", width: 168, textAlign: "center", position: "relative", flexShrink: 0,
    }}>
      {onDelete && (
        <button onClick={onDelete} title="Remove" style={{ position: "absolute", top: 2, right: 2, background: "none", border: "none", color: COLORS.faint, cursor: "pointer", padding: 2, lineHeight: 0 }}>
          <X size={12} />
        </button>
      )}
      {titleEditable ? (
        <TextInput value={title} onChange={e => onTitleChange(e.target.value)}
          style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", textAlign: "center", padding: "3px 4px", marginBottom: 5, color: COLORS.amber }} />
      ) : (
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", color: COLORS.amber, marginBottom: 5, lineHeight: 1.3 }}>{title}</div>
      )}
      <TextInput value={name} onChange={e => onNameChange(e.target.value)} placeholder="Name" style={{ fontSize: 12.5, textAlign: "center", padding: "5px 6px" }} />
      {onAddChild && (
        <button onClick={onAddChild} title="Add sub-unit below this one" style={{ marginTop: 6, background: "none", border: `1px dashed ${COLORS.line}`, borderRadius: 4, color: COLORS.muted, cursor: "pointer", fontSize: 10, padding: "3px 7px", width: "100%" }}>
          + Add Below
        </button>
      )}
    </div>
  );
}

// Straight connector lines: a stem down from a parent, splitting into
// a horizontal bar that drops a stem into each child below it —
// the standard org-chart connector look.
function OrgConnectors({ children }) {
  if (!children || children.length === 0) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%" }}>
      <div style={{ width: 2, height: 14, background: COLORS.line }} />
      <div style={{ display: "flex", alignItems: "flex-start", position: "relative" }}>
        {children.length > 1 && (
          <div style={{ position: "absolute", top: 0, left: 84, right: 84, height: 2, background: COLORS.line }} />
        )}
        {children.map((child, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0 10px" }}>
            <div style={{ width: 2, height: 14, background: COLORS.line }} />
            {child}
          </div>
        ))}
      </div>
    </div>
  );
}

// Recursively renders one node and, if it has children, the connector
// + child nodes below it — this is what lets a Section Chief expand
// into Branches -> Divisions/Groups -> further sub-units arbitrarily
// deep, since each level is rendered by the same component calling
// itself on its own children.
function OrgTree({ node, onUpdate, onDelete, onAddChild }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
      <OrgBox
        title={node.title} name={node.name} titleEditable
        onTitleChange={v => onUpdate(node.id, { title: v })}
        onNameChange={v => onUpdate(node.id, { name: v })}
        onDelete={() => onDelete(node.id)}
        onAddChild={() => onAddChild(node.id)}
      />
      {node.children && node.children.length > 0 && (
        <OrgConnectors>
          {node.children.map(child => (
            <OrgTree key={child.id} node={child} onUpdate={onUpdate} onDelete={onDelete} onAddChild={onAddChild} />
          ))}
        </OrgConnectors>
      )}
    </div>
  );
}

/* ============================================================
   TAB: MAPPING — Leaflet + OpenStreetMap (no API key/signup needed).
   Drawn shapes (fire perimeter, hazard zones, staging areas, points
   of interest) are stored as GeoJSON and synced like everything else
   in the app. Leaflet is controlled imperatively via refs (same
   pattern as the canvas-based org chart elsewhere in this file)
   rather than through a React wrapper library, since the map's own
   internal state (pan/zoom/drawn layers) doesn't need to live in
   React at all — only the saved GeoJSON does.
   ============================================================ */
function TabMapping({ mapData, setMapData }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const drawnItemsRef = useRef(null);
  const persistRef = useRef(() => {});
  const gpsMarkerRef = useRef(null);
  const gpsAccuracyRef = useRef(null);
  const gpsWatchIdRef = useRef(null);
  const freehandStateRef = useRef(null); // { points, tempLine } while actively drawing
  const [tracking, setTracking] = useState(false);
  const [gpsError, setGpsError] = useState("");
  const [activeTool, setActiveTool] = useState(null); // null | "text" | "freehand"
  const [textPrompt, setTextPrompt] = useState(null); // { latlng, value } while the text-label dialog is open

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, { center: [33.2635, -97.2286], zoom: 13 });
    mapRef.current = map;

    const streets = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19,
    }).addTo(map);
    // Esri World Imagery — free, no API key, no account required for
    // reasonable-volume use like a single department's internal tool.
    const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
      attribution: "Tiles &copy; Esri",
      maxZoom: 19,
    });
    L.control.layers({ "Street (OpenStreetMap)": streets, "Satellite (Esri)": satellite }, null, { position: "topright" }).addTo(map);

    // The FeatureGroup leaflet-draw edits/deletes shapes within, and
    // where previously-saved shapes get loaded back in on mount.
    const drawnItems = new L.FeatureGroup();
    drawnItemsRef.current = drawnItems;
    map.addLayer(drawnItems);
    if (mapData && mapData.features && mapData.features.length > 0) {
      // pointToLayer reconstructs the right marker type for a saved
      // Point feature: a real Circle (with its saved radius) if the
      // feature has a radius property, a styled text label if it has
      // a textLabel property, otherwise a plain marker. Both radius
      // and textLabel have to be added manually on save (see persist
      // below) since GeoJSON's Point geometry alone can't carry them.
      L.geoJSON(mapData, {
        pointToLayer: (feature, latlng) => {
          const props = feature.properties || {};
          if ("radius" in props) return L.circle(latlng, { radius: props.radius });
          if ("textLabel" in props) return L.marker(latlng, { icon: makeTextIcon(props.textLabel) });
          return L.marker(latlng);
        },
      }).eachLayer(layer => drawnItems.addLayer(layer));
    }

    const drawControl = new L.Control.Draw({
      position: "topleft",
      draw: {
        polygon: { shapeOptions: { color: "#C4341F" } }, // fire perimeter / hazard zones
        polyline: { shapeOptions: { color: "#3B6FA6" } }, // hose lays, access routes
        rectangle: { shapeOptions: { color: "#D9A02B" } },
        circle: { shapeOptions: { color: "#D9A02B" } }, // hazard radius
        marker: true,
        circlemarker: false,
      },
      edit: { featureGroup: drawnItems },
    });
    map.addControl(drawControl);

    // Rebuilt per-layer rather than pairing up two separate calls to
    // toGeoJSON() and eachLayer() by array index — that pairing
    // assumed both would iterate drawnItems in the exact same order,
    // which isn't guaranteed by Leaflet and could silently attach a
    // radius to the wrong feature, or throw and abort the save
    // entirely for that edit if the counts ever mismatched. Calling
    // toGeoJSON() on each layer individually and patching its own
    // result removes that assumption completely.
    const persist = () => {
      const features = [];
      drawnItems.eachLayer(layer => {
        const feature = layer.toGeoJSON();
        if (layer instanceof L.Circle) feature.properties = { ...feature.properties, radius: layer.getRadius() };
        if (layer.__textLabel) feature.properties = { ...feature.properties, textLabel: layer.__textLabel };
        features.push(feature);
      });
      setMapData({ type: "FeatureCollection", features });
    };
    persistRef.current = persist;
    map.on(L.Draw.Event.CREATED, (e) => { drawnItems.addLayer(e.layer); persist(); });
    map.on(L.Draw.Event.EDITED, persist);
    map.on(L.Draw.Event.DELETED, persist);

    // Fixes Leaflet's canvas sizing when the map mounts inside a tab
    // that wasn't visible (zero width/height) at the moment of init.
    setTimeout(() => map.invalidateSize(), 100);

    return () => {
      if (gpsWatchIdRef.current != null) navigator.geolocation.clearWatch(gpsWatchIdRef.current);
      map.remove();
      mapRef.current = null;
    };
    // Intentionally mount-once: mapData is only read here as the
    // initial state (see the component comment above) — external
    // updates from other devices show up next time this tab mounts,
    // not live while it's already open, to avoid fighting an
    // in-progress local edit with an incoming remote one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Text-label and freehand tools are implemented via a transparent
  // overlay element placed on top of the map (rendered below, only
  // while one of these tools is armed) using REACT's own pointer
  // event props — not Leaflet's event system, and not raw DOM
  // listeners attached to the map's own container.
  //
  // Two earlier versions of this tried both of those approaches and
  // each behaved inconsistently across devices in a way that didn't
  // point to a single clean cause (one browser's tap/click synthesis
  // working, another's not) — the common thread was competing with
  // Leaflet's own extensive internal event handling on that same
  // container element. A separate overlay sidesteps that completely:
  // it's a different DOM element Leaflet never sees, so there's
  // nothing for these tools' events to conflict with, and React's
  // pointer event system is normalized consistently across mouse,
  // touch, and pen input by the browser itself.
  const overlayToLatLng = (e) => {
    const rect = containerRef.current.getBoundingClientRect();
    return mapRef.current.containerPointToLatLng(L.point(e.clientX - rect.left, e.clientY - rect.top));
  };

  // Text placement uses a plain native onClick — deliberately NOT a
  // hand-rolled tap-vs-drag distance/time check. A browser's own
  // click event already only fires when there's no significant
  // movement between press and release; that's true for any ordinary
  // DOM element and has nothing to do with Leaflet, since this
  // overlay is a plain div Leaflet doesn't know exists. An earlier
  // version reimplemented that distinction manually, which turned out
  // less reliable than just trusting the browser to do what it
  // already does correctly and consistently across devices.
  const handleOverlayClick = (e) => {
    if (activeTool !== "text") return;
    try {
      setTextPrompt({ latlng: overlayToLatLng(e), value: "" });
    } catch (err) {
      // If this still doesn't show up on some browser, this at least
      // puts a concrete error in the console instead of failing
      // silently with nothing to go on.
      console.error("Text label placement failed:", err);
    }
  };

  // Freehand still needs real pointer tracking, since it has to
  // follow the drag continuously rather than just detect its end.
  const handleOverlayPointerDown = (e) => {
    if (activeTool !== "freehand") return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const start = overlayToLatLng(e);
    const tempLine = L.polyline([start], { color: "#2E8B72", weight: 3 }).addTo(mapRef.current);
    freehandStateRef.current = { points: [start], tempLine };
  };
  const handleOverlayPointerMove = (e) => {
    if (activeTool === "freehand" && freehandStateRef.current) {
      const pt = overlayToLatLng(e);
      freehandStateRef.current.points.push(pt);
      freehandStateRef.current.tempLine.setLatLngs(freehandStateRef.current.points);
    }
  };
  const handleOverlayPointerUp = () => {
    if (activeTool === "freehand" && freehandStateRef.current) {
      const state = freehandStateRef.current;
      mapRef.current.removeLayer(state.tempLine);
      if (state.points.length > 1) {
        const finalLine = L.polyline(state.points, { color: "#2E8B72", weight: 3 });
        drawnItemsRef.current.addLayer(finalLine);
        persistRef.current();
      }
      freehandStateRef.current = null;
    }
  };

  const confirmTextLabel = () => {
    const text = textPrompt.value.trim();
    setTextPrompt(null);
    if (!text || !mapRef.current) return;
    const marker = L.marker(textPrompt.latlng, { icon: makeTextIcon(text) });
    marker.__textLabel = text; // read by persist() above to save it back out
    drawnItemsRef.current.addLayer(marker);
    persistRef.current();
  };

  const toggleTracking = () => {
    if (tracking) {
      if (gpsWatchIdRef.current != null) navigator.geolocation.clearWatch(gpsWatchIdRef.current);
      gpsWatchIdRef.current = null;
      if (gpsMarkerRef.current) { mapRef.current.removeLayer(gpsMarkerRef.current); gpsMarkerRef.current = null; }
      if (gpsAccuracyRef.current) { mapRef.current.removeLayer(gpsAccuracyRef.current); gpsAccuracyRef.current = null; }
      setTracking(false);
      return;
    }
    if (!navigator.geolocation) { setGpsError("This device/browser doesn't support GPS location."); return; }
    setGpsError("");
    let firstFix = true;
    gpsWatchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        const latlng = [latitude, longitude];
        if (!gpsMarkerRef.current) {
          gpsMarkerRef.current = L.circleMarker(latlng, { radius: 8, color: "#fff", weight: 2, fillColor: "#3B6FA6", fillOpacity: 1 }).addTo(mapRef.current);
          gpsAccuracyRef.current = L.circle(latlng, { radius: accuracy, color: "#3B6FA6", weight: 1, fillOpacity: 0.1 }).addTo(mapRef.current);
        } else {
          gpsMarkerRef.current.setLatLng(latlng);
          gpsAccuracyRef.current.setLatLng(latlng);
          gpsAccuracyRef.current.setRadius(accuracy);
        }
        if (firstFix) { mapRef.current.setView(latlng, 16); firstFix = false; }
      },
      (err) => setGpsError(err.code === 1 ? "Location permission denied." : "Couldn't get GPS location."),
      { enableHighAccuracy: true, maximumAge: 5000 }
    );
    setTracking(true);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Mapping" icon={MapIcon} right={
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Btn kind={activeTool === "text" ? "solid" : "subtle"} onClick={() => setActiveTool(t => t === "text" ? null : "text")} style={{ padding: "6px 11px", fontSize: 12.5 }}>
            {activeTool === "text" ? "Tap Map to Place Text" : "Add Text Label"}
          </Btn>
          <Btn kind={activeTool === "freehand" ? "solid" : "subtle"} onClick={() => setActiveTool(t => t === "freehand" ? null : "freehand")} style={{ padding: "6px 11px", fontSize: 12.5 }}>
            {activeTool === "freehand" ? "Drawing… (tap to stop)" : "Freehand Draw"}
          </Btn>
          <Btn kind={tracking ? "solid" : "subtle"} icon={Crosshair} onClick={toggleTracking} style={{ padding: "6px 11px", fontSize: 12.5 }}>
            {tracking ? "Stop Location" : "Show My Location"}
          </Btn>
        </div>
      }>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 10, lineHeight: 1.5 }}>
          Use the shape tools (top-left) to mark the fire perimeter, hazard zones, staging areas, or points of interest, or use <strong>Add Text Label</strong> / <strong>Freehand Draw</strong> above to type a note or sketch with a finger or Apple Pencil — all saved automatically and shared across the board. While either of those two is armed, the map itself won't pan (tap the button again to release it). Switch between street and satellite view from the layer control (top-right).
          {gpsError && <span style={{ color: COLORS.dangerText, display: "block", marginTop: 4 }}>{gpsError}</span>}
        </div>
        <div style={{ position: "relative" }}>
          <div ref={containerRef} style={{ width: "100%", height: "65vh", minHeight: 420, borderRadius: 6, border: `1px solid ${COLORS.line}` }} />
          {(activeTool === "text" || activeTool === "freehand") && (
            <div
              onClick={handleOverlayClick}
              onPointerDown={handleOverlayPointerDown}
              onPointerMove={handleOverlayPointerMove}
              onPointerUp={handleOverlayPointerUp}
              onPointerCancel={handleOverlayPointerUp}
              style={{ position: "absolute", inset: 0, cursor: "crosshair", touchAction: "none", zIndex: 1000 }}
            />
          )}
        </div>
      </Panel>

      {textPrompt && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}>
          <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, padding: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Text Label</span>
              <button onClick={() => setTextPrompt(null)} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
            </div>
            <TextInput autoFocus value={textPrompt.value} onChange={e => setTextPrompt({ ...textPrompt, value: e.target.value })}
              placeholder="e.g. Staging Area, Command Post..." style={{ width: "100%" }}
              onKeyDown={e => { if (e.key === "Enter") confirmTextLabel(); if (e.key === "Escape") setTextPrompt(null); }} />
            <Btn kind="solid" onClick={confirmTextLabel} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>Place on Map</Btn>
          </div>
        </div>
      )}
    </div>
  );
}

function TabOrg({ org, setOrg }) {
  const setIc = (v) => setOrg({ ...org, ic: v });
  const setDeputyIc = (v) => setOrg({ ...org, deputyIc: v });
  const addCommandStaff = () => setOrg({ ...org, commandStaff: [...org.commandStaff, { id: uid(), title: "New Position", name: "" }] });
  const updateCommandStaff = (id, patch) => setOrg({ ...org, commandStaff: org.commandStaff.map(c => c.id === id ? { ...c, ...patch } : c) });
  const removeCommandStaff = (id) => setOrg({ ...org, commandStaff: org.commandStaff.filter(c => c.id !== id) });

  const updateSection = (nodeId, patch) => setOrg({ ...org, sections: updateOrgNode(org.sections, nodeId, patch) });
  const deleteSection = (nodeId) => {
    // The four Section Chief boxes are the permanent top level — only
    // nodes added underneath them (Branches/Divisions/Groups/etc.) can
    // actually be removed.
    if (org.sections.some(s => s.id === nodeId)) return;
    setOrg({ ...org, sections: deleteOrgNode(org.sections, nodeId) });
  };
  const addSectionChild = (parentId) => setOrg({ ...org, sections: addOrgChild(org.sections, parentId, { id: uid(), title: "Division/Group", name: "", children: [] }) });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Organization Chart" icon={Shield}>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 18, lineHeight: 1.5 }}>
          Type a name into any box to fill that position. Use "+ Add Below" on a Section Chief (or any box beneath one) to expand into Branches, Divisions, or Groups — add as many levels as the incident needs.
        </div>
        <div style={{ overflowX: "auto", paddingBottom: 8 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", minWidth: "fit-content", margin: "0 auto" }}>
            {/* Incident Commander (+ optional Deputy) at the top */}
            <div style={{ display: "flex", gap: 10 }}>
              <OrgBox title="Incident Commander" name={org.ic} onNameChange={setIc} isRoot />
              <OrgBox title="Deputy IC" name={org.deputyIc} onNameChange={setDeputyIc} isRoot />
            </div>

            <div style={{ width: 2, height: 16, background: COLORS.line }} />
            <div style={{ display: "flex", gap: 40, borderTop: `2px solid ${COLORS.line}`, paddingTop: 16, flexWrap: "wrap", justifyContent: "center" }}>
              {/* Command Staff cluster */}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "center" }}>
                  {org.commandStaff.map(cs => (
                    <OrgBox key={cs.id} title={cs.title} name={cs.name} titleEditable
                      onTitleChange={v => updateCommandStaff(cs.id, { title: v })}
                      onNameChange={v => updateCommandStaff(cs.id, { name: v })}
                      onDelete={() => removeCommandStaff(cs.id)} />
                  ))}
                </div>
                <button onClick={addCommandStaff} style={{ marginTop: 8, background: "none", border: `1px dashed ${COLORS.line}`, borderRadius: 4, color: COLORS.muted, cursor: "pointer", fontSize: 10.5, padding: "4px 10px" }}>
                  + Add Command Staff
                </button>
              </div>
              {/* Section Chiefs, each independently expandable */}
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap", justifyContent: "center" }}>
                {org.sections.map(section => (
                  <OrgTree key={section.id} node={section} onUpdate={updateSection} onDelete={deleteSection} onAddChild={addSectionChild} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: COMMUNICATIONS PLAN (ICS-205)
   ============================================================ */
function TabComms({ comms, setComms, incident }) {
  const addRow = () => setComms({ ...comms, rows: [...comms.rows, { id: uid(), zoneGroup: "", chNum: "", func: "Command", channelName: "", assignment: "", rxFreq: "", rxTone: "", txFreq: "", txTone: "", mode: "D", remarks: "" }] });
  const update = (id, patch) => setComms({ ...comms, rows: comms.rows.map(c => c.id === id ? { ...c, ...patch } : c) });
  const remove = (id) => setComms({ ...comms, rows: comms.rows.filter(c => c.id !== id) });
  const set = (patch) => setComms({ ...comms, ...patch });
  const cell = { padding: "6px 6px", fontSize: 12.5 };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-205 · Incident Radio Communications Plan" icon={Radio}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
          <Field label="Date / Time Prepared"><TextInput type="datetime-local" value={comms.dateTimePrepared} onChange={e => set({ dateTimePrepared: e.target.value })} /></Field>
          <Field label="Operational Period From"><TextInput type="datetime-local" value={comms.opFrom} onChange={e => set({ opFrom: e.target.value })} /></Field>
          <Field label="Operational Period To"><TextInput type="datetime-local" value={comms.opTo} onChange={e => set({ opTo: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="4. Basic Radio Channel Use" icon={Radio} right={<Btn kind="subtle" icon={Plus} onClick={addRow}>Add Channel</Btn>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'IBM Plex Sans', sans-serif" }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5, letterSpacing: "0.05em" }}>
                <th style={cell}>Zone/Grp</th><th style={cell}>Ch#</th><th style={cell}>Function</th><th style={cell}>Channel Name / Talkgroup</th>
                <th style={cell}>Assignment</th><th style={cell}>RX Freq (N/W)</th><th style={cell}>RX Tone/NAC</th>
                <th style={cell}>TX Freq (N/W)</th><th style={cell}>TX Tone/NAC</th><th style={cell}>Mode</th><th style={cell}>Remarks</th><th style={cell}></th>
              </tr>
            </thead>
            <tbody>
              {comms.rows.map(c => (
                <tr key={c.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}><TextInput value={c.zoneGroup} onChange={e => update(c.id, { zoneGroup: e.target.value })} style={{ width: 65 }} /></td>
                  <td style={cell}><TextInput value={c.chNum} onChange={e => update(c.id, { chNum: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}>
                    <Select value={c.func} onChange={e => update(c.id, { func: e.target.value })} style={{ width: 110 }}>
                      {["Command", "Tactical", "Ground-to-Air", "Air-to-Air", "Support", "Dispatch"].map(f => <option key={f}>{f}</option>)}
                    </Select>
                  </td>
                  <td style={cell}><TextInput value={c.channelName} onChange={e => update(c.id, { channelName: e.target.value })} style={{ width: 130 }} placeholder="TAC-3 / Talkgroup" /></td>
                  <td style={cell}><TextInput value={c.assignment} onChange={e => update(c.id, { assignment: e.target.value })} style={{ width: 100 }} /></td>
                  <td style={cell}><TextInput value={c.rxFreq} onChange={e => update(c.id, { rxFreq: e.target.value })} style={{ width: 85 }} placeholder="xxx.xxxx N/W" /></td>
                  <td style={cell}><TextInput value={c.rxTone} onChange={e => update(c.id, { rxTone: e.target.value })} style={{ width: 75 }} /></td>
                  <td style={cell}><TextInput value={c.txFreq} onChange={e => update(c.id, { txFreq: e.target.value })} style={{ width: 85 }} placeholder="xxx.xxxx N/W" /></td>
                  <td style={cell}><TextInput value={c.txTone} onChange={e => update(c.id, { txTone: e.target.value })} style={{ width: 75 }} /></td>
                  <td style={cell}>
                    <Select value={c.mode} onChange={e => update(c.id, { mode: e.target.value })} style={{ width: 70 }}>
                      <option value="A">A</option><option value="D">D</option><option value="M">M</option>
                    </Select>
                  </td>
                  <td style={cell}><TextInput value={c.remarks} onChange={e => update(c.id, { remarks: e.target.value })} style={{ width: 130 }} /></td>
                  <td style={cell}><button onClick={() => remove(c.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          {comms.rows.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>No channels assigned yet.</div>}
        </div>
      </Panel>

      <Panel title="5. Special Instructions & 6. Prepared By" icon={Radio}>
        <Field label="Special Instructions" wide>
          <TextArea value={comms.specialInstructions} onChange={e => set({ specialInstructions: e.target.value })} style={{ minHeight: 60 }}
            placeholder="Cross-band repeaters, secure voice, encoders, PL tones, incident-within-an-incident handling..." />
        </Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 12 }}>
          <Field label="Prepared By (Communications Unit Leader)"><TextInput value={comms.preparedBy} onChange={e => set({ preparedBy: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={comms.signature} onChange={e => set({ signature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Date / Time"><TextInput type="datetime-local" value={comms.dateTime} onChange={e => set({ dateTime: e.target.value })} /></Field>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: REHAB TRACKING
   ============================================================ */
function TabRehab({ rehab, setRehab, resources, now }) {
  const addEntry = () => setRehab([{ id: uid(), name: "", unit: "", timeIn: nowISO(), bp: "", pulse: "", rr: "", spo2: "", temp: "", status: "In Rehab", timeCleared: "", notes: "" }, ...rehab]);
  const update = (id, patch) => setRehab(rehab.map(r => r.id === id ? { ...r, ...patch } : r));
  const remove = (id) => setRehab(rehab.filter(r => r.id !== id));
  const clear = (id) => update(id, { status: "Cleared", timeCleared: nowISO() });

  return (
    <Panel title="Rehab / Medical Monitoring" icon={HeartPulse} right={<Btn kind="subtle" icon={Plus} onClick={addEntry}>Add Entry</Btn>}>
      {rehab.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint }}>No personnel currently logged in rehab.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {rehab.map(r => (
          <div key={r.id} style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderLeft: `3px solid ${r.status === "Cleared" ? COLORS.teal : r.status === "Transported" ? COLORS.red : COLORS.amber}`, borderRadius: 5, padding: 10 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr 0.8fr 0.8fr 0.8fr 0.8fr 0.8fr 1fr auto", gap: 8, alignItems: "end" }}>
              <Field label="Name"><TextInput value={r.name} onChange={e => update(r.id, { name: e.target.value })} /></Field>
              <Field label="Unit"><TextInput value={r.unit} onChange={e => update(r.id, { unit: e.target.value })} /></Field>
              <Field label="BP"><TextInput value={r.bp} onChange={e => update(r.id, { bp: e.target.value })} placeholder="120/80" /></Field>
              <Field label="Pulse"><TextInput value={r.pulse} onChange={e => update(r.id, { pulse: e.target.value })} /></Field>
              <Field label="Resp"><TextInput value={r.rr} onChange={e => update(r.id, { rr: e.target.value })} /></Field>
              <Field label="SpO2"><TextInput value={r.spo2} onChange={e => update(r.id, { spo2: e.target.value })} /></Field>
              <Field label="Temp"><TextInput value={r.temp} onChange={e => update(r.id, { temp: e.target.value })} /></Field>
              <Field label="Status">
                <Select value={r.status} onChange={e => update(r.id, { status: e.target.value })}>
                  {["In Rehab", "Cleared", "Transported"].map(s => <option key={s}>{s}</option>)}
                </Select>
              </Field>
              <button onClick={() => remove(r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer", height: 36 }}><Trash2 size={14} /></button>
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 11, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace" }}>In: {fmtTime(r.timeIn)} · {elapsed(r.timeIn, r.timeCleared ? new Date(r.timeCleared).getTime() : now)} elapsed</span>
              {r.timeCleared && <span style={{ fontSize: 11, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace" }}>Cleared: {fmtTime(r.timeCleared)}</span>}
              {r.status === "In Rehab" && <Btn kind="subtle" icon={CheckCircle2} onClick={() => clear(r.id)} style={{ padding: "4px 9px", fontSize: 11.5 }}>Clear</Btn>}
              <TextInput value={r.notes} onChange={e => update(r.id, { notes: e.target.value })} placeholder="Notes" style={{ flex: 1, minWidth: 160 }} />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ============================================================
   TAB: ICS-214 ACTIVITY LOG
   ============================================================ */
/* ============================================================
   TAB: ICS-208 · SAFETY MESSAGE/PLAN
   ============================================================ */
function Tab208({ ics208, setIcs208, incident }) {
  const set = (patch) => setIcs208({ ...ics208, ...patch });
  return (
    <Panel title="ICS-208 · Safety Message / Plan" icon={AlertTriangle}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
        <Field label="Date / Time Prepared"><TextInput type="datetime-local" value={ics208.dateTime} onChange={e => set({ dateTime: e.target.value })} /></Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
        <Field label="Operational Period From"><TextInput type="datetime-local" value={ics208.opFrom} onChange={e => set({ opFrom: e.target.value })} /></Field>
        <Field label="Operational Period To"><TextInput type="datetime-local" value={ics208.opTo} onChange={e => set({ opTo: e.target.value })} /></Field>
      </div>
      <div style={{ marginTop: 14 }}>
        <Field label="3. Safety Message/Expanded Safety Message, Safety Plan, Site Safety Plan" wide>
          <TextArea value={ics208.message} onChange={e => set({ message: e.target.value })} style={{ minHeight: 140 }}
            placeholder="Clear, concise statements for safety message(s), priorities, and key command emphasis/decisions/directions. Known safety hazards and specific precautions for this operational period..." />
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 12, marginTop: 14, alignItems: "end" }}>
        <Field label="4. Site Safety Plan Required?">
          <Select value={ics208.siteSafetyPlanRequired} onChange={e => set({ siteSafetyPlanRequired: e.target.value })}>
            <option>Yes</option><option>No</option>
          </Select>
        </Field>
        <Field label="Approved Site Safety Plan(s) Located At"><TextInput value={ics208.siteSafetyPlanLocation} onChange={e => set({ siteSafetyPlanLocation: e.target.value })} /></Field>
      </div>
      <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "18px 0 8px" }}>5. Prepared By</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
        <Field label="Name"><TextInput value={ics208.preparedBy} onChange={e => set({ preparedBy: e.target.value })} /></Field>
        <Field label="Position / Title"><TextInput value={ics208.position} onChange={e => set({ position: e.target.value })} placeholder="Safety Officer" /></Field>
        <Field label="Signature"><TextInput value={ics208.signature} onChange={e => set({ signature: e.target.value })} placeholder="Type name to sign" /></Field>
        <Field label="Date / Time"><TextInput type="datetime-local" value={ics208.dateTime} onChange={e => set({ dateTime: e.target.value })} /></Field>
      </div>
    </Panel>
  );
}

/* ============================================================
   TAB: ICS-208 HM · SITE SAFETY PLAN (HAZMAT)
   ============================================================ */
function Tab208HM({ ics208hm, setIcs208hm, incident }) {
  const set = (patch) => setIcs208hm({ ...ics208hm, ...patch });
  const cell = { padding: "6px 6px", fontSize: 12.5 };
  const checkRow = { display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 };
  const chk = (label, key) => (
    <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <input type="checkbox" checked={ics208hm[key]} onChange={e => set({ [key]: e.target.checked })} style={{ width: 16, height: 16 }} />
      {label}
    </label>
  );

  const updateTeam = (teamKey, id, patch) => set({ [teamKey]: ics208hm[teamKey].map(m => m.id === id ? { ...m, ...patch } : m) });

  const addMaterial = () => set({ materials: [...ics208hm.materials, { id: uid(), material: "", containerType: "", qty: "", physState: "", ph: "", idlh: "", fp: "", it: "", vp: "", vd: "", sg: "", lel: "", uel: "" }] });
  const updateMaterial = (id, patch) => set({ materials: ics208hm.materials.map(m => m.id === id ? { ...m, ...patch } : m) });
  const removeMaterial = (id) => set({ materials: ics208hm.materials.filter(m => m.id !== id) });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-208 HM · Site Safety and Control Plan" icon={AlertTriangle}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
          <Field label="Date Prepared"><TextInput type="datetime-local" value={ics208hm.dateTime} onChange={e => set({ dateTime: e.target.value })} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <Field label="Op. Period From"><TextInput type="datetime-local" value={ics208hm.opFrom} onChange={e => set({ opFrom: e.target.value })} /></Field>
            <Field label="Op. Period To"><TextInput type="datetime-local" value={ics208hm.opTo} onChange={e => set({ opTo: e.target.value })} /></Field>
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <Field label="Section I — Incident Location" wide><TextInput value={ics208hm.incidentLocation} onChange={e => set({ incidentLocation: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="Section II · Organization" icon={Users}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Incident Commander"><TextInput value={ics208hm.orgIC} onChange={e => set({ orgIC: e.target.value })} /></Field>
          <Field label="HM Group Supervisor"><TextInput value={ics208hm.orgHMGroupSupervisor} onChange={e => set({ orgHMGroupSupervisor: e.target.value })} /></Field>
          <Field label="Tech. Specialist – HM Reference"><TextInput value={ics208hm.orgTechSpecialist} onChange={e => set({ orgTechSpecialist: e.target.value })} /></Field>
          <Field label="Safety Officer"><TextInput value={ics208hm.orgSafetyOfficer} onChange={e => set({ orgSafetyOfficer: e.target.value })} /></Field>
          <Field label="Entry Leader"><TextInput value={ics208hm.orgEntryLeader} onChange={e => set({ orgEntryLeader: e.target.value })} /></Field>
          <Field label="Site Access Control Leader"><TextInput value={ics208hm.orgSiteAccessControlLeader} onChange={e => set({ orgSiteAccessControlLeader: e.target.value })} /></Field>
          <Field label="Asst. Safety Officer – HM"><TextInput value={ics208hm.orgAsstSafetyOfficerHM} onChange={e => set({ orgAsstSafetyOfficerHM: e.target.value })} /></Field>
          <Field label="Decontamination Leader"><TextInput value={ics208hm.orgDeconLeader} onChange={e => set({ orgDeconLeader: e.target.value })} /></Field>
          <Field label="Safe Refuge Area Mgr"><TextInput value={ics208hm.orgSafeRefugeAreaMgr} onChange={e => set({ orgSafeRefugeAreaMgr: e.target.value })} /></Field>
          <Field label="Environmental Health"><TextInput value={ics208hm.orgEnvironmentalHealth} onChange={e => set({ orgEnvironmentalHealth: e.target.value })} /></Field>
          <Field label="Other"><TextInput value={ics208hm.orgOther1} onChange={e => set({ orgOther1: e.target.value })} /></Field>
          <Field label="Other"><TextInput value={ics208hm.orgOther2} onChange={e => set({ orgOther2: e.target.value })} /></Field>
        </div>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Entry Team (Buddy System)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          {ics208hm.entryTeam.map(m => (
            <div key={m.id}>
              <Field label={m.label}><TextInput value={m.name} onChange={e => updateTeam("entryTeam", m.id, { name: e.target.value })} placeholder="Name" /></Field>
              <TextInput value={m.ppeLevel} onChange={e => updateTeam("entryTeam", m.id, { ppeLevel: e.target.value })} placeholder="PPE Level" style={{ marginTop: 6 }} />
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Decontamination Element</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 10 }}>
          {ics208hm.deconTeam.map(m => (
            <div key={m.id}>
              <Field label={m.label}><TextInput value={m.name} onChange={e => updateTeam("deconTeam", m.id, { name: e.target.value })} placeholder="Name" /></Field>
              <TextInput value={m.ppeLevel} onChange={e => updateTeam("deconTeam", m.id, { ppeLevel: e.target.value })} placeholder="PPE Level" style={{ marginTop: 6 }} />
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Section III · Hazard/Risk Analysis" icon={AlertTriangle} right={<Btn kind="subtle" icon={Plus} onClick={addMaterial}>Add Material</Btn>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10 }}>
              <th style={cell}>Material</th><th style={cell}>Container</th><th style={cell}>Qty</th><th style={cell}>Phys. State</th>
              <th style={cell}>pH</th><th style={cell}>IDLH</th><th style={cell}>F.P.</th><th style={cell}>I.T.</th>
              <th style={cell}>V.P.</th><th style={cell}>V.D.</th><th style={cell}>S.G.</th><th style={cell}>LEL</th><th style={cell}>UEL</th><th style={cell}></th>
            </tr></thead>
            <tbody>
              {ics208hm.materials.map(m => (
                <tr key={m.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}><TextInput value={m.material} onChange={e => updateMaterial(m.id, { material: e.target.value })} style={{ width: 110 }} placeholder="UNK if unknown" /></td>
                  <td style={cell}><TextInput value={m.containerType} onChange={e => updateMaterial(m.id, { containerType: e.target.value })} style={{ width: 90 }} /></td>
                  <td style={cell}><TextInput value={m.qty} onChange={e => updateMaterial(m.id, { qty: e.target.value })} style={{ width: 60 }} /></td>
                  <td style={cell}><TextInput value={m.physState} onChange={e => updateMaterial(m.id, { physState: e.target.value })} style={{ width: 70 }} /></td>
                  <td style={cell}><TextInput value={m.ph} onChange={e => updateMaterial(m.id, { ph: e.target.value })} style={{ width: 45 }} /></td>
                  <td style={cell}><TextInput value={m.idlh} onChange={e => updateMaterial(m.id, { idlh: e.target.value })} style={{ width: 60 }} /></td>
                  <td style={cell}><TextInput value={m.fp} onChange={e => updateMaterial(m.id, { fp: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.it} onChange={e => updateMaterial(m.id, { it: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.vp} onChange={e => updateMaterial(m.id, { vp: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.vd} onChange={e => updateMaterial(m.id, { vd: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.sg} onChange={e => updateMaterial(m.id, { sg: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.lel} onChange={e => updateMaterial(m.id, { lel: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><TextInput value={m.uel} onChange={e => updateMaterial(m.id, { uel: e.target.value })} style={{ width: 50 }} /></td>
                  <td style={cell}><button onClick={() => removeMaterial(m.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ics208hm.materials.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
        <Field label="Comment" wide><TextInput value={ics208hm.materialsComment} onChange={e => set({ materialsComment: e.target.value })} style={{ marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section IV · Hazard Monitoring" icon={AlertTriangle}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="LEL Instrument(s)"><TextInput value={ics208hm.lelInstruments} onChange={e => set({ lelInstruments: e.target.value })} /></Field>
          <Field label="O2 Instrument(s)"><TextInput value={ics208hm.o2Instruments} onChange={e => set({ o2Instruments: e.target.value })} /></Field>
          <Field label="Toxicity/PPM Instrument(s)"><TextInput value={ics208hm.toxicityInstruments} onChange={e => set({ toxicityInstruments: e.target.value })} /></Field>
          <Field label="Radiological Instrument(s)"><TextInput value={ics208hm.radiologicalInstruments} onChange={e => set({ radiologicalInstruments: e.target.value })} /></Field>
        </div>
        <Field label="Comment" wide><TextInput value={ics208hm.monitoringComment} onChange={e => set({ monitoringComment: e.target.value })} style={{ marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section V · Decontamination Procedures" icon={AlertTriangle}>
        <Field label="Standard Decontamination Procedures?">
          <Select value={ics208hm.standardDecon} onChange={e => set({ standardDecon: e.target.value })} style={{ width: 140 }}>
            <option>Yes</option><option>No</option>
          </Select>
        </Field>
        <Field label="Comment" wide><TextInput value={ics208hm.deconComment} onChange={e => set({ deconComment: e.target.value })} style={{ marginTop: 10 }} placeholder="If No, note modifications and solutions used" /></Field>
      </Panel>

      <Panel title="Section VI · Site Communications" icon={Radio}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Command Frequency"><TextInput value={ics208hm.commandFreq} onChange={e => set({ commandFreq: e.target.value })} /></Field>
          <Field label="Tactical Frequency"><TextInput value={ics208hm.tacticalFreq} onChange={e => set({ tacticalFreq: e.target.value })} /></Field>
          <Field label="Entry Frequency"><TextInput value={ics208hm.entryFreq} onChange={e => set({ entryFreq: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="Section VII · Medical Assistance" icon={HeartPulse}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Medical Monitoring?">
            <Select value={ics208hm.medicalMonitoring} onChange={e => set({ medicalMonitoring: e.target.value })}>
              <option>Yes</option><option>No</option>
            </Select>
          </Field>
          <Field label="Medical Treatment and Transport In-Place?">
            <Select value={ics208hm.medicalTreatmentInPlace} onChange={e => set({ medicalTreatmentInPlace: e.target.value })}>
              <option>Yes</option><option>No</option>
            </Select>
          </Field>
        </div>
        <Field label="Comment" wide><TextInput value={ics208hm.medicalComment} onChange={e => set({ medicalComment: e.target.value })} style={{ marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section VIII · Site Map" icon={ClipboardList}>
        <div style={checkRow}>
          {chk("Weather", "siteMapWeather")}
          {chk("Command Post", "siteMapCommandPost")}
          {chk("Zones", "siteMapZones")}
          {chk("Assembly Areas", "siteMapAssemblyAreas")}
          {chk("Escape Routes", "siteMapEscapeRoutes")}
          {chk("Other", "siteMapOther")}
        </div>
        <Field label="Site Map Notes (sketch or attach separately)" wide><TextArea value={ics208hm.siteMapNotes} onChange={e => set({ siteMapNotes: e.target.value })} style={{ minHeight: 60, marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section IX · Entry Objectives" icon={ClipboardList}>
        <Field label="Entry Objectives (and parameters that will alter or stop entry operations)" wide>
          <TextArea value={ics208hm.entryObjectives} onChange={e => set({ entryObjectives: e.target.value })} style={{ minHeight: 70 }} />
        </Field>
      </Panel>

      <Panel title="Section X · SOPs and Safe Work Practices" icon={ClipboardList}>
        <Field label="Modifications to Documented SOPs or Work Practices?">
          <Select value={ics208hm.sopModifications} onChange={e => set({ sopModifications: e.target.value })} style={{ width: 140 }}>
            <option>Yes</option><option>No</option>
          </Select>
        </Field>
        <Field label="Comment" wide><TextInput value={ics208hm.sopComment} onChange={e => set({ sopComment: e.target.value })} style={{ marginTop: 10 }} /></Field>
      </Panel>

      <Panel title="Section XI · Emergency Procedures" icon={AlertTriangle}>
        <Field label="Emergency Procedures" wide>
          <TextArea value={ics208hm.emergencyProcedures} onChange={e => set({ emergencyProcedures: e.target.value })} style={{ minHeight: 70 }} />
        </Field>
      </Panel>

      <Panel title="Section XII · Safety Briefing" icon={CheckCircle2}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Asst. Safety Officer – HM Signature"><TextInput value={ics208hm.asstSafetyOfficerSignature} onChange={e => set({ asstSafetyOfficerSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Safety Briefing Completed (Time)"><TextInput type="time" value={ics208hm.safetyBriefingTime} onChange={e => set({ safetyBriefingTime: e.target.value })} /></Field>
          <Field label="HM Group Supervisor Signature"><TextInput value={ics208hm.hmGroupSupervisorSignature} onChange={e => set({ hmGroupSupervisorSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Incident Commander Signature"><TextInput value={ics208hm.incidentCommanderSignature} onChange={e => set({ incidentCommanderSignature: e.target.value })} placeholder="Type name to sign" /></Field>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: ICS-209 · INCIDENT STATUS SUMMARY
   ============================================================ */
const THREAT_FLAG_OPTIONS = [
  ["noLikelyThreat", "No Likely Threat"], ["potentialFutureThreat", "Potential Future Threat"],
  ["massNotificationsInProgress", "Mass Notifications in Progress"], ["massNotificationsCompleted", "Mass Notifications Completed"],
  ["noEvacImminent", "No Evacuation(s) Imminent"], ["planningForEvac", "Planning for Evacuation"],
  ["planningForShelterInPlace", "Planning for Shelter-in-Place"], ["evacInProgress", "Evacuation(s) in Progress"],
  ["shelterInPlaceInProgress", "Shelter-in-Place in Progress"], ["repopulationInProgress", "Repopulation in Progress"],
  ["massImmunizationInProgress", "Mass Immunization in Progress"], ["massImmunizationComplete", "Mass Immunization Complete"],
  ["quarantineInProgress", "Quarantine in Progress"], ["areaRestrictionInEffect", "Area Restriction in Effect"],
];
const PUBLIC_STATUS_ROWS = [
  ["fatalities", "Fatalities"], ["injuries", "With Injuries/Illness"], ["trapped", "Trapped/In Need of Rescue"],
  ["missing", "Missing"], ["evacuated", "Evacuated"], ["shelterInPlace", "Sheltering in Place"],
  ["tempShelters", "In Temporary Shelters"], ["massImmunizations", "Have Received Mass Immunizations"],
  ["requireImmunizations", "Require Immunizations"], ["quarantine", "In Quarantine"],
];
const RESPONDER_STATUS_ROWS = [
  ["fatalities", "Fatalities"], ["injuries", "With Injuries/Illness"], ["trapped", "Trapped/In Need of Rescue"],
  ["missing", "Missing"], ["shelterInPlace", "Sheltering in Place"], ["receivedImmunizations", "Have Received Immunizations"],
  ["requireImmunizations", "Require Immunizations"], ["quarantine", "In Quarantine"],
];
const STRUCTURAL_ROWS = [
  ["singleResidences", "Single Residences"], ["nonresidential", "Nonresidential Commercial Property"],
  ["otherMinor", "Other Minor Structures"], ["other", "Other"],
];
const TIMEFRAME_KEYS = [["h12", "12 Hours"], ["h24", "24 Hours"], ["h48", "48 Hours"], ["h72", "72 Hours"], ["after72", "Anticipated After 72 Hours"]];

function Tab209({ ics209, setIcs209, incident }) {
  const set = (patch) => setIcs209({ ...ics209, ...patch });
  const setNested = (group, key, field, val) => setIcs209({ ...ics209, [group]: { ...ics209[group], [key]: { ...ics209[group][key], [field]: val } } });
  const setTimeframe = (group, key, val) => setIcs209({ ...ics209, [group]: { ...ics209[group], [key]: val } });
  const toggleFlag = (key) => setIcs209({ ...ics209, threatFlags: { ...ics209.threatFlags, [key]: !ics209.threatFlags[key] } });
  const cell = { padding: "5px 6px", fontSize: 12.5 };

  const addCommitment = () => set({ resourceCommitments: [...ics209.resourceCommitments, { id: uid(), agency: "", resources: "", additionalPersonnel: "", totalPersonnel: "", totalResources: "" }] });
  const updateCommitment = (id, patch) => set({ resourceCommitments: ics209.resourceCommitments.map(r => r.id === id ? { ...r, ...patch } : r) });
  const removeCommitment = (id) => set({ resourceCommitments: ics209.resourceCommitments.filter(r => r.id !== id) });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-209 · Incident Status Summary — Page 1" icon={ClipboardList}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
          <Field label="Incident Number"><TextInput value={incident.number} disabled style={{ opacity: 0.65 }} /></Field>
          <Field label="Report Version">
            <Select value={ics209.reportVersion} onChange={e => set({ reportVersion: e.target.value })}>
              <option>Initial</option><option>Update</option><option>Final</option>
            </Select>
          </Field>
          <Field label="Report # (if used)"><TextInput value={ics209.reportNumber} onChange={e => set({ reportNumber: e.target.value })} /></Field>
          <Field label="Incident Commander(s)"><TextInput value={incident.icName} disabled style={{ opacity: 0.65 }} /></Field>
          <Field label="Agency/Organization (optional)"><TextInput value={ics209.icAgencyOrg} onChange={e => set({ icAgencyOrg: e.target.value })} placeholder="KFD, or list for Unified Command" /></Field>
          <Field label="Incident Management Organization"><TextInput value={ics209.imTeam} onChange={e => set({ imTeam: e.target.value })} placeholder="Type 1/2/3 IMT, Unified Command..." /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 14 }}>
          <Field label="Incident Start Date"><TextInput type="date" value={incident.dateInitiated} disabled style={{ opacity: 0.65 }} /></Field>
          <Field label="Start Time"><TextInput type="time" value={incident.timeInitiated} disabled style={{ opacity: 0.65 }} /></Field>
          <Field label="Time Zone"><TextInput value="CST" disabled style={{ opacity: 0.65 }} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginTop: 14 }}>
          <Field label="Current Size/Area Involved"><TextInput value={ics209.sizeArea} onChange={e => set({ sizeArea: e.target.value })} placeholder="sq mi, acres..." /></Field>
          <Field label="% Contained/Completed"><TextInput value={ics209.percentContained} onChange={e => set({ percentContained: e.target.value })} /></Field>
          <Field label="Incident Definition"><TextInput value={ics209.definition} onChange={e => set({ definition: e.target.value })} placeholder="wildfire, structure fire..." /></Field>
          <Field label="Complexity Level"><TextInput value={ics209.complexityLevel} onChange={e => set({ complexityLevel: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 14 }}>
          <Field label="For Time Period From"><TextInput type="datetime-local" value={ics209.opFrom} onChange={e => set({ opFrom: e.target.value })} /></Field>
          <Field label="To"><TextInput type="datetime-local" value={ics209.opTo} onChange={e => set({ opTo: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="Approval & Routing Information" icon={CheckCircle2}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label="Prepared By — Print Name"><TextInput value={ics209.preparedByName} onChange={e => set({ preparedByName: e.target.value })} /></Field>
          <Field label="ICS Position"><TextInput value={ics209.preparedByPosition} onChange={e => set({ preparedByPosition: e.target.value })} /></Field>
          <Field label="Date/Time Prepared"><TextInput type="datetime-local" value={ics209.preparedDateTime} onChange={e => set({ preparedDateTime: e.target.value })} /></Field>
          <Field label="Date/Time Submitted"><TextInput type="datetime-local" value={ics209.submittedDateTime} onChange={e => set({ submittedDateTime: e.target.value })} /></Field>
          <Field label="Time Zone"><TextInput value={ics209.submittedTimeZone} onChange={e => set({ submittedTimeZone: e.target.value })} /></Field>
          <Field label="Primary Location/Org/Agency Sent To"><TextInput value={ics209.sentTo} onChange={e => set({ sentTo: e.target.value })} /></Field>
          <Field label="Approved By — Print Name"><TextInput value={ics209.approvedByName} onChange={e => set({ approvedByName: e.target.value })} /></Field>
          <Field label="ICS Position"><TextInput value={ics209.approvedByPosition} onChange={e => set({ approvedByPosition: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={ics209.approvedBySignature} onChange={e => set({ approvedBySignature: e.target.value })} placeholder="Type name to sign" /></Field>
        </div>
      </Panel>

      <Panel title="Incident Location Information" icon={ClipboardList}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
          <Field label="State"><TextInput value={ics209.state} onChange={e => set({ state: e.target.value })} /></Field>
          <Field label="County/Parish/Borough"><TextInput value={ics209.county} onChange={e => set({ county: e.target.value })} /></Field>
          <Field label="City"><TextInput value={ics209.city} onChange={e => set({ city: e.target.value })} /></Field>
          <Field label="Unit or Other"><TextInput value={ics209.unitOther} onChange={e => set({ unitOther: e.target.value })} /></Field>
          <Field label="Incident Jurisdiction"><TextInput value={ics209.jurisdiction} onChange={e => set({ jurisdiction: e.target.value })} /></Field>
          <Field label="Location Ownership (if different)"><TextInput value={ics209.ownership} onChange={e => set({ ownership: e.target.value })} /></Field>
          <Field label="Longitude"><TextInput value={ics209.longitude} onChange={e => set({ longitude: e.target.value })} /></Field>
          <Field label="Latitude"><TextInput value={ics209.latitude} onChange={e => set({ latitude: e.target.value })} /></Field>
          <Field label="US National Grid Reference"><TextInput value={ics209.usng} onChange={e => set({ usng: e.target.value })} /></Field>
          <Field label="Legal Description"><TextInput value={ics209.legalDescription} onChange={e => set({ legalDescription: e.target.value })} placeholder="Twp/Section/Range" /></Field>
          <Field label="UTM Coordinates"><TextInput value={ics209.utm} onChange={e => set({ utm: e.target.value })} /></Field>
        </div>
        <Field label="Short Location or Area Description" wide><TextInput value={ics209.shortLocation} onChange={e => set({ shortLocation: e.target.value })} style={{ marginTop: 12 }} /></Field>
        <Field label="Geospatial Data Note" wide><TextInput value={ics209.geospatialNote} onChange={e => set({ geospatialNote: e.target.value })} style={{ marginTop: 12 }} /></Field>
      </Panel>

      <Panel title="Incident Summary" icon={ClipboardList}>
        <Field label="Significant Events for the Time Period Reported" wide><TextArea value={ics209.significantEvents} onChange={e => set({ significantEvents: e.target.value })} style={{ minHeight: 70 }} /></Field>
        <Field label="Primary Materials or Hazards Involved" wide><TextInput value={ics209.primaryMaterials} onChange={e => set({ primaryMaterials: e.target.value })} style={{ marginTop: 12 }} /></Field>

        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Damage Assessment — Structural Summary</div>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Category</th><th style={cell}># Threatened (72hr)</th><th style={cell}># Damaged</th><th style={cell}># Destroyed</th>
          </tr></thead>
          <tbody>
            {STRUCTURAL_ROWS.map(([key, label]) => (
              <tr key={key} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}>{label}</td>
                <td style={cell}><TextInput value={ics209.structural[key].threatened} onChange={e => setNested("structural", key, "threatened", e.target.value)} style={{ width: 90 }} /></td>
                <td style={cell}><TextInput value={ics209.structural[key].damaged} onChange={e => setNested("structural", key, "damaged", e.target.value)} style={{ width: 90 }} /></td>
                <td style={cell}><TextInput value={ics209.structural[key].destroyed} onChange={e => setNested("structural", key, "destroyed", e.target.value)} style={{ width: 90 }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <Field label="Other Damage Notes" wide><TextInput value={ics209.damageOther} onChange={e => set({ damageOther: e.target.value })} style={{ marginTop: 12 }} /></Field>
      </Panel>

      <Panel title="Page 2 · Public Status Summary" icon={ClipboardList}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Category</th><th style={cell}># This Period</th><th style={cell}>Total # to Date</th>
          </tr></thead>
          <tbody>
            {PUBLIC_STATUS_ROWS.map(([key, label]) => (
              <tr key={key} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}>{label}</td>
                <td style={cell}><TextInput value={ics209.publicStatus[key].period} onChange={e => setNested("publicStatus", key, "period", e.target.value)} style={{ width: 90 }} /></td>
                <td style={cell}><TextInput value={ics209.publicStatus[key].total} onChange={e => setNested("publicStatus", key, "total", e.target.value)} style={{ width: 90 }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Responder Status Summary" icon={ClipboardList}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Category</th><th style={cell}># This Period</th><th style={cell}>Total # to Date</th>
          </tr></thead>
          <tbody>
            {RESPONDER_STATUS_ROWS.map(([key, label]) => (
              <tr key={key} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}>{label}</td>
                <td style={cell}><TextInput value={ics209.responderStatus[key].period} onChange={e => setNested("responderStatus", key, "period", e.target.value)} style={{ width: 90 }} /></td>
                <td style={cell}><TextInput value={ics209.responderStatus[key].total} onChange={e => setNested("responderStatus", key, "total", e.target.value)} style={{ width: 90 }} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>

      <Panel title="Life, Safety, and Health" icon={AlertTriangle}>
        <Field label="Status/Threat Remarks" wide><TextArea value={ics209.threatRemarks} onChange={e => set({ threatRemarks: e.target.value })} style={{ minHeight: 60 }} /></Field>
        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Threat Management (check if active)</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {THREAT_FLAG_OPTIONS.map(([key, label]) => (
            <label key={key} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={ics209.threatFlags[key]} onChange={() => toggleFlag(key)} style={{ width: 16, height: 16 }} />
              {label}
            </label>
          ))}
        </div>
        <Field label="Weather Concerns" wide><TextArea value={ics209.weatherConcerns} onChange={e => set({ weatherConcerns: e.target.value })} style={{ minHeight: 60, marginTop: 14 }} /></Field>
      </Panel>

      <Panel title="Projected Incident Activity / Movement / Escalation" icon={ClipboardList}>
        {TIMEFRAME_KEYS.map(([key, label]) => (
          <Field key={key} label={label} wide><TextInput value={ics209.projectedActivity[key]} onChange={e => setTimeframe("projectedActivity", key, e.target.value)} style={{ marginBottom: 8 }} /></Field>
        ))}
        <Field label="Strategic Objectives (planned end-state)" wide><TextArea value={ics209.strategicObjectives} onChange={e => set({ strategicObjectives: e.target.value })} style={{ minHeight: 60 }} /></Field>
      </Panel>

      <Panel title="Page 3 · Current Incident Threat Summary" icon={AlertTriangle}>
        {TIMEFRAME_KEYS.map(([key, label]) => (
          <Field key={key} label={label} wide><TextInput value={ics209.threatSummaryTimeframes[key]} onChange={e => setTimeframe("threatSummaryTimeframes", key, e.target.value)} style={{ marginBottom: 8 }} /></Field>
        ))}
      </Panel>

      <Panel title="Critical Resource Needs" icon={Truck}>
        {TIMEFRAME_KEYS.map(([key, label]) => (
          <Field key={key} label={label} wide><TextInput value={ics209.resourceNeeds[key]} onChange={e => setTimeframe("resourceNeeds", key, e.target.value)} style={{ marginBottom: 8 }} /></Field>
        ))}
      </Panel>

      <Panel title="Strategic Discussion & Planning" icon={ClipboardList}>
        <Field label="Strategic Discussion" wide><TextArea value={ics209.strategicDiscussion} onChange={e => set({ strategicDiscussion: e.target.value })} style={{ minHeight: 70 }} /></Field>
        <Field label="Planned Actions for Next Operational Period" wide><TextArea value={ics209.plannedActions} onChange={e => set({ plannedActions: e.target.value })} style={{ minHeight: 60, marginTop: 12 }} /></Field>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <Field label="Projected Final Incident Size/Area"><TextInput value={ics209.projectedFinalSize} onChange={e => set({ projectedFinalSize: e.target.value })} /></Field>
          <Field label="Anticipated Management Completion Date"><TextInput type="date" value={ics209.completionDate} onChange={e => set({ completionDate: e.target.value })} /></Field>
          <Field label="Projected Demob Start Date"><TextInput type="date" value={ics209.demobStartDate} onChange={e => set({ demobStartDate: e.target.value })} /></Field>
          <Field label="Estimated Incident Costs to Date"><TextInput value={ics209.costsToDate} onChange={e => set({ costsToDate: e.target.value })} /></Field>
          <Field label="Projected Final Incident Cost Estimate"><TextInput value={ics209.finalCostEstimate} onChange={e => set({ finalCostEstimate: e.target.value })} /></Field>
        </div>
        <Field label="Remarks" wide><TextArea value={ics209.remarks} onChange={e => set({ remarks: e.target.value })} style={{ minHeight: 60, marginTop: 12 }} /></Field>
      </Panel>

      <Panel title="Page 4 · Incident Resource Commitment Summary" icon={Truck} right={<Btn kind="subtle" icon={Plus} onClick={addCommitment}>Add Row</Btn>}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Agency/Organization</th><th style={cell}>Resources (category/kind/type)</th>
            <th style={cell}>Additional Personnel</th><th style={cell}>Total Personnel</th><th style={cell}>Total Resources</th><th style={cell}></th>
          </tr></thead>
          <tbody>
            {ics209.resourceCommitments.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={r.agency} onChange={e => updateCommitment(r.id, { agency: e.target.value })} style={{ width: 140 }} /></td>
                <td style={cell}><TextInput value={r.resources} onChange={e => updateCommitment(r.id, { resources: e.target.value })} style={{ width: 200 }} placeholder="e.g. Type 1 Engines 3/12" /></td>
                <td style={cell}><TextInput value={r.additionalPersonnel} onChange={e => updateCommitment(r.id, { additionalPersonnel: e.target.value })} style={{ width: 90 }} /></td>
                <td style={cell}><TextInput value={r.totalPersonnel} onChange={e => updateCommitment(r.id, { totalPersonnel: e.target.value })} style={{ width: 90 }} /></td>
                <td style={cell}><TextInput value={r.totalResources} onChange={e => updateCommitment(r.id, { totalResources: e.target.value })} style={{ width: 90 }} /></td>
                <td style={cell}><button onClick={() => removeCommitment(r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {ics209.resourceCommitments.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
        <Field label="Additional Cooperating and Assisting Organizations Not Listed Above" wide><TextArea value={ics209.cooperatingOrgs} onChange={e => set({ cooperatingOrgs: e.target.value })} style={{ minHeight: 50, marginTop: 12 }} /></Field>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: ICS-206 · MEDICAL PLAN
   ============================================================ */
function Tab206({ ics206, setIcs206, incident }) {
  const cell = { padding: "6px 6px", fontSize: 12.5 };
  const addRow = (key, row) => setIcs206({ ...ics206, [key]: [...ics206[key], row] });
  const updateRow = (key, id, patch) => setIcs206({ ...ics206, [key]: ics206[key].map(r => r.id === id ? { ...r, ...patch } : r) });
  const removeRow = (key, id) => setIcs206({ ...ics206, [key]: ics206[key].filter(r => r.id !== id) });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-206 · Medical Plan" icon={HeartPulse}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Operational Period From"><TextInput type="datetime-local" value={ics206.opFrom} onChange={e => setIcs206({ ...ics206, opFrom: e.target.value })} /></Field>
            <Field label="Operational Period To"><TextInput type="datetime-local" value={ics206.opTo} onChange={e => setIcs206({ ...ics206, opTo: e.target.value })} /></Field>
          </div>
        </div>
      </Panel>

      <Panel title="3. Medical Aid Stations" icon={HeartPulse}
        right={<Btn kind="subtle" icon={Plus} onClick={() => addRow("aidStations", { id: uid(), name: "", location: "", contact: "", paramedic: "No" })}>Add Station</Btn>}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Name</th><th style={cell}>Location</th><th style={cell}>Contact Number(s)/Frequency</th><th style={cell}>Paramedics On Site?</th><th style={cell}></th>
          </tr></thead>
          <tbody>
            {ics206.aidStations.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={r.name} onChange={e => updateRow("aidStations", r.id, { name: e.target.value })} style={{ width: 130 }} /></td>
                <td style={cell}><TextInput value={r.location} onChange={e => updateRow("aidStations", r.id, { location: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}><TextInput value={r.contact} onChange={e => updateRow("aidStations", r.id, { contact: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}>
                  <Select value={r.paramedic} onChange={e => updateRow("aidStations", r.id, { paramedic: e.target.value })} style={{ width: 90 }}>
                    <option>Yes</option><option>No</option>
                  </Select>
                </td>
                <td style={cell}><button onClick={() => removeRow("aidStations", r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {ics206.aidStations.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>

      <Panel title="4. Transportation (Ambulance Services)" icon={Truck}
        right={<Btn kind="subtle" icon={Plus} onClick={() => addRow("ambulances", { id: uid(), name: "", location: "", contact: "", level: "ALS" })}>Add Service</Btn>}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Ambulance Service</th><th style={cell}>Location</th><th style={cell}>Contact Number(s)/Frequency</th><th style={cell}>Level of Service</th><th style={cell}></th>
          </tr></thead>
          <tbody>
            {ics206.ambulances.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={r.name} onChange={e => updateRow("ambulances", r.id, { name: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}><TextInput value={r.location} onChange={e => updateRow("ambulances", r.id, { location: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}><TextInput value={r.contact} onChange={e => updateRow("ambulances", r.id, { contact: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}>
                  <Select value={r.level} onChange={e => updateRow("ambulances", r.id, { level: e.target.value })} style={{ width: 90 }}>
                    <option>ALS</option><option>BLS</option>
                  </Select>
                </td>
                <td style={cell}><button onClick={() => removeRow("ambulances", r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {ics206.ambulances.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>

      <Panel title="5. Hospitals" icon={Shield}
        right={<Btn kind="subtle" icon={Plus} onClick={() => addRow("hospitals", { id: uid(), name: "", address: "", contact: "", travelAir: "", travelGround: "", trauma: "No", traumaLevel: "", burn: "No", helipad: "No" })}>Add Hospital</Btn>}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
              <th style={cell}>Hospital Name</th><th style={cell}>Address / Lat-Long if Helipad</th><th style={cell}>Contact</th>
              <th style={cell}>Travel (Air)</th><th style={cell}>Travel (Ground)</th><th style={cell}>Trauma Ctr</th><th style={cell}>Burn Ctr</th><th style={cell}>Helipad</th><th style={cell}></th>
            </tr></thead>
            <tbody>
              {ics206.hospitals.map(r => (
                <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                  <td style={cell}><TextInput value={r.name} onChange={e => updateRow("hospitals", r.id, { name: e.target.value })} style={{ width: 130 }} /></td>
                  <td style={cell}><TextInput value={r.address} onChange={e => updateRow("hospitals", r.id, { address: e.target.value })} style={{ width: 160 }} /></td>
                  <td style={cell}><TextInput value={r.contact} onChange={e => updateRow("hospitals", r.id, { contact: e.target.value })} style={{ width: 110 }} /></td>
                  <td style={cell}><TextInput value={r.travelAir} onChange={e => updateRow("hospitals", r.id, { travelAir: e.target.value })} style={{ width: 80 }} placeholder="12 min" /></td>
                  <td style={cell}><TextInput value={r.travelGround} onChange={e => updateRow("hospitals", r.id, { travelGround: e.target.value })} style={{ width: 80 }} placeholder="20 min" /></td>
                  <td style={cell}>
                    <div style={{ display: "flex", gap: 4 }}>
                      <Select value={r.trauma} onChange={e => updateRow("hospitals", r.id, { trauma: e.target.value })} style={{ width: 65 }}>
                        <option>Yes</option><option>No</option>
                      </Select>
                      {r.trauma === "Yes" && <TextInput value={r.traumaLevel} onChange={e => updateRow("hospitals", r.id, { traumaLevel: e.target.value })} style={{ width: 55 }} placeholder="Lvl" />}
                    </div>
                  </td>
                  <td style={cell}>
                    <Select value={r.burn} onChange={e => updateRow("hospitals", r.id, { burn: e.target.value })} style={{ width: 75 }}>
                      <option>Yes</option><option>No</option>
                    </Select>
                  </td>
                  <td style={cell}>
                    <Select value={r.helipad} onChange={e => updateRow("hospitals", r.id, { helipad: e.target.value })} style={{ width: 75 }}>
                      <option>Yes</option><option>No</option>
                    </Select>
                  </td>
                  <td style={cell}><button onClick={() => removeRow("hospitals", r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ics206.hospitals.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>

      <Panel title="6. Special Medical Emergency Procedures" icon={HeartPulse}>
        <Field label="Special Medical Emergency Procedures" wide>
          <TextArea value={ics206.procedures} onChange={e => setIcs206({ ...ics206, procedures: e.target.value })} style={{ minHeight: 70 }}
            placeholder="Who to contact, how to contact them, who manages an incident-within-an-incident (rescue, accident, etc.)..." />
        </Field>
        <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, fontSize: 13 }}>
          <input type="checkbox" checked={ics206.aviationAssets} onChange={e => setIcs206({ ...ics206, aviationAssets: e.target.checked })} style={{ width: 18, height: 18 }} />
          Check if aviation assets are utilized for rescue (coordinate with Air Operations)
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 16 }}>
          <Field label="7. Prepared By (Medical Unit Leader)"><TextInput value={ics206.preparedBy} onChange={e => setIcs206({ ...ics206, preparedBy: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={ics206.preparedSignature} onChange={e => setIcs206({ ...ics206, preparedSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Date / Time"><TextInput type="datetime-local" value={ics206.dateTime} onChange={e => setIcs206({ ...ics206, dateTime: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginTop: 12 }}>
          <Field label="8. Approved By (Safety Officer)"><TextInput value={ics206.approvedBy} onChange={e => setIcs206({ ...ics206, approvedBy: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={ics206.approvedSignature} onChange={e => setIcs206({ ...ics206, approvedSignature: e.target.value })} placeholder="Type name to sign" /></Field>
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: ICS FORMS — dropdown selector wrapping 205 / 215A / 208 /
   208 HM / 209 / 206 / 214 so they share one tab slot instead of
   six separate tabs across the header.
   ============================================================ */
// Full, officially-numbered ICS-201 (blocks 1-10 per the FEMA form),
// as distinct from the streamlined "Tactical Worksheet" tab — both
// read/write the same underlying incident fields, so filling in one
// updates the other. This is the one that includes the Resource
// Summary table (Block 10), matching the official form exactly.
function Tab201Full({ incident, setIncident, org, objectivePresets, onSavePreset }) {
  const updateObjective = (i, val) => {
    const next = [...incident.objectives]; next[i] = val;
    setIncident({ ...incident, objectives: next });
  };
  const addObjective = () => setIncident({ ...incident, objectives: [...incident.objectives, ""] });
  const removeObjective = (i) => setIncident({ ...incident, objectives: incident.objectives.filter((_, idx) => idx !== i) });

  const addAction = () => setIncident({ ...incident, actionsLog: [...incident.actionsLog, { id: uid(), time: "", actions: "" }] });
  const updateAction = (id, patch) => setIncident({ ...incident, actionsLog: incident.actionsLog.map(a => a.id === id ? { ...a, ...patch } : a) });
  const removeAction = (id) => setIncident({ ...incident, actionsLog: incident.actionsLog.filter(a => a.id !== id) });

  const addOrder = () => setIncident({ ...incident, resourceOrders: [...incident.resourceOrders, { id: uid(), resource: "", identifier: "", ordered: "", eta: "", arrived: false, notes: "" }] });
  const updateOrder = (id, patch) => setIncident({ ...incident, resourceOrders: incident.resourceOrders.map(r => r.id === id ? { ...r, ...patch } : r) });
  const removeOrder = (id) => setIncident({ ...incident, resourceOrders: incident.resourceOrders.filter(r => r.id !== id) });

  const cell = { padding: "6px 6px", fontSize: 12.5, verticalAlign: "top" };
  const orgLines = flattenOrgFilled(org).map(item => `${"  ".repeat(item.depth || 0)}${item.title}: ${item.name}`);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-201 · Incident Briefing (Official Form)" icon={ClipboardList}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="1. Incident Name"><TextInput value={incident.name} onChange={e => setIncident({ ...incident, name: e.target.value })} /></Field>
          <Field label="2. Incident Number"><TextInput value={incident.number} onChange={e => setIncident({ ...incident, number: e.target.value })} /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
          <Field label="3. Date Initiated"><TextInput type="date" value={incident.dateInitiated} onChange={e => setIncident({ ...incident, dateInitiated: e.target.value })} /></Field>
          <Field label="Time Initiated"><TextInput type="time" value={incident.timeInitiated} onChange={e => setIncident({ ...incident, timeInitiated: e.target.value })} /></Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Field label="4. Map/Sketch (perimeter, resource assignments, incident facilities — attach separately or describe here)" wide>
            <TextArea value={incident.mapSketch || ""} onChange={e => setIncident({ ...incident, mapSketch: e.target.value })} style={{ minHeight: 70 }} />
          </Field>
        </div>
        <div style={{ marginTop: 14 }}>
          <Field label="5. Situation Summary and Health and Safety Briefing" wide>
            <TextArea value={incident.situation} onChange={e => setIncident({ ...incident, situation: e.target.value })} style={{ minHeight: 90 }} />
          </Field>
        </div>
        <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "18px 0 8px" }}>6. Prepared By</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
          <Field label="Name"><TextInput value={incident.preparedBy} onChange={e => setIncident({ ...incident, preparedBy: e.target.value })} /></Field>
          <Field label="Position / Title"><TextInput value={incident.prepPosition} onChange={e => setIncident({ ...incident, prepPosition: e.target.value })} /></Field>
          <Field label="Signature"><TextInput value={incident.prepSignature} onChange={e => setIncident({ ...incident, prepSignature: e.target.value })} placeholder="Type name to sign" /></Field>
          <Field label="Date / Time"><TextInput type="datetime-local" value={incident.prepDateTime} onChange={e => setIncident({ ...incident, prepDateTime: e.target.value })} /></Field>
        </div>
      </Panel>

      <Panel title="7. Current and Planned Objectives" icon={ClipboardList}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {incident.objectives.map((o, i) => {
            const isNewObjective = o.trim() && !objectivePresets.includes(o.trim());
            return (
              <div key={i} style={{ display: "flex", gap: 8 }}>
                <span style={{ width: 22, textAlign: "right", color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, paddingTop: 9 }}>{i + 1}.</span>
                <TextInput list="objective-presets" value={o} onChange={e => updateObjective(i, e.target.value)} style={{ flex: 1 }} placeholder="Objective..." />
                {isNewObjective && (
                  <button onClick={() => onSavePreset(o.trim())} title="Save as a quick-pick objective for next time" style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 4, color: COLORS.amber, cursor: "pointer", padding: "0 8px" }}>
                    <Star size={14} />
                  </button>
                )}
                <Btn kind="danger" onClick={() => removeObjective(i)}><Trash2 size={14} /></Btn>
              </div>
            );
          })}
          <datalist id="objective-presets">{objectivePresets.map(p => <option key={p} value={p} />)}</datalist>
          <Btn kind="subtle" icon={Plus} onClick={addObjective} style={{ alignSelf: "flex-start" }}>Add Objective</Btn>
        </div>
      </Panel>

      <Panel title="8. Current and Planned Actions, Strategies, and Tactics" icon={ClipboardList} right={<Btn kind="subtle" icon={Plus} onClick={addAction}>Add Entry</Btn>}>
        {incident.actionsLog.map(a => (
          <div key={a.id} style={{ display: "flex", gap: 8, marginBottom: 6 }}>
            <TextInput type="time" value={a.time} onChange={e => updateAction(a.id, { time: e.target.value })} style={{ width: 130 }} />
            <TextInput value={a.actions} onChange={e => updateAction(a.id, { actions: e.target.value })} placeholder="Actions..." style={{ flex: 1 }} />
            <button onClick={() => removeAction(a.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button>
          </div>
        ))}
        {incident.actionsLog.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>

      <Panel title="9. Current Organization" icon={Users}>
        {orgLines.length === 0
          ? <div style={{ fontSize: 13, color: COLORS.faint }}>None entered — fill in on the Org Chart tab.</div>
          : <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.8 }}>{orgLines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
      </Panel>

      <Panel title="10. Resource Summary" icon={Truck} right={<Btn kind="subtle" icon={Plus} onClick={addOrder}>Add Resource</Btn>}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5 }}>
            <th style={cell}>Resource</th><th style={cell}>Resource Identifier</th><th style={cell}>Date/Time Ordered</th>
            <th style={cell}>ETA</th><th style={cell}>Arrived</th><th style={cell}>Notes (location/assignment/status)</th><th style={cell}></th>
          </tr></thead>
          <tbody>
            {incident.resourceOrders.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={r.resource} onChange={e => updateOrder(r.id, { resource: e.target.value })} style={{ width: 130 }} /></td>
                <td style={cell}><TextInput value={r.identifier} onChange={e => updateOrder(r.id, { identifier: e.target.value })} style={{ width: 110 }} /></td>
                <td style={cell}><TextInput type="datetime-local" value={r.ordered} onChange={e => updateOrder(r.id, { ordered: e.target.value })} style={{ width: 170 }} /></td>
                <td style={cell}><TextInput type="time" value={r.eta} onChange={e => updateOrder(r.id, { eta: e.target.value })} style={{ width: 110 }} /></td>
                <td style={cell}>
                  <input type="checkbox" checked={r.arrived} onChange={e => updateOrder(r.id, { arrived: e.target.checked })} style={{ width: 18, height: 18 }} />
                </td>
                <td style={cell}><TextInput value={r.notes} onChange={e => updateOrder(r.id, { notes: e.target.value })} style={{ width: 180 }} /></td>
                <td style={cell}><button onClick={() => removeOrder(r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {incident.resourceOrders.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>None entered.</div>}
      </Panel>
    </div>
  );
}

const ICS_FORM_OPTIONS = [
  { k: "201full", label: "ICS-201 · Incident Briefing" },
  { k: "205", label: "ICS-205 · Communications Plan" },
  { k: "215a", label: "ICS-215A · Safety Analysis" },
  { k: "208", label: "ICS-208 · Safety Message/Plan" },
  { k: "208hm", label: "ICS-208 HM · Site Safety Plan (HazMat)" },
  { k: "209", label: "ICS-209 · Incident Status Summary" },
  { k: "206", label: "ICS-206 · Medical Plan" },
  { k: "214", label: "ICS-214 · Activity Logs" },
];

function TabICSForms(props) {
  const [selected, setSelected] = useState("201full");
  const { formsUsed, toggleFormUsed } = props;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Forms in Use" icon={CheckCircle2}>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 10, lineHeight: 1.5 }}>
          Check the additional forms this incident is using — they're included in Print/Export alongside the always-included Tactical Worksheet info. Click a form's name to open and edit it below.
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {ICS_FORM_OPTIONS.map(o => {
            const isSelected = selected === o.k;
            const isUsed = !!formsUsed[o.k];
            const alwaysIncluded = o.k === "201full";
            return (
              <div key={o.k} style={{
                display: "flex", alignItems: "center", gap: 7, padding: "7px 11px", borderRadius: 5,
                background: isSelected ? COLORS.panel2 : "transparent",
                border: `1px solid ${isSelected ? COLORS.amber : COLORS.line}`,
              }}>
                {alwaysIncluded
                  ? <CheckCircle2 size={16} color={COLORS.muted} style={{ flexShrink: 0 }} />
                  : <input type="checkbox" checked={isUsed} onChange={() => toggleFormUsed(o.k)} style={{ width: 16, height: 16, cursor: "pointer", flexShrink: 0 }} />}
                <span onClick={() => setSelected(o.k)} style={{ fontSize: 12.5, cursor: "pointer", color: alwaysIncluded || isUsed ? COLORS.text : COLORS.muted, whiteSpace: "nowrap" }}>
                  {o.label}{alwaysIncluded && <span style={{ color: COLORS.faint, fontSize: 11 }}> (always included)</span>}
                </span>
              </div>
            );
          })}
        </div>
      </Panel>

      {selected === "201full" && <Tab201Full incident={props.incident} setIncident={props.setIncident} org={props.org} objectivePresets={props.objectivePresets} onSavePreset={props.onSavePreset} />}
      {selected === "205" && <TabComms comms={props.comms} setComms={props.setComms} incident={props.incident} />}
      {selected === "215a" && <Tab215A safety={props.safety} setSafety={props.setSafety} org={props.org} incident={props.incident} />}
      {selected === "208" && <Tab208 ics208={props.ics208} setIcs208={props.setIcs208} incident={props.incident} />}
      {selected === "208hm" && <Tab208HM ics208hm={props.ics208hm} setIcs208hm={props.setIcs208hm} incident={props.incident} />}
      {selected === "209" && <Tab209 ics209={props.ics209} setIcs209={props.setIcs209} incident={props.incident} />}
      {selected === "206" && <Tab206 ics206={props.ics206} setIcs206={props.setIcs206} incident={props.incident} />}
      {selected === "214" && <Tab214 logs={props.logs} setLogs={props.setLogs} />}
    </div>
  );
}

const MAX_ATTACHMENT_BYTES = 700 * 1024; // ~700KB raw — base64 inflates
// this ~33%, keeping each attachment document safely under Firestore's
// 1MB-per-document cap with room for metadata overhead.

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function downloadAttachmentFile(a) {
  const byteChars = atob(a.dataBase64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  const blob = new Blob([new Uint8Array(byteNumbers)], { type: a.type || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = a.name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function TabAttachments({ attachments, onUpload, onDelete }) {
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const handleFiles = async (files) => {
    setError("");
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`"${file.name}" is ${fmtBytes(file.size)} — the limit is ${fmtBytes(MAX_ATTACHMENT_BYTES)}. Try a smaller photo or a compressed file.`);
        continue;
      }
      setUploading(true);
      try {
        await onUpload(file);
      } catch {
        setError(`Failed to upload "${file.name}".`);
      }
      setUploading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Attachments" icon={Paperclip}
        right={
          <>
            <input ref={fileInputRef} type="file" multiple style={{ display: "none" }}
              onChange={e => { handleFiles(Array.from(e.target.files)); e.target.value = ""; }} />
            <Btn kind="subtle" icon={Plus} onClick={() => fileInputRef.current?.click()} disabled={uploading}>
              {uploading ? "Uploading…" : "Add File"}
            </Btn>
          </>
        }>
        <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 12, lineHeight: 1.5 }}>
          Photos and documents attached to this incident — included in Print/Export (photos embed directly as pages; other file types are listed by name). Limit {fmtBytes(MAX_ATTACHMENT_BYTES)} per file.
        </div>
        {error && <div style={{ color: COLORS.dangerText, fontSize: 12.5, marginBottom: 10 }}>{error}</div>}
        {attachments.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint }}>No attachments yet.</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12 }}>
          {attachments.map(a => {
            const isImage = (a.type || "").startsWith("image/");
            return (
              <div key={a.id} style={{ background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 6, padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                {isImage ? (
                  <img src={`data:${a.type};base64,${a.dataBase64}`} alt={a.name} style={{ width: "100%", height: 100, objectFit: "cover", borderRadius: 4 }} />
                ) : (
                  <div style={{ width: "100%", height: 100, display: "flex", alignItems: "center", justifyContent: "center", background: COLORS.panel, borderRadius: 4 }}>
                    <FileText size={32} color={COLORS.muted} />
                  </div>
                )}
                <div style={{ fontSize: 12, fontWeight: 600, wordBreak: "break-word" }}>{a.name}</div>
                <div style={{ fontSize: 10.5, color: COLORS.muted }}>{fmtBytes(a.size || 0)} · {fmtDate(a.uploadedAt)}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn kind="subtle" onClick={() => downloadAttachmentFile(a)} style={{ flex: 1, justifyContent: "center", padding: "5px 8px", fontSize: 11.5 }}>Download</Btn>
                  <button onClick={() => onDelete(a.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}

function Tab214({ logs, setLogs }) {
  const [activeLog, setActiveLog] = useState(logs[0]?.id || null);
  useEffect(() => { if (!logs.find(l => l.id === activeLog)) setActiveLog(logs[0]?.id || null); }, [logs]);

  const addLog = () => {
    const l = { id: uid(), name: "", position: "", agency: "", entries: [] };
    setLogs([...logs, l]); setActiveLog(l.id);
  };
  const updateLog = (id, patch) => setLogs(logs.map(l => l.id === id ? { ...l, ...patch } : l));
  const removeLog = (id) => setLogs(logs.filter(l => l.id !== id));
  const addEntry = (id) => updateLog(id, { entries: [{ id: uid(), time: nowISO(), text: "" }, ...(logs.find(l => l.id === id)?.entries || [])] });
  const updateEntry = (logId, entryId, patch) => {
    const log = logs.find(l => l.id === logId);
    updateLog(logId, { entries: log.entries.map(e => e.id === entryId ? { ...e, ...patch } : e) });
  };
  const removeEntry = (logId, entryId) => {
    const log = logs.find(l => l.id === logId);
    updateLog(logId, { entries: log.entries.filter(e => e.id !== entryId) });
  };

  const log = logs.find(l => l.id === activeLog);

  return (
    <Panel title="ICS-214 · Unit / Activity Log" icon={ClipboardList} right={<Btn kind="subtle" icon={Plus} onClick={addLog}>New Log</Btn>}>
      {logs.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint }}>No activity logs yet. Add one per unit, position, or individual.</div>}
      {logs.length > 0 && (
        <>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
            {logs.map(l => (
              <button key={l.id} onClick={() => setActiveLog(l.id)} style={{
                padding: "6px 11px", borderRadius: 4, fontSize: 12.5, cursor: "pointer",
                background: activeLog === l.id ? COLORS.red : COLORS.panel2,
                color: activeLog === l.id ? "#fff" : COLORS.text,
                border: `1px solid ${activeLog === l.id ? COLORS.red : COLORS.line}`,
              }}>{l.name || l.position || "Untitled Log"}</button>
            ))}
          </div>
          {log && (
            <div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 10, marginBottom: 14 }}>
                <Field label="Name"><TextInput value={log.name} onChange={e => updateLog(log.id, { name: e.target.value })} /></Field>
                <Field label="ICS Position"><TextInput value={log.position} onChange={e => updateLog(log.id, { position: e.target.value })} /></Field>
                <Field label="Home Agency"><TextInput value={log.agency} onChange={e => updateLog(log.id, { agency: e.target.value })} /></Field>
                <div style={{ display: "flex", alignItems: "end" }}><Btn kind="danger" icon={Trash2} onClick={() => removeLog(log.id)}>Delete Log</Btn></div>
              </div>
              <Btn kind="subtle" icon={Plus} onClick={() => addEntry(log.id)} style={{ marginBottom: 10 }}>Add Entry</Btn>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {log.entries.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint }}>No entries logged.</div>}
                {log.entries.map(e => (
                  <div key={e.id} style={{ display: "flex", gap: 8, alignItems: "start" }}>
                    <TextInput type="time" step="1" value={new Date(e.time).toTimeString().slice(0, 8)}
                      onChange={ev => {
                        const [h, m, s] = ev.target.value.split(":").map(Number);
                        const d = new Date(e.time); d.setHours(h || 0, m || 0, s || 0);
                        updateEntry(log.id, e.id, { time: d.toISOString() });
                      }}
                      style={{ width: 110, fontFamily: "'IBM Plex Mono', monospace" }} />
                    <TextInput value={e.text} onChange={ev => updateEntry(log.id, e.id, { text: ev.target.value })} placeholder="Notable activity..." style={{ flex: 1 }} />
                    <button onClick={() => removeEntry(log.id, e.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer", paddingTop: 8 }}><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/* ============================================================
   TAB: ICS-215A INCIDENT SAFETY ANALYSIS
   ============================================================ */
function Tab215A({ safety, setSafety, org, incident }) {
  const addRow = () => setSafety({ ...safety, rows: [{ id: uid(), branch: "", division: "", hazards: "", mitigations: "" }, ...safety.rows] });
  const update = (id, patch) => setSafety({ ...safety, rows: safety.rows.map(r => r.id === id ? { ...r, ...patch } : r) });
  const remove = (id) => setSafety({ ...safety, rows: safety.rows.filter(r => r.id !== id) });
  const divisionOptions = flattenOrgTitles(org);
  const cell = { padding: "6px 6px", fontSize: 12.5, verticalAlign: "top" };

  return (
    <Panel title="ICS-215A · Incident Action Plan Safety Analysis" icon={AlertTriangle} right={<Btn kind="subtle" icon={Plus} onClick={addRow}>Add Hazard</Btn>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
        <Field label="Incident Number"><TextInput value={incident.number} disabled style={{ opacity: 0.65 }} /></Field>
      </div>

      <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Operational Period</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
        <Field label="Date / Time From"><TextInput type="datetime-local" value={safety.opFrom} onChange={e => setSafety({ ...safety, opFrom: e.target.value })} /></Field>
        <Field label="Date / Time To"><TextInput type="datetime-local" value={safety.opTo} onChange={e => setSafety({ ...safety, opTo: e.target.value })} /></Field>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5, letterSpacing: "0.05em" }}>
              <th style={cell}>Branch</th>
              <th style={cell}>Division / Group</th>
              <th style={cell}>Hazards / Risks</th>
              <th style={cell}>Mitigations for Identified Hazards</th>
              <th style={cell}></th>
            </tr>
          </thead>
          <tbody>
            {safety.rows.map(r => (
              <tr key={r.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={r.branch} onChange={e => update(r.id, { branch: e.target.value })} style={{ width: 95 }} placeholder="Branch I" /></td>
                <td style={cell}>
                  <input list="cb-div-options" value={r.division} onChange={e => update(r.id, { division: e.target.value })}
                    style={{ ...inputStyle, width: 115 }} placeholder="Div A" />
                </td>
                <td style={cell}><TextArea value={r.hazards} onChange={e => update(r.id, { hazards: e.target.value })} style={{ minHeight: 50, width: 205 }} placeholder="Falling debris, flashover potential, unstable structure..." /></td>
                <td style={cell}><TextArea value={r.mitigations} onChange={e => update(r.id, { mitigations: e.target.value })} style={{ minHeight: 50, width: 205 }} placeholder="Full PPE, RIC in place, 2-in/2-out, monitor radio traffic..." /></td>
                <td style={cell}><button onClick={() => remove(r.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="cb-div-options">{divisionOptions.map(d => <option key={d} value={d} />)}</datalist>
        {safety.rows.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>No hazards logged yet. Add one per Division/Group as the risk assessment develops.</div>}
      </div>

      <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "20px 0 8px" }}>Prepared By (Safety Officer)</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12 }}>
        <Field label="Name"><TextInput value={safety.preparedBy} onChange={e => setSafety({ ...safety, preparedBy: e.target.value })} placeholder={org.commandStaff.find(c => c.title === "Safety Officer")?.name || "Name"} /></Field>
        <Field label="Position / Title"><TextInput value={safety.position} onChange={e => setSafety({ ...safety, position: e.target.value })} placeholder="Safety Officer" /></Field>
        <Field label="Signature"><TextInput value={safety.signature} onChange={e => setSafety({ ...safety, signature: e.target.value })} placeholder="Type name to sign" /></Field>
        <Field label="Date / Time"><TextInput type="datetime-local" value={safety.dateTime} onChange={e => setSafety({ ...safety, dateTime: e.target.value })} /></Field>
      </div>
    </Panel>
  );
}

/* ============================================================
   PRINT VIEWS
   ============================================================ */
/* ============================================================
   EXPORT — builds a self-contained HTML packet and downloads it.
   window.print() is unreliable from inside the sandboxed frame
   artifacts run in, so this sidesteps that: the file opens and
   prints normally in any regular browser tab.
   ============================================================ */
function pdfEscape(str) {
  return String(str ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00B7\u2022]/g, "-")
    .replace(/\t/g, "  ")
    .replace(/[^\x20-\x7E]/g, "?")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}
const AVG_CHAR_W = { H: 0.5, HB: 0.54 };
function fitText(str, font, size, maxWidth) {
  let s = String(str ?? "").replace(/\s+/g, " ").trim();
  const w = AVG_CHAR_W[font] || 0.5;
  const maxChars = Math.max(1, Math.floor(maxWidth / (size * w)));
  if (s.length > maxChars) s = s.slice(0, Math.max(1, maxChars - 3)) + "...";
  return s;
}
function wrapPush(L, text, width = 100) {
  const words = String(text || "-").split(/\s+/);
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      L.push({ kind: "text", text: line, font: "H", size: 9 });
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) L.push({ kind: "text", text: line, font: "H", size: 9 });
}
function tableLines(headers, colWidths, rows, title) {
  const lines = [];
  if (title) lines.push({ kind: "heading", text: title });
  const xOffsets = [];
  let acc = 0;
  colWidths.forEach(w => { xOffsets.push(acc); acc += w; });
  const totalWidth = acc;
  const toRow = (cells, font, size) => ({
    kind: "row", font, size,
    // A cell is normally a plain string (truncated to fit via
    // fitText, as before). It can also be an array of {text, bold}
    // segments for mixed-weight text within one cell (e.g. bold
    // vitals labels with regular-weight values) — segmented cells
    // skip fitText, since truncating mid-segment isn't meaningful;
    // callers using this are expected to size the column generously.
    cells: cells.map((c, i) => Array.isArray(c)
      ? { segments: c, x: xOffsets[i] }
      : { text: fitText(c, font, size, colWidths[i] - 6), x: xOffsets[i] }),
  });
  lines.push(toRow(headers, "HB", 9));
  lines.push({ kind: "rule", width: totalWidth, color: "light" });
  if (rows.length === 0) {
    lines.push({ kind: "text", text: "(none entered)", font: "H", size: 9 });
  } else {
    rows.forEach(cells => lines.push(toRow(cells, "H", 9)));
  }
  lines.push({ kind: "text", text: "", font: "H", size: 9 });
  return lines;
}

// A "heading" line renders bold + a full-width light rule beneath it,
// giving the report real section breaks instead of plain bold text.
function heading(L, text) {
  L.push({ kind: "heading", text });
}

// Compact time formatters for the PDF specifically — the on-screen
// fmtTime() includes seconds (e.g. "10:58:32 PM", 11 chars), which is
// fine in the app's flexible UI but too wide for several fixed-width
// table columns in the hand-built PDF (fitText truncates rather than
// wrapping/overflowing, so a too-narrow column silently clips the
// timestamp — e.g. down to "10:58:..."). Dropping to minute precision
// here keeps every timestamp fully visible without needing every
// column sized to the exact worst case down to the pixel.
const fmtTimeShort = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "-";
// The Resource Summary's "Date/Time Ordered" field is a raw
// datetime-local input value ("YYYY-MM-DDTHH:MM", 16 characters) —
// reformatted to "MM/DD HH:MM" (11 characters), which is both shorter
// and more readable in a table cell than the ISO-ish raw string.
const fmtDateTimeShort = (raw) => {
  if (!raw) return "-";
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw; // not a parseable datetime-local value — show as-is rather than hide it
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
};

function buildPacketLines({ incident, resources, comms, org, safety, ics208, ics208hm, ics209, ics206, rehab, logs, formsUsed, attachments, orgChartImage }) {
  // Older saved/archived incidents predate these forms (or, in the
  // archive-export path, skip the normal load/normalize step
  // entirely) — fall back to blank defaults rather than throwing on
  // a missing field.
  incident = incident || blankIncident();
  resources = resources || [];
  comms = normalizeComms(comms);
  org = normalizeOrg(org);
  safety = safety || { opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] };
  ics208 = { ...defaultIcs208(), ...(ics208 || {}) };
  ics208hm = { ...defaultIcs208HM(), ...(ics208hm || {}) };
  ics209 = { ...defaultIcs209(), ...(ics209 || {}) };
  ics206 = { ...defaultIcs206(), ...(ics206 || {}) };
  logs = logs || [];
  rehab = rehab || [];
  attachments = attachments || [];
  // Older saved incidents (or a first export before any form was
  // checked) won't have this — fall back to "everything included"
  // rather than silently producing an empty packet.
  // Strict: a form is included only if its checkbox is actually
  // checked. No "include everything" fallback when nothing's been
  // checked — an untouched checklist means only the always-on
  // Tactical Worksheet / Resource Board / Org Chart content exports,
  // not every optional ICS form by default.
  const include = (key) => !!(formsUsed && formsUsed[key]);
  const L = [];
  const push = (text, font = "H", size = 9) => L.push({ kind: "text", text, font, size });
  const blank = () => push("");

  push(`Incident #: ${incident.number || "-"}   Type: ${incident.type || "-"}`, "H", 10);
  push(`Location: ${incident.location || "-"}`, "H", 10);
  push(`IC: ${incident.icName || "-"}   Prepared By: ${incident.preparedBy || "-"}`, "H", 10);
  push(`Wind: ${incident.wind || "-"}   Temp: ${incident.temp || "-"}   RH: ${incident.rh || "-"}`, "H", 10);
  push(`Conditions: ${incident.conditions || "-"}`, "H", 10);
  blank();

  // Always included, not gated by a checkbox — this is the Tactical
  // Worksheet's own data (same underlying incident fields as the full
  // ICS-201 form), not an optional add-on form like HazMat or Medical.
  heading(L, "ICS-201 · Incident Briefing");
  push(`Date/Time Initiated: ${incident.dateInitiated || "-"} ${incident.timeInitiated || ""}`, "H", 9);
  blank();
  push("Situation Summary and Health/Safety Briefing:", "HB", 9);
  wrapPush(L, incident.situation);
  blank();
  push("Objectives:", "HB", 9);
  const objs = incident.objectives.filter(Boolean);
  if (objs.length === 0) push("(none entered)");
  else objs.forEach((o, i) => wrapPush(L, `${i + 1}. ${o}`));
  blank();
  push("Current and Planned Actions, Strategies, and Tactics:", "HB", 9);
  const strategyLabels = [["strategyOffensive", "Offensive"], ["strategyDefensive", "Defensive"], ["strategyTransitional", "Transitional"], ["strategyInvestigative", "Investigative"]]
    .filter(([key]) => incident[key]).map(([, label]) => label);
  push(`Strategy: ${strategyLabels.length ? strategyLabels.join(", ") : "(none checked)"}`, "H", 9);
  const actionsWithText = (incident.actionsLog || []).filter(a => a.time || a.actions);
  if (actionsWithText.length === 0) push("(none entered)");
  else actionsWithText.forEach(a => wrapPush(L, `${a.time || "-"}: ${a.actions}`));
  blank();
  push(`Prepared By: ${incident.preparedBy || "-"}   Position: ${incident.prepPosition || "-"}`, "H", 9);
  push(`Signature: ${incident.prepSignature || "-"}   Date/Time: ${incident.prepDateTime || "-"}`, "H", 9);
  blank();

  L.push(...tableLines(["RESOURCE", "IDENTIFIER", "ORDERED", "ETA", "ARRIVED", "NOTES"], [80, 80, 70, 60, 55, 220],
    (incident.resourceOrders || []).map(r => [r.resource, r.identifier, fmtDateTimeShort(r.ordered), r.eta, r.arrived ? "X" : "", r.notes]), "10. Resource Summary"));

  L.push(...tableLines(["UNIT", "TYPE", "PERS", "STATUS", "ASSIGNMENT"], [70, 110, 45, 80, 220],
    resources.map(r => [r.label, r.kind, String(r.personnel), r.status, r.assignment]), "Resource Board Status"));

  const vitalsSegments = (r) => {
    const segs = [];
    if (r.bp) segs.push({ text: "BP ", bold: true }, { text: `${r.bp} `, bold: false });
    if (r.pulse) segs.push({ text: "P ", bold: true }, { text: `${r.pulse} `, bold: false });
    if (r.rr) segs.push({ text: "R ", bold: true }, { text: `${r.rr} `, bold: false });
    if (r.spo2) segs.push({ text: "SpO2 ", bold: true }, { text: `${r.spo2} `, bold: false });
    if (r.temp) segs.push({ text: "T ", bold: true }, { text: `${r.temp}`, bold: false });
    return segs;
  };
  // Frozen duration for cleared entries (time-in to time-cleared,
  // matching the on-screen clock's freeze behavior) — for anyone
  // still in rehab at export time, this is elapsed-so-far as of the
  // moment the report was generated, since a PDF is a snapshot.
  const rehabDuration = (r) => r.timeIn ? elapsed(r.timeIn, r.timeCleared ? new Date(r.timeCleared).getTime() : Date.now()) : "-";
  L.push(...tableLines(["NAME", "UNIT", "TIME IN", "DURATION", "VITALS", "STATUS", "CLEARED", "NOTES"], [160, 40, 50, 55, 190, 65, 50, 102],
    rehab.map(r => [r.name, r.unit, fmtTimeShort(r.timeIn), rehabDuration(r), vitalsSegments(r), r.status, r.timeCleared ? fmtTimeShort(r.timeCleared) : "", r.notes]), "Rehab / Medical Monitoring"));

  heading(L, "9. Current Organization");
  const orgLines = flattenOrgFilled(org).map(item => `${"  ".repeat(item.depth || 0)}${item.title}: ${item.name}`);
  if (orgLines.length === 0) push("(none entered)");
  else orgLines.forEach(l => wrapPush(L, l));
  if (orgChartImage) L.push({ kind: "image", img: orgChartImage });
  blank();

  if (include("205")) {
    heading(L, "ICS-205 · Incident Radio Communications Plan");
    push(`Date/Time Prepared: ${comms.dateTimePrepared || "-"}   Operational Period: ${comms.opFrom || "-"} to ${comms.opTo || "-"}`, "H", 9);
    blank();
    L.push(...tableLines(["ZN/GRP", "CH#", "FUNCTION", "CHANNEL NAME", "ASSIGN", "RX FREQ", "TX FREQ", "MODE", "REMARKS"], [45, 35, 75, 110, 80, 75, 75, 40, 160],
      comms.rows.map(c => [c.zoneGroup, c.chNum, c.func, c.channelName, c.assignment, c.rxFreq, c.txFreq, c.mode, c.remarks])));
    if (comms.specialInstructions) {
      push("Special Instructions:", "HB", 9);
      wrapPush(L, comms.specialInstructions);
    }
    push(`Prepared By (Comms Unit Leader): ${comms.preparedBy || "-"}   Signature: ${comms.signature || "-"}   Date/Time: ${comms.dateTime || "-"}`, "H", 9);
    blank();
  }

  if (include("215a")) {
    heading(L, "ICS-215A · Incident Action Plan Safety Analysis");
    push(`Operational Period: ${safety.opFrom || "-"} to ${safety.opTo || "-"}`, "H", 9);
    blank();
    L.push(...tableLines(["BRANCH", "DIV/GRP", "HAZARDS", "MITIGATIONS"], [70, 90, 270, 270],
      safety.rows.map(r => [r.branch, r.division, r.hazards, r.mitigations])));
    push(`Prepared By: ${safety.preparedBy || "-"}   Position: ${safety.position || "-"}`);
    push(`Signature: ${safety.signature || "-"}   Date/Time: ${safety.dateTime || "-"}`);
    blank();
  }

  if (include("208")) {
    heading(L, "ICS-208 · Safety Message/Plan");
    push(`Operational Period: ${ics208.opFrom || "-"} to ${ics208.opTo || "-"}`, "H", 9);
    blank();
    wrapPush(L, ics208.message || "(none entered)");
    push(`Site Safety Plan Required: ${ics208.siteSafetyPlanRequired || "-"}   Located At: ${ics208.siteSafetyPlanLocation || "-"}`, "H", 9);
    push(`Prepared By: ${ics208.preparedBy || "-"}   Position: ${ics208.position || "-"}`);
    push(`Signature: ${ics208.signature || "-"}   Date/Time: ${ics208.dateTime || "-"}`);
    blank();
  }

  if (include("208hm")) {
    heading(L, "ICS-208 HM · Site Safety and Control Plan");
    push(`Incident Location: ${ics208hm.incidentLocation || "-"}   Date Prepared: ${ics208hm.dateTime || "-"}`, "H", 9);
    push(`Op Period: ${ics208hm.opFrom || "-"} to ${ics208hm.opTo || "-"}`, "H", 9);
    push("Organization:", "HB", 9);
    push(`IC: ${ics208hm.orgIC || "-"}   HM Group Supv: ${ics208hm.orgHMGroupSupervisor || "-"}   Safety Officer: ${ics208hm.orgSafetyOfficer || "-"}`, "H", 9);
    push(`Entry Leader: ${ics208hm.orgEntryLeader || "-"}   Decon Leader: ${ics208hm.orgDeconLeader || "-"}   Site Access Control: ${ics208hm.orgSiteAccessControlLeader || "-"}`, "H", 9);
    L.push(...tableLines(["ENTRY MEMBER", "NAME", "PPE LEVEL"], [90, 150, 90],
      (ics208hm.entryTeam || []).map(m => [m.label, m.name, m.ppeLevel])));
    L.push(...tableLines(["DECON MEMBER", "NAME", "PPE LEVEL"], [90, 150, 90],
      (ics208hm.deconTeam || []).map(m => [m.label, m.name, m.ppeLevel])));
    L.push(...tableLines(["MATERIAL", "CONTAINER", "QTY", "IDLH", "LEL", "UEL"], [90, 80, 50, 60, 50, 50],
      (ics208hm.materials || []).map(m => [m.material, m.containerType, m.qty, m.idlh, m.lel, m.uel]), "Hazard/Risk Analysis"));
    push(`Monitoring — LEL: ${ics208hm.lelInstruments || "-"}   O2: ${ics208hm.o2Instruments || "-"}   Toxicity: ${ics208hm.toxicityInstruments || "-"}   Radiological: ${ics208hm.radiologicalInstruments || "-"}`, "H", 9);
    push(`Standard Decon Procedures: ${ics208hm.standardDecon || "-"}   ${ics208hm.deconComment || ""}`, "H", 9);
    push(`Comms — Command: ${ics208hm.commandFreq || "-"}   Tactical: ${ics208hm.tacticalFreq || "-"}   Entry: ${ics208hm.entryFreq || "-"}`, "H", 9);
    push(`Medical Monitoring: ${ics208hm.medicalMonitoring || "-"}   Treatment In-Place: ${ics208hm.medicalTreatmentInPlace || "-"}`, "H", 9);
    push("Entry Objectives:", "HB", 9);
    wrapPush(L, ics208hm.entryObjectives || "(none entered)");
    push("Emergency Procedures:", "HB", 9);
    wrapPush(L, ics208hm.emergencyProcedures || "(none entered)");
    push(`Safety Briefing — Asst. Safety Officer HM: ${ics208hm.asstSafetyOfficerSignature || "-"} (${ics208hm.safetyBriefingTime || "-"})`, "H", 9);
    push(`HM Group Supervisor: ${ics208hm.hmGroupSupervisorSignature || "-"}   Incident Commander: ${ics208hm.incidentCommanderSignature || "-"}`, "H", 9);
    blank();
  }

  if (include("209")) {
    heading(L, "ICS-209 · Incident Status Summary");
    push(`Incident Start: ${incident.dateInitiated || "-"} ${incident.timeInitiated || "-"} CST`, "H", 9);
    push(`Report Version: ${ics209.reportVersion || "-"}   Prepared: ${ics209.preparedDateTime || "-"}   For Period: ${ics209.opFrom || "-"} to ${ics209.opTo || "-"}`, "H", 9);
    push(`IC/Agency: ${incident.icName || "-"}${ics209.icAgencyOrg ? " - " + ics209.icAgencyOrg : ""}   Size/Area: ${ics209.sizeArea || "-"}   % Contained: ${ics209.percentContained || "-"}`, "H", 9);
    push(`Definition: ${ics209.definition || "-"}   Complexity: ${ics209.complexityLevel || "-"}`, "H", 9);
    push(`Location: ${ics209.shortLocation || "-"}`, "H", 9);
    push("Significant Events:", "HB", 9);
    wrapPush(L, ics209.significantEvents || "(none entered)");
    push(`Primary Materials/Hazards: ${ics209.primaryMaterials || "-"}`, "H", 9);
    const activeThreatFlags = THREAT_FLAG_OPTIONS.filter(([k]) => ics209.threatFlags[k]).map(([, l]) => l);
    push(`Threat Management: ${activeThreatFlags.length ? activeThreatFlags.join(", ") : "(none checked)"}`, "H", 9);
    push(`Weather Concerns: ${ics209.weatherConcerns || "-"}`, "H", 9);
    push("Strategic Objectives:", "HB", 9);
    wrapPush(L, ics209.strategicObjectives || "(none entered)");
    push("Planned Actions Next Op Period:", "HB", 9);
    wrapPush(L, ics209.plannedActions || "(none entered)");
    push(`Prepared By: ${ics209.preparedByName || "-"} (${ics209.preparedByPosition || "-"})   Approved By: ${ics209.approvedByName || "-"}`, "H", 9);
    blank();
  }

  if (include("206")) {
    heading(L, "ICS-206 · Medical Plan");
    L.push(...tableLines(["STATION", "LOCATION", "CONTACT", "PARAMEDIC"], [140, 220, 220, 100],
      ics206.aidStations.map(r => [r.name, r.location, r.contact, r.paramedic]), "Medical Aid Stations"));
    L.push(...tableLines(["SERVICE", "LOCATION", "CONTACT", "LEVEL"], [170, 190, 190, 100],
      ics206.ambulances.map(r => [r.name, r.location, r.contact, r.level]), "Ambulance Services"));
    L.push(...tableLines(["HOSPITAL", "ADDRESS", "TRAVEL AIR", "TRAVEL GRND", "TRAUMA", "BURN", "HELIPAD"], [140, 240, 75, 85, 70, 55, 65],
      ics206.hospitals.map(r => [r.name, r.address, r.travelAir, r.travelGround, r.trauma === "Yes" ? `Yes (${r.traumaLevel || "?"})` : "No", r.burn, r.helipad]), "Hospitals"));
    push(`Aviation Assets Utilized for Rescue: ${ics206.aviationAssets ? "Yes" : "No"}`, "H", 9);
  push("Special Medical Emergency Procedures:", "HB", 9);
  wrapPush(L, ics206.procedures || "(none entered)");
  push(`Prepared By: ${ics206.preparedBy || "-"}   Approved By (Safety Officer): ${ics206.approvedBy || "-"}`);
  blank();
  }

  if (include("214")) {
  heading(L, "ICS-214 · Activity Logs");
  if (logs.length === 0) {
    push("(none entered)");
  } else {
    logs.forEach(l => {
      push(`${l.name || "Unnamed"} - ${l.position || "-"} (${l.agency || "-"})`, "HB", 9);
      L.push(...tableLines(["TIME", "ACTIVITY"], [80, 620],
        l.entries.slice().sort((a, b) => new Date(a.time) - new Date(b.time)).map(e => [fmtTimeShort(e.time), e.text])));
    });
  }
  }

  const nonImageAttachments = (attachments || []).filter(a => !(a.type || "").startsWith("image/"));
  if (nonImageAttachments.length > 0) {
    heading(L, "Attached Documents");
    L.push(...tableLines(["FILE NAME", "TYPE", "SIZE"], [400, 200, 112],
      nonImageAttachments.map(a => [a.name, a.type || "unknown", `${((a.size || 0) / 1024).toFixed(0)} KB`])));
  }
  return L;
}

// Byte-accurate PDF assembly. Content is built as an array of "parts"
// (ASCII strings + binary Uint8Arrays for the embedded image) rather
// than one big string, because a JS string containing raw bytes >127
// gets mangled by UTF-8 re-encoding when passed to Blob — binary data
// has to travel as an actual typed array, not characters in a string.
function buildSimplePdf(lines, logo, meta, attachmentImages = []) {
  // Landscape — swapped from the portrait 612x792 US Letter default —
  // gives tables meaningfully more horizontal room (content width goes
  // from ~532pt to ~712pt) at the cost of shorter pages, so text-heavy
  // sections paginate a bit more often. Every width below is computed
  // from PAGE_W/CONTENT_W rather than hardcoded, so this is the only
  // place orientation needs to change.
  const PAGE_W = 792, PAGE_H = 612, MARGIN_X = 40, MARGIN_BOTTOM = 46;
  // Header layout computed once, up front, so pagination (which needs
  // to know how much vertical space the header eats on page 1) and the
  // actual per-page drawing use the exact same numbers — previously
  // these were computed separately and could disagree, letting the
  // header text overlap the first line of content when no logo loaded.
  const drawH = logo ? 54 : 0;
  const drawW = logo ? drawH * (logo.width / logo.height) : 0;
  const textBottomOffset = 70; // below the "Started:" line (headerTop-60) with clearance
  const logoBottomOffset = logo ? drawH + 8 : 0;
  const ruleOffset = Math.max(textBottomOffset, logoBottomOffset);
  const HEADER_H = ruleOffset + 14;
  const MARGIN_TOP = PAGE_H - 42;
  const LH = { H: 12, HB: 14, heading: 20 };
  const RED = "0.769 0.204 0.122";
  const GREY = "0.72 0.72 0.72";

  const pages = [];
  let cur = [];
  let y = MARGIN_TOP - HEADER_H;
  const CONTENT_W = PAGE_W - 2 * MARGIN_X;
  const IMAGE_MAX_H = 300; // cap so one image can't eat an entire page (landscape pages are shorter, so this is smaller than it'd be in portrait)
  const IMAGE_GAP = 16;
  for (const ln of lines) {
    if (ln.kind === "image") {
      // Scale to fit the content width (never upscale past the
      // image's native size), then cap the height too. Images never
      // split across a page break — if it doesn't fit in what's left,
      // the whole thing moves to a fresh page instead of clipping.
      let scale = Math.min(CONTENT_W / ln.img.width, 1);
      let displayW = ln.img.width * scale;
      let displayH = ln.img.height * scale;
      if (displayH > IMAGE_MAX_H) {
        scale = IMAGE_MAX_H / ln.img.height;
        displayH = IMAGE_MAX_H;
        displayW = ln.img.width * scale;
      }
      const needed = displayH + IMAGE_GAP;
      if (y - needed < MARGIN_BOTTOM) { pages.push(cur); cur = []; y = MARGIN_TOP; }
      cur.push({ ...ln, y, displayW, displayH });
      y -= needed;
      continue;
    }
    const lh = LH[ln.kind === "heading" ? "heading" : ln.font] || 12;
    if (y - lh < MARGIN_BOTTOM) { pages.push(cur); cur = []; y = MARGIN_TOP; }
    cur.push({ ...ln, y });
    y -= lh;
  }
  pages.push(cur);
  // Attachment photos each get their own dedicated page, appended
  // after the flowing text content — counted into the total up front
  // so "Page X of Y" is correct on every page, including the text ones.
  const totalPages = pages.length + attachmentImages.length;

  const parts = [];
  let pos = 0;
  const push = (x) => { parts.push(x); pos += (typeof x === "string") ? x.length : x.byteLength; };

  push("%PDF-1.4\n");

  let nextId = 1;
  const reserve = () => nextId++;
  const catalogId = reserve();
  const pagesTreeId = reserve();
  const fontHId = reserve();
  const fontHBId = reserve();
  const resourcesId = reserve();
  const imageId = logo ? reserve() : null;
  const pageIds = pages.map(() => reserve());
  const contentIds = pages.map(() => reserve());
  const attImageIds = attachmentImages.map(() => reserve());
  const attPageIds = attachmentImages.map(() => reserve());
  const attContentIds = attachmentImages.map(() => reserve());
  // Inline images (e.g. the org chart) live inside the normal flowing
  // pages rather than getting a dedicated page of their own — found
  // by scanning the already-paginated lines so each gets a stable
  // index for its XObject name/id, referenced later when drawing.
  const inlineImageEntries = [];
  pages.forEach(pageLines => pageLines.forEach(ln => { if (ln.kind === "image") inlineImageEntries.push(ln); }));
  const inlineImageIds = inlineImageEntries.map(() => reserve());

  const offsets = {};
  const writeObj = (id, body) => {
    offsets[id] = pos;
    push(`${id} 0 obj\n`);
    body();
    push(`\nendobj\n`);
  };

  writeObj(fontHId, () => push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"));
  writeObj(fontHBId, () => push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>"));
  if (logo) {
    writeObj(imageId, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${logo.width} /Height ${logo.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${logo.rgb.byteLength} >>\nstream\n`);
      push(logo.rgb);
      push(`\nendstream`);
    });
  }
  attachmentImages.forEach((img, idx) => {
    writeObj(attImageIds[idx], () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${img.rgb.byteLength} >>\nstream\n`);
      push(img.rgb);
      push(`\nendstream`);
    });
  });
  inlineImageEntries.forEach((ln, idx) => {
    writeObj(inlineImageIds[idx], () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${ln.img.width} /Height ${ln.img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Length ${ln.img.rgb.byteLength} >>\nstream\n`);
      push(ln.img.rgb);
      push(`\nendstream`);
    });
  });
  const xobjectEntries = [
    logo ? `/Logo ${imageId} 0 R` : "",
    ...attachmentImages.map((_, idx) => `/AttImg${idx} ${attImageIds[idx]} 0 R`),
    ...inlineImageEntries.map((_, idx) => `/InlineImg${idx} ${inlineImageIds[idx]} 0 R`),
  ].filter(Boolean).join(" ");
  const resourcesDict = xobjectEntries
    ? `<< /Font << /FH ${fontHId} 0 R /FHB ${fontHBId} 0 R >> /XObject << ${xobjectEntries} >> >>`
    : `<< /Font << /FH ${fontHId} 0 R /FHB ${fontHBId} 0 R >> >>`;
  writeObj(resourcesId, () => push(resourcesDict));

  let inlineImgCounter = 0;
  pages.forEach((pageLines, i) => {
    let stream = "";
    if (i === 0) {
      const headerTop = PAGE_H - 40;
      if (logo) {
        stream += `q ${drawW.toFixed(1)} 0 0 ${drawH.toFixed(1)} ${MARGIN_X} ${(headerTop - drawH).toFixed(1)} cm /Logo Do Q\n`;
      }
      stream += "BT\n";
      const textX = MARGIN_X + drawW + (logo ? 14 : 0);
      stream += `/FHB 18 Tf\n1 0 0 1 ${textX} ${(headerTop - 16).toFixed(1)} Tm\n(COMMAND BOARD) Tj\n`;
      stream += `/FH 9 Tf\n1 0 0 1 ${textX} ${(headerTop - 30).toFixed(1)} Tm\n(Incident Action Plan Packet) Tj\n`;
      stream += `/FHB 12 Tf\n1 0 0 1 ${textX} ${(headerTop - 46).toFixed(1)} Tm\n(${pdfEscape(meta.name || "Untitled Incident")}) Tj\n`;
      if (meta.started) {
        stream += `/FH 9 Tf\n1 0 0 1 ${textX} ${(headerTop - 60).toFixed(1)} Tm\n(Started: ${pdfEscape(meta.started)}) Tj\n`;
      }
      stream += "ET\n";
      stream += `${RED} RG 1.4 w ${MARGIN_X} ${(headerTop - ruleOffset).toFixed(1)} m ${PAGE_W - MARGIN_X} ${(headerTop - ruleOffset).toFixed(1)} l S\n`;
    }

    stream += "BT\n";
    for (const ln of pageLines) {
      if (ln.kind === "image") {
        stream += "ET\n";
        const x = MARGIN_X + (CONTENT_W - ln.displayW) / 2;
        const yBottom = ln.y - ln.displayH;
        stream += `q ${ln.displayW.toFixed(1)} 0 0 ${ln.displayH.toFixed(1)} ${x.toFixed(1)} ${yBottom.toFixed(1)} cm /InlineImg${inlineImgCounter} Do Q\n`;
        inlineImgCounter++;
        stream += "BT\n";
        continue;
      }
      if (ln.kind === "rule") {
        stream += "ET\n";
        stream += `${GREY} RG 0.6 w ${MARGIN_X} ${(ln.y + 3).toFixed(1)} m ${MARGIN_X + ln.width} ${(ln.y + 3).toFixed(1)} l S\n`;
        stream += "BT\n";
        continue;
      }
      if (ln.kind === "heading") {
        stream += `/FHB 12 Tf\n1 0 0 1 ${MARGIN_X} ${ln.y.toFixed(1)} Tm\n(${pdfEscape(ln.text)}) Tj\n`;
        stream += "ET\n";
        stream += `${RED} RG 1 w ${MARGIN_X} ${(ln.y - 4).toFixed(1)} m ${PAGE_W - MARGIN_X} ${(ln.y - 4).toFixed(1)} l S\n`;
        stream += "BT\n";
        continue;
      }
      if (ln.kind === "row") {
        for (const cell of ln.cells) {
          if (cell.segments) {
            // Draw each segment left-to-right, switching font per
            // segment and advancing x by the same average-char-width
            // estimate fitText uses elsewhere, so bold and regular
            // runs sit flush against each other with no visible gap.
            let curX = MARGIN_X + cell.x;
            for (const seg of cell.segments) {
              const segFontKey = seg.bold ? "FHB" : "FH";
              stream += `/${segFontKey} ${ln.size} Tf\n1 0 0 1 ${curX.toFixed(1)} ${ln.y.toFixed(1)} Tm\n(${pdfEscape(seg.text)}) Tj\n`;
              curX += seg.text.length * ln.size * (AVG_CHAR_W[seg.bold ? "HB" : "H"] || 0.5);
            }
            continue;
          }
          const fontKey = ln.font === "HB" ? "FHB" : "FH";
          stream += `/${fontKey} ${ln.size} Tf\n1 0 0 1 ${MARGIN_X + cell.x} ${ln.y.toFixed(1)} Tm\n(${pdfEscape(cell.text)}) Tj\n`;
        }
        continue;
      }
      const fontKey = ln.font === "HB" ? "FHB" : "FH";
      stream += `/${fontKey} ${ln.size} Tf\n1 0 0 1 ${MARGIN_X} ${ln.y.toFixed(1)} Tm\n(${pdfEscape(ln.text)}) Tj\n`;
    }
    stream += `/FH 8 Tf\n1 0 0 1 ${PAGE_W / 2 - 40} 24 Tm\n(Page ${i + 1} of ${totalPages}) Tj\n`;
    stream += "ET";

    writeObj(contentIds[i], () => push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    writeObj(pageIds[i], () => push(`<< /Type /Page /Parent ${pagesTreeId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resourcesId} 0 R /Contents ${contentIds[i]} 0 R >>`));
  });

  attachmentImages.forEach((img, idx) => {
    const availW = PAGE_W - 2 * MARGIN_X;
    const availH = PAGE_H - 100;
    const scale = Math.min(availW / img.width, availH / img.height);
    const drawImgW = img.width * scale, drawImgH = img.height * scale;
    const x = MARGIN_X + (availW - drawImgW) / 2;
    const y = PAGE_H - 50 - drawImgH;
    let stream = `q ${drawImgW.toFixed(1)} 0 0 ${drawImgH.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)} cm /AttImg${idx} Do Q\n`;
    stream += "BT\n";
    stream += `/FHB 10 Tf\n1 0 0 1 ${MARGIN_X} ${(y - 18).toFixed(1)} Tm\n(${pdfEscape(img.caption || "Attachment")}) Tj\n`;
    stream += `/FH 8 Tf\n1 0 0 1 ${PAGE_W / 2 - 40} 24 Tm\n(Page ${pages.length + idx + 1} of ${totalPages}) Tj\n`;
    stream += "ET";
    writeObj(attContentIds[idx], () => push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
    writeObj(attPageIds[idx], () => push(`<< /Type /Page /Parent ${pagesTreeId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources ${resourcesId} 0 R /Contents ${attContentIds[idx]} 0 R >>`));
  });

  writeObj(pagesTreeId, () => push(`<< /Type /Pages /Kids [${[...pageIds, ...attPageIds].map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length + attPageIds.length} >>`));
  writeObj(catalogId, () => push(`<< /Type /Catalog /Pages ${pagesTreeId} 0 R >>`));

  const xrefStart = pos;
  push(`xref\n0 ${nextId}\n0000000000 65535 f \n`);
  for (let id = 1; id < nextId; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${nextId} /Root ${catalogId} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

  return parts;
}

// Decodes the embedded KFD patch PNG into raw RGB pixel bytes via an
// offscreen canvas — needed because the hand-built PDF above embeds
// the image as a raw DeviceRGB stream rather than relying on a PDF
// library to handle PNG decoding for us.
/* ============================================================
   ORG CHART -> PDF: draws the same tree the on-screen diagram shows
   onto an offscreen canvas, then feeds it through the same
   image-embedding pipeline built for attachment photos (see
   loadLogoRGB / the attachmentImages param on buildSimplePdf) —
   the hand-built PDF writer has no way to render an HTML/CSS
   flowchart directly, so rendering it as an image is the only path.
   ============================================================ */
const ORG_BOX_W = 150, ORG_BOX_H = 56, ORG_GAP_X = 18, ORG_LEVEL_H = 88;

// Recursive layout: positions a node's box and, if it has children,
// their boxes and the connector lines to them — centering each parent
// over the full width of its children's combined subtrees (not just
// their box positions), so multi-level branches stay properly aligned.
function layoutOrgTree(node, depth) {
  if (!node.children || node.children.length === 0) {
    return { width: ORG_BOX_W, maxDepth: depth, boxes: [{ node, x: 0, y: depth * ORG_LEVEL_H }], lines: [] };
  }
  let childX = 0;
  const childResults = [];
  for (const child of node.children) {
    const r = layoutOrgTree(child, depth + 1);
    childResults.push({ r, offsetX: childX });
    childX += r.width + ORG_GAP_X;
  }
  const totalChildWidth = childX - ORG_GAP_X;
  const width = Math.max(ORG_BOX_W, totalChildWidth);
  const childrenStartX = (width - totalChildWidth) / 2;
  const boxes = [{ node, x: (width - ORG_BOX_W) / 2, y: depth * ORG_LEVEL_H }];
  const lines = [];
  let maxDepth = depth;
  const parentCenterX = width / 2;
  const parentBottomY = depth * ORG_LEVEL_H + ORG_BOX_H;
  for (const { r, offsetX } of childResults) {
    const shiftedBoxes = r.boxes.map(b => ({ ...b, x: b.x + childrenStartX + offsetX }));
    const shiftedLines = r.lines.map(l => ({ x1: l.x1 + childrenStartX + offsetX, y1: l.y1, x2: l.x2 + childrenStartX + offsetX, y2: l.y2 }));
    boxes.push(...shiftedBoxes);
    lines.push(...shiftedLines);
    maxDepth = Math.max(maxDepth, r.maxDepth);
    const childBoxX = shiftedBoxes[0].x + ORG_BOX_W / 2;
    const childBoxY = shiftedBoxes[0].y;
    // T-connector: down from parent, across, down into the child —
    // matches the on-screen diagram's connector style.
    lines.push({ x1: parentCenterX, y1: parentBottomY, x2: parentCenterX, y2: parentBottomY + 15 });
    lines.push({ x1: parentCenterX, y1: parentBottomY + 15, x2: childBoxX, y2: parentBottomY + 15 });
    lines.push({ x1: childBoxX, y1: parentBottomY + 15, x2: childBoxX, y2: childBoxY });
  }
  return { width, maxDepth, boxes, lines };
}

// Combines IC/Deputy IC, the Command Staff row, and each Section
// Chief's (possibly deep) subtree into one full-chart layout.
function layoutFullOrgChart(org) {
  const csBoxes = org.commandStaff.map((cs, i) => ({ node: cs, x: i * (ORG_BOX_W + ORG_GAP_X), y: 0 }));
  const csWidth = org.commandStaff.length > 0 ? org.commandStaff.length * ORG_BOX_W + (org.commandStaff.length - 1) * ORG_GAP_X : 0;

  const sectionResults = org.sections.map(s => layoutOrgTree(s, 0));
  const groups = [];
  if (csWidth > 0) groups.push({ width: csWidth, boxes: csBoxes, lines: [], maxDepth: 0 });
  groups.push(...sectionResults);

  const GROUP_GAP = 40;
  let curX = 0;
  const allBoxes = [];
  const allLines = [];
  let maxDepth = 0;
  const groupCenters = [];
  for (const g of groups) {
    allBoxes.push(...g.boxes.map(b => ({ ...b, x: b.x + curX })));
    allLines.push(...(g.lines || []).map(l => ({ x1: l.x1 + curX, y1: l.y1, x2: l.x2 + curX, y2: l.y2 })));
    maxDepth = Math.max(maxDepth, g.maxDepth);
    groupCenters.push(curX + g.width / 2);
    curX += g.width + GROUP_GAP;
  }
  const rowWidth = groups.length > 0 ? curX - GROUP_GAP : 0;

  const hasDeputy = !!org.deputyIc;
  const icGroupWidth = hasDeputy ? ORG_BOX_W * 2 + ORG_GAP_X : ORG_BOX_W;
  const totalWidth = Math.max(rowWidth, icGroupWidth);
  const rowOffsetX = (totalWidth - rowWidth) / 2;
  const icOffsetX = (totalWidth - icGroupWidth) / 2;

  const IC_ROW_H = ORG_BOX_H + 70; // IC box height + connector space down to the next row
  const finalBoxes = allBoxes.map(b => ({ ...b, x: b.x + rowOffsetX, y: b.y + IC_ROW_H }));
  const finalLines = allLines.map(l => ({ x1: l.x1 + rowOffsetX, y1: l.y1 + IC_ROW_H, x2: l.x2 + rowOffsetX, y2: l.y2 + IC_ROW_H }));

  const icBoxes = [{ node: { title: "Incident Commander", name: org.ic }, x: icOffsetX, y: 0, isRoot: true }];
  if (hasDeputy) icBoxes.push({ node: { title: "Deputy IC", name: org.deputyIc }, x: icOffsetX + ORG_BOX_W + ORG_GAP_X, y: 0, isRoot: true });

  const icCenterX = icOffsetX + icGroupWidth / 2;
  const barY = ORG_BOX_H + 35;
  const connectorLines = [{ x1: icCenterX, y1: ORG_BOX_H, x2: icCenterX, y2: barY }];
  if (groupCenters.length > 0) {
    const firstCenter = groupCenters[0] + rowOffsetX;
    const lastCenter = groupCenters[groupCenters.length - 1] + rowOffsetX;
    connectorLines.push({ x1: firstCenter, y1: barY, x2: lastCenter, y2: barY });
    for (const gc of groupCenters) {
      const x = gc + rowOffsetX;
      connectorLines.push({ x1: x, y1: barY, x2: x, y2: barY + 35 });
    }
  }

  return {
    boxes: [...icBoxes, ...finalBoxes],
    lines: [...connectorLines, ...finalLines],
    width: totalWidth,
    height: IC_ROW_H + (maxDepth + 1) * ORG_LEVEL_H,
  };
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  const lines = [];
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  lines.slice(0, 2).forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight));
  return lines.length;
}

// Renders the layout to an offscreen canvas and returns a PNG data
// URI — plain black/grey ink on white, matching print conventions
// (the on-screen dark theme's colors aren't meant for paper).
function renderOrgChartDataUri(org) {
  const hasAnyContent = org.ic || org.deputyIc || org.commandStaff.some(c => c.name) || org.sections.some(s => s.name || (s.children && s.children.length));
  if (!hasAnyContent) return null;
  const layout = layoutFullOrgChart(org);
  const PADDING = 24;
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(layout.width + PADDING * 2);
  canvas.height = Math.ceil(layout.height + PADDING * 2);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "#9AA0A6";
  ctx.lineWidth = 1.5;
  layout.lines.forEach(l => {
    ctx.beginPath();
    ctx.moveTo(l.x1 + PADDING, l.y1 + PADDING);
    ctx.lineTo(l.x2 + PADDING, l.y2 + PADDING);
    ctx.stroke();
  });

  layout.boxes.forEach(b => {
    const x = b.x + PADDING, y = b.y + PADDING;
    ctx.fillStyle = b.isRoot ? "#F0F0F0" : "#FFFFFF";
    ctx.strokeStyle = b.isRoot ? "#96690F" : "#9AA0A6";
    ctx.lineWidth = b.isRoot ? 2 : 1.5;
    const r = 5;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + ORG_BOX_W, y, x + ORG_BOX_W, y + ORG_BOX_H, r);
    ctx.arcTo(x + ORG_BOX_W, y + ORG_BOX_H, x, y + ORG_BOX_H, r);
    ctx.arcTo(x, y + ORG_BOX_H, x, y, r);
    ctx.arcTo(x, y, x + ORG_BOX_W, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = "center";
    ctx.fillStyle = "#96690F";
    ctx.font = "bold 10px Arial, sans-serif";
    wrapCanvasText(ctx, (b.node.title || "").toUpperCase(), x + ORG_BOX_W / 2, y + 16, ORG_BOX_W - 12, 11);

    ctx.fillStyle = "#191C1F";
    ctx.font = "12px Arial, sans-serif";
    ctx.fillText(b.node.name || "(vacant)", x + ORG_BOX_W / 2, y + ORG_BOX_H - 12);
  });

  return canvas.toDataURL("image/png");
}

function loadLogoRGB(dataUri, maxDim = 130) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const rgb = new Uint8Array(w * h * 3);
        for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
          rgb[j] = data[i]; rgb[j + 1] = data[i + 1]; rgb[j + 2] = data[i + 2];
        }
        resolve({ width: w, height: h, rgb });
      };
      img.onerror = () => resolve(null);
      img.src = dataUri;
    } catch { resolve(null); }
  });
}

async function downloadPacketPdf(data) {
  const logo = await loadLogoRGB(KFD_PATCH_DATA_URI);
  const inc = data.incident || {};
  const started = [inc.dateInitiated, inc.timeInitiated].filter(Boolean).join(" ") || (inc.opStart ? new Date(inc.opStart).toLocaleString() : "");
  // Image attachments get decoded and embedded as their own pages;
  // non-image attachments (PDFs, Word docs, etc.) are listed by name
  // in the report body instead (buildPacketLines handles that part —
  // see the "attachments" list passed through in `data`).
  const imageAttachments = (data.attachments || []).filter(a => (a.type || "").startsWith("image/"));
  const attachmentImages = [];
  // The org chart diagram is decoded here (this is the browser-only
  // step) and handed to buildPacketLines as an INLINE image placed
  // right under "9. Current Organization" — unlike attachment photos,
  // it doesn't get a trailing page of its own. Always included, not
  // gated by a checkbox, matching the text org summary next to it.
  const orgChartDataUri = renderOrgChartDataUri(normalizeOrg(data.org));
  const orgChartImage = orgChartDataUri ? await loadLogoRGB(orgChartDataUri, 1400) : null;
  for (const a of imageAttachments) {
    const decoded = await loadLogoRGB(`data:${a.type};base64,${a.dataBase64}`, 1000);
    if (decoded) attachmentImages.push({ ...decoded, caption: a.name });
  }
  const parts = buildSimplePdf(buildPacketLines({ ...data, orgChartImage }), logo, { name: inc.name, started }, attachmentImages);
  const blob = new Blob(parts, { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const safeName = (data.incident.name || "incident").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  a.download = `${safeName}-ics-packet.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function PrintView({ incident, resources, comms, org, safety, logs }) {
  return (
    <div className="print-only" style={{ color: "#111", background: "#fff", padding: 24, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      <h1 style={{ fontFamily: "'Oswald', sans-serif" }}>ICS-201 · Incident Briefing</h1>
      <p><b>Incident:</b> {incident.name} &nbsp; <b>#</b> {incident.number} &nbsp; <b>Type:</b> {incident.type}</p>
      <p><b>Location:</b> {incident.location}</p>
      <p><b>IC:</b> {incident.icName} &nbsp; <b>Prepared By:</b> {incident.preparedBy} &nbsp; <b>Op Period Start:</b> {fmtClock(incident.opStart)} {fmtDate(incident.opStart)}</p>
      <p><b>Wind:</b> {incident.wind} &nbsp; <b>Temp:</b> {incident.temp} &nbsp; <b>RH:</b> {incident.rh}</p>
      <p><b>Conditions:</b> {incident.conditions}</p>
      <p><b>Situation:</b> {incident.situation}</p>
      <p><b>Safety Message:</b> {incident.safetyMessage}</p>
      <b>Objectives:</b>
      <ol>{incident.objectives.filter(Boolean).map((o, i) => <li key={i}>{o}</li>)}</ol>

      <h2>Resource Summary</h2>
      <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th>Unit</th><th>Type</th><th>Pers.</th><th>Status</th><th>Assignment</th></tr></thead>
        <tbody>{resources.map(r => <tr key={r.id}><td>{r.label}</td><td>{r.kind}</td><td>{r.personnel}</td><td>{r.status}</td><td>{r.assignment}</td></tr>)}</tbody>
      </table>

      <h2>Command Structure</h2>
      <ul>{flattenOrgFilled(org).map((item, i) => <li key={i}>{item.title}: {item.name}</li>)}</ul>

      <h2>ICS-205 Communications Plan</h2>
      <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th>Ch#</th><th>Function</th><th>Channel Name</th><th>Assignment</th><th>RX</th><th>TX</th><th>Mode</th><th>Remarks</th></tr></thead>
        <tbody>{comms.rows.map(c => <tr key={c.id}><td>{c.chNum}</td><td>{c.func}</td><td>{c.channelName}</td><td>{c.assignment}</td><td>{c.rxFreq}</td><td>{c.txFreq}</td><td>{c.mode}</td><td>{c.remarks}</td></tr>)}</tbody>
      </table>

      <h2>ICS-215A Incident Action Plan Safety Analysis</h2>
      <p><b>Incident Name:</b> {incident.name} &nbsp; <b>Incident #:</b> {incident.number}</p>
      <p><b>Operational Period:</b> {safety.opFrom} &nbsp;to&nbsp; {safety.opTo}</p>
      <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th>Branch</th><th>Division/Group</th><th>Hazards/Risks</th><th>Mitigations for Identified Hazards</th></tr></thead>
        <tbody>{safety.rows.map(r => <tr key={r.id}><td>{r.branch}</td><td>{r.division}</td><td>{r.hazards}</td><td>{r.mitigations}</td></tr>)}</tbody>
      </table>
      <p><b>Prepared By:</b> {safety.preparedBy} &nbsp; <b>Position/Title:</b> {safety.position} &nbsp; <b>Signature:</b> {safety.signature} &nbsp; <b>Date/Time:</b> {safety.dateTime}</p>

      <h2>ICS-214 Activity Logs</h2>
      {logs.map(l => (
        <div key={l.id} style={{ marginBottom: 12 }}>
          <p><b>{l.name}</b> — {l.position} ({l.agency})</p>
          <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
            <thead><tr><th style={{ width: 90 }}>Time</th><th>Activity</th></tr></thead>
            <tbody>{l.entries.slice().sort((a, b) => new Date(a.time) - new Date(b.time)).map(e => <tr key={e.id}><td>{fmtTime(e.time)}</td><td>{e.text}</td></tr>)}</tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

/* ============================================================
   INCIDENT LIBRARY (load/save/new)
   ============================================================ */
function ChangePinModal({ onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState(""); // "" | "saving" | "done"

  const submit = async () => {
    setError("");
    const cfg = await loadPinConfig();
    const currentHash = await sha256(current);
    if (!cfg || currentHash !== cfg.pinHash) { setError("Incorrect current PIN."); return; }
    if (next.length < 4) { setError("New PIN must be at least 4 digits."); return; }
    if (next !== confirm) { setError("New PINs don't match."); return; }
    setStatus("saving");
    const nextHash = await sha256(next);
    await savePinConfig({ ...cfg, pinHash: nextHash });
    localStorage.setItem("cb_unlocked_hash", nextHash);
    setStatus("done");
    setTimeout(onClose, 900);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Change PIN</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        {status === "done" ? (
          <div style={{ color: COLORS.teal, fontSize: 13, textAlign: "center", padding: "10px 0" }}>PIN updated.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Current PIN">
              <TextInput type="password" inputMode="numeric" value={current} onChange={e => setCurrent(e.target.value.replace(/\D/g, ""))} maxLength={12} />
            </Field>
            <Field label="New PIN">
              <TextInput type="password" inputMode="numeric" value={next} onChange={e => setNext(e.target.value.replace(/\D/g, ""))} maxLength={12} />
            </Field>
            <Field label="Confirm New PIN">
              <TextInput type="password" inputMode="numeric" value={confirm} onChange={e => setConfirm(e.target.value.replace(/\D/g, ""))} maxLength={12}
                onKeyDown={e => e.key === "Enter" && submit()} />
            </Field>
            {error && <div style={{ color: COLORS.dangerText, fontSize: 12 }}>{error}</div>}
            <Btn kind="solid" onClick={submit} disabled={status === "saving"} style={{ justifyContent: "center" }}>
              {status === "saving" ? "Saving…" : "Save New PIN"}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// Mirrors ChangePinModal above, but targets the archive's separate
// password (archivePinHash) rather than the board's main PIN — kept as
// its own component since the two are genuinely different credentials.
function ChangeArchivePasswordModal({ onClose }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState(""); // "" | "saving" | "done"

  const submit = async () => {
    setError("");
    const cfg = await loadPinConfig();
    const currentHash = await sha256(current);
    if (!cfg || currentHash !== cfg.archivePinHash) { setError("Incorrect current archive password."); return; }
    if (next.length < 4) { setError("New password must be at least 4 characters."); return; }
    if (next !== confirm) { setError("New passwords don't match."); return; }
    setStatus("saving");
    const nextHash = await sha256(next);
    await savePinConfig({ ...cfg, archivePinHash: nextHash });
    localStorage.setItem(ARCHIVE_UNLOCK_KEY, nextHash);
    setStatus("done");
    setTimeout(onClose, 900);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>Change Archive Password</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        {status === "done" ? (
          <div style={{ color: COLORS.teal, fontSize: 13, textAlign: "center", padding: "10px 0" }}>Archive password updated.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <Field label="Current Archive Password">
              <TextInput type="password" value={current} onChange={e => setCurrent(e.target.value)} />
            </Field>
            <Field label="New Archive Password">
              <TextInput type="password" value={next} onChange={e => setNext(e.target.value)} />
            </Field>
            <Field label="Confirm New Password">
              <TextInput type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                onKeyDown={e => e.key === "Enter" && submit()} />
            </Field>
            {error && <div style={{ color: COLORS.dangerText, fontSize: 12 }}>{error}</div>}
            <Btn kind="solid" onClick={submit} disabled={status === "saving"} style={{ justifyContent: "center" }}>
              {status === "saving" ? "Saving…" : "Save New Password"}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

// Generic password gate for a destructive/protected action — checks
// against the same archivePinHash used to view archived incidents,
// rather than a separate credential. If no archive password has ever
// been set, the action can't be confirmed (nothing to check against)
// rather than silently allowing it through unprotected.
function PasswordConfirmModal({ title, message, onConfirm, onCancel }) {
  const [phase, setPhase] = useState("loading"); // loading | notSet | prompt
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    (async () => {
      const cfg = await loadPinConfig();
      setPhase(cfg && cfg.archivePinHash ? "prompt" : "notSet");
    })();
  }, []);

  const submit = async () => {
    setError("");
    setChecking(true);
    const cfg = await loadPinConfig();
    const hash = await sha256(pin);
    setChecking(false);
    if (cfg && cfg.archivePinHash && hash === cfg.archivePinHash) {
      onConfirm();
    } else {
      setError("Incorrect archive password.");
      setPin("");
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 70 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 320, padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 14 }}>{title}</span>
          <button onClick={onCancel} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={16} /></button>
        </div>
        {phase === "loading" && <div style={{ color: COLORS.muted, fontSize: 13 }}>Loading…</div>}
        {phase === "notSet" && (
          <div style={{ fontSize: 12.5, color: COLORS.muted, lineHeight: 1.5 }}>
            No archive password has been set yet, so this action can't be confirmed. Set one first from "View Archived Incidents" in the library.
          </div>
        )}
        {phase === "prompt" && (
          <>
            <p style={{ fontSize: 12.5, color: COLORS.muted, marginTop: 0, lineHeight: 1.5 }}>{message}</p>
            <TextInput type="password" autoFocus placeholder="Archive password" value={pin} onChange={e => setPin(e.target.value)} style={{ width: "100%" }}
              onKeyDown={e => e.key === "Enter" && submit()} />
            <Btn kind="solid" onClick={submit} disabled={checking} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>
              {checking ? "Checking…" : "Confirm"}
            </Btn>
            {error && <div style={{ color: COLORS.dangerText, fontSize: 12.5, marginTop: 10, textAlign: "center" }}>{error}</div>}
          </>
        )}
      </div>
    </div>
  );
}

function LibraryModal({ index, onClose, onLoad, onNew, onDelete, onArchive, onOpenArchive, mandatory }) {
  const active = index.filter(i => !i.archived);
  const archivedCount = index.length - active.length;
  const [confirmAction, setConfirmAction] = useState(null); // { type: "archive" | "delete", id, name }
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 480, maxHeight: "80vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${COLORS.line}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img src={KFD_PATCH_DATA_URI} alt="KFD Patch" style={{ width: 26, height: 34, objectFit: "contain", flexShrink: 0 }} />
            <div>
              <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 14, letterSpacing: "0.03em", lineHeight: 1.1 }}>COMMAND BOARD</div>
              <div style={{ fontSize: 9, color: COLORS.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>Incident Management System</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 11, color: COLORS.muted, letterSpacing: "0.05em", textTransform: "uppercase" }}>Incident Library</span>
            {!mandatory && <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>}
          </div>
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 12, lineHeight: 1.5 }}>
            {mandatory ? "Select an incident to open, or start a new one." : "Shared board — visible and editable by anyone who opens this app. Changes sync to other users within a few seconds."}
          </div>
          <Btn kind="solid" icon={Plus} onClick={() => setConfirmAction({ type: "new" })} style={{ marginBottom: 14, width: "100%", justifyContent: "center" }}>Start New Incident</Btn>
          {active.length === 0 && <div style={{ color: COLORS.faint, fontSize: 13 }}>No active incidents.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {active.map(item => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 5, padding: "9px 12px" }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{item.name || "Unnamed Incident"}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>{item.type} · {fmtDate(item.savedAt)}</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn kind="subtle" onClick={() => onLoad(item.id)} style={{ padding: "5px 9px", fontSize: 12 }}>Open</Btn>
                  <Btn kind="ghost" onClick={() => setConfirmAction({ type: "archive", id: item.id, name: item.name })} title="Archive" style={{ padding: "5px 9px", fontSize: 12 }}><Archive size={13} /></Btn>
                  <Btn kind="danger" onClick={() => setConfirmAction({ type: "delete", id: item.id, name: item.name })} style={{ padding: "5px 9px", fontSize: 12 }}><Trash2 size={13} /></Btn>
                </div>
              </div>
            ))}
          </div>
          <div style={{ borderTop: `1px solid ${COLORS.line}`, marginTop: 16, paddingTop: 12 }}>
            <Btn kind="ghost" icon={Archive} onClick={onOpenArchive} style={{ width: "100%", justifyContent: "center", fontSize: 12.5 }}>
              View Archived Incidents{archivedCount > 0 ? ` (${archivedCount})` : ""}
            </Btn>
          </div>
        </div>
      </div>

      {confirmAction && (
        <PasswordConfirmModal
          title={confirmAction.type === "archive" ? "Confirm Archive" : confirmAction.type === "delete" ? "Confirm Delete" : "Confirm New Incident"}
          message={
            confirmAction.type === "archive"
              ? `Enter the archive password to archive "${confirmAction.name || "Unnamed Incident"}".`
              : confirmAction.type === "delete"
                ? `Enter the archive password to permanently delete "${confirmAction.name || "Unnamed Incident"}". This can't be undone.`
                : "Enter the archive password to start a new incident."
          }
          onConfirm={() => {
            if (confirmAction.type === "archive") onArchive(confirmAction.id);
            else if (confirmAction.type === "delete") onDelete(confirmAction.id);
            else onNew();
            setConfirmAction(null);
          }}
          onCancel={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}

const ARCHIVE_UNLOCK_KEY = "cb_archive_unlocked_hash";

// Gated behind its own password (separate from the board's main PIN) —
// browsing here shows every archived incident with a one-click PDF
// export, or a restore button to bring it back into the active list.
function ArchiveModal({ index, onClose, onExport, onRestore, onChangePassword }) {
  const [phase, setPhase] = useState("loading"); // loading | setup | locked | browse
  const [config, setConfig] = useState(null);
  const [pin, setPin] = useState("");
  const [pin2, setPin2] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      const cfg = await loadPinConfig();
      setConfig(cfg);
      if (!cfg || !cfg.archivePinHash) { setPhase("setup"); return; }
      const remembered = localStorage.getItem(ARCHIVE_UNLOCK_KEY);
      setPhase(remembered === cfg.archivePinHash ? "browse" : "locked");
    })();
  }, []);

  const doSetup = async () => {
    setError("");
    if (pin.length < 4) return setError("Password must be at least 4 characters.");
    if (pin !== pin2) return setError("Passwords don't match.");
    const archivePinHash = await sha256(pin);
    await savePinConfig({ ...config, archivePinHash });
    localStorage.setItem(ARCHIVE_UNLOCK_KEY, archivePinHash);
    setPhase("browse");
  };
  const doUnlock = async () => {
    setError("");
    const hash = await sha256(pin);
    if (config && hash === config.archivePinHash) {
      localStorage.setItem(ARCHIVE_UNLOCK_KEY, hash);
      setPhase("browse");
    } else {
      setError("Incorrect password.");
      setPin("");
    }
  };

  const archived = index.filter(i => i.archived);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 420, maxHeight: "80vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${COLORS.line}` }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em" }}>Archived Incidents</span>
          <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>
        </div>
        <div style={{ padding: 16 }}>
          {phase === "loading" && <div style={{ color: COLORS.muted, fontSize: 13 }}>Loading…</div>}

          {(phase === "setup" || phase === "locked") && (
            <>
              <p style={{ fontSize: 12.5, color: COLORS.muted, lineHeight: 1.5, marginTop: 0 }}>
                {phase === "setup"
                  ? "No archive password is set yet. Choose one now — this is separate from the board's main PIN, and is only needed to view or export incidents that have been closed out."
                  : "Enter the archive password to view closed-out incidents."}
              </p>
              <TextInput type="password" autoFocus placeholder={phase === "setup" ? "New archive password" : "Archive password"} value={pin}
                onChange={e => setPin(e.target.value)} style={{ width: "100%" }}
                onKeyDown={e => e.key === "Enter" && phase === "locked" && doUnlock()} />
              {phase === "setup" && (
                <TextInput type="password" placeholder="Confirm password" value={pin2} onChange={e => setPin2(e.target.value)}
                  style={{ width: "100%", marginTop: 10 }}
                  onKeyDown={e => e.key === "Enter" && doSetup()} />
              )}
              <Btn kind="solid" onClick={phase === "setup" ? doSetup : doUnlock} style={{ width: "100%", justifyContent: "center", marginTop: 12 }}>
                {phase === "setup" ? "Set Password & Continue" : "Unlock"}
              </Btn>
              {error && <div style={{ color: COLORS.dangerText, fontSize: 12.5, marginTop: 10, textAlign: "center" }}>{error}</div>}
            </>
          )}

          {phase === "browse" && (
            <>
              {archived.length === 0 && <div style={{ color: COLORS.faint, fontSize: 13 }}>No archived incidents.</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {archived.map(item => (
                  <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 5, padding: "9px 12px" }}>
                    <div>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{item.name || "Unnamed Incident"}</div>
                      <div style={{ fontSize: 11, color: COLORS.muted }}>{item.type} · archived {fmtDate(item.archivedAt)}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      <Btn kind="subtle" onClick={() => onExport(item.id)} style={{ padding: "5px 9px", fontSize: 12 }}>Export PDF</Btn>
                      <Btn kind="ghost" onClick={() => onRestore(item.id)} title="Restore to active" style={{ padding: "5px 9px", fontSize: 12 }}><RotateCcw size={13} /></Btn>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ borderTop: `1px solid ${COLORS.line}`, marginTop: 14, paddingTop: 12 }}>
                <Btn kind="ghost" onClick={onChangePassword} style={{ width: "100%", justifyContent: "center", fontSize: 12 }}>
                  Change Archive Password
                </Btn>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   APP
   ============================================================ */
const TABS = [
  { k: "201", label: "Tactical Worksheet", icon: ClipboardList },
  { k: "resources", label: "Resource Board", icon: Truck },
  { k: "mapping", label: "Mapping", icon: MapIcon },
  { k: "org", label: "Org Chart", icon: Users },
  { k: "rehab", label: "Rehab", icon: HeartPulse },
  { k: "icsforms", label: "ICS Forms", icon: Layers },
  { k: "attachments", label: "Attachments", icon: Paperclip },
];

// Rendered at the very top of the tree, outside PinGate, so the dark
// theme's page reset (no white margin/background) is active even
// before the PIN gate decides what to show — otherwise the browser's
// default white body margin is visible around the lock screen.
function GlobalStyles() {
  return (
    <style>{`
      ${THEME_CSS}
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
      * { box-sizing: border-box; }
      html, body, #root { margin: 0; padding: 0; min-height: 100%; background: ${COLORS.bg}; }
      select { -webkit-appearance: none; }
      input:focus, textarea:focus, select:focus { border-color: ${COLORS.amber} !important; }
      /* Native date/time picker icons default to a dark glyph — fine
         against our dark theme's inputs, but wrong (invisible) against
         light theme's, so both the color-scheme and the icon invert
         follow the active theme via CSS variables instead of being
         hardcoded to dark. */
      input[type="date"]::-webkit-calendar-picker-indicator,
      input[type="time"]::-webkit-calendar-picker-indicator,
      input[type="datetime-local"]::-webkit-calendar-picker-indicator {
        filter: invert(var(--cb-picker-invert));
        cursor: pointer;
      }
      input[type="date"], input[type="time"], input[type="datetime-local"] {
        color-scheme: var(--cb-picker-scheme);
      }
      ::-webkit-scrollbar { height: 8px; width: 8px; }
      ::-webkit-scrollbar-thumb { background: ${COLORS.line}; border-radius: 4px; }
      .print-only { display: none; }
      @media print {
        .no-print { display: none !important; }
        .print-only { display: block !important; }
      }
    `}</style>
  );
}

export default function App() {
  // Lives above PinGate (not inside AppInner) so the chosen theme is
  // already applied — via the data-theme attribute on <html>, which
  // every COLORS.xxx reference resolves through via CSS variables —
  // before the lock screen itself even renders, not just after unlock.
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("cb-theme") || "dark"; } catch { return "dark"; }
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem("cb-theme", theme); } catch { /* private browsing, etc. — theme just won't persist */ }
  }, [theme]);
  const toggleTheme = () => setTheme(t => t === "dark" ? "light" : "dark");

  return (
    <>
      <GlobalStyles />
      <PinGate>
        {(lock) => <AppInner onLock={lock} theme={theme} toggleTheme={toggleTheme} />}
      </PinGate>
    </>
  );
}

// Tracks browser connectivity so the UI can tell the crew when they're
// on cached/offline data versus live. navigator.onLine reflects network
// interface state, not whether Firestore specifically can reach its
// servers, but it's a reliable enough signal for this purpose.
function useOnlineStatus() {
  const [online, setOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);
  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);
  return online;
}

function AppInner({ onLock, theme, toggleTheme }) {
  const online = useOnlineStatus();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("201");
  const [showLib, setShowLib] = useState(false);
  const [showChangePin, setShowChangePin] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [showChangeArchivePassword, setShowChangeArchivePassword] = useState(false);
  const [presets, setPresets] = useState({ departments: [], objectives: [], assignments: [], resourceKinds: [] });
  const [formsUsed, setFormsUsed] = useState({});
  const [attachments, setAttachments] = useState([]);
  const toggleFormUsed = (key) => setFormsUsed(f => ({ ...f, [key]: !f[key] }));
  const [incidentLoaded, setIncidentLoaded] = useState(false);
  const [index, setIndex] = useState([]);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const [now, setNow] = useState(Date.now());

  const [incident, setIncident] = useState(blankIncident());
  const [resources, setResources] = useState([]);
  const [org, setOrg] = useState({ positions: {}, divisions: [] });
  const [comms, setComms] = useState(defaultComms());
  const [safety, setSafety] = useState({ opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] });
  const [ics208, setIcs208] = useState(defaultIcs208());
  const [ics208hm, setIcs208hm] = useState(defaultIcs208HM());
  const [ics209, setIcs209] = useState(defaultIcs209());
  const [ics206, setIcs206] = useState(defaultIcs206());
  const [rehab, setRehab] = useState([]);
  const [mapData, setMapData] = useState(defaultMapData());
  const [logs, setLogs] = useState([]);

  const saveTimer = useRef(null);
  const lastKnownUpdatedAt = useRef(null);
  const dirty = useRef(false); // true while a local edit hasn't been written to shared storage yet
  // Set to true by applyBlob() every time it's called to LOAD data (opening
  // an incident, starting new, or receiving a real-time update from
  // another device) — never for a genuine local edit. The autosave effect
  // checks this and skips the very next save cycle when it's set. Without
  // this, simply opening an incident re-saves whatever was just loaded
  // back to Firestore (because `incidentLoaded` is one of autosave's
  // dependencies), which silently overwrites newer data with an older
  // cached copy on any device that hadn't synced recently — the exact
  // failure mode that caused entered data to be wiped out.
  const suppressNextAutosave = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    (async () => {
      const idx = await loadIndex();
      setIndex(idx);
      const p = await loadPresets();
      // Migrate the old flat unit list (before departments existed) into
      // a "General" department bucket, so nobody's already-saved units
      // silently disappear when this ships — they just land somewhere
      // reorganizable instead of a fixed department nobody chose.
      let departments = p.departments || [];
      if (!p.departments && p.units && p.units.length > 0) {
        departments = [{ id: uid(), name: "General", units: p.units }];
      }
      // Resource Type was a hardcoded, non-editable list before this —
      // seed it from that same list on first load so nothing changes
      // for anyone until they actually go edit it.
      const resourceKinds = p.resourceKinds && p.resourceKinds.length > 0 ? p.resourceKinds : RESOURCE_KINDS;
      setPresets({ departments, objectives: p.objectives || [], assignments: p.assignments || [], resourceKinds });
      setReady(true);
      setShowLib(true); // land on the incident library instead of auto-opening one
    })();
  }, []);

  // The incident's Date/Time Initiated is the starting point for every
  // ICS form's Operational Period — kept in sync with each form's
  // "From" field on every change. This always overwrites, by design:
  // if a specific form needs its own different operational period,
  // set it there AFTER the incident's initiated time is finalized, or
  // it'll get overwritten the next time Date/Time Initiated changes.
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    if (!incident.dateInitiated && !incident.timeInitiated) return;
    const combined = incident.dateInitiated ? `${incident.dateInitiated}T${incident.timeInitiated || "00:00"}` : "";
    if (!combined) return;
    setComms(c => ({ ...c, opFrom: combined }));
    setSafety(s => ({ ...s, opFrom: combined }));
    setIcs208(v => ({ ...v, opFrom: combined }));
    setIcs208hm(v => ({ ...v, opFrom: combined }));
    setIcs209(v => ({ ...v, opFrom: combined }));
    setIcs206(v => ({ ...v, opFrom: combined }));
  }, [incident.dateInitiated, incident.timeInitiated, ready, incidentLoaded]);

  // Same idea for "Operational Period To" — paired with Date/Time
  // Terminated, falling back to Date Initiated if Date Terminated
  // hasn't been filled in (covers the common same-day case). Always
  // overwrites on every change, same tradeoff as the "From" sync above.
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    const terminationDate = incident.dateTerminated || incident.dateInitiated;
    if (!terminationDate || !incident.timeTerminated) return;
    const combinedTo = `${terminationDate}T${incident.timeTerminated}`;
    setComms(c => ({ ...c, opTo: combinedTo }));
    setSafety(s => ({ ...s, opTo: combinedTo }));
    setIcs208(v => ({ ...v, opTo: combinedTo }));
    setIcs208hm(v => ({ ...v, opTo: combinedTo }));
    setIcs209(v => ({ ...v, opTo: combinedTo }));
    setIcs206(v => ({ ...v, opTo: combinedTo }));
  }, [incident.dateInitiated, incident.dateTerminated, incident.timeTerminated, ready, incidentLoaded]);

  // Keep ICS-201's Block 10 Resource Summary in sync with the Resource
  // Board: every checked-in resource gets (or keeps updated) a matching
  // row — Resource Identifier from its unit ID, Arrived always checked
  // with the check-in time standing in for arrival time, and Notes
  // reflecting its current assignment. Rows are matched by
  // sourceResourceId so a resource's row keeps updating as its
  // assignment changes, without disturbing any row someone added by
  // hand for something ordered but not yet on the board (those don't
  // have a sourceResourceId, so this loop never touches them). Existing
  // rows are updated in place rather than removed if a resource later
  // leaves the board, since an arrival record shouldn't disappear.
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    setIncident(inc => {
      const bySource = new Map(inc.resourceOrders.filter(r => r.sourceResourceId).map(r => [r.sourceResourceId, r]));
      let changed = false;
      const nextOrders = [...inc.resourceOrders];
      resources.forEach(r => {
        const arrivedTime = r.checkIn ? new Date(r.checkIn).toTimeString().slice(0, 5) : "";
        const existing = bySource.get(r.id);
        const synced = { resource: r.kind, identifier: r.label, eta: arrivedTime, arrived: true, notes: r.assignment || "", sourceResourceId: r.id };
        if (existing) {
          const idx = nextOrders.findIndex(o => o.id === existing.id);
          const updated = { ...existing, ...synced };
          if (updated.resource !== existing.resource || updated.identifier !== existing.identifier || updated.eta !== existing.eta || updated.arrived !== existing.arrived || updated.notes !== existing.notes) {
            nextOrders[idx] = updated;
            changed = true;
          }
        } else {
          nextOrders.push({ id: uid(), ordered: "", ...synced });
          changed = true;
        }
      });
      return changed ? { ...inc, resourceOrders: nextOrders } : inc;
    });
  }, [resources, ready, incidentLoaded]);

  // Returns the department's id synchronously (creating it if new) so
  // the picker can switch straight to it without waiting on the network
  // round-trip — the actual persist happens in the background.
  const saveDepartment = (name) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = presets.departments.find(d => d.name === trimmed);
    if (existing) return existing.id;
    const id = uid();
    const next = { ...presets, departments: [...presets.departments, { id, name: trimmed, units: [] }] };
    setPresets(next);
    savePresets(next);
    return id;
  };
  const saveUnitUnderDepartment = (deptId, unitName) => {
    const trimmed = unitName.trim();
    if (!deptId || !trimmed) return;
    const dept = presets.departments.find(d => d.id === deptId);
    if (!dept || dept.units.includes(trimmed)) return;
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, units: [...d.units, trimmed] } : d) };
    setPresets(next);
    savePresets(next);
  };
  const renameDepartment = (deptId, newName) => {
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, name: newName } : d) };
    setPresets(next);
    savePresets(next);
  };
  const deleteDepartment = (deptId) => {
    const next = { ...presets, departments: presets.departments.filter(d => d.id !== deptId) };
    setPresets(next);
    savePresets(next);
  };
  const renameUnit = (deptId, oldName, newName) => {
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, units: d.units.map(u => u === oldName ? newName : u) } : d) };
    setPresets(next);
    savePresets(next);
  };
  const deleteUnit = (deptId, unitName) => {
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, units: d.units.filter(u => u !== unitName) } : d) };
    setPresets(next);
    savePresets(next);
  };
  const moveUnit = (fromDeptId, unitName, toDeptId) => {
    if (fromDeptId === toDeptId) return;
    const next = {
      ...presets,
      departments: presets.departments.map(d => {
        if (d.id === fromDeptId) return { ...d, units: d.units.filter(u => u !== unitName) };
        if (d.id === toDeptId && !d.units.includes(unitName)) return { ...d, units: [...d.units, unitName] };
        return d;
      }),
    };
    setPresets(next);
    savePresets(next);
  };
  const reorderDepartments = (newDepartments) => {
    const next = { ...presets, departments: newDepartments };
    setPresets(next);
    savePresets(next);
  };
  const reorderUnits = (deptId, newUnits) => {
    const next = { ...presets, departments: presets.departments.map(d => d.id === deptId ? { ...d, units: newUnits } : d) };
    setPresets(next);
    savePresets(next);
  };
  const renameAssignmentPreset = (oldName, newName) => {
    const next = { ...presets, assignments: presets.assignments.map(a => a === oldName ? newName : a) };
    setPresets(next);
    savePresets(next);
  };
  const deleteAssignmentPreset = (name) => {
    const next = { ...presets, assignments: presets.assignments.filter(a => a !== name) };
    setPresets(next);
    savePresets(next);
  };
  const reorderAssignmentPresets = (newAssignments) => {
    const next = { ...presets, assignments: newAssignments };
    setPresets(next);
    savePresets(next);
  };
  const addResourceKind = (name) => {
    const trimmed = name.trim();
    if (!trimmed || presets.resourceKinds.includes(trimmed)) return;
    const next = { ...presets, resourceKinds: [...presets.resourceKinds, trimmed] };
    setPresets(next);
    savePresets(next);
  };
  const renameResourceKind = (oldName, newName) => {
    const next = { ...presets, resourceKinds: presets.resourceKinds.map(k => k === oldName ? newName : k) };
    setPresets(next);
    savePresets(next);
  };
  const deleteResourceKind = (name) => {
    const next = { ...presets, resourceKinds: presets.resourceKinds.filter(k => k !== name) };
    setPresets(next);
    savePresets(next);
  };
  const reorderResourceKinds = (newKinds) => {
    const next = { ...presets, resourceKinds: newKinds };
    setPresets(next);
    savePresets(next);
  };
  const saveObjectivePreset = async (objective) => {
    if (!objective || presets.objectives.includes(objective)) return;
    const next = { ...presets, objectives: [...presets.objectives, objective] };
    setPresets(next);
    await savePresets(next);
  };
  const saveAssignmentPreset = async (assignment) => {
    if (!assignment || presets.assignments.includes(assignment)) return;
    const next = { ...presets, assignments: [...presets.assignments, assignment] };
    setPresets(next);
    await savePresets(next);
  };

  function applyBlob(blob, markSynced = true) {
    // This function only ever LOADS data into state — it's never used
    // for an individual field edit — so every call means "the next
    // autosave cycle is not a real edit, skip it."
    suppressNextAutosave.current = true;
    setIncident(normalizeIncident(blob.incident));
    setResources(blob.resources || []);
    setOrg(normalizeOrg(blob.org));
    setComms(normalizeComms(blob.comms));
    setSafety(blob.safety || { opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] });
    // Shallow-merge onto fresh defaults rather than using the saved
    // blob as-is: an incident saved under an earlier, simpler version
    // of these forms (before they were rebuilt to match the official
    // FEMA templates field-for-field) would otherwise be missing
    // nested structures like ics208hm.entryTeam or ics209.structural,
    // and the new UI would crash calling .map() on undefined.
    setIcs208({ ...defaultIcs208(), ...(blob.ics208 || {}) });
    setIcs208hm({ ...defaultIcs208HM(), ...(blob.ics208hm || {}) });
    setIcs209({ ...defaultIcs209(), ...(blob.ics209 || {}) });
    setIcs206({ ...defaultIcs206(), ...(blob.ics206 || {}) });
    setFormsUsed(blob.formsUsed || {});
    setRehab(blob.rehab || []);
    setMapData(parseMapData(blob.mapData));
    setLogs(blob.logs || []);
    if (markSynced) lastKnownUpdatedAt.current = blob.updatedAt || null;
  }

  // autosave (debounced) whenever data changes, after initial load
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    // This render cycle is the result of a LOAD (open/new/incoming
    // real-time update), not a real edit — skip saving. Critical: without
    // this, opening an incident immediately re-saves whatever was just
    // read straight back to Firestore (since incidentLoaded is a
    // dependency below), which can silently overwrite newer data on the
    // server with an older copy if this device's read was stale.
    if (suppressNextAutosave.current) {
      suppressNextAutosave.current = false;
      return;
    }
    dirty.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const updatedAt = nowISO();
      const blob = { incident, resources, org, comms, safety, ics208, ics208hm, ics209, ics206, rehab, logs, formsUsed, mapData: JSON.stringify(mapData), updatedAt };
      const ok = await saveIncidentBlob(incident.id, blob);
      const meta = { id: incident.id, name: incident.name, type: incident.type, savedAt: updatedAt };
      const nextIndex = [meta, ...index.filter(i => i.id !== incident.id)];
      setIndex(nextIndex);
      await saveIndex(nextIndex);
      lastKnownUpdatedAt.current = updatedAt;
      dirty.current = false;
      setSaveState(ok ? "saved" : "idle");
    }, 900);
    return () => clearTimeout(saveTimer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incident, resources, org, comms, safety, ics208, ics208hm, ics209, ics206, rehab, logs, formsUsed, mapData, ready, incidentLoaded]);

  // real-time: subscribe to this incident's Firestore doc so other
  // users' changes appear here immediately, no polling needed.
  useEffect(() => {
    if (!ready || !incidentLoaded || !incident.id) return;
    const unsubscribe = watchIncident(incident.id, (blob) => {
      if (dirty.current) return; // don't clobber an in-flight local edit
      if (blob && blob.updatedAt && blob.updatedAt !== lastKnownUpdatedAt.current) {
        applyBlob(blob);
        setSaveState("synced");
      }
    });
    return () => unsubscribe();
  }, [ready, incidentLoaded, incident.id]);

  const startNew = () => {
    applyBlob({ incident: blankIncident(), resources: [], org: blankOrg(), comms: defaultComms(), safety: { opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] }, ics208: defaultIcs208(), ics208hm: defaultIcs208HM(), ics209: defaultIcs209(), ics206: defaultIcs206(), rehab: [], logs: [], formsUsed: {}, mapData: defaultMapData() });
    setAttachments([]);
    setIncidentLoaded(true);
    setShowLib(false);
  };
  const openIncident = async (id) => {
    // Deliberately bypasses Firestore's local cache — see the comment on
    // loadIncidentBlobFresh for why this matters (a stale cached read
    // here is exactly what caused entered data to get overwritten).
    const blob = await loadIncidentBlobFresh(id);
    if (blob) applyBlob(blob);
    const atts = await loadAttachments(id);
    setAttachments(atts);
    setIncidentLoaded(true);
    setShowLib(false);
  };
  const uploadAttachment = async (file) => {
    const dataBase64 = await fileToBase64(file);
    const attId = uid();
    const data = { name: file.name, type: file.type, size: file.size, dataBase64, uploadedAt: nowISO() };
    await saveAttachment(incident.id, attId, data);
    setAttachments(prev => [...prev, { id: attId, ...data }]);
  };
  const removeAttachment = async (attId) => {
    await deleteAttachment(incident.id, attId);
    setAttachments(prev => prev.filter(a => a.id !== attId));
  };
  const deleteIncident = async (id) => {
    const nextIndex = index.filter(i => i.id !== id);
    setIndex(nextIndex);
    await saveIndex(nextIndex);
    await deleteAllAttachments(id);
    await deleteIncidentBlob(id);
  };

  const archiveIncident = async (id) => {
    const nextIndex = index.map(i => i.id === id ? { ...i, archived: true, archivedAt: nowISO() } : i);
    setIndex(nextIndex);
    await saveIndex(nextIndex);
    // If the incident being archived is the one currently open, kick
    // back to the library so nobody keeps editing a closed-out incident.
    if (id === incident.id) {
      setIncidentLoaded(false);
      setShowLib(false);
    }
  };
  const restoreIncident = async (id) => {
    const nextIndex = index.map(i => i.id === id ? { ...i, archived: false } : i);
    setIndex(nextIndex);
    await saveIndex(nextIndex);
  };
  const exportArchivedIncident = async (id) => {
    const blob = await loadIncidentBlobFresh(id);
    if (blob) {
      const atts = await loadAttachments(id);
      await downloadPacketPdf({ ...blob, attachments: atts });
    }
  };

  const typeInfo = INCIDENT_TYPES.find(t => t.v === incident.type) || INCIDENT_TYPES[0];
  // When the incident clock is stopped, resource/rehab timers freeze at
  // the same moment instead of continuing to count against real time.
  const effectiveNow = incident.opEnd ? new Date(incident.opEnd).getTime() : now;

  return (
    <div style={{ minHeight: "100vh", background: COLORS.bg, color: COLORS.text, fontFamily: "'IBM Plex Sans', sans-serif" }}>
      {incidentLoaded && (
        <div className="no-print">
        {/* HEADER */}
        <div style={{ borderBottom: `1px solid ${COLORS.line}`, background: COLORS.panel, position: "sticky", top: 0, zIndex: 10 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 20px", flexWrap: "wrap", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <img src={KFD_PATCH_DATA_URI} alt="KFD Patch" style={{ width: 34, height: 44, objectFit: "contain", flexShrink: 0 }} />
              <div>
                <div style={{ fontFamily: "'Oswald', sans-serif", fontSize: 19, letterSpacing: "0.03em", lineHeight: 1 }}>COMMAND BOARD</div>
                <div style={{ fontSize: 10.5, color: COLORS.muted, letterSpacing: "0.08em", textTransform: "uppercase" }}>Incident Management System</div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap", marginLeft: "auto" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: typeInfo.c, display: "inline-block" }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{incident.name || "Untitled Incident"}</span>
                <span style={{ fontSize: 11, color: COLORS.muted }}>({incident.type})</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: COLORS.amber }}>
                <Clock size={14} />
                {fmtDuration((incident.pausedElapsedMs || 0) + (incident.opEnd ? 0 : Math.max(0, now - new Date(incident.opStart).getTime())))}
                {incident.opEnd && <span style={{ color: COLORS.faint, fontSize: 10, marginLeft: 2 }}>STOPPED</span>}
              </div>
              <Btn kind="ghost" icon={Clock}
                onClick={() => {
                  if (incident.opEnd) {
                    // Resuming: start a fresh running segment. The time
                    // already accumulated (pausedElapsedMs) is preserved
                    // as-is — only opStart resets, as the reference point
                    // for counting the NEW segment, not the total.
                    setIncident({ ...incident, opStart: nowISO(), opEnd: null });
                  } else {
                    // Stopping: fold this segment's elapsed time into the
                    // running total before freezing the display, instead
                    // of discarding it (which is what the old opStart-only
                    // reset on resume used to do).
                    const segmentMs = Math.max(0, Date.now() - new Date(incident.opStart).getTime());
                    setIncident({ ...incident, pausedElapsedMs: (incident.pausedElapsedMs || 0) + segmentMs, opEnd: nowISO() });
                  }
                }}
                style={{ padding: "6px 11px", fontSize: 12.5 }}>
                {incident.opEnd ? "Resume Clock" : "Stop Clock"}
              </Btn>
              {!online && (
                <span style={{ fontSize: 11, color: COLORS.amber, fontFamily: "'IBM Plex Mono', monospace", display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: COLORS.amber, display: "inline-block" }} />
                  offline — changes will sync when reconnected
                </span>
              )}
              <Btn kind="subtle" icon={FolderOpen} onClick={() => setShowLib(true)} style={{ padding: "6px 11px", fontSize: 12.5 }}>Incidents</Btn>
              <Btn kind="subtle" icon={Printer} onClick={() => downloadPacketPdf({ incident, resources, comms, org, safety, ics208, ics208hm, ics209, ics206, rehab, logs, formsUsed, attachments })} style={{ padding: "6px 11px", fontSize: 12.5 }}>Print / Export</Btn>
              <Btn kind="ghost" icon={KeyRound} onClick={() => setShowChangePin(true)} style={{ padding: "6px 11px", fontSize: 12.5 }}>Change PIN</Btn>
              <Btn kind="ghost" icon={Lock} onClick={onLock} style={{ padding: "6px 11px", fontSize: 12.5 }}>Lock</Btn>
              <Btn kind="ghost" icon={theme === "dark" ? Sun : Moon} onClick={toggleTheme} title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} style={{ padding: "6px 11px", fontSize: 12.5 }}>{theme === "dark" ? "Light" : "Dark"}</Btn>
              <span style={{ fontSize: 11, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", display: "flex", alignItems: "center", gap: 5, visibility: saveState === "idle" ? "hidden" : "visible" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: saveState === "saving" ? COLORS.amber : COLORS.teal, transition: "background-color 0.15s" }} />
                Synced
              </span>
            </div>
          </div>

          {/* TAB NAV */}
          <div style={{ display: "flex", gap: 2, padding: "0 16px", overflowX: "auto" }}>
            {TABS.map(t => (
              <button key={t.k} onClick={() => setTab(t.k)} style={{
                display: "flex", alignItems: "center", gap: 7, padding: "10px 14px",
                background: "transparent", border: "none", cursor: "pointer",
                color: tab === t.k ? COLORS.text : COLORS.muted,
                borderBottom: tab === t.k ? `2px solid ${COLORS.red}` : `2px solid transparent`,
                fontSize: 13, fontWeight: 600, fontFamily: "'IBM Plex Sans', sans-serif", whiteSpace: "nowrap",
              }}>
                <t.icon size={14} /> {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* MAIN */}
        <div style={{ maxWidth: 1600, margin: "0 auto", padding: "20px 16px 60px" }}>
          {!ready ? (
            <div style={{ color: COLORS.muted, padding: 40, textAlign: "center" }}>Loading…</div>
          ) : (
            <>
              {tab === "201" && <Tab201 incident={incident} setIncident={setIncident} resources={resources} objectivePresets={presets.objectives} onSavePreset={saveObjectivePreset} />}
              {tab === "resources" && <TabResources resources={resources} setResources={setResources} now={effectiveNow}
                departments={presets.departments} onAddDepartment={saveDepartment} onAddUnitUnderDepartment={saveUnitUnderDepartment}
                onRenameDepartment={renameDepartment} onDeleteDepartment={deleteDepartment} onReorderDepartment={reorderDepartments}
                onRenameUnit={renameUnit} onDeleteUnit={deleteUnit} onMoveUnit={moveUnit} onReorderUnit={reorderUnits}
                assignmentPresets={presets.assignments} onSaveAssignmentPreset={saveAssignmentPreset}
                onRenameAssignment={renameAssignmentPreset} onDeleteAssignment={deleteAssignmentPreset} onReorderAssignment={reorderAssignmentPresets}
                resourceKindPresets={presets.resourceKinds} onAddResourceKind={addResourceKind} onRenameResourceKind={renameResourceKind}
                onDeleteResourceKind={deleteResourceKind} onReorderResourceKind={reorderResourceKinds}
              />}
              {tab === "mapping" && <TabMapping mapData={mapData} setMapData={setMapData} />}
              {tab === "org" && <TabOrg org={org} setOrg={setOrg} />}
              {tab === "rehab" && <TabRehab rehab={rehab} setRehab={setRehab} resources={resources} now={effectiveNow} />}
              {tab === "icsforms" && (
                <TabICSForms
                  comms={comms} setComms={setComms}
                  safety={safety} setSafety={setSafety}
                  org={org} incident={incident} setIncident={setIncident}
                  ics208={ics208} setIcs208={setIcs208}
                  ics208hm={ics208hm} setIcs208hm={setIcs208hm}
                  ics209={ics209} setIcs209={setIcs209}
                  ics206={ics206} setIcs206={setIcs206}
                  logs={logs} setLogs={setLogs}
                  objectivePresets={presets.objectives} onSavePreset={saveObjectivePreset}
                  formsUsed={formsUsed} toggleFormUsed={toggleFormUsed}
                />
              )}
              {tab === "attachments" && <TabAttachments attachments={attachments} onUpload={uploadAttachment} onDelete={removeAttachment} />}
            </>
          )}
        </div>
        </div>
      )}

      {!ready && (
        <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: COLORS.muted, fontFamily: "'IBM Plex Sans', sans-serif" }}>
          Loading…
        </div>
      )}

      {incidentLoaded && <PrintView incident={incident} resources={resources} comms={comms} org={org} safety={safety} logs={logs} />}

      {ready && (showLib || !incidentLoaded) && (
        <LibraryModal index={index} onClose={() => setShowLib(false)} onLoad={openIncident} onNew={startNew} onDelete={deleteIncident}
          onArchive={archiveIncident} onOpenArchive={() => setShowArchive(true)} mandatory={!incidentLoaded} />
      )}

      {showChangePin && <ChangePinModal onClose={() => setShowChangePin(false)} />}

      {showArchive && (
        <ArchiveModal
          index={index}
          onClose={() => setShowArchive(false)}
          onExport={exportArchivedIncident}
          onRestore={restoreIncident}
          onChangePassword={() => setShowChangeArchivePassword(true)}
        />
      )}

      {showChangeArchivePassword && <ChangeArchivePasswordModal onClose={() => setShowChangeArchivePassword(false)} />}
    </div>
  );
}
