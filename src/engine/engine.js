// Engine iframe: receives camera frames from the page, runs AI + effects,
// returns rendered frames. Lives on the extension origin, so it is unaffected
// by the call site's Content-Security-Policy.
import { loadSettings, mergeSettings } from '../shared/settings.js';
import { Vision, Masks, Plate, canvas, ctx2d } from './vision.js';
import { Gestures } from './gestures.js';
import { Smoke, DustSnap, SealScroll, CloneBurst, EnergyOrb } from './effects.js';
import { MotionFX } from './motion.js';

const hasExt = !!globalThis.chrome?.runtime?.id;
const BASE = hasExt ? chrome.runtime.getURL('') : new URL('./', location.href).href;

const st = {
  settings: mergeSettings(),
  W: 0, H: 0,
  lastFrameAt: 0, lastNow: 0,
  micPresent: false, micMuted: false,
  debug: false, fakeSeg: false, noAI: false,
  fps: 0, frames: 0, fpsT: 0,
  tabId: null,
  hands: [],
  message: '',
};
const vision = new Vision(BASE);
const masks = new Masks();
const plate = new Plate();
const gestures = new Gestures();
const smoke = new Smoke();
const dust = new DustSnap();
const scroll = new SealScroll();
const clones = new CloneBurst();
const orb = new EnergyOrb();
const mfx = new MotionFX();
const perf = { ai: 0, fx: 0, total: 0 };

// test hook (only reachable from the same origin, i.e. the extension's own pages)
globalThis.__vfxDebug = { vision, dust, scroll, clones, orb, gestures, plate, masks, mfx, perf, fps: () => st.fps, status: () => status(), log: [] };

let frameC, frameX, outC, outX, personC, personX, hiddenC, hiddenX;

// --------------------------------------------------------------- messaging
const toPage = (msg, transfer) => parent.postMessage({ ...msg }, '*', transfer || []);
const sfx = (name, opts) => toPage({ __vfx: 'sfx', name, opts });
const mic = (muted) => { st.micMuted = !!muted; toPage({ __vfx: 'mic', muted: !!muted }); };

window.addEventListener('message', (e) => {
  if (e.source !== parent) return;
  const d = e.data;
  if (!d?.__vfx) return;
  switch (d.__vfx) {
    case 'ping': settingsReady.then(() => toPage({ __vfx: 'hello', settings: st.settings })); break;
    case 'frame': onFrame(d); break;
    case 'click': gestures.addClick(performance.now()); break;
    case 'mic-present': st.micPresent = !!d.present; break;
    case 'debug': st.debug = !!d.on; break;
    case 'fake-seg': st.fakeSeg = !!d.on; break;
    case 'no-ai': st.noAI = !!d.on; break; // test feed only: skip MediaPipe
    case 'cmd': handleCmd(d.cmd); break;
  }
});

function applySettings(s) {
  const prev = st.settings;
  st.settings = mergeSettings(s);
  toPage({ __vfx: 'settings', settings: st.settings });
  if (prev.enabled && !st.settings.enabled) resetAll();
}

function resetAll() {
  if (orb.active) orb.stop(fxCtx(performance.now(), 0));
  dust.state = 'idle'; scroll.state = 'idle'; clones.state = 'off';
  if (st.micMuted) mic(false);
}

const settingsReady = hasExt ? loadSettings().then(applySettings).catch(() => {}) : Promise.resolve();
if (hasExt) {
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'sync' && ch.vfx) applySettings(ch.vfx.newValue); });
  const setTab = (id) => { if (id != null) st.tabId = id; };
  chrome.tabs?.getCurrent?.((tab) => setTab(tab?.id));
  chrome.runtime.sendMessage({ to: 'background', type: 'whoami' }).then((r) => setTab(r?.tabId)).catch(() => {});
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.to !== 'engine' || msg.tabId !== st.tabId || !isActive()) return;
    if (msg.cmd) handleCmd(msg.cmd, true);
    sendResponse(status());
  });
}

