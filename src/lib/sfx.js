// Procedural sound effects (Web Audio synthesis — no audio files, no copyright).
// Every effect is written into `out` (an AudioNode) at time `when`.

let noiseBuf = null;
function noise(ctx) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = ctx.sampleRate * 3;
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

function noiseSrc(ctx, when, dur) {
  const s = ctx.createBufferSource();
  s.buffer = noise(ctx);
  s.loop = true;
  s.start(when, Math.random() * 2);
  s.stop(when + dur + 0.05);
  return s;
}

function env(ctx, when, points) {
  // points: [[t, value], ...] relative to `when`, linear ramps
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  for (const [t, v] of points) g.gain.linearRampToValueAtTime(v, when + t);
  return g;
}

function filt(ctx, type, freq, q = 0.7) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  return f;
}

function tone(ctx, out, when, { type = 'sine', f0, f1 = f0, dur, gain = 0.3, attack = 0.005 }) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, when);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, when + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.linearRampToValueAtTime(gain, when + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g).connect(out);
  o.start(when);
  o.stop(when + dur + 0.05);
}

// Tiny bursts of high-passed noise — sand / dust grains.
function crackles(ctx, out, when, dur, count, { rising = false, gain = 0.25 } = {}) {
  for (let i = 0; i < count; i++) {
    let u = Math.random();
    u = rising ? Math.sqrt(u) : 1 - Math.sqrt(1 - u) * 1; // density shaping
    const t = when + u * dur;
    const len = 0.004 + Math.random() * 0.018;
    const s = noiseSrc(ctx, t, len);
    const hp = filt(ctx, 'highpass', 2500 + Math.random() * 4000);
    const g = env(ctx, t, [[0.001, gain * (0.3 + Math.random() * 0.7)], [len, 0.0001]]);
    s.connect(hp).connect(g).connect(out);
  }
}

function whoosh(ctx, out, when, dur, { from = 3000, to = 500, q = 0.9, gain = 0.5, attack = 0.15 } = {}) {
  const s = noiseSrc(ctx, when, dur);
  const bp = filt(ctx, 'bandpass', from, q);
  bp.frequency.setValueAtTime(from, when);
  bp.frequency.exponentialRampToValueAtTime(to, when + dur);
  const g = env(ctx, when, [[attack, gain], [dur * 0.6, gain * 0.7], [dur, 0.0001]]);
  s.connect(bp).connect(g).connect(out);
}

function poofAt(ctx, out, when, big = 1) {
  const dur = 0.45 + 0.25 * big;
  const s = noiseSrc(ctx, when, dur);
  const lp = filt(ctx, 'lowpass', 2400 * big, 0.5);
  lp.frequency.setValueAtTime(2600, when);
  lp.frequency.exponentialRampToValueAtTime(260, when + dur);
  const g = env(ctx, when, [[0.008, 0.9 * big], [0.08, 0.5 * big], [dur, 0.0001]]);
  s.connect(lp).connect(g).connect(out);
  tone(ctx, out, when, { f0: 120, f1: 38, dur: 0.28, gain: 0.55 * big });
}

function rustle(ctx, out, when, dur, gain = 0.35) {
  // paper: band-passed noise with random flutter
  const s = noiseSrc(ctx, when, dur);
  const bp = filt(ctx, 'bandpass', 2800, 1.2);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  const steps = Math.floor(dur / 0.025);
  for (let i = 1; i <= steps; i++) {
    const shape = Math.sin((i / steps) * Math.PI);
    g.gain.linearRampToValueAtTime(gain * shape * (0.3 + Math.random() * 0.7), when + i * 0.025);
  }
  g.gain.linearRampToValueAtTime(0.0001, when + dur + 0.02);
  s.connect(bp).connect(g).connect(out);
}

