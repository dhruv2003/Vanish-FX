// Shared motion-design toolkit: easing curves, springs, noise / curl noise,
// camera shake, shockwaves, light flashes and impact frames.
// Everything here is allocation-light so it can run every frame.
import { canvas, ctx2d } from './vision.js';

// ------------------------------------------------------------------ basics
export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
/** progress of t through [a, b], clamped to 0..1 */
export const seg = (t, a, b) => clamp((t - a) / (b - a));
export const TAU = Math.PI * 2;

// ------------------------------------------------------------------ easing
// Each property gets its own curve: position usually eases out, alpha eases
// in late, scale overshoots (back / elastic / spring), etc.
const backC = 1.70158;
export const ease = {
  linear: (t) => t,
  inQuad: (t) => t * t,
  outQuad: (t) => 1 - (1 - t) * (1 - t),
  inOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  inCubic: (t) => t * t * t,
  outCubic: (t) => 1 - Math.pow(1 - t, 3),
  inOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  inQuart: (t) => t * t * t * t,
  outQuart: (t) => 1 - Math.pow(1 - t, 4),
  inExpo: (t) => (t <= 0 ? 0 : Math.pow(2, 10 * t - 10)),
  outExpo: (t) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  inOutExpo: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? Math.pow(2, 20 * t - 10) / 2 : (2 - Math.pow(2, -20 * t + 10)) / 2),
  inOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  outSine: (t) => Math.sin((t * Math.PI) / 2),
  inBack: (t, s = backC) => (s + 1) * t * t * t - s * t * t,
  outBack: (t, s = backC) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  outElastic: (t) => (t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  outBounce: (t) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
};

/**
 * Closed-form damped spring step response 0 → 1 (overshoots when zeta < 1).
 * Deterministic, so it suits fixed timelines (pop-ins, settles).
 *   t      seconds since release
 *   freq   natural frequency in Hz
 *   zeta   damping ratio (0.3 = wobbly, 0.7 = soft overshoot, 1 = critical)
 */
export function springCurve(t, freq = 3, zeta = 0.45) {
  if (t <= 0) return 0;
  const w = TAU * freq;
  if (zeta >= 1) return 1 - Math.exp(-w * t) * (1 + w * t);
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}

/** Integrated spring that chases a moving target (follow-through, lag, overshoot). */
export class Spring {
  constructor(value = 0, { stiffness = 170, damping = 22, mass = 1 } = {}) {
    this.value = value; this.target = value; this.vel = 0;
    this.k = stiffness; this.c = damping; this.m = mass;
  }
  set(v) { this.value = this.target = v; this.vel = 0; return this; }
  kick(impulse) { this.vel += impulse; return this; }
  step(dt, target = this.target) {
    this.target = target;
    // semi-implicit Euler with sub-steps: stable for stiff springs at 15 fps
    const n = Math.max(1, Math.ceil(dt / (1 / 120)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = (-this.k * (this.value - this.target) - this.c * this.vel) / this.m;
      this.vel += a * h;
      this.value += this.vel * h;
    }
    return this.value;
  }
  get settled() { return Math.abs(this.vel) < 1e-3 && Math.abs(this.value - this.target) < 1e-3; }
}

export class Spring2 {
  constructor(x = 0, y = 0, opts) { this.x = new Spring(x, opts); this.y = new Spring(y, opts); }
  set(x, y) { this.x.set(x); this.y.set(y); return this; }
  step(dt, tx, ty) { this.x.step(dt, tx); this.y.step(dt, ty); return this; }
  get vx() { return this.x.vel; }
  get vy() { return this.y.vel; }
  get px() { return this.x.value; }
  get py() { return this.y.value; }
}

// ------------------------------------------------------------------ noise
export function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
export function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(hash(xi, yi), hash(xi + 1, yi), u), lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), u), v);
}
export const fbm = (x, y) => vnoise(x, y) * 0.6 + vnoise(x * 2.3, y * 2.3) * 0.3 + vnoise(x * 5.1, y * 5.1) * 0.1;

