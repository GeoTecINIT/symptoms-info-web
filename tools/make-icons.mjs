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
//   images/logo-mark.png         (home page: images/square.png without its
//                                 wordmark, cropped to the drawing's circle)
//
// The tab icons (16/32/48) are a simplified brain drawn for small sizes: the
// logo's brain, downscaled, read as a green blob in a tab. 32 and 48 are
// rendered from the smooth paths in section 2b; 16 is drawn by hand, pixel by
// pixel, because at that size a rendered outline averages its lobes away.
// The touch icon (180) keeps the detailed brain from the logo's "O", found
// automatically by splitting the wordmark into glyphs on empty columns.

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

// Square crop centred on the brain's ink. The horizontal extent is re-measured
// at full resolution: the column scan samples every other row, and the tab
// icon has no tile any more to hide a pixel of drift.
let left = MW, right = 0;
for (let y = top; y <= bottom; y++)
  for (let x = brainSeg[0]; x <= brainSeg[1]; x++)
    if (inkCoverage((y * MW + x) * 4) > 0.5) { if (x < left) left = x; if (x > right) right = x; }
const side = Math.max(right - left + 1, bh);
const cx = (left + right + 1) / 2, cy = top + bh / 2;
const sx0 = Math.round(cx - side / 2), sy0 = Math.round(cy - side / 2);
const mask = new Float32Array(side * side);
for (let y = 0; y < side; y++)
  for (let x = 0; x < side; x++) {
    const X = sx0 + x, Y = sy0 + y;
    if (X < brainSeg[0] || X > brainSeg[1] || Y < 0 || Y >= MH) continue; // keep only the brain column range
    mask[y * side + x] = inkCoverage((Y * MW + X) * 4);
  }

/* ---------------- 2. render icons ---------------- */

const GREEN = [45, 195, 138];  // --green, the band under the masthead
const TILE = [255, 255, 255];

// Intermediate at 512 so dilation radii stay small and cheap.
const [mask512] = shrink([mask], side, side, 512, 512);

function renderIcon(size, { pad, radius, strokeRadius, boost, tile = true }) {
  // place brain (512 intermediate) inside the icon with `pad` fraction margin
  // a whole, equal margin on each side: an odd inner size in an even icon
  // cannot be centred, and the spare pixel always landed left and top
  const margin = Math.max(1, Math.round(size * pad));
  const inner = size - 2 * margin;
  const dil = dilate(mask512, 512, 512, strokeRadius);
  const [small] = shrink([dil], 512, 512, inner, inner);
  const rgba = new Uint8Array(size * size * 4);
  const off = margin;
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
      if (tile) {
        for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(TILE[k] * (1 - c) + GREEN[k] * c);
        rgba[i + 3] = Math.round(255 * tileA);
      } else {
        // transparent: solid green, coverage in alpha, so no white fringe on a dark tab
        for (let k = 0; k < 3; k++) rgba[i + k] = GREEN[k];
        rgba[i + 3] = Math.round(255 * Math.max(c, 0));
      }
    }
  return rgba;
}

const outImages = path.join(ROOT, 'images/icons');
fs.mkdirSync(outImages, { recursive: true });

/* ---------------- 2b. the simplified brain (tab icons) ---------------- */
// Green on a white rounded tile: green on transparent was barely visible in a
// light tab strip. Paths are on a 24-unit grid, left hemisphere only; the right
// is the mirror about x = 12.
const TAB_OUTLINE = [
  [12, 5.6], [10.6, 4.2], [8.4, 3.8], [6.3, 4.5], [4.9, 6.0], // upper lobe, notch at the midline
  [3.4, 7.6], [2.8, 9.8], [3.4, 11.8],                        // side lobe
  [2.7, 13.6], [3.1, 15.6], [4.7, 17.0],                      // lower lobe
  [5.4, 18.8], [7.3, 20.0], [9.6, 20.0], [11.2, 19.2], [12, 18.4],
];
const TAB_MIDLINE = [[12, 5.6], [12, 18.4]];
// folds start in the notches between lobes and wave inward, clear of the midline
const TAB_FOLDS = [
  [[3.4, 11.8], [5.2, 11.2], [6.8, 12.1], [8.6, 11.4]],
  [[6.3, 4.5], [6.9, 6.4], [8.6, 7.3]],
  [[4.7, 17.0], [6.4, 16.0], [8.2, 16.6], [9.4, 15.6]],
];

