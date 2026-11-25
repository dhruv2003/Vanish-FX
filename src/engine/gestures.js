// Gesture recognition from MediaPipe hand landmarks.
// Landmark ids: 0 wrist, 4 thumb tip, 5/9/13/17 finger MCPs, 6/10/14/18 PIPs, 8/12/16/20 tips.
const D = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function extended(h, tip, pip) {
  return D(h.pts[0], h.pts[tip]) > D(h.pts[0], h.pts[pip]) * 1.12;
}
function fingersUp(h) {
  return [[8, 6], [12, 10], [16, 14], [20, 18]].filter(([t, p]) => extended(h, t, p)).length;
}
function openPalm(h) {
  const thumbOut = D(h.pts[4], h.pts[5]) > h.size * 0.45;
  const spread = D(h.pts[8], h.pts[20]) > h.size * 0.75;
  return fingersUp(h) === 4 && thumbOut && spread;
}
function fist(h) { return fingersUp(h) <= 1; }
const D3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
// Hand-scale-normalised snap features (2D projection + 3D world landmarks when
// available, so a tilted / side-on hand still reads correctly).
function snapFeatures(h) {
  const p = h.pts;
  const s2 = Math.max(D(p[0], p[9]), D(p[5], p[17]) * 1.2, 1e-3);
  const pinch2 = Math.min(D(p[4], p[12]), D(p[4], p[11])) / s2;
  const thenar = (q, f) => ({ x: (q[1].x + q[2].x + q[0].x) / 3, y: (q[1].y + q[2].y + q[0].y) / 3, z: f ? ((q[1].z || 0) + (q[2].z || 0) + (q[0].z || 0)) / 3 : 0 });
  const palm = (q) => { let x = 0, y = 0, z = 0; for (const i of [0, 5, 9, 13, 17]) { x += q[i].x; y += q[i].y; z += q[i].z || 0; } return { x: x / 5, y: y / 5, z: z / 5 }; };
  let pinch = pinch2 * 1.1, slam;
  const w = h.world;
  if (w && w.length >= 21) {
    const s3 = Math.max(D3(w[0], w[9]), D3(w[5], w[17]) * 1.25, 0.04);
    pinch = Math.min(pinch, Math.min(D3(w[4], w[12]), D3(w[4], w[11]) * 1.05) / s3);
    slam = Math.min(D3(w[12], thenar(w, true)), D3(w[12], palm(w))) / s3;
  } else {
    slam = Math.min(D(p[12], thenar(p, false)), D(p[12], palm(p))) / s2;
  }
  return { pinch, slam };
}

export function palmCenter(h) {
  const ids = [0, 5, 9, 13, 17];
  let x = 0, y = 0;
  for (const i of ids) { x += h.pts[i].x; y += h.pts[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}
function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < 1e-6) return false;
  const u = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const v = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  return u >= -0.1 && u <= 1.1 && v >= -0.1 && v <= 1.1;
}

export class Gestures {
  constructor() {
    this.snapState = {};   // per hand key
    this.clicks = [];      // recent mic transients (ms)
    this.hold = { seal: 0, cross: 0, palm: {} };
    this.armed = { seal: true, cross: true };
    this.lastFire = 0;
    this.debug = {};
  }

  addClick(t) { this.clicks.push(t); }

