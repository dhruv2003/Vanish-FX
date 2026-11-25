// The four effects + shared smoke system. Canvas 2D on OffscreenCanvas, plus a
// small WebGL fragment shader for the energy orb.
//
// Motion design notes: every beat has anticipation → action → follow-through.
// Positions ease out, alphas fade late, scales overshoot on springs, fast moves
// smear, and big beats get a flash / shockwave / impact frame / camera shake
// from the shared MotionFX layer (X.fx).
import { canvas, ctx2d } from './vision.js';
import { clamp, lerp, seg, ease, springCurve, Spring, Spring2, hash, fbm, curl, TAU } from './motion.js';

const rnd = (a, b) => a + Math.random() * (b - a);
const bump = (t) => (t <= 0 || t >= 1 ? 0 : Math.sin(Math.PI * t)); // 0 → 1 → 0
const tmpV = { x: 0, y: 0 };

// ===================================================================== smoke
// Smoke v2: billowing, noise-textured sprites with self-shadowing, rotation,
// eased expansion, buoyancy and drift that inherits the puff's direction.
function makeSmokeSprite(seed, ash) {
  const S = 128, c = canvas(S, S), x = ctx2d(c), img = x.createImageData(S, S), d = img.data;
  const ox = seed * 17.3, oy = seed * 5.1;
  for (let py = 0, i = 0; py < S; py++) {
    for (let px = 0; px < S; px++, i += 4) {
      const u = (px - S / 2) / (S / 2), v = (py - S / 2) / (S / 2);
      const r = Math.hypot(u, v);
      const n = fbm(px / 18 + ox, py / 18 + oy);
      const n2 = fbm(px / 7 + oy, py / 7 + ox);
      // lumpy cauliflower edge: noise pushes the falloff in and out
      const edge = 0.62 + (n - 0.5) * 0.55;
      let a = clamp((edge - r) / (edge * 0.55));
      a = a * a * (3 - 2 * a) * (0.55 + 0.45 * n2);
      // fake lighting: lit from top-left, darker underside
      const lit = clamp(0.78 - v * 0.22 - u * 0.08 + (n2 - 0.5) * 0.35, 0.35, 1);
      if (ash) {
        d[i] = 70 * lit + 22; d[i + 1] = 60 * lit + 18; d[i + 2] = 54 * lit + 16;
      } else {
        d[i] = 255 * lit; d[i + 1] = 252 * lit; d[i + 2] = 250 * lit;
      }
      d[i + 3] = a * 235;
    }
  }
  x.putImageData(img, 0, 0);
  return c;
}

export class Smoke {
  constructor() {
    this.ps = [];
    this.sprites = [1, 2, 3, 4].map((s) => makeSmokeSprite(s, false));
    this.ash = [5, 6, 7].map((s) => makeSmokeSprite(s, true));
  }
  /**
   * opts: count, speed, dir {x,y} (drift the puff inherits), tint 'ash',
   * life, alpha, delay (stagger: particles are released over `delay` seconds)
   */
  puff(x, y, radius, { count = 26, speed = 1, dir = null, tint = null, life = 1, alpha = 0.95, delay = 0, ring = 1 } = {}) {
    const set = tint === 'ash' ? this.ash : this.sprites;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const sp = radius * (1.2 + Math.random() * 2.4) * speed * ring;
      const size = Math.pow(Math.random(), 1.6); // mostly small, a few big billows
      this.ps.push({
        x: x + Math.cos(a) * radius * 0.18, y: y + Math.sin(a) * radius * 0.18,
        vx: Math.cos(a) * sp + (dir ? dir.x * radius * 2.2 * speed : 0),
        vy: Math.sin(a) * sp * 0.8 - radius * 0.35 + (dir ? dir.y * radius * 2.2 * speed : 0),
        rot: Math.random() * TAU, vr: rnd(-2.2, 2.2),
        r0: radius * (0.25 + size * 0.3), r1: radius * (0.7 + size * 1.0),
        life: (0.7 + Math.random() * 0.7) * life, age: -Math.random() * delay,
        spr: set[i % set.length], alpha, rise: radius * rnd(0.4, 0.9),
      });
    }
  }
  render(c, dt) {
    if (!this.ps.length) return;
    c.save();
    for (const p of this.ps) {
      p.age += dt;
      if (p.age < 0) continue;
      const drag = Math.exp(-dt * 3.8);
      p.vx *= drag; p.vy *= drag;
      p.vy -= p.rise * dt; // buoyancy
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vr *= Math.exp(-dt * 1.5);
      p.rot += p.vr * dt;
      const u = p.age / p.life;
      const r = lerp(p.r0, p.r1, ease.outCubic(clamp(u)));
      const fadeIn = clamp(p.age / 0.07);
      c.globalAlpha = clamp(Math.pow(1 - u, 1.7) * p.alpha * fadeIn);
      c.setTransform(1, 0, 0, 1, p.x, p.y);
      c.rotate(p.rot);
      c.drawImage(p.spr, -r, -r, r * 2, r * 2);
    }
    c.restore();
    this.ps = this.ps.filter((p) => p.age < p.life);
  }
}

// ================================================================ dust snap
// Dust v2: the body is sliced into 20 noise-assigned layers of 2 px grains that
// drift, rotate and scale while fading to ash, plus up to 900 additive embers.
// Layer slicing / ash fade / ember seeding adapted from
// thanos-snap-video-extension (thanos_engine.js `_buildDust` / `_drawDust`),
// MIT © 2026 Aayush Bhatta. Our additions: anticipation shiver + chromatic
// flicker, charred edge band, velocity smears, curl-noise embers, fine grains,
// a lingering ash cloud and a spiral / overshoot / settle reappear.
const DUST_LAYERS = 20;
const DUST_MAX_W = 640;
const ANTICIP = 0.16;  // s — shiver before the breakup
const SETTLE = 0.45;   // s — settle pulse after reappearing
const DIRS = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] };

export class DustSnap {
  constructor() { this.state = 'idle'; this.tailUntil = 0; }
  get hidesPerson() { return this.state !== 'idle'; }
  get busy() { return this.state === 'out' || this.state === 'in'; }

  trigger(X) {
    if (this.busy) return false;
    if (this.state === 'idle') return this._begin(X, 'out');
    if (this.state === 'gone') return this._begin(X, 'in');
    return false;
  }

  _begin(X, dir) {
    const { masks, settings } = X;
    if (!masks.bbox) {
      // nobody in frame: just toggle state instantly
      this.state = dir === 'out' ? 'gone' : 'idle';
      X.mic(dir === 'out' && settings.muteWhileGone);
      return true;
    }
    this.D = clamp(settings.dustDuration || 2.8, 1, 8);
    this.t0 = X.now;
    this.state = dir;
    this._build(X, dir);
    this.cues = new Set();
    if (dir === 'out') {
      X.sfx('shiver');
      X.fx.kick(0.12);
      if (settings.muteWhileGone) setTimeout(() => X.mic(true), 300);
    } else {
      X.sfx('dustIn', { duration: this.D });
      X.mic(false);
    }
    return true;
  }

  _alloc(W, H, LW, LH) {
    if (this.W === W && this.H === H) return;
    this.W = W; this.H = H; this.LW = LW; this.LH = LH;
    this.src = canvas(LW, LH); this.srcX = ctx2d(this.src, { willReadFrequently: true });
    this.layerC = Array.from({ length: DUST_LAYERS }, () => canvas(LW, LH));
    this.layerX = this.layerC.map((c) => ctx2d(c));
    this.buf = new ImageData(LW, LH);
    this.map = new Uint8Array(LW * LH);
    this.scratch = canvas(LW, LH); this.scratchX = ctx2d(this.scratch);
    this.maskC = canvas(LW, LH); this.maskX = ctx2d(this.maskC);
    this.body = canvas(W, H); this.bodyX = ctx2d(this.body);
    this.tint = canvas(W, H); this.tintX = ctx2d(this.tint);
    // fine grains render at half resolution (cheap putImageData)
    this.gw = W >> 1; this.gh = H >> 1;
    this.gImg = new ImageData(this.gw, this.gh);
    this.g32 = new Uint32Array(this.gImg.data.buffer);
    this.gC = canvas(this.gw, this.gh); this.gX = ctx2d(this.gC);
  }

