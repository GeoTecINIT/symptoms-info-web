// Generates the SyMptOMS favicon set and social share image from the logo master.
//
// Stdlib only (zlib for PNG), per the repo's no-dependencies rule. NOT part of
// build.mjs: the outputs are committed binaries, and this only needs running
// again if images/logo-symptoms_big.png changes.
//
//   node tools/make-icons.mjs                  write the icons
//   node tools/make-icons.mjs --preview out/   also write a preview sheet there
//
// Writes:
//   images/icons/favicon-16.png, favicon-32.png, apple-touch-icon.png
//   src/standalone/favicon.ico   (16/32/48, PNG-in-ICO; copied to the site root)
//   images/og-symptoms.png       (1200x630 share image)
//
// The icon is the brain from the logo's "O", found automatically by splitting
// the wordmark into glyphs on empty columns. Small sizes dilate the strokes
// before downscaling -- the outline is ~3% of the brain's height, so a plain
// downscale averages it into grey mush at 32px and nothing at all at 16px.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const previewAt = process.argv.indexOf('--preview');
const PREVIEW_DIR = previewAt > -1 ? process.argv[previewAt + 1] : null;

/* ---------------- PNG decode / encode ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function decodePNG(buf) {
  let p = 8, w, h, bitDepth, colorType, interlace;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('unsupported PNG');
  const channels = { 6: 4, 2: 3, 4: 2, 0: 1 }[colorType];
  if (!channels) throw new Error('unsupported color type ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = new Uint8Array(w * h * channels);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    prev = cur;
  }
  // normalise to RGBA
  if (channels === 4) return { w, h, data: out };
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (channels === 3) { rgba[i*4]=out[i*3]; rgba[i*4+1]=out[i*3+1]; rgba[i*4+2]=out[i*3+2]; rgba[i*4+3]=255; }
    else if (channels === 2) { rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=out[i*2]; rgba[i*4+3]=out[i*2+1]; }
    else { rgba[i*4]=rgba[i*4+1]=rgba[i*4+2]=out[i]; rgba[i*4+3]=255; }
  }
  return { w, h, data: rgba };
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- float-channel image ops ---------------- */

// Exact area-average weights for shrinking srcLen samples to dstLen.
function areaWeights(srcLen, dstLen) {
  const scale = srcLen / dstLen, rows = [];
  for (let d = 0; d < dstLen; d++) {
    const s0 = d * scale, s1 = (d + 1) * scale, taps = [];
    for (let s = Math.floor(s0); s < Math.min(srcLen, Math.ceil(s1)); s++) {
      const wgt = Math.min(s + 1, s1) - Math.max(s, s0);
      if (wgt > 0) taps.push([s, wgt / scale]);
    }
    rows.push(taps);
  }
  return rows;
}

// Separable area downscale of an array of Float32 planes (w x h each).
function shrink(planes, w, h, nw, nh) {
  const wx = areaWeights(w, nw), wy = areaWeights(h, nh);
  return planes.map((src) => {
    const tmp = new Float32Array(nw * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < nw; x++) {
        let acc = 0;
        for (const [s, k] of wx[x]) acc += src[y * w + s] * k;
        tmp[y * nw + x] = acc;
      }
    const dst = new Float32Array(nw * nh);
    for (let x = 0; x < nw; x++)
      for (let y = 0; y < nh; y++) {
        let acc = 0;
        for (const [s, k] of wy[y]) acc += tmp[s * nw + x] * k;
        dst[y * nw + x] = acc;
      }
    return dst;
  });
}

// Separable square max filter: thickens strokes before a big downscale so a
// 3%-of-height outline does not average away to grey.
function dilate(src, w, h, r) {
  if (r <= 0) return src;
  const tmp = new Float32Array(w * h), dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, src[y * w + k]);
      tmp[y * w + x] = m;
    }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, tmp[k * w + x]);
      dst[y * w + x] = m;
    }
  return dst;
}

/* ---------------- 1. isolate the brain ---------------- */

const master = decodePNG(fs.readFileSync(path.join(ROOT, 'images/logo-symptoms_big.png')));
const { w: MW, h: MH, data: M } = master;
console.log('master', MW + 'x' + MH);

let opaque = 0, partial = 0, clear = 0;
for (let i = 3; i < M.length; i += 4 * 97) { const a = M[i]; if (a === 255) opaque++; else if (a === 0) clear++; else partial++; }
console.log('alpha sample: opaque', opaque, 'partial', partial, 'transparent', clear);

// "Ink" = the dark teal of the letters and the brain, NOT the bright green line.
// Coverage folds in alpha, so anti-aliased edges keep their partial weight.
const TEAL = [31, 82, 94];
function inkCoverage(i) {
  const r = M[i], g = M[i + 1], b = M[i + 2], a = M[i + 3] / 255;
  if (a === 0) return 0;
  // distance from teal vs distance from white/green decides membership
  const dt = Math.hypot(r - TEAL[0], g - TEAL[1], b - TEAL[2]);
  const dg = Math.hypot(r - 45, g - 195, b - 138);
  const dw = Math.hypot(r - 255, g - 255, b - 255);
  if (dg < dt) return 0;
  // on an opaque white background, coverage is how far toward teal the pixel is
  const t = Math.max(0, Math.min(1, 1 - dt / (dt + dw)));
  return a * t;
}

