import { loadSettings, saveSettings } from '../shared/settings.js';

const EFFECTS = [
  { id: 'snap', emoji: '🫰', name: 'Dust Snap', how: 'Snap your fingers. Snap again to come back.', key: 'Alt+Shift+1' },
  { id: 'scroll', emoji: '📜', name: 'Sealing Scroll', how: 'Press palms together (hand seal) and hold briefly.', key: 'Alt+Shift+2' },
  { id: 'clones', emoji: '👥', name: 'Clone Burst', how: 'Cross your index fingers.', key: 'Alt+Shift+3' },
  { id: 'orb', emoji: '🔵', name: 'Energy Orb', how: 'Hold an open palm up for a second. Close your fist to end it.', key: 'Alt+Shift+4' },
];
const ACTION = {
  snap: { idle: 'Vanish', gone: 'Return', out: '…', in: '…' },
  scroll: { idle: 'Seal', sealed: 'Release', sealing: '…', releasing: '…' },
  clones: { off: 'Summon', on: 'Dismiss', appearing: '…', leaving: '…' },
  orb: { off: 'Charge', on: 'Release', charging: 'Release', collapsing: '…' },
};

let settings, tabId, lastStatus = null;
const $ = (id) => document.getElementById(id);

function renderEffects() {
  $('effects').innerHTML = '';
  for (const fx of EFFECTS) {
    const el = document.createElement('div');
    el.className = 'fx' + (settings.effects[fx.id] ? '' : ' off');
    el.innerHTML = `<div class="emoji">${fx.emoji}</div>
      <div><h3>${fx.name} <span class="state" id="st-${fx.id}"></span></h3><p>${fx.how}</p></div>
      <button id="go-${fx.id}" title="Trigger now (${fx.key})">Try</button>
      <label class="switch" title="Gesture + shortcut on/off"><input type="checkbox" id="on-${fx.id}"><span></span></label>`;
    $('effects').appendChild(el);
    const sw = el.querySelector(`#on-${fx.id}`);
    sw.checked = !!settings.effects[fx.id];
    sw.onchange = () => { settings.effects[fx.id] = sw.checked; el.classList.toggle('off', !sw.checked); save(); };
    el.querySelector(`#go-${fx.id}`).onclick = () => send({ type: 'trigger', effect: fx.id, force: true });
  }
}

function bind(id, kind = 'checkbox', parse = (v) => v) {
  const el = $(id);
  if (kind === 'checkbox') { el.checked = !!settings[id]; el.onchange = () => { settings[id] = el.checked; save(); }; }
  else { el.value = settings[id]; el.oninput = () => { settings[id] = parse(el.value); label(); save(); }; }
}
function label() { $('dustDurationVal').textContent = Number(settings.dustDuration).toFixed(1) + 's'; }

let saveT;
function save() { clearTimeout(saveT); saveT = setTimeout(() => saveSettings(settings), 120); }

async function send(cmd) {
  if (tabId == null) return null;
  try { return await chrome.runtime.sendMessage({ to: 'engine', tabId, cmd }); } catch { return null; }
}

async function poll() {
  const s = await send(null);
  lastStatus = s;
  const el = $('status');
  el.className = '';
  if (!settings.enabled) { el.textContent = 'Off'; }
  else if (!s) { el.textContent = 'No camera on this tab yet. Join a call or open the test mirror.'; el.className = 'warn'; }
  else if (s.error) { el.textContent = 'AI failed to load: ' + s.error; el.className = 'warn'; }
  else if (!s.modelsReady) { el.textContent = 'Camera active · loading AI…'; }
  else {
    el.textContent = `Live · ${s.fps} fps · room ${s.roomLocked ? 'locked ✓' : `learned ${s.bgCoverage}%`}` + (s.micPresent ? '' : ' · no mic');
    el.className = 'ok';
  }
  for (const fx of EFFECTS) {
    const state = s?.states?.[fx.id];
    $(`st-${fx.id}`).textContent = state && !['idle', 'off'].includes(state) ? state : '';
    const b = $(`go-${fx.id}`);
    b.disabled = !s;
    b.textContent = (state && ACTION[fx.id][state]) || 'Try';
  }
  $('captureBg').disabled = !s;
  const cap = s?.capture;
  if (cap?.phase === 'countdown') $('captureBg').textContent = `Leave the frame… ${cap.secs}`;
  else if (cap?.phase === 'capturing') $('captureBg').textContent = 'Capturing… stay out!';
  else if (cap?.phase === 'done') $('captureBg').textContent = cap.locked ? `Room captured ✓ (${cap.pct}%)` : `Only ${cap.pct}% seen · try again`;
  else $('captureBg').textContent = s?.roomLocked ? '📷 Re-capture empty room' : '📷 Capture empty room';
}

(async () => {
  settings = await loadSettings();
  [tabId] = (await chrome.tabs.query({ active: true, currentWindow: true })).map((t) => t.id);
  $('enabled').checked = settings.enabled;
  $('enabled').onchange = () => { settings.enabled = $('enabled').checked; save(); poll(); };
  renderEffects();
  ['soundConfirm', 'muteWhileGone', 'sfxToCall', 'sfxLocal'].forEach((k) => bind(k));
  bind('sensitivity', 'range', Number);
  bind('dustDuration', 'range', Number);
  bind('sfxVolume', 'range', Number);
  bind('dustDirection', 'select');
  bind('cloneCount', 'select', Number);
  label();
  $('captureBg').onclick = () => send({ type: 'captureBg', delayMs: 3000 });
  $('openMirror').onclick = () => chrome.tabs.create({ url: chrome.runtime.getURL('preview/preview.html') });
  $('shortcuts').onclick = () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  poll();
  setInterval(poll, 500);
})();