/**
 * Curl of a scalar noise field: a divergence-free flow (turbulent wind that
 * swirls instead of converging). Writes into `out` to avoid allocations.
 */
export function curl(x, y, t, out) {
  const e = 0.35;
  const n = (a, b) => vnoise(a + t * 0.37, b - t * 0.23) + 0.5 * vnoise(a * 2.1 - t * 0.5, b * 2.1 + t * 0.4);
  const dx = (n(x + e, y) - n(x - e, y)) / (2 * e);
  const dy = (n(x, y + e) - n(x, y - e)) / (2 * e);
  out.x = dy; out.y = -dx;
  return out;
}

// ------------------------------------------------------------------ shake
/** Trauma-based camera shake (trauma² → amplitude, smooth noise offsets). */
export class Shake {
  constructor() { this.trauma = 0; }
  add(a) { this.trauma = clamp(this.trauma + a); }
  update(dt) { this.trauma = Math.max(0, this.trauma - dt * 1.6); }
  sample(now, W) {
    const s = this.trauma * this.trauma;
    const t = now / 1000 * 22;
    return {
      x: (vnoise(t, 3.1) * 2 - 1) * s * W * 0.022,
      y: (vnoise(7.7, t) * 2 - 1) * s * W * 0.016,
      r: (vnoise(t, 11.3) * 2 - 1) * s * 0.018,
      s,
    };
  }
}

// --------------------------------------------------------- overlay FX layer
/**
 * Global one-shot beats shared by all effects: shockwave rings (with a cheap
 * refraction warp), radial light flashes, impact frames and camera shake.
 */
export class MotionFX {
  constructor() {
    this.rings = [];
    this.flashes = [];
    this.impactUntil = 0;
    this.impactStart = 0;
    this.shake = new Shake();
  }

  shockwave(x, y, { r0 = 10, r1 = 300, dur = 0.6, color = '255,240,220', width = 0.12, warp = 1 } = {}) {
    this.rings.push({ x, y, r0, r1, dur, color, width, warp, age: 0 });
  }
  flash(x, y, { radius = 400, dur = 0.35, color = '255,235,200', peak = 0.9, full = 0 } = {}) {
    this.flashes.push({ x, y, radius, dur, color, peak, full, age: 0 });
  }
  impact(now, ms = 90) { this.impactStart = now; this.impactUntil = now + ms; }
  kick(amount) { this.shake.add(amount); }
  get busy() { return this.rings.length || this.flashes.length || this.shake.trauma > 0; }

  resize(W, H) {
    if (this.W === W && this.H === H) return;
    this.W = W; this.H = H;
    this.snap = canvas(W, H); this.snapX = ctx2d(this.snap);
  }