// Column occupancy -> glyph segments; the brain is the one centred near 61.2%
// of the width (measured on the 1000px logo: brain spans ~x 560..665).
const colInk = new Float32Array(MW);
for (let y = 0; y < MH; y += 2)
  for (let x = 0; x < MW; x++) {
    const c = inkCoverage((y * MW + x) * 4);
    if (c > 0.5) colInk[x] += 1;
  }
const segments = [];
let start = -1;
for (let x = 0; x <= MW; x++) {
  const on = x < MW && colInk[x] > 0;
  if (on && start < 0) start = x;
  if (!on && start >= 0) { segments.push([start, x - 1]); start = -1; }
}
const target = MW * 0.612;
// merge segments separated by tiny gaps (the brain's two hemispheres touch only lightly)
const merged = [];
for (const s of segments) {
  const last = merged[merged.length - 1];
  if (last && s[0] - last[1] < MW * 0.004) last[1] = s[1];
  else merged.push([...s]);
}
const brainSeg = merged.reduce((best, s) =>
  Math.abs((s[0] + s[1]) / 2 - target) < Math.abs((best[0] + best[1]) / 2 - target) ? s : best);
console.log('segments', merged.map((s) => (s[0] / MW * 1000).toFixed(0) + '-' + (s[1] / MW * 1000).toFixed(0)).join(' '));
console.log('brain segment (1000px scale)', (brainSeg[0] / MW * 1000).toFixed(1), (brainSeg[1] / MW * 1000).toFixed(1));

// vertical extent within that segment
let top = MH, bottom = 0;
for (let y = 0; y < MH; y++)
  for (let x = brainSeg[0]; x <= brainSeg[1]; x++)
    if (inkCoverage((y * MW + x) * 4) > 0.5) { if (y < top) top = y; if (y > bottom) bottom = y; break; }
const bw = brainSeg[1] - brainSeg[0] + 1, bh = bottom - top + 1;
console.log('brain bbox', brainSeg[0], top, bw + 'x' + bh);

// square crop with the brain centred
const side = Math.max(bw, bh);
const cx = brainSeg[0] + bw / 2, cy = top + bh / 2;
const sx0 = Math.round(cx - side / 2), sy0 = Math.round(cy - side / 2);
const mask = new Float32Array(side * side);
for (let y = 0; y < side; y++)
  for (let x = 0; x < side; x++) {
    const X = sx0 + x, Y = sy0 + y;
    if (X < brainSeg[0] || X > brainSeg[1] || Y < 0 || Y >= MH) continue; // keep only the brain column range
    mask[y * side + x] = inkCoverage((Y * MW + X) * 4);
  }

/* ---------------- 2. render icons ---------------- */

const INK = [31, 82, 94];      // --ink
const TILE = [255, 255, 255];

// Intermediate at 512 so dilation radii stay small and cheap.
const [mask512] = shrink([mask], side, side, 512, 512);

function renderIcon(size, { pad, radius, strokeRadius, boost, tile = true }) {
  // place brain (512 intermediate) inside the icon with `pad` fraction margin
  const inner = Math.round(size * (1 - 2 * pad));
  const dil = dilate(mask512, 512, 512, strokeRadius);
  const [small] = shrink([dil], 512, 512, inner, inner);
  const rgba = new Uint8Array(size * size * 4);
  const off = Math.round((size - inner) / 2);
  const rpx = radius * size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // rounded-square tile coverage with a 1px soft edge
      let tileA = 1;
      if (tile && rpx > 0) {
        const qx = Math.max(rpx - (x + 0.5), 0, (x + 0.5) - (size - rpx));
        const qy = Math.max(rpx - (y + 0.5), 0, (y + 0.5) - (size - rpx));
        const d = Math.hypot(qx, qy) - rpx;
        tileA = Math.max(0, Math.min(1, 0.5 - d));
      }
      const mx = x - off, my = y - off;
      let c = mx >= 0 && my >= 0 && mx < inner && my < inner ? small[my * inner + mx] : 0;
      c = Math.min(1, Math.pow(Math.max(0, c), boost));
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(TILE[k] * (1 - c) + INK[k] * c);
      rgba[i + 3] = Math.round(255 * (tile ? tileA : Math.max(c, 0)));
    }
  return rgba;
}

const outImages = path.join(ROOT, 'images/icons');
fs.mkdirSync(outImages, { recursive: true });