  _build(X, mode) {
    const { W, H, settings } = X;
    const LW = Math.min(W, DUST_MAX_W), LH = Math.round((H * LW) / W);
    this._alloc(W, H, LW, LH);
    const sx = this.srcX;
    sx.globalCompositeOperation = 'copy';
    sx.drawImage(X.layers.person(), 0, 0, LW, LH);
    const src = sx.getImageData(0, 0, LW, LH).data;

    let minX = LW, maxX = 0, minY = LH, maxY = 0;
    for (let y = 0; y < LH; y += 3) {
      for (let x = 0; x < LW; x += 3) {
        if (src[(y * LW + x) * 4 + 3] > 40) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX <= minX) { minX = 0; maxX = LW; minY = 0; maxY = LH; }
    const [dx, dy] = DIRS[settings.dustDirection] || DIRS.right;
    this.dir = [dx, dy];

    // low-frequency value noise so the dissolve eats away in organic patches
    const GW = 9, GH = 7;
    const grid = Array.from({ length: GW * GH }, Math.random);
    const noise = (x, y) => {
      const fx = (x / LW) * (GW - 1), fy = (y / LH) * (GH - 1);
      const ix = Math.min(GW - 2, fx | 0), iy = Math.min(GH - 2, fy | 0);
      const tx = fx - ix, ty = fy - iy;
      const a = grid[iy * GW + ix], b = grid[iy * GW + ix + 1];
      const c = grid[(iy + 1) * GW + ix], d = grid[(iy + 1) * GW + ix + 1];
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    };

    const K = DUST_LAYERS, G = 2;
    const map = this.map;
    map.fill(255);
    const spanX = maxX - minX + 1, spanY = maxY - minY + 1;
    const kx = W / LW, ky = H / LH;
    const embers = [];
    const fine = [];
    const cxs = new Float32Array(K), cys = new Float32Array(K), cns = new Float32Array(K);
    const fineEvery = Math.max(1, Math.round(Math.sqrt((spanX * spanY) / (G * G) / 5000)));
    let gi = 0;
    for (let y = 0; y < LH; y += G) {
      for (let x = 0; x < LW; x += G) {
        const i0 = (y * LW + x) * 4;
        if (src[i0 + 3] < 12) continue;
        // downwind edge breaks first (the wind eats the side it blows toward)
        const along = dx ? (dx > 0 ? (x - minX) / spanX : 1 - (x - minX) / spanX) : (dy > 0 ? (y - minY) / spanY : 1 - (y - minY) / spanY);
        let v = 0.45 * (1 - along) + 0.55 * noise(x, y) + (Math.random() - 0.5) * 0.32;
        v = clamp((v + 0.16) / 1.32);
        const li = Math.min(K - 1, (v * K) | 0);
        for (let yy = y; yy < Math.min(LH, y + G); yy++) {
          for (let xx = x; xx < Math.min(LW, x + G); xx++) map[yy * LW + xx] = li;
        }
        cxs[li] += x; cys[li] += y; cns[li]++;
        if (Math.random() < 0.006 && embers.length < 900) {
          embers.push({ ox: x * kx, oy: y * ky, x: 0, y: 0, vx: 0, vy: 0, li, s: 1 + Math.random() * 2.2, warm: Math.random() < 0.35, seed: Math.random() * 100, live: false });
        }
        if (gi++ % fineEvery === 0 && fine.length < 9000) {
          fine.push(x * kx, y * ky, li, src[i0] | (src[i0 + 1] << 8) | (src[i0 + 2] << 16), Math.random() * 100);
        }
      }
    }
    // paint each layer canvas (one reusable ImageData, K passes)
    const bd = this.buf.data;
    for (let li = 0; li < K; li++) {
      bd.fill(0);
      for (let p = 0, n = LW * LH; p < n; p++) {
        if (map[p] !== li) continue;
        const o = p * 4;
        bd[o] = src[o]; bd[o + 1] = src[o + 1]; bd[o + 2] = src[o + 2]; bd[o + 3] = src[o + 3];
      }
      this.layerX[li].putImageData(this.buf, 0, 0);
    }
    this.embers = embers;
    this.fine = Float32Array.from(fine);
    this.nFine = fine.length / 5;
    this.cx = ((minX + maxX) / 2) * kx;
    this.cy = ((minY + maxY) / 2) * ky;
    this.span = Math.max(spanX * kx, spanY * ky);
    const up = dx !== 0 ? -1 : 0;
    this.layers = Array.from({ length: K }, (_, i) => {
      // mostly downwind, lifted upward a bit (horizontal winds), staggered starts
      const ang = Math.atan2(dy, dx) + (up ? up * (0.15 + Math.random() * 0.55) * Math.sign(dx || 1) : (Math.random() - 0.5) * 0.7);
      const dist = (0.22 + Math.random() * 0.26) * W;
      return {
        start: (i / K) * 0.55 + Math.random() * 0.02,
        len: 0.38 + Math.random() * 0.07,
        vx: Math.cos(ang) * dist, vy: Math.sin(ang) * dist,
        rot: (Math.random() - 0.5) * 0.3,
        spin: Math.random() < 0.5 ? -1 : 1,
        cx: cns[i] ? (cxs[i] / cns[i]) * kx : this.cx, cy: cns[i] ? (cys[i] / cns[i]) * ky : this.cy,
      };
    });
  }

  // progress of layer i at normalised time lt (out: dissolving, in: arriving)
  _local(L, lt, mode) {
    if (mode === 'out') return clamp((lt - L.start) / L.len);
    return clamp((lt - (1 - L.start - L.len)) / L.len);
  }

  render(X) {
    const now = X.now;
    if (this.state === 'gone') { if (now < this.tailUntil) this._tail(X); return; }
    if (this.state !== 'out' && this.state !== 'in') return;
    const t = (now - this.t0) / 1000;
    if (this.state === 'out') this._renderOut(X, t);
    else this._renderIn(X, t);
  }

  // live body = live person ∩ layers that haven't left yet (so you keep moving)
  _drawBody(X, keep, { jitter = 0, chroma = 0, scale = 1 } = {}) {
    const m = this.maskX, { LW, LH, W, H } = this;
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, LW, LH);
    let any = false;
    for (let i = 0; i < DUST_LAYERS; i++) if (keep(i)) { m.drawImage(this.layerC[i], 0, 0); any = true; }
    if (!any) return;
    const b = this.bodyX;
    b.globalCompositeOperation = 'copy';
    b.drawImage(X.layers.person(), 0, 0);
    b.globalCompositeOperation = 'destination-in';
    b.drawImage(this.maskC, 0, 0, W, H);
    b.globalCompositeOperation = 'source-over';
    const c = X.ctx;
    c.save();
    if (scale !== 1) { c.translate(this.cx, this.cy); c.scale(scale, scale); c.translate(-this.cx, -this.cy); }
    const jx = jitter ? (Math.random() - 0.5) * jitter : 0, jy = jitter ? (Math.random() - 0.5) * jitter * 0.6 : 0;
    c.drawImage(this.body, jx, jy);
    if (chroma > 0) {
      // chromatic flicker: red / cyan fringes split sideways
      const tx = this.tintX;
      for (const [col, off] of [['#ff2a2a', -1], ['#20e0ff', 1]]) {
        tx.globalCompositeOperation = 'copy';
        tx.drawImage(this.body, 0, 0);
        tx.globalCompositeOperation = 'source-atop';
        tx.fillStyle = col;
        tx.fillRect(0, 0, W, H);
        c.globalCompositeOperation = 'screen';
        c.globalAlpha = 0.45 * chroma;
        c.drawImage(this.tint, jx + off * chroma * W * 0.006, jy);
      }
    }
    c.restore();
  }

  // a layer drawn from the snapshot, tinted (ash / char / glow)
  _layer(c, i, tintCol, tintA, mode = 'source-over') {
    const { W, H } = this;
    if (tintA > 0.001) {
      const s = this.scratchX;
      s.globalCompositeOperation = 'copy';
      s.drawImage(this.layerC[i], 0, 0);
      s.globalCompositeOperation = 'source-atop';
      s.fillStyle = `rgba(${tintCol},${tintA})`;
      s.fillRect(0, 0, this.LW, this.LH);
      c.globalCompositeOperation = mode;
      c.drawImage(this.scratch, 0, 0, W, H);
    } else {
      c.globalCompositeOperation = mode;
      c.drawImage(this.layerC[i], 0, 0, W, H);
    }
  }

