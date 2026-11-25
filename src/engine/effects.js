// The four effects + shared smoke system. All drawing is Canvas 2D on OffscreenCanvas.
import { canvas, ctx2d } from './vision.js';

const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a));
const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutBack = (t) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

// cheap 2D value noise in [0,1]
function hash(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return lerp(lerp(hash(xi, yi), hash(xi + 1, yi), u), lerp(hash(xi, yi + 1), hash(xi + 1, yi + 1), u), v);
}
const fbm = (x, y) => vnoise(x, y) * 0.6 + vnoise(x * 2.3, y * 2.3) * 0.3 + vnoise(x * 5.1, y * 5.1) * 0.1;

// ===================================================================== smoke
function makeSmokeSprite(seed) {
  const S = 128, c = canvas(S, S), x = ctx2d(c);
  for (let i = 0; i < 9; i++) {
    const a = hash(seed, i) * Math.PI * 2, r = hash(i, seed) * S * 0.2;
    const cx = S / 2 + Math.cos(a) * r, cy = S / 2 + Math.sin(a) * r, rad = S * (0.22 + hash(seed + i, 3) * 0.14);
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, rad);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(235,235,240,0.25)');
    g.addColorStop(1, 'rgba(220,220,230,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, S, S);
  }
  return c;
}

export class Smoke {
  constructor() { this.ps = []; this.sprites = [1, 2, 3].map(makeSmokeSprite); }
  puff(x, y, radius, { count = 26, tint = null, speed = 1 } = {}) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = radius * (1.4 + Math.random() * 2.2) * speed;
      this.ps.push({
        x: x + Math.cos(a) * radius * 0.15, y: y + Math.sin(a) * radius * 0.15,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.8 - radius * 0.3,
        r0: radius * (0.35 + Math.random() * 0.3), r1: radius * (0.9 + Math.random() * 0.6),
        life: 0.7 + Math.random() * 0.6, age: 0, spr: this.sprites[i % 3], tint,
      });
    }
  }
  render(c, dt) {
    if (!this.ps.length) return;
    c.save();
    for (const p of this.ps) {
      p.age += dt;
      const drag = Math.exp(-dt * 4.5);
      p.vx *= drag; p.vy *= drag;
      p.x += p.vx * dt; p.y += p.vy * dt;
      const u = p.age / p.life;
      const r = lerp(p.r0, p.r1, easeOut(clamp(u)));
      c.globalAlpha = clamp(Math.pow(1 - u, 1.6) * 0.95);
      c.drawImage(p.spr, p.x - r, p.y - r, r * 2, r * 2);
    }
    c.restore();
    this.ps = this.ps.filter((p) => p.age < p.life);
  }
}

// ================================================================ dust snap
export class DustSnap {
  constructor() { this.state = 'idle'; }
  get hidesPerson() { return this.state !== 'idle'; }
  get busy() { return this.state === 'out' || this.state === 'in'; }

  trigger(X) {
    if (this.busy) return false;
    if (this.state === 'idle') return this._begin(X, 'out');
    if (this.state === 'gone') return this._begin(X, 'in');
    return false;
  }

  _begin(X, dir) {
    const { masks, W, H, settings } = X;
    if (!masks.bbox) {
      // nobody in frame: just toggle state instantly
      this.state = dir === 'out' ? 'gone' : 'idle';
      X.mic(dir === 'out' && settings.muteWhileGone);
      return true;
    }
    this.D = clamp(settings.dustDuration || 2.8, 1, 8);
    this.t0 = X.now;
    this.state = dir;
    this._build(X);
    X.sfx(dir === 'out' ? 'dustOut' : 'dustIn', { duration: this.D });
    if (dir === 'out' && settings.muteWhileGone) setTimeout(() => X.mic(true), 300);
    if (dir === 'in') X.mic(false);
    return true;
  }