// Catmull-Rom through the points, flattened to short segments
function smoothPath(pts, steps = 12) {
  if (pts.length < 3) return pts;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((j) => 0.5 * (2 * p1[j] + (p2[j] - p0[j]) * t
        + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2 + (3 * p1[j] - p0[j] - 3 * p2[j] + p3[j]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
const TAB_SEGMENTS = (() => {
  const segs = [TAB_OUTLINE, TAB_MIDLINE, ...TAB_FOLDS].flatMap((p) => {
    const sm = smoothPath(p), both = [sm, sm.map(([x, y]) => [24 - x, y])];
    return both.flatMap((q) => q.slice(1).map((pt, i) => [q[i], pt]));
  });
  // centre vertically on the drawn outline (it is not symmetric top to bottom)
  const ys = segs.flat().map(([, y]) => y);
  const dy = 12 - (Math.min(...ys) + Math.max(...ys)) / 2;
  return segs.map((sg) => sg.map(([x, y]) => [x, y + dy]));
})();
function segDist(x, y, [[ax, ay], [bx, by]]) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

// 16px by hand: the left eight columns, mirrored. '#' green, '.' white.
// Each hemisphere is closed, with a white fissure between them: a shared 2px
// midline joined the top and bottom edges into something like a capital I.
const TAB_16 = [
  '........',
  '........',
  '...###..',
  '..#...#.',
  '.#....#.',
  '.#.##.#.',
  '#...#.#.',
  '#.....#.',
  '.#....#.',
  '#.##..#.',
  '#...#.#.',
  '.#....#.',
  '..#...#.',
  '...###..',
  '........',
  '........',
];

function tileCoverage(fx, fy, size, radius) {
  const r = radius * size;
  const qx = Math.max(r - fx, 0, fx - (size - r)), qy = Math.max(r - fy, 0, fy - (size - r));
  return Math.hypot(qx, qy) <= r ? 1 : 0;
}

// stroke and pad in pixels; 4x4 supersampling for the edges
function renderTab(size, { stroke, pad, radius = 0.18 }) {
  const rgba = new Uint8Array(size * size * 4), SS = 4, scale = 24 / (size - 2 * pad);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let ink = 0, tileA = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const fx = px + (sx + 0.5) / SS, fy = py + (sy + 0.5) / SS;
          tileA += tileCoverage(fx, fy, size, radius);
          if (size === 16) continue;
          const x = (fx - pad) * scale, y = (fy - pad) * scale;
          let d = Infinity;
          for (const sg of TAB_SEGMENTS) { const v = segDist(x, y, sg); if (v < d) d = v; }
          if (d / scale <= stroke / 2) ink++;
        }
      const c = size === 16 ? (TAB_16[py][px < 8 ? px : 15 - px] === '#' ? 1 : 0) : ink / (SS * SS);
      const i = (py * size + px) * 4;
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(TILE[k] * (1 - c) + GREEN[k] * c);
      rgba[i + 3] = Math.round((255 * tileA) / (SS * SS));
    }
  return rgba;
}

const pngs = {
  16: encodePNG(16, 16, renderTab(16, {})),
  32: encodePNG(32, 32, renderTab(32, { stroke: 2.1, pad: 1.5 })),
  48: encodePNG(48, 48, renderTab(48, { stroke: 2.9, pad: 2.5 })),
  // the touch icon: the detailed brain, a white full-bleed square (iOS fills
  // transparency with black and masks the corners itself)
  180: encodePNG(180, 180, renderIcon(180, { pad: 0.12, radius: 0, strokeRadius: 1, boost: 0.9 })),
};
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



/* ---------------- 4. home page mark ---------------- */
// images/square.png is the brain, the hands and the wordmark under them. The
// home page shows the wordmark in the masthead already, so its hero uses the
// drawing alone, cropped to a square around the drawing's smallest enclosing
// circle: the drawing then fits the image's inscribed circle, which is what
// lets custom.css keep the pulse rings clear of it.
{
  const src = decodePNG(fs.readFileSync(path.join(ROOT, 'images/square.png')));
  const { w: SW, h: SH, data: SD } = src;
  const opaque = (x, y) => SD[(y * SW + x) * 4 + 3] > 40;

  // the drawing is the first run of inked rows; the wordmark starts after a gap
  let y0 = 0;
  while (y0 < SH && ![...Array(SW).keys()].some((x) => opaque(x, y0))) y0++;
  let y1 = y0;
  while (y1 + 1 < SH && [...Array(SW).keys()].some((x) => opaque(x, y1 + 1))) y1++;
  let x0 = SW, x1 = 0;
  for (let y = y0; y <= y1; y++) for (let x = 0; x < SW; x++) if (opaque(x, y)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }

  // smallest enclosing circle by grid search on a sample of the ink
  const pts = [];
  for (let y = y0; y <= y1; y += 3) for (let x = x0; x <= x1; x += 3) if (opaque(x, y)) pts.push([x, y]);
  let best = [Infinity, 0, 0];
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  for (let cy = my - 200; cy <= my + 200; cy += 2)
    for (let cx = mx - 60; cx <= mx + 60; cx += 2) {
      let m = 0;
      for (const [x, y] of pts) { const d = (x - cx) ** 2 + (y - cy) ** 2; if (d > m) m = d; }
      if (m < best[0]) best = [m, cx, cy];
    }
  const r = Math.ceil(Math.sqrt(best[0])) + 4; // + the sampling step
  const side = 2 * r, ox = Math.round(best[1] - r), oy = Math.round(best[2] - r);
  if (oy < 0 || ox < 0 || ox + side > SW) throw new Error("crop runs off the image");
  console.log('mark: drawing rows', y0 + '-' + y1, 'circle r', r, 'crop', ox, oy, side);

  // premultiplied planes, cropped (transparent outside the source), then shrunk
  const planes = [0, 1, 2, 3].map(() => new Float32Array(side * side));
  for (let y = 0; y < side; y++)
    for (let x = 0; x < side; x++) {
      const X = ox + x, Y = oy + y;
      if (X < 0 || Y < 0 || X >= SW || Y > y1) continue; // Y > y1 is the wordmark
      const i = (Y * SW + X) * 4, a = SD[i + 3] / 255, j = y * side + x;
      planes[0][j] = SD[i] * a; planes[1][j] = SD[i + 1] * a; planes[2][j] = SD[i + 2] * a; planes[3][j] = a;
    }
  const OUT = 720; // ~3x the largest size the home page shows it at
  const [pr, pg, pb, pa] = shrink(planes, side, side, OUT, OUT);
  const out = new Uint8Array(OUT * OUT * 4);
  for (let i = 0; i < OUT * OUT; i++) {
    const a = pa[i];
    out[i * 4] = a ? Math.round(Math.min(255, pr[i] / a)) : 0;
    out[i * 4 + 1] = a ? Math.round(Math.min(255, pg[i] / a)) : 0;
    out[i * 4 + 2] = a ? Math.round(Math.min(255, pb[i] / a)) : 0;
    out[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  fs.writeFileSync(path.join(ROOT, 'images/logo-mark.png'), encodePNG(OUT, OUT, out));
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

for (const f of ['images/icons/favicon-16.png', 'images/icons/favicon-32.png', 'images/icons/apple-touch-icon.png', 'src/standalone/favicon.ico', 'images/og-symptoms.png', 'images/logo-mark.png'])
  console.log(f.padEnd(36), fs.statSync(path.join(ROOT, f)).size + ' B');