function clack(ctx, out, when) {
  tone(ctx, out, when, { type: 'triangle', f0: 520, f1: 380, dur: 0.09, gain: 0.35 });
  const s = noiseSrc(ctx, when, 0.03);
  const g = env(ctx, when, [[0.001, 0.4], [0.03, 0.0001]]);
  s.connect(filt(ctx, 'bandpass', 1800, 2)).connect(g).connect(out);
}

function bell(ctx, out, when, f, gain = 0.25, dur = 1.8) {
  for (const [ratio, amp] of [[1, 1], [2.76, 0.45], [5.4, 0.25], [8.93, 0.12]]) {
    if (f * ratio > ctx.sampleRate * 0.45) continue;
    tone(ctx, out, when, { f0: f * ratio, dur: dur / Math.sqrt(ratio), gain: gain * amp, attack: 0.003 });
  }
}

const SFX = {
  dustOut(ctx, out, t, { duration = 2.8 } = {}) {
    whoosh(ctx, out, t, duration, { from: 3500, to: 450, gain: 0.32, attack: 0.25 });
    whoosh(ctx, out, t + 0.1, duration * 0.9, { from: 600, to: 180, q: 0.5, gain: 0.35, attack: 0.5 });
    crackles(ctx, out, t, duration * 0.8, 140, { gain: 0.22 });
    // sad low drone
    tone(ctx, out, t, { f0: 196, f1: 185, dur: duration, gain: 0.07, attack: 0.4 });
    tone(ctx, out, t, { f0: 233, f1: 220, dur: duration, gain: 0.05, attack: 0.4 });
  },
  dustIn(ctx, out, t, { duration = 2.8 } = {}) {
    whoosh(ctx, out, t, duration, { from: 400, to: 3500, gain: 0.32, attack: duration * 0.7 });
    crackles(ctx, out, t, duration, 140, { rising: true, gain: 0.22 });
    tone(ctx, out, t + duration * 0.85, { f0: 900, f1: 1800, dur: 0.6, gain: 0.08, attack: 0.05 });
    tone(ctx, out, t + duration * 0.9, { f0: 1350, f1: 2700, dur: 0.6, gain: 0.05, attack: 0.05 });
  },
  poof(ctx, out, t, { big = 1 } = {}) { poofAt(ctx, out, t, big); },
  unroll(ctx, out, t) { rustle(ctx, out, t, 0.5); clack(ctx, out, t + 0.5); },
  rollUp(ctx, out, t) { rustle(ctx, out, t, 0.45, 0.3); clack(ctx, out, t + 0.45); },
  suck(ctx, out, t) {
    whoosh(ctx, out, t, 1.0, { from: 2500, to: 160, q: 1.4, gain: 0.55, attack: 0.5 });
    tone(ctx, out, t, { type: 'sawtooth', f0: 420, f1: 60, dur: 1.0, gain: 0.06, attack: 0.3 });
  },
  sealChime(ctx, out, t) {
    bell(ctx, out, t, 660, 0.22);
    bell(ctx, out, t + 0.12, 990, 0.16);
    poofAt(ctx, out, t, 0.5);
  },
  burst(ctx, out, t) {
    poofAt(ctx, out, t, 1.4);
    whoosh(ctx, out, t, 0.6, { from: 300, to: 3000, gain: 0.35, attack: 0.05 });
    bell(ctx, out, t + 0.05, 880, 0.12, 1.2);
  },
  // anticipation: a short electric crackle / shiver
  shiver(ctx, out, t) {
    crackles(ctx, out, t, 0.18, 26, { rising: true, gain: 0.2 });
    tone(ctx, out, t, { type: 'sawtooth', f0: 90, f1: 140, dur: 0.18, gain: 0.05, attack: 0.04 });
  },
  // big beat: sub drop + body thump + a short noisy crack
  impact(ctx, out, t) {
    tone(ctx, out, t, { f0: 95, f1: 32, dur: 0.6, gain: 0.7, attack: 0.004 });
    tone(ctx, out, t, { type: 'triangle', f0: 180, f1: 60, dur: 0.18, gain: 0.35, attack: 0.002 });
    const s = noiseSrc(ctx, t, 0.25);
    const lp = filt(ctx, 'lowpass', 1800, 0.7);
    lp.frequency.setValueAtTime(3200, t);
    lp.frequency.exponentialRampToValueAtTime(200, t + 0.25);
    s.connect(lp).connect(env(ctx, t, [[0.003, 0.7], [0.05, 0.25], [0.25, 0.0001]])).connect(out);
  },
  // shockwave: a fast swept whoosh that rushes past
  shockwave(ctx, out, t, { soft = 0 } = {}) {
    const g = soft ? 0.25 : 0.45;
    whoosh(ctx, out, t, 0.55, { from: 600, to: 4200, q: 1.1, gain: g, attack: 0.03 });
    whoosh(ctx, out, t + 0.12, 0.6, { from: 3800, to: 300, q: 0.8, gain: g * 0.6, attack: 0.08 });
  },
  // sparkle: a scatter of tiny bell pings
  sparkle(ctx, out, t, { soft = 0 } = {}) {
    const n = soft ? 4 : 8;
    for (let i = 0; i < n; i++) {
      const f = 1400 + Math.random() * 1800;
      bell(ctx, out, t + i * (0.025 + Math.random() * 0.03), f, (soft ? 0.03 : 0.05) * (1 - i / (n + 2)), 0.5);
    }
  },
  orbStop(ctx, out, t) {
    tone(ctx, out, t, { f0: 1400, f1: 180, dur: 0.4, gain: 0.18 });
    poofAt(ctx, out, t, 0.35);
  },
};

