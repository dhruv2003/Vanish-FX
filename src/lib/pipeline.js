// Page-side pipeline: wraps camera + mic tracks.
// Video frames are shipped to the engine iframe (where the AI + effects run)
// and the rendered frames come back. Audio stays here: mic mute + sound FX.
import { createSfxPlayer } from './sfx.js';

const TAG = '[Vanish FX]';

// ---------------------------------------------------------------- engine link
export class EngineLink {
  constructor(getFrame) {
    this.getFrame = getFrame; // async () => HTMLIFrameElement
    this.win = null;
    this.settings = null;
    this.ready = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = {};
    window.addEventListener('message', (e) => this._onMessage(e));
  }

  connect(timeoutMs = 6000) {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const frame = await this.getFrame();
      if (!frame) return false;
      this.frame = frame;
      return new Promise((resolve) => {
        const start = Date.now();
        this._helloResolve = resolve;
        const ping = () => {
          if (this.win) return;
          if (Date.now() - start > timeoutMs) { resolve(false); return; }
          try { frame.contentWindow?.postMessage({ __vfx: 'ping' }, '*'); } catch {}
          setTimeout(ping, 150);
        };
        ping();
      });
    })();
    // allow a retry later if it failed
    this.ready.then((ok) => { if (!ok) this.ready = null; });
    return this.ready;
  }

  _onMessage(e) {
    const d = e.data;
    if (!d || typeof d !== 'object' || !d.__vfx) return;
    if (!this.frame || e.source !== this.frame.contentWindow) return;
    switch (d.__vfx) {
      case 'hello':
        this.win = e.source;
        this.settings = d.settings;
        this._helloResolve?.(true);
        break;
      case 'settings':
        this.settings = d.settings;
        break;
      case 'out': {
        const p = this.pending.get(d.id);
        if (p) { clearTimeout(p.timer); this.pending.delete(d.id); p.resolve(d.bmp); }
        else d.bmp?.close?.();
        break;
      }
    }
    this.handlers[d.__vfx]?.forEach((fn) => fn(d));
  }

  on(type, fn) { (this.handlers[type] ||= []).push(fn); }

  send(msg, transfer) {
    if (!this.win) return;
    try { this.win.postMessage({ __vfx: msg.type, ...msg }, '*', transfer || []); } catch (err) { console.warn(TAG, err); }
  }

  process(bmp, pipeId, timeoutMs = 1200) {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve(null); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.send({ type: 'frame', id, pipeId, bmp }, [bmp]);
    });
  }
}

// ------------------------------------------------------------- track disguise
// Make our processed track look like the real device to the call app.
function disguise(out, src, onStop) {
  const def = (k, get) => { try { Object.defineProperty(out, k, { get, configurable: true }); } catch {} };
  def('label', () => src.label);
  const outSettings = out.getSettings.bind(out);
  out.getSettings = () => ({ ...src.getSettings(), ...pick(outSettings(), ['width', 'height', 'frameRate']) });
  out.getCapabilities = () => src.getCapabilities?.() || {};
  out.getConstraints = () => src.getConstraints();
  out.applyConstraints = (c) => src.applyConstraints(c);
  const origStop = out.stop.bind(out);
  out.stop = () => { origStop(); onStop(); };
  const origClone = out.clone.bind(out);
  out.clone = () => { const c = origClone(); disguise(c, src, () => {}); return c; };
  src.addEventListener('ended', () => { try { origStop(); } catch {} onStop(); });
  return out;
}
function pick(o, keys) { const r = {}; for (const k of keys) if (o[k] != null) r[k] = o[k]; return r; }

// --------------------------------------------------------------------- video
let pipeCounter = 0;

function wrapVideo(src, link) {
  if (typeof MediaStreamTrackProcessor === 'undefined' || typeof MediaStreamTrackGenerator === 'undefined') {
    console.warn(TAG, 'Insertable streams unavailable; camera effects disabled.');
    return src;
  }
  const pipeId = ++pipeCounter;
  const processor = new MediaStreamTrackProcessor({ track: src, maxBufferSize: 2 });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });
  const reader = processor.readable.getReader();
  const writer = generator.writable.getWriter();
  let running = true;
  let busySince = 0;

  const stop = () => {
    if (!running) return;
    running = false;
    reader.cancel().catch(() => {});
    writer.close().catch(() => {});
    try { src.stop(); } catch {}
    link.send({ type: 'pipe-ended', pipeId });
  };

  (async () => {
    while (running) {
      let r;
      try { r = await reader.read(); } catch { break; }
      if (r.done) break;
      const frame = r.value;
      const enabled = link.win && link.settings?.enabled !== false;
      if (!enabled) { writer.write(frame).catch(() => {}); continue; }
      if (busySince) {
        // engine still working on the previous frame
        if (performance.now() - busySince > 1500) writer.write(frame).catch(() => {});
        else frame.close();
        continue;
      }
      busySince = performance.now();
      const ts = frame.timestamp;
      let bmp;
      try { bmp = await createImageBitmap(frame); }
      catch { writer.write(frame).catch(() => {}); busySince = 0; continue; }
      frame.close();
      link.process(bmp, pipeId).then((out) => {
        busySince = 0;
        if (!out) return;
        if (running) {
          try { writer.write(new VideoFrame(out, { timestamp: ts })).catch(() => {}); } catch {}
        }
        out.close();
      });
    }
    stop();
  })();

  return disguise(generator, src, stop);
}

