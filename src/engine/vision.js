// AI layer: hand landmarks + person segmentation (MediaPipe, local WASM/WebGL),
// mask post-processing and the learned "empty room" background plate.
import { FilesetResolver, HandLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';

export const canvas = (w, h) => new OffscreenCanvas(Math.max(1, w), Math.max(1, h));
export const ctx2d = (c, opts) => c.getContext('2d', opts);

export class Vision {
  constructor(base) {
    this.base = base;
    this.ready = false;
    this.loading = false;
    this.error = null;
    this.lastTs = 0;
  }

  async load() {
    if (this.loading || this.ready) return;
    this.loading = true;
    try {
      const fileset = await FilesetResolver.forVisionTasks(this.base + 'wasm');
      const make = async (Cls, opts) => {
        try {
          return await Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'GPU' } });
        } catch (e) {
          console.warn('[Vanish FX] GPU delegate failed, using CPU', e);
          return Cls.createFromOptions(fileset, { ...opts, baseOptions: { ...opts.baseOptions, delegate: 'CPU' } });
        }
      };
      this.hands = await make(HandLandmarker, {
        baseOptions: { modelAssetPath: this.base + 'models/hand_landmarker.task' },
        runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
      // Mask v2: the multiclass selfie model (hair / body / clothes / face) gives
      // much fuller silhouettes than the landscape model; person = 1 - background.
      // Falls back to the landscape model if the multiclass one can't load.
      const segOpts = (file) => ({
        baseOptions: { modelAssetPath: this.base + 'models/' + file },
        runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
      });
      try {
        this.seg = await make(ImageSegmenter, segOpts('selfie_multiclass_256x256.tflite'));
        this.multiclass = true;
      } catch (e) {
        console.warn('[Vanish FX] multiclass segmenter unavailable, using landscape model', e);
        this.seg = await make(ImageSegmenter, segOpts('selfie_segmenter_landscape.tflite'));
        this.multiclass = false;
      }
      this.ready = true;
    } catch (e) {
      console.error('[Vanish FX] model load failed', e);
      this.error = String(e?.message || e);
    } finally {
      this.loading = false;
    }
  }

  ts() {
    let t = performance.now();
    if (t <= this.lastTs) t = this.lastTs + 0.01;
    this.lastTs = t;
    return t;
  }

  detectHands(img, W, H) {
    if (!this.ready) return [];
    const r = this.hands.detectForVideo(img, this.ts());
    return (r.landmarks || []).map((lm, i) => {
      const pts = lm.map((p) => ({ x: p.x * W, y: p.y * H }));
      const label = r.handedness?.[i]?.[0]?.categoryName || `h${i}`;
      return { pts, world: r.worldLandmarks?.[i] || null, key: label, size: Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) || 1 };
    });
  }

  segment(img, onMask) {
    if (!this.ready) return false;
    this.seg.segmentForVideo(img, this.ts(), (res) => {
      const m = res.confidenceMasks?.[0];
      if (m) onMask(m.getAsFloat32Array(), m.width, m.height, this.multiclass);
    });
    return true;
  }
}


// --------------------------------------------------------------------- masks
// Mask v2 — hide / learn / influence-zone masks are built on the GPU at ~640 px
// with canvas compositing. Adapted from thanos-snap-video-extension
// (thanos_engine.js `_updateMask` / `_stamp`), MIT © 2026 Aayush Bhatta.
// See THIRD_PARTY_NOTICES.md.
const ANALYSIS_W = 640;

/** Union of `src` shifted around a circle of radius r (cheap GPU dilation). */
// (`dirs` trimmed from 16 where a blur follows anyway; `w,h` lets it rescale)
function stamp(ctx, src, r, dirs = 16, w = src.width, h = src.height) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(src, 0, 0, w, h);
  for (let k = 0; k < dirs; k++) {
    const a = (k / dirs) * Math.PI * 2;
    ctx.drawImage(src, Math.cos(a) * r, Math.sin(a) * r, w, h);
    ctx.drawImage(src, Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5, w, h);
  }
}