  /** Draw rings + flashes over the composed frame `outC`. */
  render(c, outC, dt) {
    const { W, H } = this;
    if (this.rings.length) {
      // refraction: a ring-shaped window onto a slightly magnified copy of the frame
      this.snapX.globalCompositeOperation = 'copy';
      this.snapX.drawImage(outC, 0, 0);
      for (const r of this.rings) {
        r.age += dt;
        const u = clamp(r.age / r.dur);
        const rad = lerp(r.r0, r.r1, ease.outCubic(u));
        const w = Math.max(2, rad * r.width * (1 - u * 0.5));
        const fade = 1 - ease.inQuad(u);
        if (r.warp > 0) {
          c.save();
          c.beginPath();
          c.arc(r.x, r.y, rad + w, 0, TAU);
          c.arc(r.x, r.y, Math.max(0, rad - w), 0, TAU, true);
          c.clip();
          const m = 1 + 0.06 * r.warp * fade;
          c.translate(r.x, r.y); c.scale(m, m); c.translate(-r.x, -r.y);
          c.drawImage(this.snap, 0, 0);
          c.restore();
        }
        c.save();
        c.globalCompositeOperation = 'lighter';
        const g = c.createRadialGradient(r.x, r.y, Math.max(0, rad - w), r.x, r.y, rad + w);
        g.addColorStop(0, `rgba(${r.color},0)`);
        g.addColorStop(0.55, `rgba(${r.color},${0.38 * fade})`);
        g.addColorStop(0.7, `rgba(255,255,255,${0.2 * fade})`);
        g.addColorStop(1, `rgba(${r.color},0)`);
        c.fillStyle = g;
        c.beginPath(); c.arc(r.x, r.y, rad + w, 0, TAU); c.fill();
        c.restore();
      }
      this.rings = this.rings.filter((r) => r.age < r.dur);
    }
    if (this.flashes.length) {
      c.save();
      c.globalCompositeOperation = 'lighter';
      for (const f of this.flashes) {
        f.age += dt;
        const u = clamp(f.age / f.dur);
        // fast attack, exponential decay
        const a = f.peak * (u < 0.12 ? u / 0.12 : Math.pow(1 - (u - 0.12) / 0.88, 2.2));
        const g = c.createRadialGradient(f.x, f.y, 0, f.x, f.y, f.radius * (0.7 + 0.5 * u));
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(0.25, `rgba(${f.color},${a * 0.7})`);
        g.addColorStop(1, `rgba(${f.color},0)`);
        c.fillStyle = g;
        c.fillRect(0, 0, W, H);
        if (f.full) { c.fillStyle = `rgba(${f.color},${a * f.full})`; c.fillRect(0, 0, W, H); }
      }
      c.restore();
      this.flashes = this.flashes.filter((f) => f.age < f.dur);
    }
  }

  /**
   * Post pass: impact frame (a couple of high-contrast frames) and camera shake.
   * Returns true if it changed `outC` (via the scratch copy).
   */
  post(outX, outC, now, dt) {
    this.shake.update(dt);
    const impact = now < this.impactUntil;
    const sh = this.shake.sample(now, this.W);
    if (!impact && sh.s < 1e-4) return false;
    const { W, H } = this;
    this.snapX.globalCompositeOperation = 'copy';
    this.snapX.drawImage(outC, 0, 0);
    outX.save();
    outX.globalCompositeOperation = 'copy';
    if (sh.s > 1e-4) {
      // zoom a touch so the shaken frame never reveals its edges
      const z = 1 + sh.s * 0.05 + Math.abs(sh.r) * 0.6;
      outX.translate(W / 2 + sh.x, H / 2 + sh.y);
      outX.rotate(sh.r);
      outX.scale(z, z);
      outX.translate(-W / 2, -H / 2);
    }
    outX.drawImage(this.snap, 0, 0);
    outX.restore();
    if (impact) {
      // anime-style impact frame: inverted, crushed contrast, warm tint
      const k = 1 - clamp((now - this.impactStart) / (this.impactUntil - this.impactStart));
      outX.save();
      outX.globalAlpha = 0.3 + 0.3 * k;
      outX.filter = 'grayscale(1) contrast(2.6) invert(1)';
      outX.drawImage(this.snap, 0, 0);
      outX.filter = 'none';
      outX.globalAlpha = 0.25 * k;
      outX.globalCompositeOperation = 'overlay';
      outX.fillStyle = '#ff9a3c';
      outX.fillRect(0, 0, W, H);
      outX.restore();
    }
    return true;
  }
}

/**
 * Smear trail: draw `img` at earlier points along a motion path with falling
 * alpha (cheap motion blur for fast moves). `at(k)` returns {x,y,sx,sy,rot}
 * for k in 0..1 (1 = current).
 */
export function smear(c, img, at, { copies = 4, alpha = 0.35, spread = 1 } = {}) {
  for (let i = copies; i >= 1; i--) {
    const k = 1 - (i / copies) * spread;
    const p = at(k);
    if (!p) continue;
    c.save();
    c.globalAlpha = alpha * (1 - i / (copies + 1));
    c.translate(p.x, p.y);
    if (p.rot) c.rotate(p.rot);
    c.scale(p.sx ?? 1, p.sy ?? 1);
    c.drawImage(img, -p.ox, -p.oy);
    c.restore();
  }
}