// --------------------------------------------------------------------- audio
const audio = {
  ctx: null, sfxBus: null, toCall: null, local: null, player: null, mics: new Set(), muted: false,
  init() {
    if (this.ctx) return this.ctx;
    const ctx = (this.ctx = new AudioContext({ latencyHint: 'interactive' }));
    this.sfxBus = ctx.createGain();
    this.toCall = ctx.createGain();
    this.local = ctx.createGain();
    this.sfxBus.connect(this.toCall);
    this.sfxBus.connect(this.local).connect(ctx.destination);
    this.player = createSfxPlayer(ctx, this.sfxBus);
    const resume = () => ctx.state === 'suspended' && ctx.resume().catch(() => {});
    resume();
    ['pointerdown', 'keydown'].forEach((ev) => window.addEventListener(ev, resume, { capture: true }));
    return ctx;
  },
  apply(settings) {
    if (!this.ctx || !settings) return;
    const t = this.ctx.currentTime;
    this.sfxBus.gain.setTargetAtTime(settings.sfxVolume ?? 0.8, t, 0.02);
    this.toCall.gain.setTargetAtTime(settings.sfxToCall ? 1 : 0, t, 0.02);
    this.local.gain.setTargetAtTime(settings.sfxLocal ? 0.9 : 0, t, 0.02);
  },
  setMuted(m) {
    this.muted = m;
    if (!this.ctx) return;
    for (const mic of this.mics) mic.gain.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.04);
  },
};

function wrapAudio(src, link) {
  const ctx = audio.init();
  audio.apply(link.settings);
  const source = ctx.createMediaStreamSource(new MediaStream([src]));
  const gain = ctx.createGain();
  gain.gain.value = audio.muted ? 0 : 1;
  const dest = ctx.createMediaStreamDestination();
  source.connect(gain).connect(dest);
  audio.toCall.connect(dest);

  // Snap "click" detector: sharp broadband transient in the high band.
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2200;
  const sp = ctx.createScriptProcessor(512, 1, 1);
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(hp).connect(sp).connect(sink).connect(ctx.destination);
  let avg = 0.002, lastClick = 0;
  sp.onaudioprocess = (e) => {
    const d = e.inputBuffer.getChannelData(0);
    let peak = 0, sum = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); sum += v * v; if (v > peak) peak = v; }
    const rms = Math.sqrt(sum / d.length);
    const now = performance.now();
    if (peak > 0.06 && peak > avg * 9 && now - lastClick > 250) {
      lastClick = now;
      link.send({ type: 'click', strength: peak / Math.max(avg, 1e-4) });
    }
    avg = avg * 0.97 + rms * 0.03;
  };

  const mic = { gain };
  audio.mics.add(mic);
  link.send({ type: 'mic-present', present: true });
  const out = dest.stream.getAudioTracks()[0];
  const stop = () => {
    audio.mics.delete(mic);
    try { source.disconnect(); sp.disconnect(); audio.toCall.disconnect(dest); } catch {}
    try { src.stop(); } catch {}
    if (!audio.mics.size) link.send({ type: 'mic-present', present: false });
  };
  return disguise(out, src, stop);
}

// ------------------------------------------------------------------- public
export function attachLink(link) {
  if (link._attached) return;
  link._attached = true;
  link.on('sfx', (d) => {
    audio.init();
    audio.apply(link.settings);
    audio.player.play(d.name, d.opts || {});
  });
  link.on('mic', (d) => audio.setMuted(!!d.muted));
  link.on('settings', (d) => audio.apply(d.settings));
}

export function wrapStream(stream, link) {
  attachLink(link);
  const tracks = stream.getTracks().map((t) => {
    try {
      if (t.kind === 'video') return wrapVideo(t, link);
      if (t.kind === 'audio') return wrapAudio(t, link);
    } catch (err) { console.warn(TAG, 'wrap failed', err); }
    return t;
  });
  return new MediaStream(tracks);
}