  _build(X) {
    const { W, H, masks, settings } = X;
    const person = X.layers.person();
    const img = ctx2d(person).getImageData(0, 0, W, H).data;
    const b = masks.bbox;
    const areaPx = b.w * b.h * 0.6;
    let s = Math.max(2, Math.round(Math.sqrt(areaPx / 26000)));
    this.s = s;
    const gw = (this.gw = Math.ceil(W / s)), gh = (this.gh = Math.ceil(H / s));
    const dirs = { right: [1, 0], left: [-1, 0], up: [0, -1], down: [0, 1] };
    const [dx, dy] = dirs[settings.dustDirection] || dirs.right;
    this.dir = [dx, dy];
    const ox = [], oy = [], col = [], cell = [], proj = [], nz = [];
    const x0 = Math.max(0, Math.floor(b.x / s) - 1), x1 = Math.min(gw - 1, Math.ceil((b.x + b.w) / s) + 1);
    const y0 = Math.max(0, Math.floor(b.y / s) - 1), y1 = Math.min(gh - 1, Math.ceil((b.y + b.h) / s) + 1);
    const sc = 1 / (W * 0.07);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const px = Math.min(W - 1, gx * s + (s >> 1)), py = Math.min(H - 1, gy * s + (s >> 1));
        const i = (py * W + px) * 4;
        if (img[i + 3] < 40) continue;
        ox.push(gx * s); oy.push(gy * s);
        col.push(img[i] | (img[i + 1] << 8) | (img[i + 2] << 16));
        cell.push(gy * gw + gx);
        proj.push(gx * s * dx + gy * s * dy);
        nz.push(fbm(gx * s * sc, gy * s * sc));
      }
    }
    const n = (this.n = ox.length);
    let pmin = Infinity, pmax = -Infinity;
    for (const p of proj) { if (p < pmin) pmin = p; if (p > pmax) pmax = p; }
    const D = this.D;
    this.life = D * 0.42;
    const maxDelay = D - this.life;
    this.ox = Float32Array.from(ox); this.oy = Float32Array.from(oy);
    this.col = Uint32Array.from(col); this.cell = Int32Array.from(cell);
    this.delay = new Float32Array(n); this.seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = (proj[i] - pmin) / Math.max(1, pmax - pmin); // 0 upwind .. 1 downwind
      const d = (1 - p) * 0.5 + nz[i] * 0.42 + Math.random() * 0.08;
      this.delay[i] = clamp(d) * maxDelay;
      this.seed[i] = Math.random() * 100;
    }
    this.buf = new ImageData(W, H);
    this.buf32 = new Uint32Array(this.buf.data.buffer);
    this.pc = canvas(W, H); this.pcx = ctx2d(this.pc);
    this.intact = new ImageData(gw, gh);
    this.intact32 = new Uint32Array(this.intact.data.buffer);
    this.ic = canvas(gw, gh); this.icx = ctx2d(this.ic);
    this.tmp = canvas(W, H); this.tmpx = ctx2d(this.tmp);
  }

  render(X) {
    if (this.state !== 'out' && this.state !== 'in') return;
    const { W, H, ctx } = X;
    const t = (X.now - this.t0) / 1000;
    if (t >= this.D) {
      this.state = this.state === 'out' ? 'gone' : 'idle';
      if (this.state === 'idle') return; // engine draws live frame next time
      return;
    }
    const rev = this.state === 'in';
    const { n, ox, oy, col, delay, seed, cell, s, life, buf32, intact32 } = this;
    const [dx, dy] = this.dir;
    const px = -dy, py = dx;
    const v = W * 0.06, acc = W * 0.55, wob = W * 0.045, lift = dy === 0 ? H * 0.12 : 0;
    buf32.fill(0);
    intact32.fill(0);
    const dustR = 74, dustG = 66, dustB = 58;
    for (let i = 0; i < n; i++) {
      let a = rev ? this.D - t - delay[i] : t - delay[i];
      if (a <= 0) { intact32[cell[i]] = 0xff000000 | 0xffffff; continue; }
      if (a >= life) continue;
      const u = a / life;
      const sd = seed[i];
      const travel = v * a + 0.5 * acc * a * a;
      const w = Math.sin(sd + a * 2.6) * wob * u + Math.sin(sd * 1.7 + a * 5.3) * wob * 0.3 * u;
      const x = (ox[i] + dx * travel + px * w) | 0;
      const y = (oy[i] + dy * travel + py * w - lift * a * a) | 0;
      const alpha = Math.pow(1 - u, 1.25) * 255;
      if (alpha < 4) continue;
      const k = clamp(u * 1.6);
      const c = col[i];
      const r = lerp(c & 255, dustR, k), g = lerp((c >> 8) & 255, dustG, k), b = lerp((c >> 16) & 255, dustB, k);
      const px32 = ((alpha & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255);
      const sz = Math.max(1, Math.round(s * (1 - u * 0.55)));
      for (let yy = 0; yy < sz; yy++) {
        const Y = y + yy;
        if (Y < 0 || Y >= H) continue;
        const row = Y * W;
        for (let xx = 0; xx < sz; xx++) {
          const Xp = x + xx;
          if (Xp >= 0 && Xp < W) buf32[row + Xp] = px32;
        }
      }
    }
    // intact part of the body = live person ∩ cells that haven't blown away yet
    this.icx.putImageData(this.intact, 0, 0);
    const tx = this.tmpx;
    tx.globalCompositeOperation = 'copy';
    tx.drawImage(X.layers.person(), 0, 0);
    tx.globalCompositeOperation = 'destination-in';
    tx.imageSmoothingEnabled = true;
    tx.drawImage(this.ic, 0, 0, this.gw * s, this.gh * s);
    tx.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.tmp, 0, 0);
    this.pcx.putImageData(this.buf, 0, 0);
    ctx.drawImage(this.pc, 0, 0);
  }
}