  _renderOut(X, t) {
    const c = X.ctx, D = this.D, Dd = D - ANTICIP;
    const lt = (t - ANTICIP) / Dd; // dissolve progress (negative during anticipation)
    if (t >= D) {
      this.state = 'gone';
      this.tailUntil = X.now + 1600;
      this._tail(X);
      return;
    }
    // --- anticipation: body shiver + chromatic flicker, then dissolve
    const ant = seg(t, 0, ANTICIP);
    const flicker = t < ANTICIP + 0.12 ? (Math.random() < 0.7 ? 1 : 0.3) * (1 - seg(t, ANTICIP, ANTICIP + 0.12)) : 0;
    this._drawBody(X, (i) => this._local(this.layers[i], lt, 'out') <= 0, {
      jitter: X.W * 0.006 * bump(ant) + X.W * 0.002 * flicker, chroma: Math.max(bump(ant), flicker * 0.6),
    });
    this._cue('dust', ANTICIP, t, () => { X.sfx('dustOut', { duration: D - ANTICIP }); X.fx.kick(0.18); });
    // --- charred band: layers about to break go dark with a hot orange rim
    c.save();
    for (let i = 0; i < DUST_LAYERS; i++) {
      const L = this.layers[i];
      const pending = (L.start - lt) * Dd; // seconds until it breaks
      if (pending <= 0 || pending > 0.3) continue;
      const u = 1 - pending / 0.3;
      c.globalAlpha = 1;
      this._layer(c, i, '26,16,10', 0.92 * ease.outQuad(u));
      c.globalAlpha = 0.6 * bump(u * 0.9 + 0.1);
      this._layer(c, i, '255,110,30', 0.9, 'lighter');
    }
    // --- flying layers with velocity smears
    for (let i = 0; i < DUST_LAYERS; i++) {
      const L = this.layers[i];
      const local = this._local(L, lt, 'out');
      if (local <= 0 || local >= 1) continue;
      this._cue('ash' + i, -1, 0, () => {
        X.smoke.puff(L.cx, L.cy, this.span * 0.13, { count: 2, tint: 'ash', dir: { x: L.vx / X.W, y: L.vy / X.W }, speed: 0.5, life: 2.8, alpha: 0.26 });
      });
      for (let k = 2; k >= 0; k--) {
        const lk = local - k * 0.045;
        if (lk <= 0) continue;
        const e = ease.inQuad(lk); // accelerates away
        const a = Math.pow(1 - lk, 1.4) * (k ? 0.22 / k : 1);
        if (a < 0.01) continue;
        c.save();
        c.globalAlpha = a;
        const wob = Math.sin(lk * 5 + i) * X.W * 0.012 * lk;
        c.translate(L.cx + L.vx * e - L.vy / X.W * wob, L.cy + L.vy * e + L.vx / X.W * wob);
        c.rotate(L.rot * e * L.spin);
        const sc = 1 + 0.1 * e;
        // stretch along the direction of travel (faster = longer)
        const ang = Math.atan2(L.vy, L.vx), st = 1 + 0.35 * lk;
        c.rotate(ang); c.scale(sc * st, sc / Math.sqrt(st)); c.rotate(-ang);
        c.translate(-L.cx, -L.cy);
        this._layer(c, i, '62,48,40', Math.min(0.75, lk * 1.6));
        c.restore();
      }
    }
    c.restore();
    this._fine(X, lt, 'out');
    this._embers(X, lt, 'out', X.dt);
  }

  _renderIn(X, t) {
    const c = X.ctx, D = this.D;
    const lt = t / D;
    if (t >= D + SETTLE) { this.state = 'idle'; return; }
    if (t >= D) {
      // --- settle pulse: a damped scale throb + white rim light
      const u = (t - D) / SETTLE;
      this._cue('settle', D, t, () => {
        X.sfx('sparkle');
        X.fx.flash(this.cx, this.cy, { radius: this.span * 0.8, dur: 0.4, color: '255,240,210', peak: 0.25 });
        X.fx.shockwave(this.cx, this.cy, { r0: this.span * 0.2, r1: this.span * 0.8, dur: 0.5, width: 0.05, warp: 0.4 });
      });
      const pulse = 1 + 0.035 * Math.exp(-5 * u) * Math.sin(u * Math.PI * 3);
      this._drawBody(X, () => true, { scale: pulse });
      const rim = Math.pow(1 - u, 2) * 0.5;
      if (rim > 0.01) {
        c.save();
        c.globalAlpha = rim;
        this.tintX.globalCompositeOperation = 'copy';
        this.tintX.drawImage(this.body, 0, 0);
        this.tintX.globalCompositeOperation = 'source-atop';
        this.tintX.fillStyle = '#fff3dc';
        this.tintX.fillRect(0, 0, X.W, X.H);
        c.globalCompositeOperation = 'lighter';
        c.translate(this.cx, this.cy); c.scale(pulse, pulse); c.translate(-this.cx, -this.cy);
        c.drawImage(this.tint, 0, 0);
        c.restore();
      }
      return;
    }
    this._drawBody(X, (i) => this._local(this.layers[i], lt, 'in') >= 1);
    c.save();
    for (let i = 0; i < DUST_LAYERS; i++) {
      const L = this.layers[i];
      const local = this._local(L, lt, 'in');
      if (local <= 0 || local >= 1) continue;
      // spiral home with overshoot (outBack), regaining colour on the way
      const p = ease.outBack(local, 2.2);
      const q = 1 - p; // 1 far … 0 home (slightly negative = overshoot)
      const th = q * 1.5 * L.spin;
      const ox = L.vx * q, oy = L.vy * q;
      const cs = Math.cos(th), sn = Math.sin(th);
      c.save();
      c.globalAlpha = Math.pow(local, 0.6);
      c.translate(L.cx + ox * cs - oy * sn, L.cy + ox * sn + oy * cs);
      c.rotate(L.rot * q * L.spin);
      const sc = 1 + 0.1 * q;
      c.scale(sc, sc);
      c.translate(-L.cx, -L.cy);
      this._layer(c, i, '62,48,40', Math.min(0.75, Math.max(0, q) * 1.6));
      // arrival glint
      const g = bump(seg(local, 0.7, 1));
      if (g > 0.02) { c.globalAlpha = g * 0.6; this._layer(c, i, '255,230,180', 0.9, 'lighter'); }
      c.restore();
    }
    c.restore();
    this._fine(X, lt, 'in');
    this._embers(X, lt, 'in', X.dt);
  }

  _cue(name, at, t, fn) { if (t >= at && !this.cues.has(name)) { this.cues.add(name); fn(); } }

  // fine grains: inherit their layer's velocity, plus turbulence; streaked
  _fine(X, lt, mode) {
    const { gw, gh, g32, fine, nFine, layers, W } = this;
    g32.fill(0);
    const sx = gw / W;
    const out = mode === 'out';
    const dr = 74, dg = 66, db = 58;
    for (let j = 0; j < nFine; j++) {
      const o = j * 5;
      const L = layers[fine[o + 2]];
      let local = this._local(L, lt, mode);
      if (local <= 0 || local >= 1) continue;
      const sd = fine[o + 4];
      const u = out ? local : 1 - local; // distance along the path
      const e = out ? ease.inQuad(u) * 1.25 : ease.inCubic(u) * 1.25;
      const wob = Math.sin(sd + u * 6) * W * 0.03 * u;
      let x = fine[o] + L.vx * e + Math.cos(sd) * wob;
      let y = fine[o + 1] + L.vy * e + Math.sin(sd * 1.3) * wob - (out ? W * 0.04 * u * u : 0);
      if (!out) {
        // converge on a spiral
        const th = u * 2.2 * L.spin, ox = x - fine[o], oy = y - fine[o + 1];
        x = fine[o] + ox * Math.cos(th) - oy * Math.sin(th);
        y = fine[o + 1] + ox * Math.sin(th) + oy * Math.cos(th);
      }
      const alpha = (out ? Math.pow(1 - u, 1.2) : Math.pow(1 - u, 0.8)) * 255;
      if (alpha < 6) continue;
      const k = clamp(u * 1.6);
      const col = fine[o + 3];
      const r = lerp(col & 255, dr, k), g = lerp((col >> 8) & 255, dg, k), b = lerp((col >> 16) & 255, db, k);
      const X0 = (x * sx) | 0, Y0 = (y * sx) | 0;
      // streak: head + 2 tail pixels opposite the travel direction
      const vx = L.vx, vy = L.vy, vl = Math.hypot(vx, vy) || 1;
      const tx = out ? -vx / vl : vx / vl, ty = out ? -vy / vl : vy / vl;
      for (let s = 0; s < 3; s++) {
        const px = (X0 + tx * s * (1 + u * 2)) | 0, py = (Y0 + ty * s * (1 + u * 2)) | 0;
        if (px < 0 || py < 0 || px >= gw || py >= gh) continue;
        const a = (alpha * (1 - s * 0.35)) & 255;
        g32[py * gw + px] = (a << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
      }
    }
    this.gX.putImageData(this.gImg, 0, 0);
    X.ctx.drawImage(this.gC, 0, 0, W, this.H);
  }

  // embers: integrate layer velocity + curl-noise wind; additive streaks
  _embers(X, lt, mode, dt) {
    const c = X.ctx, W = this.W;
    const out = mode === 'out';
    const tt = X.now / 1000;
    c.save();
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';
    for (const p of this.embers) {
      const L = this.layers[p.li];
      const local = out ? clamp((lt - L.start) / (L.len * 1.4)) : this._local(L, lt, 'in');
      if (local <= 0 || local >= 1) { p.live = false; continue; }
      if (out) {
        if (!p.live) { p.live = true; p.x = p.ox; p.y = p.oy; p.vx = L.vx * 0.4; p.vy = L.vy * 0.4 - W * 0.05; }
        curl(p.x / (W * 0.12), p.y / (W * 0.12), tt, tmpV);
        const ax = L.vx * 1.1 + tmpV.x * W * 0.9, ay = L.vy * 1.1 + tmpV.y * W * 0.9 - W * 0.12;
        p.vx += (ax - p.vx) * Math.min(1, dt * 2.5);
        p.vy += (ay - p.vy) * Math.min(1, dt * 2.5);
        p.x += p.vx * dt; p.y += p.vy * dt;
      } else {
        // reverse: spiral in from far away
        const q = 1 - ease.outCubic(local);
        const th = q * 2.4 * L.spin + p.seed;
        const r = q * (Math.hypot(L.vx, L.vy) * 1.2);
        const nx = p.ox + Math.cos(th) * r, ny = p.oy + Math.sin(th) * r;
        if (!p.live) { p.live = true; p.x = nx; p.y = ny; }
        p.vx = (nx - p.x) / Math.max(dt, 1e-3); p.vy = (ny - p.y) / Math.max(dt, 1e-3);
        p.x = nx; p.y = ny;
      }
      const a = out ? (1 - local) : bump(local);
      c.strokeStyle = p.warm ? (out ? `rgba(255,150,70,${a * 0.9})` : `rgba(255,220,150,${a})`) : `rgba(190,170,150,${a * 0.6})`;
      c.lineWidth = p.s;
      const k = 0.035;
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(p.x - p.vx * k, p.y - p.vy * k);
      c.stroke();
    }
    c.restore();
  }

  // after the body is gone, embers and grains keep riding the wind briefly
  _tail(X) {
    const lt = 1 + (X.now - (this.t0 + this.D * 1000)) / 1000 / (this.D - ANTICIP);
    this._embers(X, Math.min(lt, 1.6), 'out', X.dt);
  }
}

// ============================================================ sealing scroll
function drawChakra(c, x, y, R, k, now, hue = 'gold') {
  if (k <= 0.01) return;
  c.save();
  c.globalCompositeOperation = 'lighter';
  const col = hue === 'gold' ? '255,170,60' : '90,170,255';
  let g = c.createRadialGradient(x, y, 0, x, y, R);
  g.addColorStop(0, `rgba(255,240,200,${0.55 * k})`);
  g.addColorStop(0.35, `rgba(${col},${0.35 * k})`);
  g.addColorStop(1, `rgba(${col},0)`);
  c.fillStyle = g;
  c.beginPath(); c.arc(x, y, R, 0, TAU); c.fill();
  // rotating rays
  const t = now / 1000;
  c.translate(x, y);
  c.rotate(t * 0.9);
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU;
    const len = R * (0.75 + 0.25 * Math.sin(t * 5 + i * 1.7));
    c.fillStyle = `rgba(${col},${0.22 * k})`;
    c.beginPath();
    c.moveTo(Math.cos(a - 0.05) * R * 0.15, Math.sin(a - 0.05) * R * 0.15);
    c.lineTo(Math.cos(a) * len, Math.sin(a) * len);
    c.lineTo(Math.cos(a + 0.05) * R * 0.15, Math.sin(a + 0.05) * R * 0.15);
    c.fill();
  }
  // contracting rings (energy gathering)
  c.lineWidth = Math.max(1, R * 0.012);
  for (let i = 0; i < 3; i++) {
    const u = ((t * 0.9 + i / 3) % 1);
    c.strokeStyle = `rgba(255,230,170,${0.5 * k * u})`;
    c.beginPath(); c.arc(0, 0, R * (1 - u) * 0.9, 0, TAU); c.stroke();
  }
  c.restore();
}

