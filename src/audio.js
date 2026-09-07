// Shared Web Audio helper for the Mayday alarm.
//
// iOS Safari (and most mobile browsers) only allow an AudioContext to
// be created or resumed from inside a genuine user gesture (a tap).
// Creating a brand-new context later, outside a gesture — which is
// exactly what happens when a Mayday is triggered remotely by another
// device — starts it "suspended" and silently unable to play. The fix
// is to create ONE context as early as possible, during a gesture
// that's guaranteed to happen anyway (unlocking the PIN screen), and
// keep reusing that same instance afterward. Once a specific
// AudioContext instance has been started inside a gesture, that same
// instance can keep playing sounds later without needing another one.
let sharedCtx = null;

// Call this from inside a real click/tap handler, as early in the
// session as possible.
export function unlockAudioContext() {
  try {
    if (!sharedCtx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return;
      sharedCtx = new Ctor();
    }
    if (sharedCtx.state === "suspended") sharedCtx.resume();
  } catch { /* Web Audio unsupported — nothing to do */ }
}

// A generated two-tone siren, not an audio file — avoids needing any
// external asset. Uses the shared, already-unlocked context when
// available; falls back to a fresh one otherwise (which will work
// fine on desktop browsers, and on the device that itself triggers
// the Mayday, since that's a click — but may still be silently
// blocked on a device receiving the alert remotely if it was never
// unlocked via unlockAudioContext first).
export function playMaydayTone() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    const ctx = sharedCtx || new Ctor();
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
