import React, { useState, useEffect, useRef, useMemo } from "react";
import {
  Radio, Truck, HeartPulse, ClipboardList, Users, Save,
  Printer, Plus, X, Clock, ChevronRight, Trash2, Download,
  FolderOpen, AlertTriangle, Shield, CheckCircle2, ArrowRightLeft, Lock, GripVertical
} from "lucide-react";
import {
  loadIndex, saveIndex, loadIncidentBlob, saveIncidentBlob,
  deleteIncidentBlob, watchIncident, loadPinConfig, savePinConfig,
} from "./store";
import { COLORS, KFD_PATCH_DATA_URI } from "./theme";
import PinGate from "./PinGate.jsx";
import { sha256 } from "./pin";

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
    opStart: nowISO(),
    wind: "",
    temp: "",
    rh: "",
    conditions: "",
    situation: "",
    safetyMessage: "",
    objectives: [""],
  };
}

// Older saved incidents may only have the single combined "weather"
// field from before it was split into Wind/Temp/RH/Conditions — carry
// that text into Conditions once, rather than silently losing it.
function normalizeIncident(inc) {
  if (!inc) return blankIncident();
  const hasNewFields = inc.wind || inc.temp || inc.rh || inc.conditions;
  if (!hasNewFields && inc.weather) {
    return { ...inc, wind: "", temp: "", rh: "", conditions: inc.weather };
  }
  return { wind: "", temp: "", rh: "", conditions: "", ...inc };
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

function Btn({ children, onClick, kind = "ghost", icon: Icon, style, type = "button", disabled }) {
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
    danger: { background: "transparent", color: "#E4796B", border: `1px solid #5A2B24` },
  };
  return (
    <button type={type} disabled={disabled} onClick={onClick} style={{ ...base, ...kinds[kind], ...style }}>
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
function Tab201({ incident, setIncident, resources }) {
  const typeInfo = INCIDENT_TYPES.find(t => t.v === incident.type);
  const updateObjective = (i, val) => {
    const next = [...incident.objectives]; next[i] = val;
    setIncident({ ...incident, objectives: next });
  };
  const addObjective = () => setIncident({ ...incident, objectives: [...incident.objectives, ""] });
  const removeObjective = (i) => setIncident({ ...incident, objectives: incident.objectives.filter((_, idx) => idx !== i) });

  const counts = STATUS_FLOW.map(s => ({ status: s, n: resources.filter(r => r.status === s).length }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="ICS-201 · Incident Briefing" icon={ClipboardList}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
          <Field label="Incident Name"><TextInput value={incident.name} onChange={e => setIncident({ ...incident, name: e.target.value })} placeholder="e.g. County Rd 411 Structure" /></Field>
          <Field label="Incident Number"><TextInput value={incident.number} onChange={e => setIncident({ ...incident, number: e.target.value })} placeholder="Dispatch / CAD #" /></Field>
          <Field label="Incident Type">
            <Select value={incident.type} onChange={e => setIncident({ ...incident, type: e.target.value })}>
              {INCIDENT_TYPES.map(t => <option key={t.v} value={t.v}>{t.v}</option>)}
            </Select>
          </Field>
          <Field label="Location"><TextInput value={incident.location} onChange={e => setIncident({ ...incident, location: e.target.value })} placeholder="Address / cross streets / lat-long" /></Field>
          <Field label="Incident Commander"><TextInput value={incident.icName} onChange={e => setIncident({ ...incident, icName: e.target.value })} /></Field>
          <Field label="Prepared By"><TextInput value={incident.preparedBy} onChange={e => setIncident({ ...incident, preparedBy: e.target.value })} /></Field>
          <Field label="Wind"><TextInput value={incident.wind} onChange={e => setIncident({ ...incident, wind: e.target.value })} placeholder="8 mph SW" /></Field>
          <Field label="Temp"><TextInput value={incident.temp} onChange={e => setIncident({ ...incident, temp: e.target.value })} placeholder="72°F" /></Field>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginTop: 14 }}>
          <Field label="RH"><TextInput value={incident.rh} onChange={e => setIncident({ ...incident, rh: e.target.value })} placeholder="45%" /></Field>
          <Field label="Conditions"><TextInput value={incident.conditions} onChange={e => setIncident({ ...incident, conditions: e.target.value })} placeholder="Clear, smoke visible..." /></Field>
          <Field label="Current Situation Summary" wide><TextArea value={incident.situation} onChange={e => setIncident({ ...incident, situation: e.target.value })} /></Field>
          <Field label="Safety Message" wide><TextArea value={incident.safetyMessage} onChange={e => setIncident({ ...incident, safetyMessage: e.target.value })} /></Field>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", marginBottom: 8 }}>Initial Response Objectives</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {incident.objectives.map((o, i) => (
              <div key={i} style={{ display: "flex", gap: 8 }}>
                <span style={{ width: 22, textAlign: "right", color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, paddingTop: 9 }}>{i + 1}.</span>
                <TextInput value={o} onChange={e => updateObjective(i, e.target.value)} style={{ flex: 1 }} placeholder="Objective..." />
                <Btn kind="danger" onClick={() => removeObjective(i)}><Trash2 size={14} /></Btn>
              </div>
            ))}
            <Btn kind="subtle" icon={Plus} onClick={addObjective} style={{ alignSelf: "flex-start" }}>Add Objective</Btn>
          </div>
        </div>
      </Panel>

      <Panel title="Resource Summary (auto)" icon={Truck}>
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
function ResourceForm({ onAdd }) {
  const [f, setF] = useState({ label: "", kind: RESOURCE_KINDS[0], personnel: 1, assignment: "" });
  const submit = () => {
    if (!f.label.trim()) return;
    onAdd({ id: uid(), label: f.label.trim(), kind: f.kind, personnel: Number(f.personnel) || 1, assignment: f.assignment, status: "Staging", statusSince: nowISO(), checkIn: nowISO(), notes: "", history: [{ status: "Staging", at: nowISO() }] });
    setF({ label: "", kind: f.kind, personnel: 1, assignment: "" });
  };
  return (
    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
      <Field label="Unit / Resource ID"><TextInput value={f.label} onChange={e => setF({ ...f, label: e.target.value })} placeholder="Engine 21, Crew 3, Med 1..." style={{ width: 180 }} onKeyDown={e => e.key === "Enter" && submit()} /></Field>
      <Field label="Type">
        <Select value={f.kind} onChange={e => setF({ ...f, kind: e.target.value })} style={{ width: 150 }}>
          {RESOURCE_KINDS.map(k => <option key={k} value={k}>{k}</option>)}
        </Select>
      </Field>
      <Field label="Personnel"><TextInput type="number" min="0" value={f.personnel} onChange={e => setF({ ...f, personnel: e.target.value })} style={{ width: 80 }} /></Field>
      <Field label="Assignment / Division"><TextInput value={f.assignment} onChange={e => setF({ ...f, assignment: e.target.value })} placeholder="Div A, Branch 1..." style={{ width: 160 }} /></Field>
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

function TabResources({ resources, setResources, now }) {
  // Drag state lives here (not per-card) since the floating preview and
  // column highlight need to render across the whole board. Built on
  // the Pointer Events API + elementFromPoint rather than native HTML5
  // drag-and-drop, because HTML5 DnD is unreliable on touch devices —
  // this app needs to work on iPads and phones, not just desktop mice.
  const [drag, setDrag] = useState(null); // { id, x, y, overStatus }

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
      <Panel title="Check In Resource" icon={Truck}>
        <ResourceForm onAdd={addResource} />
      </Panel>
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
function TabOrg({ org, setOrg }) {
  const setPos = (pos, val) => setOrg({ ...org, positions: { ...org.positions, [pos]: val } });
  const addDiv = () => setOrg({ ...org, divisions: [...org.divisions, { id: uid(), name: "", supervisor: "" }] });
  const updateDiv = (id, patch) => setOrg({ ...org, divisions: org.divisions.map(d => d.id === id ? { ...d, ...patch } : d) });
  const removeDiv = (id) => setOrg({ ...org, divisions: org.divisions.filter(d => d.id !== id) });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Panel title="Command & General Staff" icon={Shield}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {CG_POSITIONS.map(pos => (
            <Field key={pos} label={pos}>
              <TextInput value={org.positions[pos] || ""} onChange={e => setPos(pos, e.target.value)} placeholder="Name" />
            </Field>
          ))}
        </div>
      </Panel>
      <Panel title="Section Chiefs" icon={Users}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {SECTION_CHIEFS.map(pos => (
            <Field key={pos} label={pos}>
              <TextInput value={org.positions[pos] || ""} onChange={e => setPos(pos, e.target.value)} placeholder="Name" />
            </Field>
          ))}
        </div>
      </Panel>
      <Panel title="Divisions / Groups / Branches (Operations)" icon={ChevronRight} right={<Btn kind="subtle" icon={Plus} onClick={addDiv}>Add</Btn>}>
        {org.divisions.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint }}>No divisions/groups established.</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {org.divisions.map(d => (
            <div key={d.id} style={{ display: "flex", gap: 8 }}>
              <TextInput value={d.name} onChange={e => updateDiv(d.id, { name: e.target.value })} placeholder="Division A / Group: Ventilation..." style={{ flex: 1 }} />
              <TextInput value={d.supervisor} onChange={e => updateDiv(d.id, { supervisor: e.target.value })} placeholder="Supervisor" style={{ flex: 1 }} />
              <Btn kind="danger" onClick={() => removeDiv(d.id)}><Trash2 size={14} /></Btn>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

/* ============================================================
   TAB: COMMUNICATIONS PLAN (ICS-205)
   ============================================================ */
function TabComms({ comms, setComms }) {
  const addRow = () => setComms([...comms, { id: uid(), channel: "", func: "Command", assignment: "", tx: "", rx: "", mode: "Digital", remarks: "" }]);
  const update = (id, patch) => setComms(comms.map(c => c.id === id ? { ...c, ...patch } : c));
  const remove = (id) => setComms(comms.filter(c => c.id !== id));
  const cell = { padding: "6px 6px", fontSize: 12.5 };
  return (
    <Panel title="ICS-205 · Incident Radio Communications Plan" icon={Radio} right={<Btn kind="subtle" icon={Plus} onClick={addRow}>Add Channel</Btn>}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "'IBM Plex Sans', sans-serif" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${COLORS.line}`, color: COLORS.muted, textTransform: "uppercase", fontSize: 10.5, letterSpacing: "0.05em" }}>
              <th style={cell}>Channel</th><th style={cell}>Function</th><th style={cell}>Assignment</th>
              <th style={cell}>TX Freq</th><th style={cell}>RX Freq</th><th style={cell}>Mode</th><th style={cell}>Remarks</th><th style={cell}></th>
            </tr>
          </thead>
          <tbody>
            {comms.map(c => (
              <tr key={c.id} style={{ borderBottom: `1px solid ${COLORS.line}` }}>
                <td style={cell}><TextInput value={c.channel} onChange={e => update(c.id, { channel: e.target.value })} style={{ width: 100 }} placeholder="TAC-3" /></td>
                <td style={cell}>
                  <Select value={c.func} onChange={e => update(c.id, { func: e.target.value })} style={{ width: 110 }}>
                    {["Command", "Tactical", "Ops", "Air-to-Ground", "Support", "EMS/Medical", "Rehab"].map(f => <option key={f}>{f}</option>)}
                  </Select>
                </td>
                <td style={cell}><TextInput value={c.assignment} onChange={e => update(c.id, { assignment: e.target.value })} style={{ width: 110 }} /></td>
                <td style={cell}><TextInput value={c.tx} onChange={e => update(c.id, { tx: e.target.value })} style={{ width: 90 }} placeholder="MHz" /></td>
                <td style={cell}><TextInput value={c.rx} onChange={e => update(c.id, { rx: e.target.value })} style={{ width: 90 }} placeholder="MHz" /></td>
                <td style={cell}>
                  <Select value={c.mode} onChange={e => update(c.id, { mode: e.target.value })} style={{ width: 100 }}>
                    {["Digital", "Analog", "Trunked", "Mixed"].map(m => <option key={m}>{m}</option>)}
                  </Select>
                </td>
                <td style={cell}><TextInput value={c.remarks} onChange={e => update(c.id, { remarks: e.target.value })} style={{ width: 150 }} /></td>
                <td style={cell}><button onClick={() => remove(c.id)} style={{ background: "none", border: "none", color: COLORS.faint, cursor: "pointer" }}><Trash2 size={14} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {comms.length === 0 && <div style={{ fontSize: 13, color: COLORS.faint, padding: "10px 2px" }}>No channels assigned yet.</div>}
      </div>
    </Panel>
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
              <span style={{ fontSize: 11, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace" }}>In: {fmtTime(r.timeIn)} · {elapsed(r.timeIn, now)} elapsed</span>
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
  const divisionOptions = org.divisions.map(d => d.name).filter(Boolean);
  const cell = { padding: "6px 6px", fontSize: 12.5, verticalAlign: "top" };

  return (
    <Panel title="ICS-215A · Incident Action Plan Safety Analysis" icon={AlertTriangle} right={<Btn kind="subtle" icon={Plus} onClick={addRow}>Add Hazard</Btn>}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Incident Name"><TextInput value={incident.name} disabled style={{ opacity: 0.65 }} /></Field>
        <Field label="Incident Number"><TextInput value={incident.number} disabled style={{ opacity: 0.65 }} /></Field>
      </div>

      <div style={{ fontSize: 11, letterSpacing: "0.06em", textTransform: "uppercase", color: COLORS.muted, fontFamily: "'IBM Plex Mono', monospace", margin: "16px 0 8px" }}>Operational Period</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }}>
        <Field label="Date / Time From"><TextInput value={safety.opFrom} onChange={e => setSafety({ ...safety, opFrom: e.target.value })} placeholder="MM/DD/YYYY HH:MM" /></Field>
        <Field label="Date / Time To"><TextInput value={safety.opTo} onChange={e => setSafety({ ...safety, opTo: e.target.value })} placeholder="MM/DD/YYYY HH:MM" /></Field>
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
        <Field label="Name"><TextInput value={safety.preparedBy} onChange={e => setSafety({ ...safety, preparedBy: e.target.value })} placeholder={org.positions["Safety Officer"] || "Name"} /></Field>
        <Field label="Position / Title"><TextInput value={safety.position} onChange={e => setSafety({ ...safety, position: e.target.value })} placeholder="Safety Officer" /></Field>
        <Field label="Signature"><TextInput value={safety.signature} onChange={e => setSafety({ ...safety, signature: e.target.value })} placeholder="Type name to sign" /></Field>
        <Field label="Date / Time"><TextInput value={safety.dateTime} onChange={e => setSafety({ ...safety, dateTime: e.target.value })} placeholder={new Date().toLocaleString()} /></Field>
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
    cells: cells.map((c, i) => ({ text: fitText(c, font, size, colWidths[i] - 6), x: xOffsets[i] })),
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

function buildPacketLines({ incident, resources, comms, org, safety, logs }) {
  const L = [];
  const push = (text, font = "H", size = 9) => L.push({ kind: "text", text, font, size });
  const blank = () => push("");

  push(`Incident #: ${incident.number || "-"}   Type: ${incident.type || "-"}`, "H", 10);
  push(`Location: ${incident.location || "-"}`, "H", 10);
  push(`IC: ${incident.icName || "-"}   Prepared By: ${incident.preparedBy || "-"}`, "H", 10);
  push(`Wind: ${incident.wind || "-"}   Temp: ${incident.temp || "-"}   RH: ${incident.rh || "-"}`, "H", 10);
  push(`Conditions: ${incident.conditions || "-"}`, "H", 10);
  blank();

  heading(L, "ICS-201 · Incident Briefing");
  push("Situation:", "HB", 9);
  wrapPush(L, incident.situation);
  blank();
  push("Safety Message:", "HB", 9);
  wrapPush(L, incident.safetyMessage);
  blank();
  push("Objectives:", "HB", 9);
  const objs = incident.objectives.filter(Boolean);
  if (objs.length === 0) push("(none entered)");
  else objs.forEach((o, i) => wrapPush(L, `${i + 1}. ${o}`));
  blank();

  L.push(...tableLines(["UNIT", "TYPE", "PERS", "STATUS", "ASSIGNMENT"], [70, 90, 35, 70, 140],
    resources.map(r => [r.label, r.kind, String(r.personnel), r.status, r.assignment]), "Resource Summary"));

  heading(L, "Command Structure");
  const orgLines = [
    ...Object.entries(org.positions).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    ...org.divisions.filter(d => d.name).map(d => `${d.name} - Supv: ${d.supervisor || "-"}`),
  ];
  if (orgLines.length === 0) push("(none entered)");
  else orgLines.forEach(l => wrapPush(L, l));
  blank();

  L.push(...tableLines(["CHANNEL", "FUNCTION", "ASSIGN", "TX", "RX", "MODE"], [65, 85, 85, 55, 55, 60],
    comms.map(c => [c.channel, c.func, c.assignment, c.tx, c.rx, c.mode]), "ICS-205 · Communications Plan"));

  heading(L, "ICS-215A · Incident Action Plan Safety Analysis");
  push(`Operational Period: ${safety.opFrom || "-"} to ${safety.opTo || "-"}`, "H", 9);
  blank();
  L.push(...tableLines(["BRANCH", "DIV/GRP", "HAZARDS", "MITIGATIONS"], [60, 70, 175, 175],
    safety.rows.map(r => [r.branch, r.division, r.hazards, r.mitigations])));
  push(`Prepared By: ${safety.preparedBy || "-"}   Position: ${safety.position || "-"}`);
  push(`Signature: ${safety.signature || "-"}   Date/Time: ${safety.dateTime || "-"}`);
  blank();

  heading(L, "ICS-214 · Activity Logs");
  if (logs.length === 0) {
    push("(none entered)");
  } else {
    logs.forEach(l => {
      push(`${l.name || "Unnamed"} - ${l.position || "-"} (${l.agency || "-"})`, "HB", 9);
      L.push(...tableLines(["TIME", "ACTIVITY"], [60, 440],
        l.entries.slice().sort((a, b) => new Date(a.time) - new Date(b.time)).map(e => [fmtTime(e.time), e.text])));
    });
  }
  return L;
}

// Byte-accurate PDF assembly. Content is built as an array of "parts"
// (ASCII strings + binary Uint8Arrays for the embedded image) rather
// than one big string, because a JS string containing raw bytes >127
// gets mangled by UTF-8 re-encoding when passed to Blob — binary data
// has to travel as an actual typed array, not characters in a string.
function buildSimplePdf(lines, logo, meta) {
  const PAGE_W = 612, PAGE_H = 792, MARGIN_X = 40, MARGIN_BOTTOM = 46;
  const HEADER_H = logo ? 86 : 46;
  const MARGIN_TOP = PAGE_H - 42;
  const LH = { H: 12, HB: 14, heading: 20 };
  const RED = "0.769 0.204 0.122";
  const GREY = "0.72 0.72 0.72";

  const pages = [];
  let cur = [];
  let y = MARGIN_TOP - HEADER_H;
  for (const ln of lines) {
    const lh = LH[ln.kind === "heading" ? "heading" : ln.font] || 12;
    if (y - lh < MARGIN_BOTTOM) { pages.push(cur); cur = []; y = MARGIN_TOP; }
    cur.push({ ...ln, y });
    y -= lh;
  }
  pages.push(cur);
  const totalPages = pages.length;

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
  const resourcesDict = logo
    ? `<< /Font << /FH ${fontHId} 0 R /FHB ${fontHBId} 0 R >> /XObject << /Logo ${imageId} 0 R >> >>`
    : `<< /Font << /FH ${fontHId} 0 R /FHB ${fontHBId} 0 R >> >>`;
  writeObj(resourcesId, () => push(resourcesDict));

  pages.forEach((pageLines, i) => {
    let stream = "";
    if (i === 0) {
      const drawH = logo ? 54 : 0;
      const drawW = logo ? drawH * (logo.width / logo.height) : 0;
      const headerTop = PAGE_H - 40;
      if (logo) {
        stream += `q ${drawW.toFixed(1)} 0 0 ${drawH.toFixed(1)} ${MARGIN_X} ${(headerTop - drawH).toFixed(1)} cm /Logo Do Q\n`;
      }
      stream += "BT\n";
      const textX = MARGIN_X + drawW + (logo ? 14 : 0);
      stream += `/FHB 18 Tf\n1 0 0 1 ${textX} ${(headerTop - 16).toFixed(1)} Tm\n(COMMAND BOARD) Tj\n`;
      stream += `/FH 9 Tf\n1 0 0 1 ${textX} ${(headerTop - 30).toFixed(1)} Tm\n(ICS Incident Packet) Tj\n`;
      stream += `/FHB 12 Tf\n1 0 0 1 ${textX} ${(headerTop - 46).toFixed(1)} Tm\n(${pdfEscape(meta.name || "Untitled Incident")}) Tj\n`;
      stream += "ET\n";
      stream += `${RED} RG 1.4 w ${MARGIN_X} ${(headerTop - drawH - 8).toFixed(1)} m ${PAGE_W - MARGIN_X} ${(headerTop - drawH - 8).toFixed(1)} l S\n`;
    }

    stream += "BT\n";
    for (const ln of pageLines) {
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

  writeObj(pagesTreeId, () => push(`<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`));
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
  const parts = buildSimplePdf(buildPacketLines(data), logo, { name: data.incident.name });
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
      <ul>{Object.entries(org.positions).filter(([, v]) => v).map(([k, v]) => <li key={k}>{k}: {v}</li>)}</ul>
      <ul>{org.divisions.filter(d => d.name).map(d => <li key={d.id}>{d.name} — Supv: {d.supervisor}</li>)}</ul>

      <h2>ICS-205 Communications Plan</h2>
      <table border="1" cellPadding="4" style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead><tr><th>Channel</th><th>Function</th><th>Assignment</th><th>TX</th><th>RX</th><th>Mode</th><th>Remarks</th></tr></thead>
        <tbody>{comms.map(c => <tr key={c.id}><td>{c.channel}</td><td>{c.func}</td><td>{c.assignment}</td><td>{c.tx}</td><td>{c.rx}</td><td>{c.mode}</td><td>{c.remarks}</td></tr>)}</tbody>
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
    await savePinConfig({ pinHash: nextHash });
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
            {error && <div style={{ color: "#E4796B", fontSize: 12 }}>{error}</div>}
            <Btn kind="solid" onClick={submit} disabled={status === "saving"} style={{ justifyContent: "center" }}>
              {status === "saving" ? "Saving…" : "Save New PIN"}
            </Btn>
          </div>
        )}
      </div>
    </div>
  );
}

function LibraryModal({ index, onClose, onLoad, onNew, onDelete, mandatory }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div style={{ background: COLORS.panel, border: `1px solid ${COLORS.line}`, borderRadius: 8, width: 480, maxHeight: "80vh", overflow: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", borderBottom: `1px solid ${COLORS.line}` }}>
          <span style={{ fontFamily: "'Oswald', sans-serif", textTransform: "uppercase", letterSpacing: "0.05em" }}>Incident Library</span>
          {!mandatory && <button onClick={onClose} style={{ background: "none", border: "none", color: COLORS.muted, cursor: "pointer" }}><X size={18} /></button>}
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 11.5, color: COLORS.muted, marginBottom: 12, lineHeight: 1.5 }}>
            {mandatory ? "Select an incident to open, or start a new one." : "Shared board — visible and editable by anyone who opens this app. Changes sync to other users within a few seconds."}
          </div>
          <Btn kind="solid" icon={Plus} onClick={onNew} style={{ marginBottom: 14, width: "100%", justifyContent: "center" }}>Start New Incident</Btn>
          {index.length === 0 && <div style={{ color: COLORS.faint, fontSize: 13 }}>No saved incidents yet.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {index.map(item => (
              <div key={item.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: COLORS.panel2, border: `1px solid ${COLORS.line}`, borderRadius: 5, padding: "9px 12px" }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{item.name || "Unnamed Incident"}</div>
                  <div style={{ fontSize: 11, color: COLORS.muted }}>{item.type} · {fmtDate(item.savedAt)}</div>
                </div>
                <div style={{ display: "flex", gap: 6 }}>
                  <Btn kind="subtle" onClick={() => onLoad(item.id)} style={{ padding: "5px 9px", fontSize: 12 }}>Open</Btn>
                  <Btn kind="danger" onClick={() => onDelete(item.id)} style={{ padding: "5px 9px", fontSize: 12 }}><Trash2 size={13} /></Btn>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   APP
   ============================================================ */
const TABS = [
  { k: "201", label: "ICS-201 Briefing", icon: ClipboardList },
  { k: "resources", label: "Resource Board", icon: Truck },
  { k: "org", label: "Org Chart", icon: Users },
  { k: "rehab", label: "Rehab", icon: HeartPulse },
  { k: "comms", label: "ICS-205 Comms", icon: Radio },
  { k: "215a", label: "ICS-215A Safety", icon: AlertTriangle },
  { k: "214", label: "ICS-214 Logs", icon: ArrowRightLeft },
];

// Rendered at the very top of the tree, outside PinGate, so the dark
// theme's page reset (no white margin/background) is active even
// before the PIN gate decides what to show — otherwise the browser's
// default white body margin is visible around the lock screen.
function GlobalStyles() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap');
      * { box-sizing: border-box; }
      html, body, #root { margin: 0; padding: 0; min-height: 100%; background: ${COLORS.bg}; }
      select { -webkit-appearance: none; }
      input:focus, textarea:focus, select:focus { border-color: ${COLORS.amber} !important; }
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
  return (
    <>
      <GlobalStyles />
      <PinGate>
        {(lock) => <AppInner onLock={lock} />}
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

function AppInner({ onLock }) {
  const online = useOnlineStatus();
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState("201");
  const [showLib, setShowLib] = useState(false);
  const [showChangePin, setShowChangePin] = useState(false);
  const [incidentLoaded, setIncidentLoaded] = useState(false);
  const [index, setIndex] = useState([]);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | saved
  const [now, setNow] = useState(Date.now());

  const [incident, setIncident] = useState(blankIncident());
  const [resources, setResources] = useState([]);
  const [org, setOrg] = useState({ positions: {}, divisions: [] });
  const [comms, setComms] = useState([]);
  const [safety, setSafety] = useState({ opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] });
  const [rehab, setRehab] = useState([]);
  const [logs, setLogs] = useState([]);

  const saveTimer = useRef(null);
  const lastKnownUpdatedAt = useRef(null);
  const dirty = useRef(false); // true while a local edit hasn't been written to shared storage yet

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    (async () => {
      const idx = await loadIndex();
      setIndex(idx);
      setReady(true);
      setShowLib(true); // land on the incident library instead of auto-opening one
    })();
  }, []);

  function applyBlob(blob, markSynced = true) {
    setIncident(normalizeIncident(blob.incident));
    setResources(blob.resources || []);
    setOrg(blob.org || { positions: {}, divisions: [] });
    setComms(blob.comms || []);
    setSafety(blob.safety || { opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] });
    setRehab(blob.rehab || []);
    setLogs(blob.logs || []);
    if (markSynced) lastKnownUpdatedAt.current = blob.updatedAt || null;
  }

  // autosave (debounced) whenever data changes, after initial load
  useEffect(() => {
    if (!ready || !incidentLoaded) return;
    dirty.current = true;
    setSaveState("saving");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const updatedAt = nowISO();
      const blob = { incident, resources, org, comms, safety, rehab, logs, updatedAt };
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
  }, [incident, resources, org, comms, safety, rehab, logs, ready, incidentLoaded]);

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
    applyBlob({ incident: blankIncident(), resources: [], org: { positions: {}, divisions: [] }, comms: [], safety: { opFrom: "", opTo: "", preparedBy: "", position: "", signature: "", dateTime: "", rows: [] }, rehab: [], logs: [] });
    setIncidentLoaded(true);
    setShowLib(false);
  };
  const openIncident = async (id) => {
    const blob = await loadIncidentBlob(id);
    if (blob) applyBlob(blob);
    setIncidentLoaded(true);
    setShowLib(false);
  };
  const deleteIncident = async (id) => {
    const nextIndex = index.filter(i => i.id !== id);
    setIndex(nextIndex);
    await saveIndex(nextIndex);
    await deleteIncidentBlob(id);
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
                <div style={{ fontSize: 10.5, color: COLORS.muted, letterSpacing: "0.08em", textTransform: "uppercase" }}>ICS Field Incident Management</div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: typeInfo.c, display: "inline-block" }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{incident.name || "Untitled Incident"}</span>
                <span style={{ fontSize: 11, color: COLORS.muted }}>({incident.type})</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: COLORS.amber }}>
                <Clock size={14} />
                {elapsed(incident.opStart, incident.opEnd ? new Date(incident.opEnd).getTime() : now)}
                {incident.opEnd && <span style={{ color: COLORS.faint, fontSize: 10, marginLeft: 2 }}>STOPPED</span>}
              </div>
              <Btn kind="ghost"
                onClick={() => setIncident(incident.opEnd
                  ? { ...incident, opStart: nowISO(), opEnd: null }
                  : { ...incident, opEnd: nowISO() })}
                style={{ padding: "5px 9px", fontSize: 12 }}>
                {incident.opEnd ? "Resume Clock" : "Stop Clock"}
              </Btn>
              {!online && (
                <span style={{ fontSize: 11, color: COLORS.amber, fontFamily: "'IBM Plex Mono', monospace", display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 7, height: 7, borderRadius: "50%", background: COLORS.amber, display: "inline-block" }} />
                  offline — changes will sync when reconnected
                </span>
              )}
              <span style={{ fontSize: 11, color: COLORS.faint, fontFamily: "'IBM Plex Mono', monospace", display: "flex", alignItems: "center", gap: 5, visibility: saveState === "idle" ? "hidden" : "visible" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: saveState === "saving" ? COLORS.amber : COLORS.teal, transition: "background-color 0.15s" }} />
                synced to shared board
              </span>
              <Btn kind="subtle" icon={FolderOpen} onClick={() => setShowLib(true)}>Incidents</Btn>
              <Btn kind="subtle" icon={Printer} onClick={() => downloadPacketPdf({ incident, resources, comms, org, safety, logs })}>Print / Export</Btn>
              <Btn kind="ghost" onClick={() => setShowChangePin(true)} style={{ padding: "6px 9px", fontSize: 12 }}>Change PIN</Btn>
              <Btn kind="ghost" icon={Lock} onClick={onLock} style={{ padding: "6px 9px", fontSize: 12 }}>Lock</Btn>
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
              {tab === "201" && <Tab201 incident={incident} setIncident={setIncident} resources={resources} />}
              {tab === "resources" && <TabResources resources={resources} setResources={setResources} now={effectiveNow} />}
              {tab === "org" && <TabOrg org={org} setOrg={setOrg} />}
              {tab === "rehab" && <TabRehab rehab={rehab} setRehab={setRehab} resources={resources} now={effectiveNow} />}
              {tab === "comms" && <TabComms comms={comms} setComms={setComms} />}
              {tab === "215a" && <Tab215A safety={safety} setSafety={setSafety} org={org} incident={incident} />}
              {tab === "214" && <Tab214 logs={logs} setLogs={setLogs} />}
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
        <LibraryModal index={index} onClose={() => setShowLib(false)} onLoad={openIncident} onNew={startNew} onDelete={deleteIncident} mandatory={!incidentLoaded} />
      )}

      {showChangePin && <ChangePinModal onClose={() => setShowChangePin(false)} />}
    </div>
  );
}
