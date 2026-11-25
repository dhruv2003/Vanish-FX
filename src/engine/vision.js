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
      this.seg = await make(ImageSegmenter, {
        baseOptions: { modelAssetPath: this.base + 'models/selfie_segmenter_landscape.tflite' },
        runningMode: 'VIDEO', outputConfidenceMasks: true, outputCategoryMask: false,
      });
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
      return { pts, key: label, size: Math.hypot(pts[0].x - pts[9].x, pts[0].y - pts[9].y) || 1 };
    });
  }

  segment(img, onMask) {
    if (!this.ready) return false;
    this.seg.segmentForVideo(img, this.ts(), (res) => {
      const m = res.confidenceMasks?.[0];
      if (m) onMask(m.getAsFloat32Array(), m.width, m.height);
    });
    return true;
  }
}

// --------------------------------------------------------------------- masks
export class Masks {
  constructor() {
    this.sw = 0; this.sh = 0;
    this.valid = false;
    this.bbox = null; // in full-res pixels
  }

  resize(W, H) {
    this.W = W; this.H = H;
    this.sw = 256;
    this.sh = Math.max(8, Math.round((256 * H) / W));
    this.segIn = canvas(this.sw, this.sh);
    this.segInCtx = ctx2d(this.segIn, { willReadFrequently: true });
    this.conf = new Float32Array(this.sw * this.sh);
    this.tmpA = new Uint8Array(this.sw * this.sh);
    this.tmpB = new Uint8Array(this.sw * this.sh);
    this.person = canvas(this.sw, this.sh);
    this.personCtx = ctx2d(this.person);
    this.personImg = new ImageData(this.sw, this.sh);
    this.hide = canvas(this.sw, this.sh);
    this.hideCtx = ctx2d(this.hide);
    this.hideImg = new ImageData(this.sw, this.sh);
    this.hideSoft = canvas(this.sw, this.sh);
    this.hideSoftCtx = ctx2d(this.hideSoft);
    this.valid = false;
  }

  // Small copy of the frame used as segmentation input.
  input(frame) {
    this.segInCtx.drawImage(frame, 0, 0, this.sw, this.sh);
    return this.segIn;
  }

  // Test-only: build a "confidence" mask by chroma (blue-ish = person).
  fakeFromInput() {
    const d = this.segInCtx.getImageData(0, 0, this.sw, this.sh).data;
    const c = new Float32Array(this.sw * this.sh);
    for (let i = 0; i < c.length; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      c[i] = b > r + 40 && b > g + 20 ? 1 : 0;
    }
    this.update(c, this.sw, this.sh);
  }

  update(raw, mw, mh) {
    const { sw, sh, conf } = this;
    const n = sw * sh;
    // resample (masks normally already match the input size) + temporal smoothing
    const sameSize = mw === sw && mh === sh;
    for (let y = 0, i = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++, i++) {
        const v = sameSize ? raw[i] : raw[Math.min(mh - 1, ((y * mh) / sh) | 0) * mw + Math.min(mw - 1, ((x * mw) / sw) | 0)];
        conf[i] = this.valid ? conf[i] * 0.35 + v * 0.65 : v;
      }
    }
    this.valid = true;

