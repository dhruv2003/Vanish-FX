// Isolated-world content script. Only job: create the hidden engine iframe
// when the page hook asks for it (lazily, only once a camera is requested).
(() => {
  let frame = null;
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__vfx !== 'need-engine') return;
    if (!frame || !frame.isConnected) {
      frame = document.createElement('iframe');
      frame.src = chrome.runtime.getURL('engine.html');
      frame.setAttribute('data-vanishfx', '1');
      frame.setAttribute('aria-hidden', 'true');
      frame.tabIndex = -1;
      frame.style.cssText = 'position:fixed!important;width:1px!important;height:1px!important;left:-10px!important;top:-10px!important;opacity:0!important;pointer-events:none!important;border:0!important;';
      (document.documentElement || document).appendChild(frame);
    }
    window.postMessage({ __vfx: 'engine-created' }, '*');
  });
})();