const isActive = () => performance.now() - st.lastFrameAt < 2500;

function status() {
  const now = performance.now();
  return {
    active: isActive(),
    modelsReady: vision.ready, loading: vision.loading, error: vision.error,
    bgCoverage: Math.round(plate.coverage * 100),
    roomLocked: !!plate.locked,
    capture: plate.captureInfo ? plate.captureInfo(now) : null,
    capturing: plate.capturePending(now) ? Math.max(0, Math.ceil(((plate.captureStart || 0) - now) / 1000)) : null,
    micPresent: st.micPresent, micMuted: st.micMuted,
    fps: st.fps, hands: st.hands.length,
    states: { snap: dust.state, scroll: scroll.state, clones: clones.state, orb: orb.state },
    message: st.message,
  };
}

const pendingCmds = [];
function handleCmd(cmd, manual) {
  if (!cmd) return;
  if (cmd.type === 'captureBg') { plate.captureRoom(performance.now()); return; }
  if (cmd.type === 'trigger') pendingCmds.push({ effect: cmd.effect, force: !!cmd.force || !!manual });
}

// -------------------------------------------------------------- frame loop
function ensureSize(w, h) {
  const maxW = 1280;
  let W = w, H = h;
  if (W > maxW) { H = Math.round((H * maxW) / W); W = maxW; }
  if (W === st.W && H === st.H) return;
  st.W = W; st.H = H;
  frameC = canvas(W, H); frameX = ctx2d(frameC, { willReadFrequently: false });
  outC = canvas(W, H); outX = ctx2d(outC);
  personC = canvas(W, H); personX = ctx2d(personC, { willReadFrequently: true });
  hiddenC = canvas(W, H); hiddenX = ctx2d(hiddenC);
  masks.resize(W, H);
  plate.resize(W, H);
  mfx.resize(W, H);
}

function fxCtx(now, dt) {
  let personDone = false, hiddenDone = false;
  const layers = {
    person() {
      if (!personDone) {
        personDone = true;
        personX.globalCompositeOperation = 'copy';
        personX.drawImage(frameC, 0, 0);
        personX.globalCompositeOperation = 'destination-in';
        personX.drawImage(masks.person, 0, 0, st.W, st.H);
        personX.globalCompositeOperation = 'source-over';
      }
      return personC;
    },
    // live frame with the person replaced by the learned empty room
    hidden() {
      if (!hiddenDone) {
        hiddenDone = true;
        // Room v2: exposure-matched room; once the room is locked the wider
        // soft influence zone (shadows, bounce light) is replaced as well
        const fill = plate.exposed();
        hiddenX.globalCompositeOperation = 'copy';
        hiddenX.drawImage(fill, 0, 0);
        hiddenX.globalCompositeOperation = 'destination-in';
        hiddenX.drawImage(plate.locked && masks.zoneValid ? masks.zone : masks.hideSoft, 0, 0, st.W, st.H);
        hiddenX.globalCompositeOperation = 'destination-over';
        hiddenX.drawImage(frameC, 0, 0);
        hiddenX.globalCompositeOperation = 'source-over';
      }
      return hiddenC;
    },
  };
  return { W: st.W, H: st.H, ctx: outX, now, dt, masks, layers, sfx, mic, settings: st.settings, smoke, fx: mfx };
}