// ============================================================ sealing scroll
function drawScroll(c, cx, cy, openW, h, glow, now) {
  const rr = h * 0.12;           // roller radius
  const rl = h * 1.18;           // roller length
  c.save();
  // paper
  if (openW > 1) {
    const x0 = cx - openW / 2, y0 = cy - h / 2;
    const g = c.createLinearGradient(0, y0, 0, y0 + h);
    g.addColorStop(0, '#d9c28c'); g.addColorStop(0.12, '#f1e3bb'); g.addColorStop(0.88, '#efdfb4'); g.addColorStop(1, '#cdb37a');
    c.fillStyle = g;
    c.fillRect(x0, y0, openW, h);
    c.save();
    c.beginPath(); c.rect(x0, y0, openW, h); c.clip();
    // border lines
    c.strokeStyle = 'rgba(140,30,25,0.85)';
    c.lineWidth = h * 0.02;
    c.strokeRect(x0 + h * 0.07, y0 + h * 0.07, Math.max(0, openW - h * 0.14), h * 0.86);
    c.lineWidth = h * 0.008;
    c.strokeRect(x0 + h * 0.1, y0 + h * 0.1, Math.max(0, openW - h * 0.2), h * 0.8);
    // brush "writing" columns
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
    // seal circle
    const R = h * 0.3;
    if (glow > 0) { c.shadowColor = 'rgba(255,190,60,0.95)'; c.shadowBlur = h * 0.35 * glow; }
    c.strokeStyle = glow > 0 ? `rgba(${lerp(150, 255, glow) | 0},${lerp(30, 160, glow) | 0},30,1)` : 'rgba(150,30,25,0.95)';
    c.lineWidth = h * 0.025;
    c.beginPath(); c.arc(cx, cy, R, 0, Math.PI * 2); c.stroke();
    c.lineWidth = h * 0.012;
    c.beginPath(); c.arc(cx, cy, R * 0.8, 0, Math.PI * 2); c.stroke();
    // spiral
    c.beginPath();
    for (let a = 0; a < Math.PI * 6; a += 0.12) {
      const r = (a / (Math.PI * 6)) * R * 0.62;
      const px = cx + Math.cos(a + now * 0.002 * glow) * r, py = cy + Math.sin(a + now * 0.002 * glow) * r;
      a === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
    }
    c.stroke();
    // ring of ticks
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
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
    // shading near rollers
    const sh = c.createLinearGradient(x0, 0, x0 + openW, 0);
    const e = Math.min(0.15, (h * 0.15) / openW);
    sh.addColorStop(0, 'rgba(70,45,10,0.35)'); sh.addColorStop(e, 'rgba(70,45,10,0)');
    sh.addColorStop(1 - e, 'rgba(70,45,10,0)'); sh.addColorStop(1, 'rgba(70,45,10,0.35)');
    c.fillStyle = sh;
    c.fillRect(x0, y0, openW, h);
  }
  // rollers
  for (const side of [-1, 1]) {
    const rx = cx + side * (openW / 2 + rr * 0.85);
    const g = c.createLinearGradient(rx - rr, 0, rx + rr, 0);
    g.addColorStop(0, '#4a2a12'); g.addColorStop(0.35, '#b07a45'); g.addColorStop(0.55, '#d9a46a'); g.addColorStop(1, '#3b200d');
    c.fillStyle = g;
    c.fillRect(rx - rr, cy - h * 0.52, rr * 2, h * 1.04);
    // paper wrapped on roller
    const pg = c.createLinearGradient(rx - rr, 0, rx + rr, 0);
    pg.addColorStop(0, '#a88e58'); pg.addColorStop(0.5, '#f3e6c2'); pg.addColorStop(1, '#9a804a');
    c.fillStyle = pg;
    c.fillRect(rx - rr * 0.92, cy - h / 2, rr * 1.84, h);
    // end caps
    c.fillStyle = '#7a1f17';
    for (const end of [-1, 1]) {
      const ey = cy + end * (rl / 2);
      c.beginPath();
      c.ellipse(rx, ey - end * rr * 0.25, rr * 1.05, rr * 0.45, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#3d0f0b';
      c.fillRect(rx - rr * 0.95, Math.min(ey, cy + end * h * 0.5), rr * 1.9, Math.abs(ey - (cy + end * h * 0.5)));
      c.fillStyle = '#7a1f17';
    }
  }
  c.restore();
}

function drawWarped(c, img, b, tx, ty, e) {
  const x = lerp(b.cx, tx, easeInOut(e)), y = lerp(b.cy, ty, easeInOut(e));
  const k = 1 - e;
  const sx = Math.pow(k, 1.15) * (1 - 0.4 * Math.sin(e * Math.PI)), sy = Math.pow(k, 0.85);
  c.save();
  c.globalAlpha = 1 - seg(e, 0.8, 1);
  c.translate(x, y);
  c.rotate(e * e * 2.4);
  c.scale(Math.max(0.001, sx), Math.max(0.001, sy));
  c.drawImage(img, -b.cx, -b.cy);
  c.restore();
}

export class SealScroll {
  constructor() { this.state = 'idle'; this.sparks = []; }
  get hidesPerson() {
    if (this.state === 'sealed') return true;
    const t = this.t();
    if (this.state === 'sealing') return t >= 0.75;
    if (this.state === 'releasing') return t < 1.15;
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
      this.snap = canvas(W, H);
      ctx2d(this.snap).drawImage(X.layers.person(), 0, 0);
      this.bbox = { ...b };
      this.state = 'sealing';
      this.t0 = performance.now();
      this.cues = new Set();
      X.smoke.puff(this.cx, this.cy, this.h * 0.8);
      X.sfx('poof');
      return true;
    }
    if (this.state === 'sealed') {
      this.state = 'releasing';
      this.t0 = performance.now();
      this.cues = new Set();
      X.sfx('unroll');
      return true;
    }
    return false;
  }

  _cue(name, at, fn) { if (this.t() >= at && !this.cues.has(name)) { this.cues.add(name); fn(); } }

  render(X) {
    if (this.state === 'idle') return;
    const c = X.ctx, now = X.now, t = this.t();
    let openW = 0, scale = 1, glow = 0, bob = 0;
    if (this.state === 'sealing') {
      scale = easeOutBack(seg(t, 0, 0.25));
      openW = this.maxW * easeOut(seg(t, 0.25, 0.75)) * (1 - easeInOut(seg(t, 1.85, 2.3)));
      glow = seg(t, 1.2, 1.7) * (1 - seg(t, 2.3, 2.6) * 0.6);
      this._cue('unroll', 0.25, () => X.sfx('unroll'));
      this._cue('suck', 0.75, () => X.sfx('suck'));
      this._cue('mute', 0.9, () => X.settings.muteWhileGone && X.mic(true));
      this._cue('roll', 1.85, () => X.sfx('rollUp'));
      this._cue('chime', 2.3, () => { X.sfx('sealChime'); X.smoke.puff(this.cx, this.cy, this.h * 0.5, { count: 14 }); });
      if (t >= 0.75) {
        const e = seg(t, 0.75, 1.75);
        if (e < 1) {
          drawWarped(c, this.snap, this.bbox, this.cx, this.cy, easeIn(e) * 0.6 + e * 0.4);
          this._spawnSparks(X, 5);
        }
      }
      if (t >= 2.6) this.state = 'sealed';
    } else if (this.state === 'sealed') {
      glow = 0.4 + 0.15 * Math.sin(now / 300);
      bob = Math.sin(now / 600) * this.h * 0.04;
    } else if (this.state === 'releasing') {
      openW = this.maxW * easeOut(seg(t, 0, 0.45)) * (1 - easeInOut(seg(t, 1.15, 1.55)));
      glow = 0.5 + seg(t, 0.2, 0.45) * 0.5 - seg(t, 0.6, 1.0) * 1;
      scale = 1 - easeIn(seg(t, 1.6, 1.85));
      this._cue('burst', 0.45, () => {
        X.sfx('burst');
        X.smoke.puff(this.cx, this.cy, this.h * 1.3, { count: 34, speed: 1.3 });
        X.mic(false);
      });
      this._cue('roll', 1.15, () => X.sfx('rollUp'));
      this._cue('gone', 1.6, () => { X.sfx('poof', { big: 0.6 }); X.smoke.puff(this.cx, this.cy, this.h * 0.6, { count: 16 }); });
      if (t >= 0.45 && t < 1.15 && X.masks.bbox) {
        const e = 1 - easeOut(seg(t, 0.45, 1.15));
        drawWarped(c, X.layers.person(), X.masks.bbox, this.cx, this.cy, e);
      }
      if (t >= 0.45 && t < 0.75) {
        // flash
        c.save();
        c.globalCompositeOperation = 'lighter';
        const f = 1 - seg(t, 0.45, 0.75);
        const g = c.createRadialGradient(this.cx, this.cy, 0, this.cx, this.cy, this.h * 2.5);
        g.addColorStop(0, `rgba(255,220,150,${0.8 * f})`);
        g.addColorStop(1, 'rgba(255,200,120,0)');
        c.fillStyle = g;
        c.fillRect(0, 0, X.W, X.H);
        c.restore();
      }
      if (t >= 2.0) { this.state = 'idle'; return; }
    }
    this._renderSparks(c, X.dt);
    if (scale > 0.01) {
      c.save();
      c.translate(this.cx, this.cy + bob);
      c.scale(scale, scale);
      if (this.state === 'sealed') c.rotate(Math.sin(now / 900) * 0.04);
      drawScroll(c, 0, 0, openW, this.h, clamp(glow), now);
      c.restore();
    }
  }

  _spawnSparks(X, n) {
    const b = this.bbox;
    for (let i = 0; i < n; i++) {
      const x = b.x + Math.random() * b.w, y = b.y + Math.random() * b.h;
      const ang = Math.atan2(y - this.cy, x - this.cx);
      this.sparks.push({ ang, rad: Math.hypot(x - this.cx, y - this.cy), age: 0, life: 0.55 + Math.random() * 0.3, gold: Math.random() < 0.4, sz: 2 + Math.random() * 4 });
    }
  }
  _renderSparks(c, dt) {
    if (!this.sparks.length) return;
    c.save();
    for (const p of this.sparks) {
      p.age += dt;
      const u = clamp(p.age / p.life);
      const r = p.rad * (1 - easeIn(u));
      const a = p.ang + u * 3.2;
      const x = this.cx + Math.cos(a) * r, y = this.cy + Math.sin(a) * r;
      c.globalAlpha = 1 - u * 0.5;
      c.fillStyle = p.gold ? '#ffd36b' : '#1c1226';
      if (p.gold) { c.globalCompositeOperation = 'lighter'; } else { c.globalCompositeOperation = 'source-over'; }
      c.beginPath(); c.arc(x, y, p.sz * (1 - u * 0.6), 0, Math.PI * 2); c.fill();
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
    slots.forEach((sl, i) => {
      if (this.state === 'appearing' || this.state === 'on') {
        const at = i * 0.16;
        if (!this.cues.has(i) && t >= at && b) {
          this.cues.add(i);
          const cx = b.cx + sl.dx * b.w, cy = b.cy;
          X.smoke.puff(cx, cy, b.w * 0.45 * sl.s, { count: 22 });
          X.sfx('poof', { big: 0.8 });
        }
        this.alphas[i] = clamp((t - at - 0.06) / 0.2);
      } else if (this.state === 'leaving') {
        const at = i * 0.08;
        if (!this.cues.has(i) && t >= at && b) {
          this.cues.add(i);
          X.smoke.puff(b.cx + sl.dx * b.w, b.cy, b.w * 0.45 * sl.s, { count: 18 });
          X.sfx('poof', { big: 0.6 });
        }
        if (t >= at + 0.08) this.alphas[i] = Math.max(0, this.alphas[i] - X.dt * 8);
      }
    });
    if (this.state === 'appearing' && t > slots.length * 0.16 + 0.3) this.state = 'on';
    if (this.state === 'leaving' && t > slots.length * 0.08 + 0.4) { this.state = 'off'; this.alphas.fill(0); }
    if (!b) return false;
    const c = X.ctx;
    const ax = b.cx, ay = b.y + b.h;
    let drew = false;
    for (let i = slots.length - 1; i >= 0; i--) {
      const sl = slots[i];
      if (this.alphas[i] <= 0) continue;
      const k = (this.head - Math.min(sl.delay, this.filled - 1) + 10) % 10;
      c.save();
      c.globalAlpha = this.alphas[i];
      c.filter = `brightness(${sl.b})`;
      c.translate(ax + sl.dx * b.w, ay);
      c.scale(sl.s, sl.s);
      c.translate(-ax, -ay);
      c.drawImage(this.hist[k], 0, 0);
      c.restore();
      drew = true;
    }
    return drew;
  }
}

// =============================================================== energy orb
export class EnergyOrb {
  constructor() { this.state = 'off'; this.sparks = []; this.inflow = []; }
  get active() { return this.state !== 'off'; }

  start(X, key) {
    if (this.state === 'charging' || this.state === 'on') return false;
    this.key = key || null;
    this.state = 'charging';
    this.t0 = X.now;
    this.missing = 0;
    this.pos = null;
    X.sfx('orbStart');
    return true;
  }
  stop(X) {
    if (this.state !== 'charging' && this.state !== 'on') return false;
    this.state = 'collapsing';
    this.t0 = X.now;
    X.sfx('orbStop');
    return true;
  }
  toggle(X, key) { return this.active && this.state !== 'collapsing' ? this.stop(X) : this.start(X, key); }

  render(X, palms) {
    if (this.state === 'off') return;
    const { W, H } = X;
    const c = X.ctx;
    // follow the hand that summoned it
    let target = null, size = W * 0.1;
    const p = this.key ? palms.find((q) => q.key === this.key) : null;
    if (this.key) {
      if (p) {
        this.missing = 0;
        target = { x: lerp(p.center.x, p.mcp.x, 0.35), y: lerp(p.center.y, p.mcp.y, 0.35) };
        size = p.size;
        if (p.fist && this.state !== 'collapsing') { this.fistT = (this.fistT || 0) + X.dt; if (this.fistT > 0.15) this.stop(X); }
        else this.fistT = 0;
      } else {
        this.missing += X.dt;
        if (this.missing > 0.7) this.stop(X);
      }
    } else {
      target = this.pos || { x: W * 0.5, y: H * 0.62 };
    }
    if (target) this.pos = this.pos ? { x: lerp(this.pos.x, target.x, 0.55), y: lerp(this.pos.y, target.y, 0.55) } : target;
    this.size = this.size ? lerp(this.size, size, 0.2) : size;
    if (!this.pos) return;

    const t = (X.now - this.t0) / 1000;
    let grow = 1;
    if (this.state === 'charging') { grow = easeOutBack(seg(t, 0, 0.8)); if (t > 0.8) this.state = 'on'; }
    if (this.state === 'collapsing') { grow = 1 - easeIn(seg(t, 0, 0.3)); if (t > 0.45) { this.state = 'off'; this.sparks = []; this.inflow = []; return; } }
    const now = X.now / 1000;
    const R = clamp(this.size * 0.5, W * 0.025, W * 0.07) * grow * (1 + 0.05 * Math.sin(now * 23));
    const { x, y } = this.pos;
    c.save();
    c.globalCompositeOperation = 'lighter';
    // light spill on the scene
    let g = c.createRadialGradient(x, y, 0, x, y, R * 6 + 1);
    g.addColorStop(0, 'rgba(40,110,255,0.22)'); g.addColorStop(1, 'rgba(40,110,255,0)');
    c.fillStyle = g; c.fillRect(x - R * 6, y - R * 6, R * 12, R * 12);
    if (R > 0.5) {
      g = c.createRadialGradient(x, y, R * 0.2, x, y, R * 1.9);
      g.addColorStop(0, 'rgba(60,150,255,0.45)'); g.addColorStop(1, 'rgba(30,80,255,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, R * 1.9, 0, Math.PI * 2); c.fill();
      g = c.createRadialGradient(x, y, 0, x, y, R);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(170,225,255,0.9)');
      g.addColorStop(0.7, 'rgba(40,120,255,0.6)'); g.addColorStop(1, 'rgba(40,90,255,0)');
      c.fillStyle = g; c.beginPath(); c.arc(x, y, R, 0, Math.PI * 2); c.fill();
      // spinning shells
      c.lineCap = 'round';
      for (let k = 0; k < 8; k++) {
        const rot = k * 0.785 + now * (k % 2 ? 7 : -9);
        const tilt = 0.25 + 0.2 * Math.sin(now * 3 + k);
        c.strokeStyle = `rgba(${k % 3 ? 210 : 255},${240},255,${0.5 + 0.3 * Math.sin(now * 11 + k)})`;
        c.lineWidth = Math.max(1, R * 0.06);
        c.beginPath();
        const a0 = now * 12 + k * 1.3;
        c.ellipse(x, y, R * 0.92, R * 0.92 * tilt, rot, a0, a0 + 1.9);
        c.stroke();
      }
    }
    // sparks flung off the surface
    if (this.state !== 'collapsing' && R > 2) {
      for (let i = 0; i < 3; i++) {
        const a = Math.random() * Math.PI * 2;
        this.sparks.push({ x: x + Math.cos(a) * R, y: y + Math.sin(a) * R, vx: Math.cos(a + 1.3) * R * 6, vy: Math.sin(a + 1.3) * R * 6, age: 0, life: 0.25 + Math.random() * 0.2 });
      }
    }
    // charge: particles stream into the palm
    if (this.state === 'charging') {
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2, d = this.size * (1.5 + Math.random());
        this.inflow.push({ a, d, age: 0, life: 0.35 + Math.random() * 0.2 });
      }
    }
    c.strokeStyle = 'rgba(190,235,255,0.9)';
    c.lineWidth = Math.max(1, R * 0.04);
    for (const s of this.sparks) {
      s.age += X.dt; s.x += s.vx * X.dt; s.y += s.vy * X.dt;
      c.globalAlpha = clamp(1 - s.age / s.life);
      c.beginPath(); c.moveTo(s.x, s.y); c.lineTo(s.x - s.vx * 0.02, s.y - s.vy * 0.02); c.stroke();
    }
    c.fillStyle = 'rgba(160,220,255,1)';
    for (const p of this.inflow) {
      p.age += X.dt;
      const u = clamp(p.age / p.life);
      const d = p.d * (1 - easeIn(u));
      c.globalAlpha = u;
      c.beginPath(); c.arc(x + Math.cos(p.a + u) * d, y + Math.sin(p.a + u) * d, Math.max(1, this.size * 0.03), 0, Math.PI * 2); c.fill();
    }
    if (this.state === 'collapsing') {
      const u = seg(t, 0.2, 0.45);
      c.globalAlpha = 1 - u;
      c.strokeStyle = 'rgba(200,240,255,1)';
      c.lineWidth = Math.max(1, this.size * 0.05 * (1 - u));
      c.beginPath(); c.arc(x, y, this.size * (0.2 + u * 1.4), 0, Math.PI * 2); c.stroke();
    }
    c.restore();
    this.sparks = this.sparks.filter((s) => s.age < s.life);
    this.inflow = this.inflow.filter((p) => p.age < p.life);
  }
}