export class Masks {
  constructor() {
    this.sw = 0; this.sh = 0;
    this.valid = false;
    this.bbox = null; // in full-res pixels
    this.wantZone = false; // influence zone is only needed once the room is locked
    this.zoneValid = false;
  }

  resize(W, H) {
    this.W = W; this.H = H;
    this.sw = 256;
    this.sh = Math.max(8, Math.round((256 * H) / W));
    const { sw, sh } = this;
    this.segIn = canvas(sw, sh);
    this.segInCtx = ctx2d(this.segIn, { willReadFrequently: true });
    this.conf = new Float32Array(sw * sh);
    this.person = canvas(sw, sh);
    this.personCtx = ctx2d(this.person);
    this.personImg = new ImageData(sw, sh);
    this.rawC = canvas(sw, sh);
    this.rawCtx = ctx2d(this.rawC);
    this.rawImg = new ImageData(sw, sh);
    const aw = (this.aw = Math.min(ANALYSIS_W, W)), ah = (this.ah = Math.max(8, Math.round((aw * H) / W)));
    const pair = () => { const c = canvas(aw, ah); return [c, ctx2d(c)]; };
    [this.hard, this.hardX] = pair();
    [this.prev, this.prevX] = pair();
    [this.dil0, this.dil0X] = pair();
    [this.hideSoft, this.hideSoftX] = pair();
    [this.learn, this.learnX] = pair();
    // the influence zone is very soft, so it lives at half resolution
    const zw = (this.zw = aw >> 1), zh = (this.zh = ah >> 1);
    this.zone0 = canvas(zw, zh); this.zone0X = ctx2d(this.zone0);
    this.zone = canvas(zw, zh); this.zoneX = ctx2d(this.zone);
    this.valid = false;
    this.zoneValid = false;
  }

  // Small copy of the frame used as segmentation input.
  input(frame) {
    this.segInCtx.drawImage(frame, 0, 0, this.sw, this.sh);
    return this.segIn;
  }

  // Test-only: build a "confidence" mask by chroma (blue-ish = person).
  fakeFromInput() {
    const d = this.segInCtx.getImageData(0, 0, this.sw, this.sh).data;
    const c = (this.fakeBuf ||= new Float32Array(this.sw * this.sh));
    for (let i = 0; i < c.length; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      c[i] = b > r + 40 && b > g + 20 ? 1 : 0;
    }
    this.update(c, this.sw, this.sh, false);
  }