const specs = {
  16: { pad: 0.03, radius: 0.18, strokeRadius: 4, boost: 0.7 },  // chosen from a 6-way comparison: the midline survives, folds cannot
  32: { pad: 0.08, radius: 0.18, strokeRadius: 6, boost: 0.7 },
  48: { pad: 0.08, radius: 0.18, strokeRadius: 4, boost: 0.8 },
  // iOS masks the corners itself, so the touch icon is a full-bleed square
  180: { pad: 0.12, radius: 0, strokeRadius: 1, boost: 0.9 },
};
const pngs = {};
for (const [s, spec] of Object.entries(specs)) {
  const size = Number(s);
  pngs[size] = encodePNG(size, size, renderIcon(size, spec));
}
fs.writeFileSync(path.join(outImages, 'favicon-16.png'), pngs[16]);
fs.writeFileSync(path.join(outImages, 'favicon-32.png'), pngs[32]);
fs.writeFileSync(path.join(outImages, 'apple-touch-icon.png'), pngs[180]);

// favicon.ico: PNG-in-ICO (valid since Windows Vista, supported by every
// current browser), 16 / 32 / 48.
{
  const sizes = [16, 32, 48];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = [], blobs = [];
  for (const s of sizes) {
    const e = Buffer.alloc(16);
    e[0] = s; e[1] = s; e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[s].length, 8); e.writeUInt32LE(offset, 12);
    offset += pngs[s].length;
    entries.push(e); blobs.push(pngs[s]);
  }
  fs.writeFileSync(path.join(ROOT, 'src/standalone/favicon.ico'), Buffer.concat([header, ...entries, ...blobs]));
}

/* ---------------- 3. social share image 1200x630 ---------------- */
{
  const W = 1200, H = 630, logoW = 960;
  const logoH = Math.round(MH * logoW / MW);
  // premultiplied RGBA planes for correct edge blending
  const planes = [0, 1, 2, 3].map(() => new Float32Array(MW * MH));
  for (let i = 0; i < MW * MH; i++) {
    const a = M[i * 4 + 3] / 255;
    planes[0][i] = M[i * 4] * a; planes[1][i] = M[i * 4 + 1] * a; planes[2][i] = M[i * 4 + 2] * a; planes[3][i] = a;
  }
  const [r, g, b, a] = shrink(planes, MW, MH, logoW, logoH);
  const out = new Uint8Array(W * H * 4);
  const ox = Math.round((W - logoW) / 2), oy = Math.round((H - logoH) / 2);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const lx = x - ox, ly = y - oy;
      let R = 255, G = 255, B = 255;
      if (lx >= 0 && ly >= 0 && lx < logoW && ly < logoH) {
        const j = ly * logoW + lx, al = a[j];
        R = r[j] + 255 * (1 - al); G = g[j] + 255 * (1 - al); B = b[j] + 255 * (1 - al);
      }
      out[i] = Math.round(Math.min(255, R)); out[i + 1] = Math.round(Math.min(255, G));
      out[i + 2] = Math.round(Math.min(255, B)); out[i + 3] = 255;
    }
  fs.writeFileSync(path.join(ROOT, 'images/og-symptoms.png'), encodePNG(W, H, out));
}



/* ---------------- optional preview sheet ---------------- */
if (PREVIEW_DIR) {
  // nearest-neighbour upscale so a 16px icon is inspectable, on light and dark tabs
  const cells = [[16, 8], [32, 4], [48, 3], [180, 1]];
  const cell = 180, gap = 12, W = cells.length * (cell + gap) + gap, H = 2 * (cell + gap) + gap;
  const sheet = new Uint8Array(W * H * 4);
  const bgs = [[241, 243, 244], [53, 54, 58]]; // Chrome light / dark tab strip
  for (let row = 0; row < 2; row++) {
    for (let y = 0; y < cell + gap; y++) for (let x = 0; x < W; x++) {
      const i = ((row * (cell + gap) + y) * W + x) * 4;
      sheet[i] = bgs[row][0]; sheet[i + 1] = bgs[row][1]; sheet[i + 2] = bgs[row][2]; sheet[i + 3] = 255;
    }
    cells.forEach(([size, scale], ci) => {
      const img = decodePNG(pngs[size]).data;
      const x0 = gap + ci * (cell + gap), y0 = gap + row * (cell + gap);
      for (let y = 0; y < size * scale; y++) for (let x = 0; x < size * scale; x++) {
        const si = (Math.floor(y / scale) * size + Math.floor(x / scale)) * 4;
        const di = ((y0 + y) * W + (x0 + x)) * 4, al = img[si + 3] / 255;
        for (let k = 0; k < 3; k++) sheet[di + k] = Math.round(img[si + k] * al + sheet[di + k] * (1 - al));
      }
    });
  }
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  fs.writeFileSync(path.join(PREVIEW_DIR, 'icon-preview.png'), encodePNG(W, H, sheet));
}

for (const f of ['images/icons/favicon-16.png', 'images/icons/favicon-32.png', 'images/icons/apple-touch-icon.png', 'src/standalone/favicon.ico', 'images/og-symptoms.png'])
  console.log(f.padEnd(36), fs.statSync(path.join(ROOT, f)).size + ' B');
