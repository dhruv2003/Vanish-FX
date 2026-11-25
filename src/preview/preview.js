import { EngineLink, wrapStream } from '../lib/pipeline.js';

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const link = new EngineLink(async () => $('#engine'));

async function syntheticStream() {
  // Test feed: a drawn room + a blue "person" (engine uses colour keying in this mode).
  const c = document.createElement('canvas');
  c.width = 1280; c.height = 720;
  const x = c.getContext('2d');
  const draw = (t) => {
    x.fillStyle = '#b8a48c'; x.fillRect(0, 0, 1280, 720);
    x.fillStyle = '#d7c9b0'; x.fillRect(0, 0, 1280, 470);
    x.fillStyle = '#e9f0f2'; x.fillRect(840, 90, 300, 220); x.strokeStyle = '#6d5a45'; x.lineWidth = 12; x.strokeRect(840, 90, 300, 220);
    x.fillStyle = '#7a5134'; x.fillRect(110, 200, 260, 22); x.fillRect(110, 300, 260, 22);
    ['#c0392b', '#e1a23b', '#2f6f4f', '#6c4a9c'].forEach((col, i) => { x.fillStyle = col; x.fillRect(125 + i * 55, 140, 38, 60); });
    x.fillStyle = '#2e7d4f'; x.beginPath(); x.arc(1080, 520, 70, 0, 7); x.fill();
    const sway = Math.sin(t / 700) * 40;
    x.fillStyle = '#2d52c8'; x.beginPath(); x.ellipse(640 + sway, 650, 230, 240, 0, Math.PI, 0); x.fill();
    x.fillStyle = '#3a63e0'; x.beginPath(); x.arc(640 + sway * 1.1, 330, 105, 0, 7); x.fill();
    x.fillStyle = '#ffffff'; x.beginPath(); x.arc(605 + sway * 1.1, 315, 14, 0, 7); x.arc(675 + sway * 1.1, 315, 14, 0, 7); x.fill();
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);
  return c.captureStream(30);
}

$('#start').onclick = async () => {
  $('#start').disabled = true;
  const ok = await link.connect();
  if (!ok) { $('#start').textContent = 'Engine failed to start'; return; }
  let raw;
  if (params.has('synthetic')) {
    raw = await syntheticStream();
    link.send({ type: 'fake-seg', on: true });
  } else {
    raw = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: { echoCancellation: true, noiseSuppression: false } });
  }
  link.send({ type: 'debug', on: $('#debug').checked });
  const out = wrapStream(raw, link);
  // show video only (avoid hearing yourself); sound FX still play locally
  $('#out').srcObject = new MediaStream(out.getVideoTracks());
  $('#start').textContent = '● Live';
  window.__vfxOut = out;
};
document.querySelectorAll('[data-fx]').forEach((b) => (b.onclick = () => link.send({ type: 'cmd', cmd: { type: 'trigger', effect: b.dataset.fx, force: true } })));
$('#bg').onclick = () => link.send({ type: 'cmd', cmd: { type: 'captureBg', delayMs: 3000 } });
$('#debug').onchange = () => link.send({ type: 'debug', on: $('#debug').checked });
if (params.has('autostart')) $('#start').click();