    // person alpha (soft) + bbox
    const pd = this.personImg.data;
    let minX = sw, minY = sh, maxX = -1, maxY = -1, area = 0;
    const bin = this.tmpA;
    for (let i = 0; i < n; i++) {
      const c = conf[i];
      let a = (c - 0.3) / 0.4;
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      a = a * a * (3 - 2 * a);
      pd[i * 4] = pd[i * 4 + 1] = pd[i * 4 + 2] = 255;
      pd[i * 4 + 3] = a * 255;
      bin[i] = c > 0.22 ? 1 : 0;
      if (c > 0.5) {
        area++;
        const x = i % sw, y = (i / sw) | 0;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
    this.personCtx.putImageData(this.personImg, 0, 0);
    this.area = area / n;
    if (area > n * 0.004) {
      const kx = this.W / sw, ky = this.H / sh;
      const x = minX * kx, y = minY * ky, w = (maxX - minX + 1) * kx, h = (maxY - minY + 1) * ky;
      this.bbox = { x, y, w, h, cx: x + w / 2, cy: y + h / 2 };
    } else this.bbox = null;

    // dilated hide mask (separable max filter)
    const r = Math.max(2, Math.round(sw * 0.035));
    const tmp = this.tmpB;
    for (let y = 0; y < sh; y++) {
      let run = -1e9;
      const row = y * sw;
      for (let x = 0; x < sw; x++) { if (bin[row + x]) run = x; tmp[row + x] = x - run <= r ? 1 : 0; }
      run = 1e9;
      for (let x = sw - 1; x >= 0; x--) { if (bin[row + x]) run = x; if (run - x <= r) tmp[row + x] = 1; }
    }
    const hd = this.hideImg.data;
    for (let x = 0; x < sw; x++) {
      let run = -1e9;
      for (let y = 0; y < sh; y++) { if (tmp[y * sw + x]) run = y; bin[y * sw + x] = y - run <= r ? 1 : 0; }
      run = 1e9;
      for (let y = sh - 1; y >= 0; y--) { if (tmp[y * sw + x]) run = y; if (run - y <= r) bin[y * sw + x] = 1; }
    }
    for (let i = 0; i < n; i++) { hd[i * 4] = hd[i * 4 + 1] = hd[i * 4 + 2] = 255; hd[i * 4 + 3] = bin[i] ? 255 : 0; }
    this.hideCtx.putImageData(this.hideImg, 0, 0);
    this.hideSoftCtx.clearRect(0, 0, sw, sh);
    this.hideSoftCtx.filter = 'blur(2px)';
    this.hideSoftCtx.drawImage(this.hide, 0, 0);
    this.hideSoftCtx.filter = 'none';
  }
}

// ---------------------------------------------------- learned background plate
export class Plate {
  resize(W, H) {
    this.W = W; this.H = H;
    this.bg = canvas(W, H); this.bgCtx = ctx2d(this.bg);
    this.tmp = canvas(W, H); this.tmpCtx = ctx2d(this.tmp);
    this.fill = canvas(W, H); this.fillCtx = ctx2d(this.fill);
    this.levels = [];
    let w = W, h = H;
    while (w > 6) {
      w = Math.max(1, Math.round(w / 2)); h = Math.max(1, Math.round(h / 2));
      const c = canvas(w, h);
      this.levels.push({ c, x: ctx2d(c), w, h });
    }
    this.probe = canvas(16, 9);
    this.probeCtx = ctx2d(this.probe, { willReadFrequently: true });
    this.coverage = 0;
    this.captureUntil = 0;
    this.frameNo = 0;
  }

  capture(now, delayMs = 3000, durMs = 1500) {
    this.captureStart = now + delayMs;
    this.captureUntil = now + delayMs + durMs;
  }

  capturing(now) { return now >= (this.captureStart || 0) && now < this.captureUntil; }
  capturePending(now) { return now < this.captureUntil; }

  learn(frame, masks, now) {
    const { bgCtx, tmpCtx, W, H } = this;
    if (this.capturing(now)) {
      bgCtx.globalAlpha = 0.35;
      bgCtx.drawImage(frame, 0, 0, W, H);
      bgCtx.globalAlpha = 1;
    } else if (masks.valid) {
      tmpCtx.globalCompositeOperation = 'copy';
      tmpCtx.drawImage(frame, 0, 0, W, H);
      // hard-edged mask: soft edges would leave near-transparent pixels whose
      // 8-bit premultiplied colours drift (dark rims in the filled room)
      tmpCtx.globalCompositeOperation = 'destination-out';
      tmpCtx.imageSmoothingEnabled = false;
      tmpCtx.drawImage(masks.hide, 0, 0, W, H);
      tmpCtx.imageSmoothingEnabled = true;
      tmpCtx.globalCompositeOperation = 'source-over';
      bgCtx.globalAlpha = 0.1;
      bgCtx.drawImage(this.tmp, 0, 0);
      bgCtx.globalAlpha = 1;
    }
    if (++this.frameNo % 20 === 0) {
      this.probeCtx.clearRect(0, 0, 16, 9);
      this.probeCtx.drawImage(this.bg, 0, 0, 16, 9);
      const d = this.probeCtx.getImageData(0, 0, 16, 9).data;
      let s = 0;
      for (let i = 3; i < d.length; i += 4) s += d[i] > 230 ? 1 : 0;
      this.coverage = s / 144;
    }
  }

  // Push-pull hole filling: unknown regions get smoothly filled from neighbours.
  filled() {
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
    f.drawImage(this.bg, 0, 0);
    return this.fill;
  }
}