function drawScroll(c, cx, cy, openW, h, glow, now, wob = 0) {
  const rr = h * 0.12;           // roller radius
  const rl = h * 1.18;           // roller length
  c.save();
  // paper (with wobble follow-through: skew + flutter from the unroll spring)
  if (openW > 1) {
    const x0 = cx - openW / 2, y0 = cy - h / 2;
    c.save();
    c.translate(cx, cy);
    c.transform(1, wob * 0.05, 0, 1 - Math.abs(wob) * 0.04, 0, 0);
    c.translate(-cx, -cy);
    const g = c.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, '#d9c28c'); g.addColorStop(0.12, '#f1e3bb'); g.addColorStop(0.88, '#efdfb4'); g.addColorStop(1, '#cdb37a');
    c.fillStyle = g;
    c.fillRect(x0, y0, openW, h);
    c.save();
    c.beginPath(); c.rect(x0, y0, openW, h); c.clip();
    c.strokeStyle = 'rgba(140,30,25,0.85)';
    c.lineWidth = h * 0.02;
    c.strokeRect(x0 + h * 0.07, y0 + h * 0.07, Math.max(0, openW - h * 0.14), h * 0.86);
    c.lineWidth = h * 0.008;
    c.strokeRect(x0 + h * 0.1, y0 + h * 0.1, Math.max(0, openW - h * 0.2), h * 0.8);
    c.strokeStyle = 'rgba(25,18,15,0.78)';
    c.lineCap = 'round';
    const cols = Math.floor((openW / 2 - h * 0.45) / (h * 0.09));
    for (let side = -1; side <= 1; side += 2) {
      for (let k = 0; k < cols; k++) {
        const x = cx + side * (h * 0.42 + k * h * 0.09);
        let y = y0 + h * 0.18;
        while (y < y0 + h * 0.8) {
          const len = h * (0.025 + hash(k * 7 + side, y) * 0.05);
          c.lineWidth = h * (0.008 + hash(y, k) * 0.012);
          c.beginPath(); c.moveTo(x - h * 0.012, y); c.lineTo(x + h * 0.012, y + len * 0.6); c.stroke();
          y += len + h * 0.03;
        }
      }
    }
    const R = h * 0.3;
    if (glow > 0) { c.shadowColor = 'rgba(255,190,60,0.95)'; c.shadowBlur = h * 0.35 * glow; }
    c.strokeStyle = glow > 0 ? `rgba(${lerp(150, 255, glow) | 0},${lerp(30, 160, glow) | 0},30,1)` : 'rgba(150,30,25,0.95)';
    c.lineWidth = h * 0.025;
    c.beginPath(); c.arc(cx, cy, R, 0, TAU); c.stroke();
    c.lineWidth = h * 0.012;
    c.beginPath(); c.arc(cx, cy, R * 0.8, 0, TAU); c.stroke();
    c.beginPath();
    for (let a = 0; a < Math.PI * 6; a += 0.12) {
      const r = (a / (Math.PI * 6)) * R * 0.62;
      const px = cx + Math.cos(a + now * 0.004 * glow) * r, py = cy + Math.sin(a + now * 0.004 * glow) * r;
      a === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
    }
    c.stroke();
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * TAU + now * 0.001 * glow;
      c.beginPath();
      c.moveTo(cx + Math.cos(a) * R * 0.82, cy + Math.sin(a) * R * 0.82);
      c.lineTo(cx + Math.cos(a) * R * 0.97, cy + Math.sin(a) * R * 0.97);
      c.stroke();
    }
    c.font = `bold ${R * 0.62}px serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = c.strokeStyle;
    c.fillText('封', cx, cy + R * 0.03);
    c.restore();
    const sh = c.createLinearGradient(x0, 0, x0 + openW, 0);
    const e = Math.min(0.15, (h * 0.15) / openW);
    sh.addColorStop(0, 'rgba(70,45,10,0.35)'); sh.addColorStop(e, 'rgba(70,45,10,0)');
    sh.addColorStop(1 - e, 'rgba(70,45,10,0)'); sh.addColorStop(1, 'rgba(70,45,10,0.35)');
    c.fillStyle = sh;
    c.fillRect(x0, y0, openW, h);
    c.restore();
  }
  // rollers lag the paper a little (secondary motion)
  for (const side of [-1, 1]) {
    const rx = cx + side * (openW / 2 + rr * 0.85);
    const ry = cy + side * wob * h * 0.04;
    const g = c.createLinearGradient(rx - rr, 0, rx + rr, 0);
    g.addColorStop(0, '#4a2a12'); g.addColorStop(0.35, '#b07a45'); g.addColorStop(0.55, '#d9a46a'); g.addColorStop(1, '#3b200d');
    c.fillStyle = g;
    c.fillRect(rx - rr, ry - h * 0.52, rr * 2, h * 1.04);
    const pg = c.createLinearGradient(rx - rr, 0, rx + rr, 0);
    pg.addColorStop(0, '#a88e58'); pg.addColorStop(0.5, '#f3e6c2'); pg.addColorStop(1, '#9a804a');
    c.fillStyle = pg;
    c.fillRect(rx - rr * 0.92, ry - h / 2, rr * 1.84, h);
    c.fillStyle = '#7a1f17';
    for (const end of [-1, 1]) {
      const ey = ry + end * (rl / 2);
      c.beginPath();
      c.ellipse(rx, ey - end * rr * 0.25, rr * 1.05, rr * 0.45, 0, 0, TAU);
      c.fill();
      c.fillStyle = '#3d0f0b';
      c.fillRect(rx - rr * 0.95, Math.min(ey, ry + end * h * 0.5), rr * 1.9, Math.abs(ey - (ry + end * h * 0.5)));
      c.fillStyle = '#7a1f17';
    }
  }
  c.restore();
}

/**
 * Person on a spiral path into (e→1) or out of (e→0) the scroll. Stretches
 * toward the scroll while moving fast (squash & stretch), shrinks, spins.
 * e < 0 = overshoot past full size (spring pop-out).
 */
function warpXform(b, tx, ty, e, spin) {
  const ee = clamp(e);
  const th = ee * spin;
  const vx = b.cx - tx, vy = b.cy - ty;
  const k = 1 - ee;
  const x = tx + (vx * Math.cos(th) - vy * Math.sin(th)) * k;
  const y = ty + (vx * Math.sin(th) + vy * Math.cos(th)) * k;
  const scale = Math.max(0.001, 1 - e);
  const st = 1 + 0.9 * bump(ee); // stretch while in flight
  return { x, y, scale, st, dir: Math.atan2(ty - y, tx - x), rot: ee * ee * 2.4 * Math.sign(spin), alpha: 1 - seg(ee, 0.85, 1) };
}
function drawWarped(c, img, b, tx, ty, e, spin, alphaMul = 1) {
  const p = warpXform(b, tx, ty, e, spin);
  c.save();
  c.globalAlpha = p.alpha * alphaMul;
  c.translate(p.x, p.y);
  c.rotate(p.dir); c.scale(p.st, 1 / Math.sqrt(p.st)); c.rotate(-p.dir);
  c.rotate(p.rot);
  c.scale(p.scale, p.scale);
  c.drawImage(img, -b.cx, -b.cy);
  c.restore();
}

export class SealScroll {
  constructor() {
    this.state = 'idle'; this.sparks = [];
    this.tassel = new Spring(0, { stiffness: 40, damping: 3 });
  }
  get hidesPerson() {
    if (this.state === 'sealed') return true;
    const t = this.t();
    if (this.state === 'sealing') return t >= 1.0;
    if (this.state === 'releasing') return t < 1.2;
    return false;
  }
  t() { return (performance.now() - this.t0) / 1000; }

  trigger(X) {
    if (this.state === 'idle') {
      const b = X.masks.bbox;
      if (!b) return false;
      const { W, H } = X;
      this.h = clamp(b.w * 0.42, H * 0.18, H * 0.32);
      this.maxW = Math.min(W * 0.8, this.h * 3.3);
      this.cx = clamp(b.cx, W * 0.25, W * 0.75);
      this.cy = clamp(b.y + b.h * 0.62, H * 0.4, H * 0.78);
      if (!this.snap || this.snap.width !== W || this.snap.height !== H) { this.snap = canvas(W, H); this.snapX = ctx2d(this.snap); }
      this.snapX.globalCompositeOperation = 'copy';
      this.snapX.drawImage(X.layers.person(), 0, 0);
      this.bbox = { ...b };
      this.spin = (Math.random() < 0.5 ? -1 : 1) * 2.6;
      this.state = 'sealing';
      this.t0 = performance.now();
      this.cues = new Set();
      X.smoke.puff(this.cx, this.cy, this.h * 0.8, { count: 24, delay: 0.12 });
      X.sfx('poof');
      return true;
    }
    if (this.state === 'sealed') {
      this.state = 'releasing';
      this.t0 = performance.now();
      this.cues = new Set();
      X.sfx('shiver');
      return true;
    }
    return false;
  }

  _cue(name, at, fn) { if (this.t() >= at && !this.cues.has(name)) { this.cues.add(name); fn(); } }

  _impact(X, big) {
    X.fx.impact(X.now, big ? 90 : 60);
    X.fx.kick(big ? 0.6 : 0.45);
    X.fx.shockwave(this.cx, this.cy, { r0: this.h * 0.3, r1: this.h * (big ? 4.5 : 3.2), dur: big ? 0.7 : 0.55, color: '255,210,140' });
    X.fx.flash(this.cx, this.cy, { radius: this.h * (big ? 4 : 2.5), dur: big ? 0.5 : 0.35, peak: big ? 0.85 : 0.7, full: big ? 0.12 : 0 });
  }

  render(X) {
    if (this.state === 'idle') return;
    const c = X.ctx, now = X.now, t = this.t();
    let openW = 0, scale = 1, glow = 0, bob = 0, rot = 0, sx = 1, sy = 1, wob = 0, chakra = 0, jx = 0, jy = 0;
    const h = this.h;
    if (this.state === 'sealing') {
      // spring pop-in with a wind-up rotation
      scale = springCurve(t, 2.2, 0.38);
      rot = -0.35 * (1 - springCurve(t, 1.8, 0.3));
      // unroll on a wobbly spring; the spring error drives paper flutter
      const open = springCurve(t - 0.22, 1.6, 0.42);
      const close = t >= 2.0 ? springCurve(t - 2.0, 2.6, 0.62) : 0;
      openW = Math.max(0, this.maxW * open * (1 - close));
      wob = (t > 0.22 && open > 0.6 ? clamp((open - 1) * 2.5, -1, 1) : 0) + Math.sin(t * 19) * 0.3 * bump(seg(t, 0.22, 1.1));
      // anticipation: chakra glow builds, scroll inhales before the suck
      chakra = ease.inOutSine(seg(t, 0.45, 1.0)) * (1 - seg(t, 1.9, 2.3) * 0.7);
      const inhale = bump(seg(t, 0.8, 1.05));
      sx *= 1 + 0.05 * inhale; sy *= 1 - 0.05 * inhale;
      // gulp: squash kick as the person disappears inside
      const gulp = seg(t, 1.9, 2.2);
      if (gulp > 0 && gulp < 1) { const s = Math.exp(-5 * gulp) * Math.sin(gulp * Math.PI * 3) * 0.12; sx *= 1 + s; sy *= 1 - s; }
      // snap shut: rollers clack together and squash
      const shut = seg(t, 2.35, 2.75);
      if (shut > 0 && shut < 1) { const s = Math.exp(-6 * shut) * Math.sin(shut * Math.PI * 4) * 0.18; sx *= 1 - s; sy *= 1 + s; }
      glow = seg(t, 1.1, 1.6) * (1 - seg(t, 2.3, 2.6) * 0.6);
      this._cue('unroll', 0.22, () => X.sfx('unroll'));
      this._cue('suck', 1.0, () => X.sfx('suck'));
      this._cue('mute', 1.1, () => X.settings.muteWhileGone && X.mic(true));
      this._cue('gulp', 1.9, () => X.fx.kick(0.22));
      this._cue('roll', 2.0, () => X.sfx('rollUp'));
      this._cue('shut', 2.35, () => {
        X.sfx('impact'); X.sfx('sealChime');
        this._impact(X, false);
        X.smoke.puff(this.cx, this.cy, h * 0.6, { count: 16, ring: 1.4 });
      });
      drawChakra(c, this.cx, this.cy, h * 2.4 * (0.6 + 0.4 * chakra), chakra, now);
      if (t >= 1.0) {
        const e = seg(t, 1.0, 1.9);
        if (e < 1) {
          const ee = ease.inCubic(e) * 0.6 + e * 0.4;
          // motion-smear trail: the same snapshot at earlier points of the path
          for (const [lag, a] of [[0.12, 0.18], [0.06, 0.3]]) {
            const el = Math.max(0, ee - lag);
            if (el > 0) drawWarped(c, this.snap, this.bbox, this.cx, this.cy, el, this.spin, a);
          }
          drawWarped(c, this.snap, this.bbox, this.cx, this.cy, ee, this.spin);
          this._spawnSparks(X, 6);
        }
      }
      if (t >= 2.9) { this.state = 'sealed'; this.tassel.set(0); }
    } else if (this.state === 'sealed') {
      // idle float: bob, sway that lags the bob, a tassel on a loose spring
      const tt = now / 1000;
      bob = Math.sin(tt * 1.7) * h * 0.05;
      rot = Math.sin(tt * 1.7 - 0.9) * 0.045;
      const acc = -Math.sin(tt * 1.7) * 1.7 * 1.7 * 0.05;
      this.tassel.step(X.dt, acc * 4);
      glow = 0.4 + 0.15 * Math.sin(tt * 3.3);
      chakra = 0.18 + 0.08 * Math.sin(tt * 2.1);
      drawChakra(c, this.cx, this.cy + bob, h * 1.6, chakra, now);
    } else if (this.state === 'releasing') {
      // anticipation: tremble harder and harder, inhale
      const ant = seg(t, 0, 0.4);
      jx = (Math.random() - 0.5) * h * 0.08 * ant * ant;
      jy = (Math.random() - 0.5) * h * 0.05 * ant * ant;
      sx *= 1 - 0.06 * ease.inQuad(ant) * (t < 0.4 ? 1 : 0);
      sy *= 1 + 0.06 * ease.inQuad(ant) * (t < 0.4 ? 1 : 0);
      chakra = t < 0.4 ? ease.inQuad(ant) : 1 - seg(t, 0.4, 1.0);
      const open = springCurve(t - 0.4, 2.6, 0.35);
      const close = t >= 1.25 ? springCurve(t - 1.25, 2.6, 0.62) : 0;
      openW = Math.max(0, this.maxW * open * (1 - close));
      wob = t > 0.4 && open > 0.6 ? clamp((open - 1) * 2.5, -1, 1) : 0;
      glow = 0.5 + ant * 0.5 - seg(t, 0.6, 1.0);
      // exit: stretch up, then squash to nothing
      const pre = bump(seg(t, 1.6, 1.78));
      sx *= 1 - 0.12 * pre; sy *= 1 + 0.15 * pre;
      scale = 1 - ease.inBack(seg(t, 1.75, 1.98), 2.2);
      this._cue('burst', 0.4, () => {
        X.sfx('burst'); X.sfx('shockwave');
        this._impact(X, true);
        X.smoke.puff(this.cx, this.cy, h * 1.3, { count: 34, speed: 1.4, ring: 1.3 });
        X.mic(false);
      });
      this._cue('roll', 1.25, () => X.sfx('rollUp'));
      this._cue('gone', 1.85, () => { X.sfx('poof', { big: 0.6 }); X.smoke.puff(this.cx, this.cy, h * 0.6, { count: 16 }); });
      drawChakra(c, this.cx, this.cy, h * 2.6, chakra, now);
      if (t >= 0.4 && t < 1.2 && X.masks.bbox) {
        // spring pop-out: e goes 1 → 0 and overshoots below 0 (bigger than life)
        const p = springCurve(t - 0.4, 1.9, 0.42);
        const e = 1 - p;
        const img = X.layers.person(), b = X.masks.bbox;
        if (e > 0.05) drawWarped(c, img, b, this.cx, this.cy, Math.min(1, e + 0.12), -this.spin, 0.3);
        drawWarped(c, img, b, this.cx, this.cy, e, -this.spin);
      }
      if (t >= 2.1) { this.state = 'idle'; return; }
    }
    this._renderSparks(c, X.dt);
    if (scale > 0.01) {
      c.save();
      c.translate(this.cx + jx, this.cy + bob + jy);
      c.rotate(rot);
      c.scale(scale * sx, scale * sy);
      drawScroll(c, 0, 0, openW, h, clamp(glow), now, wob);
      if (this.state === 'sealed') this._drawTassel(c, h);
      c.restore();
    }
  }

  _drawTassel(c, h) {
    const a = clamp(this.tassel.value, -0.8, 0.8);
    const y0 = h * 0.62, L = h * 0.55;
    c.save();
    c.translate(0, y0);
    c.rotate(a);
    c.strokeStyle = '#8a1c14'; c.lineWidth = Math.max(1, h * 0.015);
    c.beginPath(); c.moveTo(0, 0); c.quadraticCurveTo(-a * L * 0.3, L * 0.5, 0, L * 0.7); c.stroke();
    c.fillStyle = '#c0392b';
    c.beginPath(); c.ellipse(0, L * 0.72, h * 0.04, h * 0.05, 0, 0, TAU); c.fill();
    c.fillStyle = '#e0a030';
    for (let i = -2; i <= 2; i++) c.fillRect(i * h * 0.012 - h * 0.004, L * 0.75, h * 0.008, L * 0.25);
    c.restore();
  }

  _spawnSparks(X, n) {
    const b = this.bbox;
    for (let i = 0; i < n; i++) {
      const x = b.x + Math.random() * b.w, y = b.y + Math.random() * b.h;
      const ang = Math.atan2(y - this.cy, x - this.cx);
      this.sparks.push({ ang, rad: Math.hypot(x - this.cx, y - this.cy), age: 0, life: 0.55 + Math.random() * 0.3, gold: Math.random() < 0.45, sz: 2 + Math.random() * 4, px: x, py: y });
    }
  }
  _renderSparks(c, dt) {
    if (!this.sparks.length) return;
    c.save();
    c.lineCap = 'round';
    for (const p of this.sparks) {
      p.age += dt;
      const u = clamp(p.age / p.life);
      const r = p.rad * (1 - ease.inCubic(u));
      const a = p.ang + u * 3.2 * Math.sign(this.spin || 1);
      const x = this.cx + Math.cos(a) * r, y = this.cy + Math.sin(a) * r;
      c.globalAlpha = 1 - u * 0.5;
      c.globalCompositeOperation = p.gold ? 'lighter' : 'source-over';
      c.strokeStyle = p.gold ? '#ffd36b' : '#1c1226';
      c.lineWidth = p.sz * (1 - u * 0.6);
      // velocity streak from the previous position
      c.beginPath(); c.moveTo(p.px, p.py); c.lineTo(x, y); c.stroke();
      p.px = x; p.py = y;
    }
    c.restore();
    this.sparks = this.sparks.filter((p) => p.age < p.life);
  }
}

// =============================================================== clone burst
const CLONE_SLOTS = [
  { dx: -0.8, s: 0.93, b: 0.95, delay: 2 },
  { dx: 0.8, s: 0.93, b: 0.95, delay: 4 },
  { dx: -1.55, s: 0.84, b: 0.86, delay: 6 },
  { dx: 1.55, s: 0.84, b: 0.86, delay: 8 },
];
const CLONE_GAP = 0.16, CLONE_LEAD = 0.1, POP_GAP = 0.1, POP_DUR = 0.34;

export class CloneBurst {
  constructor() { this.state = 'off'; this.hist = []; this.head = 0; this.alphas = [0, 0, 0, 0]; }
  get active() { return this.state !== 'off'; }

  trigger(X) {
    const b = X.masks.bbox;
    const n = clamp(X.settings.cloneCount | 0 || 2, 2, 4);
    if (this.state === 'off' || this.state === 'leaving') {
      if (!b) return false;
      this.state = 'appearing';
      this.t0 = X.now;
      this.n = n;
      this.cues = new Set();
      this.alphas.fill(0);
      return true;
    }
    this.state = 'leaving';
    this.t0 = X.now;
    this.cues = new Set();
    return true;
  }

  _record(X) {
    const { W, H } = X;
    if (this.hist.length !== 10 || this.hist[0].width !== W || this.hist[0].height !== H) {
      this.hist = Array.from({ length: 10 }, () => canvas(W, H));
      this.histCtx = this.hist.map((c) => ctx2d(c));
      this.flashC = canvas(W, H); this.flashX = ctx2d(this.flashC);
      this.filled = 0;
    }
    this.head = (this.head + 1) % 10;
    const x = this.histCtx[this.head];
    x.globalCompositeOperation = 'copy';
    x.drawImage(X.layers.person(), 0, 0);
    this.filled = Math.min(10, (this.filled || 0) + 1);
  }

  // Draw clones behind the real person. Returns true if it drew something.
  render(X) {
    if (this.state === 'off') return false;
    const b = X.masks.bbox;
    this._record(X);
    const t = (X.now - this.t0) / 1000;
    const slots = CLONE_SLOTS.slice(0, this.n);
    // per-slot transform: { a, sx, sy, flash }
    const tf = slots.map(() => null);
    slots.forEach((sl, i) => {
      if (this.state === 'appearing' || this.state === 'on') {
        const at = CLONE_LEAD + i * CLONE_GAP;
        if (b) {
          const cx = b.cx + sl.dx * b.w, cy = b.cy;
          // staggered cascade of puffs leading each clone
          for (let k = 0; k < 3; k++) {
            this._cue(`p${i}${k}`, at - 0.1 + k * 0.05, t, () => {
              X.smoke.puff(cx + rnd(-0.15, 0.15) * b.w, cy + (k - 1) * b.h * 0.22, b.w * (0.32 - k * 0.04) * sl.s, { count: 10, speed: 0.9 });
            });
          }
          this._cue(`s${i}`, at - 0.08, t, () => X.sfx('poof', { big: 0.75 }));
          this._cue(`k${i}`, at + 0.02, t, () => X.sfx('sparkle', { soft: 1 }));
        }
        const u = t - at;
        if (u <= 0) { this.alphas[i] = 0; return; }
        // pop: spring scale with overshoot; stretch from the spring's velocity
        const p = this.state === 'on' ? 1 : springCurve(u, 2.6, 0.35);
        const vel = this.state === 'on' ? 0 : (springCurve(u + 0.016, 2.6, 0.35) - p) / 0.016;
        const st = clamp(vel * 0.05, -0.25, 0.35);
        this.alphas[i] = clamp(u / 0.06);
        tf[i] = { sx: p / (1 + st * 0.6), sy: p * (1 + st), flash: 1 - seg(u, 0.02, 0.26) };
      } else if (this.state === 'leaving') {
        const at = i * POP_GAP;
        const u = (t - at) / POP_DUR;
        if (b) {
          this._cue(`q${i}`, at + POP_DUR * 0.35, t, () => {
            X.smoke.puff(b.cx + sl.dx * b.w, b.cy, b.w * 0.45 * sl.s, { count: 18, speed: 1.1 });
            X.sfx('poof', { big: 0.6 });
          });
        }
        if (u <= 0) { tf[i] = { sx: 1, sy: 1, flash: 0 }; return; }
        if (u < 0.35) {
          // anticipation squash
          const a = ease.outQuad(u / 0.35);
          tf[i] = { sx: 1 + 0.22 * a, sy: 1 - 0.3 * a, flash: 0.4 * a };
        } else {
          // stretch up and vanish
          const v = ease.inCubic(clamp((u - 0.35) / 0.65));
          tf[i] = { sx: 1.22 * (1 - v), sy: 0.7 + 0.8 * v, flash: 0.4 * (1 - v) };
          this.alphas[i] = 1 - v;
        }
        if (u >= 1) this.alphas[i] = 0;
      }
    });
    if (this.state === 'appearing' && t > CLONE_LEAD + slots.length * CLONE_GAP + 0.6) this.state = 'on';
    if (this.state === 'leaving' && t > (slots.length - 1) * POP_GAP + POP_DUR + 0.05) { this.state = 'off'; this.alphas.fill(0); }
    if (!b) return false;
    const c = X.ctx;
    const ay = b.y + b.h;
    const tt = X.now / 1000;
    let drew = false;
    for (let i = slots.length - 1; i >= 0; i--) {
      const sl = slots[i];
      if (this.alphas[i] <= 0) continue;
      const f = tf[i] || { sx: 1, sy: 1, flash: 0 };
      const k = (this.head - Math.min(sl.delay, this.filled - 1) + 10) % 10;
      // secondary motion: each clone sways on its own rhythm
      const sway = Math.sin(tt * (1.1 + i * 0.23) + i * 1.7) * b.w * 0.035;
      const lean = Math.sin(tt * (0.8 + i * 0.17) + i) * 0.025;
      const ax = b.cx + sl.dx * b.w + sway;
      const draw = (img) => {
        c.translate(ax, ay);
        c.rotate(lean);
        c.scale(sl.s * f.sx, sl.s * f.sy);
        c.translate(-b.cx, -ay);
        c.drawImage(img, 0, 0);
      };
      c.save();
      c.globalAlpha = this.alphas[i];
      c.filter = `brightness(${sl.b})`;
      draw(this.hist[k]);
      c.restore();
      if (f.flash > 0.02) {
        // white silhouette flash
        const fx = this.flashX;
        fx.globalCompositeOperation = 'copy';
        fx.drawImage(this.hist[k], 0, 0);
        fx.globalCompositeOperation = 'source-atop';
        fx.fillStyle = '#ffffff';
        fx.fillRect(0, 0, X.W, X.H);
        c.save();
        c.globalAlpha = this.alphas[i] * f.flash * 0.95;
        draw(this.flashC);
        c.restore();
      }
      drew = true;
    }
    return drew;
  }

  _cue(name, at, t, fn) { if (t >= at && !this.cues.has(name)) { this.cues.add(name); fn(); } }
}

// =============================================================== energy orb
// WebGL fragment-shader orb: fbm swirl energy, bright core, rim, rotating bands.
const ORB_VS = 'attribute vec2 p;varying vec2 v;void main(){v=p*.5+.5;gl_Position=vec4(p,0.,1.);}';
const ORB_FS = `precision mediump float;
varying vec2 v;
uniform float uT, uE, uHot;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
  return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float s=0.,a=.5;for(int i=0;i<5;i++){s+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return s;}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