  // returns { events: [...], palms: [...] }
  update(hands, now, s, micPresent) {
    const events = [];
    const sens = s.sensitivity ?? 0.5;
    const cooldown = now - this.lastFire < 1100;
    this.clicks = this.clicks.filter((c) => now - c < 600);
    const fire = (e) => { if (!cooldown) { events.push(e); this.lastFire = now; } };

    // ---------------------------------------------------------- finger snap
    // Sensitivity-scaled, angle-tolerant snap kinematics adapted from
    // thanos-snap-video-extension (gesture.js `handFeatures` / `setSensitivity`),
    // MIT © 2026 Aayush Bhatta. Fused with our mic click detector below.
    const k = sens;
    const pinchMax = 0.44 + 0.16 * k;        // thumb–middle "armed" contact
    const separationMin = 0.50 - 0.10 * k;   // thumb and middle pull apart
    const slamMax = 0.52 + 0.16 * k;         // middle finger lands in the palm
    const dropMin = 0.18 - 0.08 * k;         // ...dropping that far
    const armedWindowMs = 650 + 350 * k;     // how long an armed pinch stays live
    const seen = new Set();
    for (const h of hands) {
      seen.add(h.key);
      const st = (this.snapState[h.key] ||= { contact: false, lastEnd: -1e9, motionAt: -1e9, used: -1e9, armedAt: -1e9, armPinch: 9, peakSlam: 0, hist: [] });
      const f = snapFeatures(h);
      const isContact = f.pinch < pinchMax && !openPalm(h);
      if (isContact) {
        if (!st.contact) st.start = now;
        st.contact = true;
        st.armedAt = now;
        st.armPinch = f.pinch;
        st.peakSlam = Math.max(st.peakSlam, f.slam);
      } else if (st.contact) {
        st.contact = false;
        st.lastEnd = now;
      }
      st.hist.push(now, f.slam);
      while (st.hist.length && now - st.hist[0] > 450) st.hist.splice(0, 2);
      let maxSlam = st.peakSlam;
      for (let i = 1; i < st.hist.length; i += 2) if (st.hist[i] > maxSlam) maxSlam = st.hist[i];
      const armed = now - st.armedAt <= armedWindowMs;
      if (armed && !isContact) {
        const separated = f.pinch >= separationMin || f.pinch - st.armPinch >= 0.18;
        const landed = f.slam < slamMax;
        const slammed = maxSlam - f.slam >= dropMin;
        if ((separated && landed) || (separated && slammed) || (landed && slammed)) {
          st.motionAt = now;
          st.armedAt = -1e9; st.peakSlam = 0; st.hist.length = 0;
        }
      }
      this.debug.pinch = f.pinch;
    }
    // hand vanished mid-contact (motion blur during the snap) counts as a release
    for (const [k, st] of Object.entries(this.snapState)) {
      if (!seen.has(k) && st.contact) { st.contact = false; st.lastEnd = now; }
    }
    if (s.effects.snap) {
      const useSound = s.soundConfirm && micPresent;
      for (const st of Object.values(this.snapState)) {
        if (now - st.used < 1200) continue;
        let ok = false;
        if (useSound) {
          const recent = st.contact || now - st.lastEnd < 450 || now - st.motionAt < 300;
          const c = this.clicks.find((c) => Math.abs(c - (st.contact ? now : st.lastEnd)) < 380);
          ok = recent && c != null && (st.contact ? now - st.start < 3000 : true);
          if (ok) this.clicks = this.clicks.filter((x) => x !== c);
        } else {
          ok = now - st.motionAt < 120;
        }
        if (ok) { st.used = now; fire('snap'); break; }
      }
    }

    // ------------------------------------------------- two-hand signs
    let twoHandPose = false;
    if (hands.length === 2) {
      const [a, b] = hands;
      const hs = (a.size + b.size) / 2;
      // seal: palms pressed together, fingers up
      const up = (h) => h.pts[12].y < h.pts[0].y - h.size * 0.5 && extended(h, 8, 6) && extended(h, 12, 10);
      const seal = up(a) && up(b) && D(a.pts[8], b.pts[8]) < hs * 0.6 && D(a.pts[12], b.pts[12]) < hs * 0.6 && D(a.pts[0], b.pts[0]) < hs * 1.6;
      // cross: index fingers crossing each other
      const ia = extended(a, 8, 6) && D(a.pts[5], a.pts[8]) > a.size * 0.5;
      const ib = extended(b, 8, 6) && D(b.pts[5], b.pts[8]) > b.size * 0.5;
      let cross = false;
      if (ia && ib && !seal) {
        const va = { x: a.pts[8].x - a.pts[5].x, y: a.pts[8].y - a.pts[5].y };
        const vb = { x: b.pts[8].x - b.pts[5].x, y: b.pts[8].y - b.pts[5].y };
        const sin = Math.abs(va.x * vb.y - va.y * vb.x) / (Math.hypot(va.x, va.y) * Math.hypot(vb.x, vb.y));
        cross = sin > 0.55 && segIntersect(a.pts[5], a.pts[8], b.pts[5], b.pts[8]);
      }
      twoHandPose = seal || cross || D(a.pts[0], b.pts[0]) < hs * 2;
      this.debug.seal = seal; this.debug.cross = cross;
      this._hold('seal', seal, now, 520 - 300 * sens, () => s.effects.scroll && fire('scroll'));
      this._hold('cross', cross, now, 420 - 250 * sens, () => s.effects.clones && fire('clones'));
    } else {
      this._hold('seal', false, now);
      this._hold('cross', false, now);
      this.debug.seal = this.debug.cross = false;
    }

    // ------------------------------------------------------- open palm (orb)
    const palms = [];
    for (const h of hands) {
      const open = !twoHandPose && openPalm(h);
      const p = (this.hold.palm[h.key] ||= { since: 0, fired: false });
      if (open) { if (!p.since) p.since = now; } else { p.since = 0; p.fired = false; }
      const held = p.since && now - p.since > 750 - 350 * sens;
      if (held && !p.fired && s.effects.orb) { p.fired = true; events.push('orb:' + h.key); }
      palms.push({ key: h.key, center: palmCenter(h), size: h.size, open, fist: fist(h), mcp: h.pts[9], wrist: h.pts[0] });
    }
    for (const k of Object.keys(this.hold.palm)) if (!hands.some((h) => h.key === k)) delete this.hold.palm[k];

    return { events, palms };
  }

  _hold(name, active, now, needMs = 0, onFire) {
    if (active) {
      if (!this.hold[name]) this.hold[name] = now;
      if (this.armed[name] && now - this.hold[name] >= needMs) { this.armed[name] = false; onFire?.(); }
    } else {
      this.hold[name] = 0;
      this.armed[name] = true;
    }
  }
}
