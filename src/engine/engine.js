// Engine iframe: receives camera frames from the page, runs AI + effects,
// returns rendered frames. Lives on the extension origin, so it is unaffected
// by the call site's Content-Security-Policy.
import { loadSettings, mergeSettings } from '../shared/settings.js';
import { Vision, Masks, Plate, canvas, ctx2d } from './vision.js';
import { Gestures } from './gestures.js';
import { Smoke, DustSnap, SealScroll, CloneBurst, EnergyOrb } from './effects.js';

const hasExt = !!globalThis.chrome?.runtime?.id;
const BASE = hasExt ? chrome.runtime.getURL('') : new URL('./', location.href).href;

const st = {
  settings: mergeSettings(),
  W: 0, H: 0,
  lastFrameAt: 0, lastNow: 0,
  micPresent: false, micMuted: false,
  debug: false, fakeSeg: false,
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

// test hook (only reachable from the same origin, i.e. the extension's own pages)
globalThis.__vfxDebug = { dust, scroll, clones, orb, gestures, log: [] };

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
    capturing: plate.capturePending?.(now) ? Math.max(0, Math.ceil(((plate.captureStart || 0) - now) / 1000)) : null,
    micPresent: st.micPresent, micMuted: st.micMuted,
    fps: st.fps, hands: st.hands.length,
    states: { snap: dust.state, scroll: scroll.state, clones: clones.state, orb: orb.state },
    message: st.message,
  };
}

const pendingCmds = [];
function handleCmd(cmd, manual) {
  if (!cmd) return;
  if (cmd.type === 'captureBg') { plate.capture(performance.now(), cmd.delayMs ?? 3000); return; }
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
        const fill = plate.filled();
        hiddenX.globalCompositeOperation = 'copy';
        hiddenX.drawImage(fill, 0, 0);
        hiddenX.globalCompositeOperation = 'destination-in';
        hiddenX.drawImage(masks.hideSoft, 0, 0, st.W, st.H);
        hiddenX.globalCompositeOperation = 'destination-over';
        hiddenX.drawImage(frameC, 0, 0);
        hiddenX.globalCompositeOperation = 'source-over';
      }
      return hiddenC;
    },
  };
  return { W: st.W, H: st.H, ctx: outX, now, dt, masks, layers, sfx, mic, settings: st.settings, smoke };
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
  if (!vision.ready && !vision.loading && !vision.error) vision.load();

  // ---- AI
  let hands = [];
  try {
    if (vision.ready) {
      hands = vision.detectHands(frameC, st.W, st.H);
      if (st.fakeSeg) { masks.input(frameC); masks.fakeFromInput(); }
      else vision.segment(masks.input(frameC), (m, w, h) => masks.update(m, w, h));
    } else if (st.fakeSeg) { masks.input(frameC); masks.fakeFromInput(); }
  } catch (err) { console.warn('[Vanish FX] inference error', err); }
  st.hands = hands;
  if (masks.valid) plate.learn(frameC, masks, now);

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
  if (st.debug) drawDebug(hands);
  reply(d.id);
}

function reply(id) {
  const bmp = outC.transferToImageBitmap();
  toPage({ __vfx: 'out', id, bmp }, [bmp]);
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
  c.fillRect(8, 8, 330, 92);
  c.fillStyle = '#fff';
  c.font = '14px system-ui, sans-serif';
  const s = status();
  c.fillText(`models: ${vision.ready ? 'ready' : vision.error ? 'ERROR ' + vision.error : 'loading…'}  fps: ${s.fps}`, 16, 28);
  c.fillText(`hands: ${hands.length}  seal: ${gestures.debug.seal ? 'YES' : '-'}  cross: ${gestures.debug.cross ? 'YES' : '-'}`, 16, 48);
  c.fillText(`room learned: ${s.bgCoverage}%  mic: ${st.micPresent ? (st.micMuted ? 'muted' : 'live') : 'none'}`, 16, 68);
  c.fillText(`snap:${dust.state} scroll:${scroll.state} clones:${clones.state} orb:${orb.state}`, 16, 88);
  c.restore();
}
