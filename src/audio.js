// Short synthesized feedback tones (WebAudio only, no audio files).
let ctx = null;

// name -> list of [frequency Hz, duration s]
const TONES = {
  ui: [[620, 0.05]],
  grab: [[440, 0.07]],
  drop: [[330, 0.06], [262, 0.09]],
  flip: [[520, 0.05], [660, 0.06]],
  good: [[523, 0.09], [784, 0.16]],
  bad: [[300, 0.12], [233, 0.18]],
};

/** Must be called from a user gesture (the Enter button). */
export function unlock() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
}

/** Silence the tones while the page or the headset session is hidden, and bring them back. */
export function suspendAudio(hidden) {
  if (!ctx) return;
  try { (hidden ? ctx.suspend() : ctx.resume()).catch(() => {}); } catch { /* closed context */ }
}

export function play(name) {
  if (!ctx || !TONES[name]) return;
  let t = ctx.currentTime;
  for (const [freq, dur] of TONES[name]) {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    t += dur;
  }
}
