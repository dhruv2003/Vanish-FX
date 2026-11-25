// Generates the extension icons (no image deps): a violet orb with a figure dissolving into dust.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function png(size, px) {
  const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function render(size) {
  const ss = 4, S = size * ss;
  const acc = new Float32Array(size * size * 4);
  const rnd = (i) => { const s = Math.sin(i * 12.9898) * 43758.5453; return s - Math.floor(s); };
  const dust = Array.from({ length: 60 }, (_, i) => ({ x: 0.5 + rnd(i) * 0.38, y: 0.3 + rnd(i + 99) * 0.45, r: 0.012 + rnd(i + 7) * 0.025 }));
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = (x + 0.5) / S, v = (y + 0.5) / S;
    const d = Math.hypot(u - 0.5, v - 0.5);
    let col = [0, 0, 0, 0];
    if (d < 0.48) {
      const t = Math.min(1, d / 0.48);
      col = [lerp(139, 40, t), lerp(92, 22, t), lerp(246, 90, t), 255];
      // figure (head + shoulders), left half solid
      const head = Math.hypot(u - 0.45, v - 0.38) < 0.11;
      const body = v > 0.53 && v < 0.82 && Math.hypot((u - 0.45) / 0.22, (v - 0.82) / 0.3) < 1;
      if ((head || body) && u < 0.5) col = [255, 240, 220, 255];
      for (const p of dust) if (Math.hypot(u - p.x, v - p.y) < p.r && u >= 0.5) col = [255, 205, 140, 255];
    }
    const i = ((y / ss | 0) * size + (x / ss | 0)) * 4;
    for (let k = 0; k < 4; k++) acc[i + k] += col[k] / (ss * ss);
  }
  return png(size, Buffer.from(Uint8Array.from(acc, (v) => Math.round(v))));
}
const lerp = (a, b, t) => a + (b - a) * t;
const out = process.argv[2] || 'src/icons';
mkdirSync(out, { recursive: true });
for (const s of [16, 48, 128]) writeFileSync(`${out}/icon${s}.png`, render(s));
console.log('icons ->', out);