  update(raw, mw, mh, multiclass = false) {
    const { sw, sh, conf } = this;
    const n = sw * sh;
    const pd = this.personImg.data, rd = this.rawImg.data;
    const sameSize = mw === sw && mh === sh;
    let minX = sw, minY = sh, maxX = -1, maxY = -1, area = 0;
    for (let y = 0, i = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++, i++) {
        let v = sameSize ? raw[i] : raw[Math.min(mh - 1, ((y * mh) / sh) | 0) * mw + Math.min(mw - 1, ((x * mw) / sw) | 0)];
        if (multiclass) v = 1 - v; // multiclass mask 0 is "background"
        // display mask: temporally smoothed + smoothstep edge
        const c = (conf[i] = this.valid ? conf[i] * 0.35 + v * 0.65 : v);
        let a = (c - 0.3) / 0.4;
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        pd[i * 4] = pd[i * 4 + 1] = pd[i * 4 + 2] = 255;
        pd[i * 4 + 3] = a * a * (3 - 2 * a) * 255;
        // raw (unsmoothed) ramp for the hide mask: faint noise is exactly 0
        let r = (v - 0.2) / 0.3;
        r = r < 0 ? 0 : r > 1 ? 1 : r;
        rd[i * 4] = rd[i * 4 + 1] = rd[i * 4 + 2] = 255;
        rd[i * 4 + 3] = r * r * (3 - 2 * r) * 255;
        if (c > 0.5) {
          area++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    this.valid = true;
    this.personCtx.putImageData(this.personImg, 0, 0);
    this.rawCtx.putImageData(this.rawImg, 0, 0);
    this.area = area / n;
    if (area > n * 0.004) {
      const kx = this.W / sw, ky = this.H / sh;
      const x = minX * kx, y = minY * ky, w = (maxX - minX + 1) * kx, h = (maxY - minY + 1) * ky;
      this.bbox = { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
    } else this.bbox = null;
    this._gpuMasks();
  }

  _gpuMasks() {
    const { aw, ah } = this;
    // keep the previous hard mask: hiding uses the union of the last two masks,
    // so a body that moved since the (slightly late) mask is still covered
    this.prevX.globalCompositeOperation = 'copy';
    this.prevX.drawImage(this.hard, 0, 0);
    // hard mask: boost soft confidence so anything partly you counts as you
    const hc = this.hardX;
    hc.globalCompositeOperation = 'copy';
    hc.drawImage(this.rawC, 0, 0, aw, ah);
    hc.globalCompositeOperation = 'source-over';
    for (let k = 0; k < 3; k++) hc.drawImage(this.hard, 0, 0);
    // hide mask: union(prev, cur) grown ~2.8% of width, blurred, then firmed so
    // there's no semi-transparent rim of you left — only a short feather
    const rad = Math.max(4, Math.round(aw * 0.028));
    this.rad = rad;
    const d0 = this.dil0X;
    d0.globalCompositeOperation = 'source-over';
    d0.clearRect(0, 0, aw, ah);
    stamp(d0, this.hard, rad, 12);
    stamp(d0, this.prev, rad, 12);
    const dc = this.hideSoftX;
    dc.globalCompositeOperation = 'copy';
    dc.filter = `blur(${Math.max(1, Math.round(rad * 0.35))}px)`;
    dc.drawImage(this.dil0, 0, 0);
    dc.filter = 'none';
    dc.globalCompositeOperation = 'source-over';
    for (let k = 0; k < 3; k++) dc.drawImage(this.hideSoft, 0, 0);
    // learn-exclusion mask: wider still, so edges / motion blur never get baked
    // into the room plate
    const ec = this.learnX;
    ec.globalCompositeOperation = 'source-over';
    ec.clearRect(0, 0, aw, ah);
    stamp(ec, this.hideSoft, Math.round(rad * 0.8), 10);
    // influence zone (room locked only): your shadow / bounce light near you is
    // replaced too, fading out softly so there's no seam with the live picture
    if (this.wantZone) {
      const z0 = this.zone0X;
      z0.globalCompositeOperation = 'source-over';
      z0.clearRect(0, 0, this.zw, this.zh);
      stamp(z0, this.learn, Math.round(rad * 1.25), 8, this.zw, this.zh);
      const zc = this.zoneX;
      zc.globalCompositeOperation = 'copy';
      zc.filter = `blur(${Math.round(rad * 0.8)}px)`;
      zc.drawImage(this.zone0, 0, 0);
      zc.filter = 'none';
      zc.globalCompositeOperation = 'source-over';
      zc.drawImage(this.zone, 0, 0); // firm the core, keep the long soft tail
      this.zoneValid = true;
    } else this.zoneValid = false;
  }
}

// ---------------------------------------------------- learned background plate
// Room v2: guided capture + lock, per-channel exposure tracking and a scanline
// fill on top of push-pull. Capture timing, gain tracking and the scanline fill
// are adapted from thanos-snap-video-extension (thanos_engine.js `_tickCapture`,
// `_updateGain`, `_scanlineFill`), MIT © 2026 Aayush Bhatta.
function makeGrain() {
  const S = 128, c = canvas(S, S), x = ctx2d(c), img = x.createImageData(S, S);
  for (let i = 0; i < S * S; i++) {
    const v = 128 + (Math.random() - 0.5) * 26;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

export const CAPTURE = { countdown: 3000, until: 5500, lockAt: 0.9, autoLockAt: 0.98 };

export class Plate {
  resize(W, H) {
    this.W = W; this.H = H;
    this.bg = canvas(W, H); this.bgCtx = ctx2d(this.bg);
    this.tmp = canvas(W, H); this.tmpCtx = ctx2d(this.tmp);
    this.fill = canvas(W, H); this.fillCtx = ctx2d(this.fill);
    this.exp = canvas(W, H); this.expCtx = ctx2d(this.exp);
    this.levels = [];
    let w = W, h = H;
    while (w > 6) {
      w = Math.max(1, Math.round(w / 2)); h = Math.max(1, Math.round(h / 2));
      const c = canvas(w, h);
      this.levels.push({ c, x: ctx2d(c), w, h });
    }
    this.probe = canvas(32, 18);
    this.probeCtx = ctx2d(this.probe, { willReadFrequently: true });
    this.slW = Math.max(16, Math.round(W / 8)); this.slH = Math.max(9, Math.round(H / 8));
    this.sl = canvas(this.slW, this.slH);
    this.slCtx = ctx2d(this.sl, { willReadFrequently: true });
    this.gainCv = [0, 1, 2].map(() => ctx2d(canvas(64, 36), { willReadFrequently: true }));
    this.coverage = 0;
    this.locked = false;
    this.gain = [1, 1, 1];
    this.cap = null;      // { start } while a guided capture runs
    this.result = null;   // { pct, locked, at } after the last capture
    this.frameNo = 0;
    this.fillValid = false;
  }

  // -- guided capture: 3 s countdown to step out, learn hard until 5.5 s, then
  //    lock the room if ≥ 90% of it has been seen
  captureRoom(now) {
    this.locked = false;
    this.gain = [1, 1, 1];
    this.cap = { start: now };
    this.result = null;
    this.fillValid = false;
  }
  // back-compat with the v1 API
  capture(now, delayMs = CAPTURE.countdown) { this.captureRoom(now - (CAPTURE.countdown - delayMs)); }
  capturing(now) { return !!this.cap && now - this.cap.start >= CAPTURE.countdown; }
  capturePending() { return !!this.cap; }
  get captureStart() { return this.cap ? this.cap.start + CAPTURE.countdown : 0; }

  /** phase info for status() and the mirror hint */
  captureInfo(now) {
    if (this.cap) {
      const t = now - this.cap.start;
      if (t < CAPTURE.countdown) return { phase: 'countdown', secs: Math.ceil((CAPTURE.countdown - t) / 1000) };
      return { phase: 'capturing', progress: (t - CAPTURE.countdown) / (CAPTURE.until - CAPTURE.countdown) };
    }
    if (this.result && now - this.result.at < 5000) return { phase: 'done', ...this.result };
    return null;
  }

  _tick(now) {
    if (!this.cap || now - this.cap.start < CAPTURE.until) return;
    this.cap = null;
    this._measure();
    const pct = Math.round(this.coverage * 100);
    if (this.coverage >= CAPTURE.lockAt) this._lock();
    this.result = { pct, locked: this.locked, at: now };
  }

  _lock() {
    this.locked = true;
    this.gain = [1, 1, 1];
    this.fillValid = false;
  }

  learn(frame, masks, now, { autoLock = true } = {}) {
    this._tick(now);
    const { bgCtx, tmpCtx, W, H } = this;
    if (this.locked) {
      // captured room is frozen (so your shadow never gets baked in); only
      // follow the camera's auto exposure / white balance
      if (++this.frameNo % 3 === 0) this._updateGain(frame, masks);
      return;
    }
    if (!masks.valid) return;
    tmpCtx.globalCompositeOperation = 'copy';
    tmpCtx.drawImage(frame, 0, 0, W, H);
    // hard-edged mask: soft edges would leave near-transparent pixels whose
    // 8-bit premultiplied colours drift (dark rims in the filled room)
    tmpCtx.globalCompositeOperation = 'destination-out';
    tmpCtx.imageSmoothingEnabled = false;
    tmpCtx.drawImage(masks.learn, 0, 0, W, H);
    tmpCtx.imageSmoothingEnabled = true;
    tmpCtx.globalCompositeOperation = 'source-over';
    bgCtx.globalAlpha = this.capturing(now) ? 0.5 : masks.bbox ? 0.08 : 0.2; // nobody in frame: learn fast
    bgCtx.drawImage(this.tmp, 0, 0);
    bgCtx.globalAlpha = 1;
    this.fillValid = false;
    if (++this.frameNo % 15 === 0) {
      this._measure();
      // walked out of frame on your own and the whole room got seen: lock it in
      if (autoLock && !this.cap && this.coverage >= CAPTURE.autoLockAt) {
        this._lock();
        this.result = { pct: Math.round(this.coverage * 100), locked: true, at: now, auto: true };
      }
    }
  }

  _measure() {
    const c = this.probeCtx;
    c.clearRect(0, 0, 32, 18);
    c.drawImage(this.bg, 0, 0, 32, 18);
    const d = c.getImageData(0, 0, 32, 18).data;
    let s = 0;
    for (let i = 3; i < d.length; i += 4) s += d[i] > 200 ? 1 : 0;
    this.coverage = s / (32 * 18);
  }

  /** per-channel ratio of live vs captured room, measured away from you */
  _updateGain(frame, masks) {
    const gw = 64, gh = 36;
    const [lc, pc, zc] = this.gainCv;
    lc.globalCompositeOperation = pc.globalCompositeOperation = zc.globalCompositeOperation = 'copy';
    lc.drawImage(frame, 0, 0, gw, gh);
    pc.drawImage(this.bg, 0, 0, gw, gh);
    zc.drawImage(masks.zoneValid ? masks.zone : masks.learn, 0, 0, gw, gh);
    const L = lc.getImageData(0, 0, gw, gh).data;
    const P = pc.getImageData(0, 0, gw, gh).data;
    const Z = zc.getImageData(0, 0, gw, gh).data;
    const sl = [0, 0, 0], sp = [0, 0, 0];
    let n = 0;
    for (let i = 0; i < L.length; i += 4) {
      if (Z[i + 3] > 6 || P[i + 3] < 250) continue;
      const lum = L[i] + L[i + 1] + L[i + 2];
      if (lum > 735 || lum < 30) continue; // clipped highlights / deep blacks
      for (let c = 0; c < 3; c++) { sl[c] += L[i + c]; sp[c] += P[i + c]; }
      n++;
    }
    if (n < 40) return;
    for (let c = 0; c < 3; c++) {
      const g = Math.min(2, Math.max(0.5, sl[c] / Math.max(1, sp[c])));
      this.gain[c] = this.gain[c] * 0.7 + g * 0.3;
    }
  }

  /** each row bridges the hole with the real room colours on either side */
  _scanline() {
    const { slW: sw, slH: sh } = this;
    const c = this.slCtx;
    c.globalCompositeOperation = 'copy';
    c.drawImage(this.bg, 0, 0, sw, sh);
    const img = c.getImageData(0, 0, sw, sh);
    const d = img.data;
    let any = false;
    for (let y = 0; y < sh; y++) {
      const row = y * sw;
      let x = 0;
      while (x < sw) {
        if (d[(row + x) * 4 + 3] >= 128) { x++; continue; }
        const a = x;
        while (x < sw && d[(row + x) * 4 + 3] < 128) x++;
        const L = a > 0 ? (row + a - 1) * 4 : -1;
        const R = x < sw ? (row + x) * 4 : -1;
        if (L < 0 && R < 0) continue; // whole row unknown: push-pull covers it
        any = true;
        for (let k = a; k < x; k++) {
          const t = (k - a + 1) / (x - a + 1);
          const o = (row + k) * 4;
          for (let ch = 0; ch < 3; ch++) {
            const lv = L >= 0 ? d[L + ch] : d[R + ch];
            const rv = R >= 0 ? d[R + ch] : d[L + ch];
            d[o + ch] = lv + (rv - lv) * t;
          }
          d[o + 3] = 255;
        }
      }
    }
    if (!any) return null;
    c.putImageData(img, 0, 0);
    return this.sl;
  }

  // Push-pull hole filling + scanline bridge: unknown regions get filled from
  // their neighbours. A locked room never changes, so its fill is cached.
  filled() {
    if (this.fillValid) return this.fill;
    const { levels, W, H } = this;
    let prev = this.bg;
    for (const L of levels) {
      L.x.globalCompositeOperation = 'copy';
      L.x.drawImage(prev, 0, 0, L.w, L.h);
      L.x.globalCompositeOperation = 'source-over';
      prev = L.c;
    }
    const top = levels[levels.length - 1];
    for (let i = 0; i < 6; i++) top.x.drawImage(top.c, 0, 0);
    top.x.globalCompositeOperation = 'destination-over';
    for (let i = 0; i < Math.max(top.w, top.h); i++) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) top.x.drawImage(top.c, dx, dy);
    }
    top.x.fillStyle = '#6b6560';
    top.x.fillRect(0, 0, top.w, top.h);
    top.x.globalCompositeOperation = 'source-over';
    for (let i = levels.length - 2; i >= 0; i--) {
      const L = levels[i], up = levels[i + 1];
      L.x.globalCompositeOperation = 'destination-over';
      L.x.drawImage(up.c, 0, 0, L.w, L.h);
      L.x.globalCompositeOperation = 'source-over';
    }
    const f = this.fillCtx;
    f.globalCompositeOperation = 'copy';
    f.drawImage(levels[0].c, 0, 0, W, H);
    f.globalCompositeOperation = 'source-over';
    // scanline on top: walls / furniture continue across instead of one blob
    const sl = this._scanline();
    if (sl) {
      f.filter = `blur(${Math.max(2, Math.round(W / 160))}px)`;
      f.drawImage(sl, 0, 0, W, H);
      f.filter = 'none';
    }
    // grain on the guessed (smooth) parts so they don't read as a flat blur
    f.globalCompositeOperation = 'overlay';
    f.globalAlpha = 0.5;
    f.fillStyle = this.grainPattern || (this.grainPattern = f.createPattern(makeGrain(), 'repeat'));
    f.fillRect(0, 0, W, H);
    f.globalAlpha = 1;
    f.globalCompositeOperation = 'source-over';
    f.filter = 'blur(1.5px)'; // hides the stair-steps where known pixels meet the guess
    f.drawImage(this.bg, 0, 0);
    f.filter = 'none';
    this.fillValid = this.locked;
    return this.fill;
  }

  /** filled room, exposure-matched to the live camera when locked */
  exposed() {
    const fill = this.filled();
    if (!this.locked) return fill;
    const g = this.gain, gmax = Math.max(g[0], g[1], g[2]);
    if (Math.abs(g[0] - 1) + Math.abs(g[1] - 1) + Math.abs(g[2] - 1) < 0.01) return fill;
    const x = this.expCtx;
    x.globalCompositeOperation = 'copy';
    x.filter = `brightness(${gmax})`;
    x.drawImage(fill, 0, 0);
    x.filter = 'none';
    x.globalCompositeOperation = 'multiply';
    x.fillStyle = `rgb(${(255 * g[0]) / gmax},${(255 * g[1]) / gmax},${(255 * g[2]) / gmax})`;
    x.fillRect(0, 0, this.W, this.H);
    x.globalCompositeOperation = 'source-over';
    return this.exp;
  }
}