// Looping charge-up hum for the energy orb. Returns { stop(t) }.
function orbLoop(ctx, out, t) {
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.linearRampToValueAtTime(0.5, t + 0.7);
  master.connect(out);
  const nodes = [];
  const lp = filt(ctx, 'lowpass', 900, 4);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 6;
  const lfoG = ctx.createGain();
  lfoG.gain.value = 350;
  lfo.connect(lfoG).connect(lp.frequency);
  lp.connect(master);
  for (const f of [110, 165.5]) {
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = 0.12;
    o.connect(g).connect(lp);
    nodes.push(o);
  }
  // rising whine
  const w = ctx.createOscillator();
  w.frequency.setValueAtTime(500, t);
  w.frequency.exponentialRampToValueAtTime(1500, t + 0.8);
  const vib = ctx.createOscillator();
  vib.frequency.value = 9;
  const vibG = ctx.createGain();
  vibG.gain.value = 25;
  vib.connect(vibG).connect(w.frequency);
  const wg = ctx.createGain();
  wg.gain.value = 0.05;
  w.connect(wg).connect(master);
  nodes.push(w, vib, lfo);
  // sizzle
  const n = ctx.createBufferSource();
  n.buffer = noise(ctx);
  n.loop = true;
  const hp = filt(ctx, 'highpass', 5000);
  const ng = ctx.createGain();
  ng.gain.value = 0.06;
  n.connect(hp).connect(ng).connect(master);
  nodes.push(n);
  nodes.forEach((x) => x.start(t));
  return {
    stop(at) {
      master.gain.cancelScheduledValues(at);
      master.gain.setValueAtTime(master.gain.value, at);
      master.gain.linearRampToValueAtTime(0.0001, at + 0.25);
      nodes.forEach((x) => x.stop(at + 0.3));
      SFX.orbStop(ctx, out, at);
    },
  };
}

export function createSfxPlayer(ctx, out) {
  let orb = null;
  return {
    play(name, opts = {}) {
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
      const t = ctx.currentTime + 0.01 + (opts.delay || 0);
      if (name === 'orbStart') {
        if (!orb) orb = orbLoop(ctx, out, t);
        return;
      }
      if (name === 'orbStop') {
        if (orb) { orb.stop(t); orb = null; }
        return;
      }
      SFX[name]?.(ctx, out, t, opts);
    },
  };
}
