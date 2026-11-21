// Game sounds, made on the spot with Web Audio: no audio files to bundle or load. Off until the
// player switches them on in a game window; the choice is kept on this device.

const KEY = 'freetime.play.sound';
let ctx = null;

export function soundOn() {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function setSound(on) {
  try {
    localStorage.setItem(KEY, on ? '1' : '0');
  } catch {
    // Not kept: the next game starts silent again.
  }
  if (on) audio(); // created inside the click, so the browser lets it play
}

function audio() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

/** One note: a frequency (sliding to `to`), a shape, and a short envelope. */
function tone(a, { freq, to, type = 'sine', at = 0, dur = 0.08, gain = 0.12 }) {
  const t0 = a.currentTime + at;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.03);
}

/** A burst of filtered noise (splashes, knocks). */
function noise(a, { at = 0, dur = 0.2, gain = 0.1, freq = 900, type = 'lowpass' }) {
  const t0 = a.currentTime + at;
  const buffer = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buffer;
  const f = a.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(f).connect(g).connect(a.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

const SOUNDS = {
  move: (a) => {
    tone(a, { freq: 540, to: 400, dur: 0.06, gain: 0.09 });
    noise(a, { dur: 0.03, gain: 0.05, freq: 2400, type: 'bandpass' });
  },
  capture: (a) => {
    tone(a, { freq: 320, to: 150, type: 'triangle', dur: 0.12, gain: 0.14 });
    noise(a, { dur: 0.06, gain: 0.09, freq: 1800, type: 'bandpass' });
  },
  check: (a) => {
    tone(a, { freq: 660, type: 'square', dur: 0.07, gain: 0.05 });
    tone(a, { freq: 880, type: 'square', at: 0.08, dur: 0.09, gain: 0.05 });
  },
  box: (a) => tone(a, { freq: 620, to: 990, dur: 0.13, gain: 0.1 }),
  miss: (a) => noise(a, { dur: 0.32, gain: 0.12, freq: 700 }),
  hit: (a) => {
    tone(a, { freq: 190, to: 80, type: 'square', dur: 0.16, gain: 0.07 });
    noise(a, { dur: 0.2, gain: 0.12, freq: 1200 });
  },
  sunk: (a) => {
    SOUNDS.hit(a);
    tone(a, { freq: 420, to: 90, type: 'sawtooth', at: 0.12, dur: 0.45, gain: 0.05 });
  },
  win: (a) => [523, 659, 784, 1047].forEach((freq, k) => tone(a, { freq, type: 'triangle', at: k * 0.09, dur: 0.16, gain: 0.11 })),
  lose: (a) => [392, 330, 262].forEach((freq, k) => tone(a, { freq, type: 'triangle', at: k * 0.12, dur: 0.2, gain: 0.1 })),
  draw: (a) => [440, 440].forEach((freq, k) => tone(a, { freq, type: 'triangle', at: k * 0.12, dur: 0.14, gain: 0.09 })),
};

/** Plays one of the sounds above, if sounds are on. */
export function sound(name) {
  if (!SOUNDS[name] || !soundOn()) return;
  const a = audio();
  if (!a) return;
  try {
    SOUNDS[name](a);
  } catch {
    // No sound is better than a broken game.
  }
}
