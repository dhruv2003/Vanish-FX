// MAIN-world content script: intercepts getUserMedia on call sites.
import { EngineLink, wrapStream } from './lib/pipeline.js';

(() => {
  if (window.__vanishFxHooked) return;
  window.__vanishFxHooked = true;
  const md = navigator.mediaDevices;
  if (!md || !MediaDevices.prototype.getUserMedia) return;

  const findFrame = () => document.querySelector('iframe[data-vanishfx]');
  const link = new EngineLink(() => new Promise((resolve) => {
    const existing = findFrame();
    if (existing) return resolve(existing);
    const onMsg = (e) => {
      if (e.source !== window || e.data?.__vfx !== 'engine-created') return;
      window.removeEventListener('message', onMsg);
      resolve(findFrame());
    };
    window.addEventListener('message', onMsg);
    window.postMessage({ __vfx: 'need-engine' }, '*');
    setTimeout(() => resolve(findFrame()), 3000);
  }));

  const orig = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (constraints) {
    const stream = await orig.call(this, constraints);
    try {
      const ok = await link.connect();
      if (!ok || link.settings?.enabled === false) return stream;
      return wrapStream(stream, link);
    } catch (err) {
      console.warn('[Vanish FX] passthrough:', err);
      return stream;
    }
  };
})();