void main(){
  vec2 p=v*2.-1.;
  float r=length(p), R=.5;
  float sw=uT*2.2+(1.-r/R)*3.2;
  vec2 q=rot(sw)*p;
  float e1=fbm(q*3.2+vec2(uT*.9,-uT*.7));
  float e2=fbm(rot(-sw*.7)*p*6.5-vec2(uT*1.7,uT*1.1));
  float inside=smoothstep(R,R-.07,r);
  float energy=pow(e1*.7+e2*.55,2.4)*inside*2.4;
  float core=exp(-pow(r/(R*.3),2.))*(1.2+.3*uHot);
  float rim=exp(-pow((r-R*.96)/(R*.075),2.))*.9;
  float bands=0.;
  for(int k=0;k<3;k++){
    float fk=float(k);
    float an=uT*(1.4+fk*.8)*(mod(fk,2.)*2.-1.)+fk*2.1;
    vec2 b=rot(an)*p; b.y/=.26+.14*fk;
    float d=abs(length(b)-R*.9);
    float arc=smoothstep(-.2,.8,sin(atan(b.y,b.x)+uT*7.+fk*2.));
    bands+=exp(-d*d/.0012)*arc;
  }
  bands*=smoothstep(R*1.15,R*.7,r);
  float outer=exp(-max(r-R*.9,0.)*6.)*.32*(1.-inside*.6);
  vec3 col=vec3(.12,.42,1.)*energy+vec3(.55,.85,1.)*rim+vec3(.75,.95,1.)*bands*.9
          +vec3(1.)*core+vec3(.18,.45,1.)*outer+vec3(.6,.3,1.)*energy*e2*.4;
  col*=uE;
  col=min(col,vec3(1.));
  float a=max(col.r,max(col.g,col.b));
  gl_FragColor=vec4(col,a);
}`;

class OrbGL {
  constructor(S = 256) {
    this.S = S;
    this.c = canvas(S, S);
    const gl = (this.gl = this.c.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: true }));
    if (!gl) throw new Error('no webgl');
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const pr = gl.createProgram();
    gl.attachShader(pr, sh(gl.VERTEX_SHADER, ORB_VS));
    gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, ORB_FS));
    gl.linkProgram(pr);
    if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.u = { t: gl.getUniformLocation(pr, 'uT'), e: gl.getUniformLocation(pr, 'uE'), hot: gl.getUniformLocation(pr, 'uHot') };
  }
  draw(t, energy, hot) {
    const gl = this.gl;
    if (gl.isContextLost()) return null;
    gl.viewport(0, 0, this.S, this.S);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(this.u.t, t);
    gl.uniform1f(this.u.e, energy);
    gl.uniform1f(this.u.hot, hot);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.c;
  }
}

// 2D fallback orb sprite (no WebGL)
function drawOrb2D(c, x, y, R, now) {
  let g = c.createRadialGradient(x, y, R * 0.2, x, y, R * 1.9);
  g.addColorStop(0, 'rgba(60,150,255,0.45)'); g.addColorStop(1, 'rgba(30,80,255,0)');
  c.fillStyle = g; c.beginPath(); c.arc(x, y, R * 1.9, 0, TAU); c.fill();
  g = c.createRadialGradient(x, y, 0, x, y, R);
  g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(170,225,255,0.9)');
  g.addColorStop(0.7, 'rgba(40,120,255,0.6)'); g.addColorStop(1, 'rgba(40,90,255,0)');
  c.fillStyle = g; c.beginPath(); c.arc(x, y, R, 0, TAU); c.fill();
  c.lineCap = 'round';
  for (let k = 0; k < 8; k++) {
    const rot = k * 0.785 + now * (k % 2 ? 7 : -9);
    c.strokeStyle = `rgba(${k % 3 ? 210 : 255},240,255,${0.5 + 0.3 * Math.sin(now * 11 + k)})`;
    c.lineWidth = Math.max(1, R * 0.06);
    c.beginPath();
    const a0 = now * 12 + k * 1.3;
    c.ellipse(x, y, R * 0.92, R * 0.92 * (0.25 + 0.2 * Math.sin(now * 3 + k)), rot, a0, a0 + 1.9);
    c.stroke();
  }
}

const ORB_COLLAPSE = { swell: 0.12, implode: 0.3, end: 0.85 };

export class EnergyOrb {
  constructor() {
    this.state = 'off'; this.sparks = []; this.inflow = []; this.rings = []; this.trail = [];
    this.follow = new Spring2(0, 0, { stiffness: 260, damping: 19 });
    this.sizeS = new Spring(0, { stiffness: 120, damping: 18 });
    try { this.gl = new OrbGL(256); } catch (e) { console.warn('[Vanish FX] WebGL orb unavailable, using 2D', e); this.gl = null; }
  }
  get active() { return this.state !== 'off'; }

  start(X, key) {
    if (this.state === 'charging' || this.state === 'on') return false;
    this.key = key || null;
    this.state = 'charging';
    this.t0 = X.now;
    this.missing = 0;
    this.pos = null;
    this.trail.length = 0;
    this.sparks = []; this.inflow = []; this.rings = [];
    this.lastRing = 0;
    X.sfx('orbStart');
    return true;
  }
  stop(X) {
    if (this.state !== 'charging' && this.state !== 'on') return false;
    this.state = 'collapsing';
    this.t0 = X.now;
    this.cues = new Set();
    X.sfx('orbStop');
    return true;
  }
  toggle(X, key) { return this.active && this.state !== 'collapsing' ? this.stop(X) : this.start(X, key); }

  render(X, palms) {
    if (this.state === 'off') return;
    const { W, H, dt } = X;
    const c = X.ctx;
    // follow the hand that summoned it (spring: lag + overshoot on fast moves)
    let target = null, size = W * 0.1;
    const p = this.key ? palms.find((q) => q.key === this.key) : null;
    if (this.key) {
      if (p) {
        this.missing = 0;
        target = { x: lerp(p.center.x, p.mcp.x, 0.35), y: lerp(p.center.y, p.mcp.y, 0.35) };
        size = p.size;
        if (p.fist && this.state !== 'collapsing') { this.fistT = (this.fistT || 0) + dt; if (this.fistT > 0.15) this.stop(X); }
        else this.fistT = 0;
      } else {
        this.missing += dt;
        if (this.missing > 0.7) this.stop(X);
      }
    } else {
      target = this.pos || { x: W * 0.5, y: H * 0.62 };
    }
    if (!this.pos) {
      if (!target) return;
      this.follow.set(target.x, target.y);
      this.sizeS.set(size);
    }
    if (target && this.state !== 'collapsing') this.follow.step(dt, target.x, target.y);
    else this.follow.step(dt, this.follow.px, this.follow.py);
    this.pos = { x: this.follow.px, y: this.follow.py };
    this.size = this.sizeS.step(dt, size);

    const t = (X.now - this.t0) / 1000;
    const now = X.now / 1000;
    let grow = 1, sx = 1, sy = 1, hot = 0, energy = 1;
    if (this.state === 'charging') {
      // particles spiral in first; the orb pops at 0.25 s on a spring
      grow = springCurve(t - 0.25, 2.0, 0.4);
      energy = 0.5 + 0.5 * seg(t, 0.25, 0.9);
      if (t > 0.95) {
        this.state = 'on';
        X.fx.shockwave(this.pos.x, this.pos.y, { r0: this.size * 0.3, r1: this.size * 2.2, dur: 0.45, color: '120,190,255', width: 0.1, warp: 0.6 });
      }
    }
    let flashNow = false;
    if (this.state === 'collapsing') {
      // anticipation swell → implosion squash → flash + shockwave
      const sw = seg(t, 0, ORB_COLLAPSE.swell), im = seg(t, ORB_COLLAPSE.swell, ORB_COLLAPSE.implode);
      grow = (1 + 0.18 * ease.outQuad(sw)) * (1 - ease.inCubic(im));
      sx = 1 + 0.45 * im; sy = Math.max(0.05, 1 - 0.55 * im);
      hot = sw;
      if (!this.cues.has('pop') && t >= ORB_COLLAPSE.implode) { this.cues.add('pop'); flashNow = true; }
      if (t > ORB_COLLAPSE.end && !this.sparks.length) { this.state = 'off'; this.inflow = []; this.rings = []; return; }
      if (t > ORB_COLLAPSE.end + 0.6) { this.state = 'off'; this.sparks = []; this.inflow = []; this.rings = []; return; }
    }
    const R = clamp(this.size * 0.5, W * 0.025, W * 0.07) * grow * (1 + 0.05 * Math.sin(now * 23));
    const { x, y } = this.pos;
    const vx = this.follow.vx, vy = this.follow.vy;
    const speed = Math.hypot(vx, vy) / W; // screen widths per second
    if (flashNow) {
      X.fx.flash(x, y, { radius: this.size * 3.5, dur: 0.4, color: '150,200,255', peak: 0.9 });
      X.fx.shockwave(x, y, { r0: this.size * 0.2, r1: this.size * 3.2, dur: 0.55, color: '150,210,255' });
      X.fx.kick(0.3);
      X.sfx('shockwave', { soft: 1 });
      for (let i = 0; i < 40; i++) {
        const a = Math.random() * TAU, sp = this.size * rnd(3, 9);
        this.sparks.push({ x, y, vx: Math.cos(a) * sp + vx * 0.6, vy: Math.sin(a) * sp + vy * 0.6, age: 0, life: rnd(0.3, 0.6) });
      }
    }

    c.save();
    c.globalCompositeOperation = 'lighter';
    // light spill on the scene
    if (R > 0.5) {
      const g = c.createRadialGradient(x, y, 0, x, y, R * 6 + 1);
      g.addColorStop(0, `rgba(40,110,255,${0.22 * Math.min(1, grow)})`); g.addColorStop(1, 'rgba(40,110,255,0)');
      c.fillStyle = g; c.fillRect(x - R * 6, y - R * 6, R * 12, R * 12);
    }
    // charge: hum-ring pulses contracting into the palm, faster as it charges
    if (this.state === 'charging' || this.state === 'on') {
      const period = this.state === 'charging' ? lerp(0.3, 0.12, seg(t, 0, 0.9)) : 0.6;
      if (now - this.lastRing > period) { this.lastRing = now; this.rings.push({ age: 0, life: 0.4 }); }
    }
    c.lineWidth = Math.max(1, this.size * 0.025);
    for (const r of this.rings) {
      r.age += dt;
      const u = clamp(r.age / r.life);
      c.strokeStyle = `rgba(140,210,255,${0.6 * ease.inQuad(u) * (1 - u * 0.3)})`;
      c.beginPath(); c.arc(x, y, Math.max(1, R + this.size * 1.8 * (1 - ease.outCubic(u))), 0, TAU); c.stroke();
    }
    this.rings = this.rings.filter((r) => r.age < r.life);
    if (this.state === 'charging') {
      for (let i = 0; i < 7; i++) {
        const a = Math.random() * TAU, d = this.size * (1.4 + Math.random() * 1.2);
        this.inflow.push({ a, d, age: 0, life: 0.38 + Math.random() * 0.25, spin: Math.random() < 0.5 ? -1 : 1, px: null, py: null });
      }
    }
    c.lineCap = 'round';
    for (const q of this.inflow) {
      q.age += dt;
      const u = clamp(q.age / q.life);
      // log-spiral inward; tail = the same spiral a moment earlier
      const at = (v) => { const d = q.d * (1 - ease.inCubic(v)), a = q.a + q.spin * v * 3.2; tmpV.x = x + Math.cos(a) * d; tmpV.y = y + Math.sin(a) * d; return tmpV; };
      const tail = at(Math.max(0, u - 0.12)); const tx = tail.x, ty = tail.y;
      const head = at(u);
      c.strokeStyle = `rgba(170,225,255,${0.3 + 0.6 * u})`;
      c.lineWidth = Math.max(1, this.size * 0.025 * (0.5 + u));
      c.beginPath(); c.moveTo(tx, ty); c.lineTo(head.x, head.y); c.stroke();
    }
    this.inflow = this.inflow.filter((q) => q.age < q.life);

    // the orb: trail copies (smear) + stretched along its velocity
    if (R > 1) {
      const st = 1 + clamp(speed * 0.8, 0, 0.7);
      const ang = Math.atan2(vy, vx);
      const sprite = this.gl ? this.gl.draw(now, energy, hot) : null;
      const drawAt = (px, py, rr, alpha, stretch) => {
        c.save();
        c.globalAlpha = alpha;
        c.translate(px, py);
        c.rotate(ang); c.scale(sx * stretch, sy / Math.sqrt(stretch)); c.rotate(-ang);
        if (sprite) c.drawImage(sprite, -rr * 2, -rr * 2, rr * 4, rr * 4);
        else drawOrb2D(c, 0, 0, rr, now);
        c.restore();
      };
      if (speed > 0.15) {
        for (let i = 0; i < this.trail.length; i++) {
          const tp = this.trail[i];
          const k = (i + 1) / (this.trail.length + 1);
          drawAt(tp.x, tp.y, R * (0.6 + 0.4 * k), 0.25 * k * clamp(speed - 0.15), st);
        }
      }
      drawAt(x, y, R, 1, st);
    }
    this.trail.push({ x, y });
    if (this.trail.length > 5) this.trail.shift();

    // sparks flung off the surface inherit the orb's velocity
    if (this.state !== 'collapsing' && R > 2) {
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * TAU;
        this.sparks.push({ x: x + Math.cos(a) * R, y: y + Math.sin(a) * R, vx: Math.cos(a + 1.3) * R * 6 + vx * 0.8, vy: Math.sin(a + 1.3) * R * 6 + vy * 0.8, age: 0, life: 0.25 + Math.random() * 0.2 });
      }
    }
    c.strokeStyle = 'rgba(190,235,255,0.9)';
    c.lineWidth = Math.max(1, this.size * 0.02);
    for (const s of this.sparks) {
      s.age += dt;
      s.vx *= Math.exp(-dt * 2); s.vy *= Math.exp(-dt * 2);
      s.x += s.vx * dt; s.y += s.vy * dt;
      c.globalAlpha = clamp(1 - s.age / s.life);
      c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x - s.vx * 0.03, s.y - s.vy * 0.03); c.stroke();
    }
    c.restore();
    this.sparks = this.sparks.filter((s) => s.age < s.life);
  }
}