function onFrame(d) {
  const bmp = d.bmp;
  try {
    ensureSize(bmp.width, bmp.height);
    frameX.drawImage(bmp, 0, 0, st.W, st.H);
  } finally { bmp.close(); }
  const now = performance.now();
  const dt = st.lastNow ? Math.min(0.1, (now - st.lastNow) / 1000) : 1 / 30;
  st.lastNow = now;
  st.lastFrameAt = now;
  if (++st.frames && now - st.fpsT > 1000) { st.fps = st.frames; st.frames = 0; st.fpsT = now; }

  if (!st.settings.enabled) {
    outX.drawImage(frameC, 0, 0);
    return reply(d.id);
  }
  if (!st.noAI && !vision.ready && !vision.loading && !vision.error) vision.load();

  // ---- AI
  const t0 = performance.now();
  let hands = [];
  try {
    if (vision.ready) {
      hands = vision.detectHands(frameC, st.W, st.H);
      if (st.fakeSeg) { masks.input(frameC); masks.fakeFromInput(); }
      else vision.segment(masks.input(frameC), (m, w, h) => masks.update(m, w, h));
    } else if (st.fakeSeg) { masks.input(frameC); masks.fakeFromInput(); }
  } catch (err) { console.warn('[Vanish FX] inference error', err); }
  st.hands = hands;
  masks.wantZone = plate.locked;
  plate.learn(frameC, masks, now, { autoLock: dust.state === 'idle' && scroll.state === 'idle' });
  const t1 = performance.now();

  const X = fxCtx(now, dt);

  // ---- gestures -> effects
  const { events, palms } = gestures.update(hands, now, st.settings, st.micPresent);
  const fx = st.settings.effects;
  for (const c of pendingCmds.splice(0)) {
    if (!c.force && !fx[c.effect]) continue;
    events.push(c.effect === 'orb' ? 'orb!' : c.effect);
  }
  st.message = '';
  if (events.length) globalThis.__vfxDebug.log.push([Math.round(now), ...events]);
  for (const e of events) {
    if (e === 'snap') { if (scroll.state === 'idle' || scroll.state === undefined) dust.trigger(X); }
    else if (e === 'scroll') { if (dust.state === 'idle') { if (!scroll.trigger(X)) st.message = 'Scroll needs you in frame'; } }
    else if (e === 'clones') { if (!dust.hidesPerson && !scroll.hidesPerson) clones.trigger(X); }
    else if (e === 'orb!') orb.toggle(X, null);
    else if (e.startsWith('orb:')) orb.start(X, e.slice(4));
  }

  // ---- render
  const hidden = dust.hidesPerson || scroll.hidesPerson;
  outX.globalCompositeOperation = 'copy';
  outX.drawImage(hidden && masks.valid ? X.layers.hidden() : frameC, 0, 0);
  outX.globalCompositeOperation = 'source-over';
  if (!hidden && clones.active) {
    if (clones.render(X)) outX.drawImage(X.layers.person(), 0, 0);
  } else if (clones.active && hidden) {
    clones.state = 'off'; clones.alphas.fill(0);
  }
  dust.render(X);
  scroll.render(X);
  orb.render(X, palms);
  smoke.render(outX, dt);
  mfx.render(outX, outC, dt);
  mfx.post(outX, outC, now, dt);
  const t2 = performance.now();
  perf.ai = perf.ai * 0.9 + (t1 - t0) * 0.1;
  perf.fx = perf.fx * 0.9 + (t2 - t1) * 0.1;
  logStates(now);
  grabFrames(now);
  if (st.debug) drawDebug(hands);
  if (st.debug) {
    const cap = plate.captureInfo(now);
    if (cap?.phase === 'countdown') drawHint(`Step out of frame… ${cap.secs}`);
    else if (cap?.phase === 'capturing') drawHint('Capturing your room… stay out of frame');
    else if (cap?.phase === 'done') drawHint(cap.locked ? `Room ${cap.auto ? 'auto-' : ''}captured ✓ (${cap.pct}%) · come back and snap!` : `Room ${cap.pct}% captured · part of you was still in view, try again`);
    else if (!plate.locked && plate.coverage < 0.9) drawHint('Tip: click "Capture empty room" and step out of frame, so vanishing shows your real wall instead of a blur');
  }
  reply(d.id);
}

