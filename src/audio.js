// Shared Web Audio helper for the Mayday alarm.
//
// iOS Safari (and most mobile browsers) only allow an AudioContext to
// be created or resumed from inside a genuine user gesture (a tap).
// Creating a brand-new context later, outside a gesture — which is
// exactly what happens when a Mayday is triggered remotely by another
// device — starts it "suspended" and silently unable to play. The fix
// is to create ONE context as early as possible, during a gesture
// that's guaranteed to happen anyway (unlocking the PIN screen), and
// keep reusing that same instance afterward.
//
// That alone isn't the full story, though: iOS also RE-suspends an
// already-unlocked context the moment the tab loses focus, the phone
// locks, or the app is backgrounded — and resuming it again from
// outside a fresh gesture (which is exactly what happens when a
// remote Mayday arrives while the device is idle) silently does not
// work on iOS, no matter how the context was originally created. This
// module resumes it opportunistically on every tap in the app and
// every time the tab becomes visible again (see resumeOnAnyGesture /
// resumeOnVisible below, wired up in App.jsx), which meaningfully
// improves the odds if the device is actively being used, but there
// is no client-side trick that reliably plays audio while a phone is
// genuinely locked or the browser is backgrounded — that's a real,
// hard platform restriction. The only fully reliable fix for a
// locked/backgrounded phone is a native push notification (Web Push
// via a service worker), which is a materially larger feature
// involving Firebase Cloud Messaging and is not what this module
// does.
let sharedCtx = null;

function getCtx() {
  if (!sharedCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

// Call this from inside a real click/tap handler, as early in the
// session as possible.
export function unlockAudioContext() {
  try {
    const ctx = getCtx();
    if (ctx && ctx.state === "suspended") ctx.resume();
  } catch { /* Web Audio unsupported — nothing to do */ }
}

export function playMaydayTone() {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const beep = (freq, startTime, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.3, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.02);
    };
    const now = ctx.currentTime;
    for (let i = 0; i < 4; i++) {
      beep(880, now + i * 0.4, 0.18);
      beep(660, now + i * 0.4 + 0.2, 0.18);
    }
  } catch { /* Web Audio unsupported or blocked — the popup still shows regardless */ }
}

// Call once, on app mount, to wire up the opportunistic re-resume
// attempts described above. Returns a cleanup function.
export function setupAudioResumeListeners() {
  const resume = () => { try { const ctx = getCtx(); if (ctx && ctx.state === "suspended") ctx.resume(); } catch { /* ignore */ } };
  const onVisible = () => { if (document.visibilityState === "visible") resume(); };
  window.addEventListener("pointerdown", resume);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("pointerdown", resume);
    document.removeEventListener("visibilitychange", onVisible);
  };
}