// state-transition log (read by the headless tests through __vfxDebug)
let lastStates = '';
function logStates(now) {
  const s = `${dust.state} ${scroll.state} ${clones.state} ${orb.state}`;
  if (s === lastStates) return;
  lastStates = s;
  const tr = (globalThis.__vfxDebug.transitions ||= []);
  tr.push({ t: Math.round(now), snap: dust.state, scroll: scroll.state, clones: clones.state, orb: orb.state });
  if (tr.length > 200) tr.shift();
}

// test hook: tests push { at, name } into __vfxDebug.grabs to get exact-time
// copies of the rendered output (browser screenshots lag at low frame rates)
function grabFrames(now) {
  const g = globalThis.__vfxDebug.grabs;
  if (!g?.length) return;
  const tr = globalThis.__vfxDebug.transitions || [];
  for (const r of g) if (r.at == null && tr.length > r.after) { r.t0 = tr[r.after].t; r.at = r.t0 + r.rel; }
  for (const req of g.filter((r) => !r.done && r.at != null && now >= r.at)) {
    req.done = true;
    req.actual = Math.round(now - req.t0);
    outC.convertToBlob({ type: 'image/jpeg', quality: 0.9 }).then((b) => {
      const fr = new FileReader();
      fr.onload = () => { req.data = fr.result; };
      fr.readAsDataURL(b);
    });
  }
}

function reply(id) {
  const bmp = outC.transferToImageBitmap();
  toPage({ __vfx: 'out', id, bmp }, [bmp]);
}

function drawHint(text) {
  const c = outX;
  c.save();
  c.font = `600 ${Math.round(st.W / 55)}px system-ui, sans-serif`;
  const w = c.measureText(text).width + 32, h = st.W / 30;
  c.fillStyle = 'rgba(139,92,246,0.9)';
  c.beginPath(); c.roundRect((st.W - w) / 2, st.H - h - 16, w, h, 10); c.fill();
  c.fillStyle = '#fff'; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, st.W / 2, st.H - h / 2 - 16);
  c.restore();
}

// ----------------------------------------------------- local debug overlay
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function drawDebug(hands) {
  const c = outX;
  c.save();
  c.lineWidth = 2;
  for (const h of hands) {
    c.strokeStyle = 'rgba(0,255,170,0.9)';
    c.beginPath();
    for (const [a, b] of BONES) { c.moveTo(h.pts[a].x, h.pts[a].y); c.lineTo(h.pts[b].x, h.pts[b].y); }
    c.stroke();
    c.fillStyle = '#ff3b6b';
    for (const i of [4, 8, 12]) { c.beginPath(); c.arc(h.pts[i].x, h.pts[i].y, 5, 0, 7); c.fill(); }
  }
  if (masks.bbox) { c.strokeStyle = 'rgba(255,255,0,0.6)'; const b = masks.bbox; c.strokeRect(b.x, b.y, b.w, b.h); }
  c.fillStyle = 'rgba(0,0,0,0.55)';
  c.fillRect(8, 8, 360, 112);
  c.fillStyle = '#fff';
  c.font = '14px system-ui, sans-serif';
  const s = status();
  c.fillText(`models: ${vision.ready ? 'ready' : vision.error ? 'ERROR ' + vision.error : 'loading…'}  fps: ${s.fps}`, 16, 28);
  c.fillText(`hands: ${hands.length}  seal: ${gestures.debug.seal ? 'YES' : '-'}  cross: ${gestures.debug.cross ? 'YES' : '-'}`, 16, 48);
  c.fillText(`room ${s.roomLocked ? 'locked' : 'learned'}: ${s.bgCoverage}%  mic: ${st.micPresent ? (st.micMuted ? 'muted' : 'live') : 'none'}`, 16, 68);
  c.fillText(`snap:${dust.state} scroll:${scroll.state} clones:${clones.state} orb:${orb.state}`, 16, 88);
  c.fillText(`ms/frame  ai: ${perf.ai.toFixed(1)}  fx: ${perf.fx.toFixed(1)}`, 16, 108);
  c.restore();
}
