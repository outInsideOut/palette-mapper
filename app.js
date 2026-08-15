/* ============================================================================
   PALETTE MAPPER
   ----------------------------------------------------------------------------
   Paste an image, build a palette, snap every pixel to its nearest palette
   entry, export the result. Everything runs client-side.

   Deliberately a single classic script rather than ES modules: `type="module"`
   is blocked by CORS when the page is opened from file://, and this tool is
   meant to work both hosted (GitHub Pages) and straight off disk. Same reason
   there is no Web Worker — worker scripts are cross-origin on file:// too, so
   the heavy loops are chunked on the main thread instead (see `processBuffer`).
   ========================================================================== */
(function () {
'use strict';

/* ---------------------------------------------------------------------------
   0. CONSTANTS AND STATE
   ------------------------------------------------------------------------ */

var PREVIEW_MAX = 1200;    // long edge of the live-preview working buffer
var ORIGINAL_MAX = 1600;   // long edge of the "before" canvas — display only
var MAX_COLORS = 256;      // matcher LUT stores palette indices in an Int16Array
var EXTRACT_SAMPLES = 20000;
var YIELD_MS = 14;         // work slice between event-loop yields
var ALPHA_CUTOFF = 8;      // default alpha cut; user-adjustable at runtime

var LS_PALETTES = 'pm.palettes.v1';
var LS_SETTINGS = 'pm.settings.v1';
var LS_CURRENT  = 'pm.current.v1';

var state = {
  img: null,             // HTMLImageElement of the source
  name: 'image',         // source filename stem, used for export naming
  srcCanvas: null,       // full-resolution source, for eyedropper sampling
  srcCtx: null,
  srcW: 0,
  srcH: 0,
  palette: { name: '', colors: [] },
  activeId: null,        // id of the saved palette this was loaded from
  selected: -1,          // index of the swatch open in the editor
  library: [],
  view: 'split',         // split | before | after
  split: 50,             // percent
  zoom: 'fit',           // 'fit' or a number
  dispW: 0,
  dispH: 0,
  eyedropper: false,
  renderToken: 0,
  lastWork: null,        // { w, h } of the most recent processed buffer
  busy: false
};

var els = {};

/* ---------------------------------------------------------------------------
   1. PRESETS
   ---------------------------------------------------------------------------
   Only palettes whose exact values are unambiguous ship here. Anything else
   (Lospec sets, studio palettes) comes in through the import box, which will
   scrape hex codes out of arbitrary pasted text.
   ------------------------------------------------------------------------ */

function grayscale(n) {
  var out = [], i, v;
  for (i = 0; i < n; i++) {
    v = Math.round(i * 255 / (n - 1));
    out.push(rgbToHex(v, v, v));
  }
  return out;
}

function webSafe() {
  var steps = [0, 51, 102, 153, 204, 255], out = [], r, g, b;
  for (r = 0; r < 6; r++) for (g = 0; g < 6; g++) for (b = 0; b < 6; b++) {
    out.push(rgbToHex(steps[r], steps[g], steps[b]));
  }
  return out;
}

var PRESETS = [
  { name: 'Game Boy (DMG)', colors: ['#0f380f', '#306230', '#8bac0f', '#9bbc0f'] },
  { name: '1-bit Mono', colors: ['#000000', '#ffffff'] },
  { name: 'PICO-8', colors: [
    '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
    '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'] },
  { name: 'Sweetie 16', colors: [
    '#1a1c2c', '#5d275d', '#b13e53', '#ef7d57', '#ffcd75', '#a7f070', '#38b764', '#257179',
    '#29366f', '#3b5dc9', '#41a6f6', '#73eff7', '#f4f4f4', '#94b0c2', '#566c86', '#333c57'] },
  { name: 'CGA 16', colors: [
    '#000000', '#0000aa', '#00aa00', '#00aaaa', '#aa0000', '#aa00aa', '#aa5500', '#aaaaaa',
    '#555555', '#5555ff', '#55ff55', '#55ffff', '#ff5555', '#ff55ff', '#ffff55', '#ffffff'] },
  { name: 'Solarized', colors: [
    '#002b36', '#073642', '#586e75', '#657b83', '#839496', '#93a1a1', '#eee8d5', '#fdf6e3',
    '#b58900', '#cb4b16', '#dc322f', '#d33682', '#6c71c4', '#268bd2', '#2aa198', '#859900'] },
  { name: 'Grayscale 4', colors: grayscale(4) },
  { name: 'Grayscale 8', colors: grayscale(8) },
  { name: 'Grayscale 16', colors: grayscale(16) },
  { name: 'Web Safe 216', colors: webSafe() }
];

/* ---------------------------------------------------------------------------
   2. COLOUR MATH
   ------------------------------------------------------------------------ */

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function clamp255(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

function hex2(n) { var s = n.toString(16); return s.length < 2 ? '0' + s : s; }
function rgbToHex(r, g, b) {
  return '#' + hex2(clamp255(Math.round(r))) + hex2(clamp255(Math.round(g))) + hex2(clamp255(Math.round(b)));
}

function hexToRgb(hex) {
  var h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
  var n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function normalizeHex(hex) {
  var rgb = hexToRgb(hex);
  return rgb ? rgbToHex(rgb[0], rgb[1], rgb[2]) : null;
}

/* sRGB <-> linear. The 256-entry table covers the integer path; the float
   path (dithered values land between levels) falls through to Math.pow, and
   is only ever hit on a matcher cache miss. */
var SRGB_LIN = (function () {
  var t = new Float64Array(256), i, c;
  for (i = 0; i < 256; i++) {
    c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

function srgbToLinear(v) {
  if (v >= 0 && v <= 255 && (v | 0) === v) return SRGB_LIN[v];
  var c = clamp(v, 0, 255) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c) {
  var v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(Math.max(c, 0), 1 / 2.4) - 0.055;
  return clamp255(v * 255);
}

/* Björn Ottosson's OKLab. Perceptually near-uniform, so plain euclidean
   distance in it is a good stand-in for "looks closest". */
function rgbToOklab(r, g, b, out) {
  var R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  var l = 0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B;
  var m = 0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B;
  var s = 0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B;
  var l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  out[0] = 0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_;
  out[1] = 1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_;
  out[2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_;
  return out;
}

function oklabToRgb(L, A, B_, out) {
  var l_ = L + 0.3963377774 * A + 0.2158037573 * B_;
  var m_ = L - 0.1055613458 * A - 0.0638541728 * B_;
  var s_ = L - 0.0894841775 * A - 1.2914855480 * B_;
  var l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  out[0] = linearToSrgb( 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s);
  out[1] = linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s);
  out[2] = linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
  return out;
}

function oklabLightness(hex) {
  var rgb = hexToRgb(hex), lab = [0, 0, 0];
  if (!rgb) return 0;
  rgbToOklab(rgb[0], rgb[1], rgb[2], lab);
  return lab[0];
}

/* ---------------------------------------------------------------------------
   3. THE MATCHER
   ---------------------------------------------------------------------------
   Built once per (palette, metric) pair and reused for every pixel.

   The lookup table is keyed on 7 bits per channel (2^21 entries). That drops
   the low bit of each input channel before matching, which is well below any
   visible threshold and turns a per-pixel search into an array read — the
   difference between "instant" and "a spinner" on a 3MP image. The guarantee
   that every output pixel is exactly a palette colour is unaffected; only the
   tie-breaking at a decision boundary is approximate.

   One 8MB table is allocated for the life of the page and shared by every
   matcher. Entries are stamped with a generation counter rather than cleared,
   because a render that is still in flight when the palette changes would
   otherwise start reading another matcher's answers out of a table that had
   been refilled underneath it. A stale generation simply misses and recomputes.
   ------------------------------------------------------------------------ */

var LUT_BITS = 7;
var LUT_SIZE = 1 << (LUT_BITS * 3);
var LUT_STRIDE = 512;             // > MAX_COLORS, so index and generation pack cleanly
var lutBuffer = null;
var lutGen = 0;

function buildMatcher(colors, metric) {
  var n = Math.min(colors.length, MAX_COLORS);
  var pr = new Float32Array(n), pg = new Float32Array(n), pb = new Float32Array(n);
  var k0 = new Float32Array(n), k1 = new Float32Array(n), k2 = new Float32Array(n);
  var lab = [0, 0, 0], i, j, rgb;

  for (i = 0; i < n; i++) {
    rgb = hexToRgb(colors[i]) || [0, 0, 0];
    pr[i] = rgb[0]; pg[i] = rgb[1]; pb[i] = rgb[2];
    if (metric === 'oklab') {
      rgbToOklab(rgb[0], rgb[1], rgb[2], lab);
      k0[i] = lab[0]; k1[i] = lab[1]; k2[i] = lab[2];
    } else {
      k0[i] = rgb[0]; k1[i] = rgb[1]; k2[i] = rgb[2];
    }
  }

  if (!lutBuffer) lutBuffer = new Int32Array(LUT_SIZE);
  lutGen++;
  if (lutGen * LUT_STRIDE > 2000000000) { lutBuffer.fill(0); lutGen = 1; }
  var lut = lutBuffer;
  var genBase = lutGen * LUT_STRIDE;

  var scratch = [0, 0, 0];

  function searchOklab(r, g, b) {
    rgbToOklab(r, g, b, scratch);
    var best = 0, bd = Infinity, d, d0, d1, d2;
    for (var i2 = 0; i2 < n; i2++) {
      d0 = scratch[0] - k0[i2]; d1 = scratch[1] - k1[i2]; d2 = scratch[2] - k2[i2];
      d = d0 * d0 + d1 * d1 + d2 * d2;
      if (d < bd) { bd = d; best = i2; }
    }
    return best;
  }

  function searchSrgb(r, g, b) {
    var best = 0, bd = Infinity, d, d0, d1, d2;
    for (var i2 = 0; i2 < n; i2++) {
      d0 = r - k0[i2]; d1 = g - k1[i2]; d2 = b - k2[i2];
      d = d0 * d0 + d1 * d1 + d2 * d2;
      if (d < bd) { bd = d; best = i2; }
    }
    return best;
  }

  /* Thiadmer Riemersma's "redmean" — a cheap low-cost approximation of
     perceptual distance that weights channels by where in the red axis the
     comparison sits. */
  function searchRedmean(r, g, b) {
    var best = 0, bd = Infinity, d, rm, dr, dg, db;
    for (var i2 = 0; i2 < n; i2++) {
      rm = (r + k0[i2]) * 0.5;
      dr = r - k0[i2]; dg = g - k1[i2]; db = b - k2[i2];
      d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
      if (d < bd) { bd = d; best = i2; }
    }
    return best;
  }

  var search = metric === 'oklab' ? searchOklab
             : metric === 'redmean' ? searchRedmean
             : searchSrgb;

  function nearest(r, g, b) {
    var ri = r < 0 ? 0 : (r > 255 ? 255 : r | 0);
    var gi = g < 0 ? 0 : (g > 255 ? 255 : g | 0);
    var bi = b < 0 ? 0 : (b > 255 ? 255 : b | 0);
    var key = ((ri >> 1) << 14) | ((gi >> 1) << 7) | (bi >> 1);
    var hit = lut[key] - genBase;
    if (hit >= 0 && hit < LUT_STRIDE) return hit;
    var idx = search(ri, gi, bi);
    lut[key] = genBase + idx;
    return idx;
  }

  /* Mean nearest-neighbour spacing, in sRGB units. Ordered dithering needs a
     threshold amplitude, and the right one depends on how far apart the
     palette entries actually are — a 4-colour palette needs a much wider
     spread than a 216-colour one. Deriving it here means the strength slider
     behaves the same way whatever palette is loaded. */
  var meanNN = 0;
  if (n > 1) {
    var total = 0;
    for (i = 0; i < n; i++) {
      var mind = Infinity;
      for (j = 0; j < n; j++) {
        if (i === j) continue;
        var a0 = pr[i] - pr[j], a1 = pg[i] - pg[j], a2 = pb[i] - pb[j];
        var dd = a0 * a0 + a1 * a1 + a2 * a2;
        if (dd < mind) mind = dd;
      }
      total += Math.sqrt(mind);
    }
    meanNN = total / n;
  }

  return { n: n, pr: pr, pg: pg, pb: pb, nearest: nearest, meanNN: meanNN };
}

/* ---------------------------------------------------------------------------
   4. PALETTE EXTRACTION — median cut, then k-means refinement in OKLab
   ------------------------------------------------------------------------ */

function samplePixels(imageData, maxSamples) {
  var d = imageData.data;
  var total = imageData.width * imageData.height;
  var stride = Math.max(1, Math.floor(total / maxSamples));
  var out = [], i, o;
  for (i = 0; i < total; i += stride) {
    o = i * 4;
    if (d[o + 3] < ALPHA_CUTOFF) continue;
    out.push([d[o], d[o + 1], d[o + 2]]);
  }
  return out;
}

function medianCut(samples, count) {
  if (!samples.length) return [];
  var boxes = [samples];

  function boxRange(box) {
    var lo = [255, 255, 255], hi = [0, 0, 0], i, c, ch;
    for (i = 0; i < box.length; i++) {
      c = box[i];
      for (ch = 0; ch < 3; ch++) {
        if (c[ch] < lo[ch]) lo[ch] = c[ch];
        if (c[ch] > hi[ch]) hi[ch] = c[ch];
      }
    }
    var axis = 0, span = hi[0] - lo[0];
    if (hi[1] - lo[1] > span) { axis = 1; span = hi[1] - lo[1]; }
    if (hi[2] - lo[2] > span) { axis = 2; span = hi[2] - lo[2]; }
    return { axis: axis, span: span };
  }

  while (boxes.length < count) {
    var target = -1, bestSpan = -1, i;
    for (i = 0; i < boxes.length; i++) {
      if (boxes[i].length < 2) continue;
      var r = boxRange(boxes[i]);
      if (r.span > bestSpan) { bestSpan = r.span; target = i; }
    }
    if (target < 0 || bestSpan <= 0) break;

    var box = boxes[target];
    var axis = boxRange(box).axis;
    box.sort(function (a, b) { return a[axis] - b[axis]; });
    var mid = box.length >> 1;
    boxes.splice(target, 1, box.slice(0, mid), box.slice(mid));
  }

  return boxes.filter(function (b) { return b.length; }).map(function (box) {
    var r = 0, g = 0, b = 0, i;
    for (i = 0; i < box.length; i++) { r += box[i][0]; g += box[i][1]; b += box[i][2]; }
    return [r / box.length, g / box.length, b / box.length];
  });
}

function extractPalette(imageData, count) {
  var samples = samplePixels(imageData, EXTRACT_SAMPLES);
  if (!samples.length) return [];

  var centers = medianCut(samples, count);
  if (!centers.length) return [];

  /* Refine in OKLab so the clusters split where the eye sees difference,
     rather than where the RGB cube happens to be wide. */
  var n = centers.length, i, k, iter;
  var sLab = new Float32Array(samples.length * 3);
  var lab = [0, 0, 0];
  for (i = 0; i < samples.length; i++) {
    rgbToOklab(samples[i][0], samples[i][1], samples[i][2], lab);
    sLab[i * 3] = lab[0]; sLab[i * 3 + 1] = lab[1]; sLab[i * 3 + 2] = lab[2];
  }
  var cLab = new Float32Array(n * 3);
  for (k = 0; k < n; k++) {
    rgbToOklab(centers[k][0], centers[k][1], centers[k][2], lab);
    cLab[k * 3] = lab[0]; cLab[k * 3 + 1] = lab[1]; cLab[k * 3 + 2] = lab[2];
  }

  var sums = new Float64Array(n * 3), counts = new Uint32Array(n);
  for (iter = 0; iter < 8; iter++) {
    sums.fill(0); counts.fill(0);
    for (i = 0; i < samples.length; i++) {
      var l0 = sLab[i * 3], l1 = sLab[i * 3 + 1], l2 = sLab[i * 3 + 2];
      var best = 0, bd = Infinity;
      for (k = 0; k < n; k++) {
        var d0 = l0 - cLab[k * 3], d1 = l1 - cLab[k * 3 + 1], d2 = l2 - cLab[k * 3 + 2];
        var d = d0 * d0 + d1 * d1 + d2 * d2;
        if (d < bd) { bd = d; best = k; }
      }
      sums[best * 3] += l0; sums[best * 3 + 1] += l1; sums[best * 3 + 2] += l2;
      counts[best]++;
    }
    for (k = 0; k < n; k++) {
      if (!counts[k]) continue;   // keep an empty cluster where it is
      cLab[k * 3] = sums[k * 3] / counts[k];
      cLab[k * 3 + 1] = sums[k * 3 + 1] / counts[k];
      cLab[k * 3 + 2] = sums[k * 3 + 2] / counts[k];
    }
  }

  var rgb = [0, 0, 0], out = [], seen = {};
  var order = [];
  for (k = 0; k < n; k++) order.push(k);
  order.sort(function (a, b) { return cLab[a * 3] - cLab[b * 3]; });
  for (i = 0; i < order.length; i++) {
    oklabToRgb(cLab[order[i] * 3], cLab[order[i] * 3 + 1], cLab[order[i] * 3 + 2], rgb);
    var hex = rgbToHex(rgb[0], rgb[1], rgb[2]);
    if (seen[hex]) continue;      // collapsed clusters can land on the same colour
    seen[hex] = true;
    out.push(hex);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   5. PALETTE FILE FORMATS
   ------------------------------------------------------------------------ */

function parsePaletteText(text, filename) {
  var name = (filename || '').replace(/\.[^.]+$/, '') || '';
  // Strip a UTF-8 BOM — .gpl and .pal files exported from Windows tools have one.
  var trimmed = String(text).replace(/^\uFEFF/, '').trim();
  var colors = [];
  var lines, i, m;

  if (/^GIMP Palette/i.test(trimmed)) {
    lines = trimmed.split(/\r?\n/);
    for (i = 0; i < lines.length; i++) {
      if (/^Name:/i.test(lines[i])) name = lines[i].replace(/^Name:\s*/i, '').trim() || name;
      if (/^[#\s]*$/.test(lines[i]) || /^(Columns|Name):/i.test(lines[i])) continue;
      m = lines[i].match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
      if (m) colors.push(rgbToHex(+m[1], +m[2], +m[3]));
    }
  } else if (/^JASC-PAL/i.test(trimmed)) {
    lines = trimmed.split(/\r?\n/).slice(3);
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(/^\s*(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
      if (m) colors.push(rgbToHex(+m[1], +m[2], +m[3]));
    }
  } else if (/^[[{]/.test(trimmed)) {
    try {
      var json = JSON.parse(trimmed);
      var arr = Array.isArray(json) ? json : (json.colors || json.palette || []);
      if (json && json.name) name = json.name;
      for (i = 0; i < arr.length; i++) {
        var v = arr[i];
        if (typeof v === 'string') { var h = normalizeHex(v); if (h) colors.push(h); }
        else if (Array.isArray(v) && v.length >= 3) colors.push(rgbToHex(v[0], v[1], v[2]));
        else if (v && typeof v === 'object' && 'r' in v) colors.push(rgbToHex(v.r, v.g, v.b));
      }
    } catch (e) { /* fall through to the scrape below */ }
  }

  /* Default path: pull hex codes out of whatever this is. Handles Lospec
     dumps, CSS, a column of codes, a paragraph with codes in it. */
  if (!colors.length) {
    var hexes = trimmed.match(/#?\b[0-9a-fA-F]{6}\b/g) || [];
    for (i = 0; i < hexes.length; i++) {
      var hh = normalizeHex(hexes[i]);
      if (hh) colors.push(hh);
    }
  }

  /* Last resort: whitespace-separated "R G B" triplet lines. */
  if (!colors.length) {
    lines = trimmed.split(/\r?\n/);
    for (i = 0; i < lines.length; i++) {
      m = lines[i].match(/^\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})\s*$/);
      if (m) colors.push(rgbToHex(+m[1], +m[2], +m[3]));
    }
  }

  return { name: name, colors: dedupe(colors).slice(0, MAX_COLORS) };
}

/* Adobe colour table: 256 flat RGB triples, optionally with a trailing count. */
function parseActBuffer(buf, filename) {
  var b = new Uint8Array(buf), colors = [], i;
  var count = 256;
  if (b.length >= 772) {
    var declared = (b[768] << 8) | b[769];
    if (declared > 0 && declared <= 256) count = declared;
  }
  for (i = 0; i < count && i * 3 + 2 < b.length; i++) {
    colors.push(rgbToHex(b[i * 3], b[i * 3 + 1], b[i * 3 + 2]));
  }
  return { name: (filename || '').replace(/\.[^.]+$/, ''), colors: dedupe(colors) };
}

function dedupe(colors) {
  var seen = {}, out = [], i;
  for (i = 0; i < colors.length; i++) {
    if (!colors[i] || seen[colors[i]]) continue;
    seen[colors[i]] = true;
    out.push(colors[i]);
  }
  return out;
}

function serializeHex(pal) {
  return pal.colors.map(function (c) { return c.replace('#', '').toUpperCase(); }).join('\n') + '\n';
}

function serializeGpl(pal) {
  var lines = ['GIMP Palette', 'Name: ' + (pal.name || 'Untitled'), 'Columns: 0', '#'];
  pal.colors.forEach(function (c) {
    var rgb = hexToRgb(c);
    if (!rgb) return;
    lines.push(pad3(rgb[0]) + ' ' + pad3(rgb[1]) + ' ' + pad3(rgb[2]) + '\t' + c.toUpperCase());
  });
  return lines.join('\n') + '\n';
}

function pad3(n) { return String(n).padStart(3, ' '); }

/* ---------------------------------------------------------------------------
   6. THE PROCESSING PIPELINE
   ---------------------------------------------------------------------------
   Order is fixed and matters:
     source -> pixelate/resize -> tone adjustments -> map (+dither) -> upscale
   ------------------------------------------------------------------------ */

var BAYER4 = [
   0,  8,  2, 10,
  12,  4, 14,  6,
   3, 11,  1,  9,
  15,  7, 13,  5];

var BAYER8 = [
   0, 32,  8, 40,  2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44,  4, 36, 14, 46,  6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
   3, 35, 11, 43,  1, 33,  9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47,  7, 39, 13, 45,  5, 37,
  63, 31, 55, 23, 61, 29, 53, 21];

function readOptions() {
  return {
    metric: els.metric.value,
    dither: els.dither.value,
    ditherAmt: +els.ditherAmt.value / 100,
    pixel: +els.pixel.value,
    smooth: els.smooth.checked,
    brightness: +els.brightness.value,
    contrast: +els.contrast.value,
    saturation: +els.saturation.value,
    gamma: +els.gamma.value / 100,
    alphaCut: +els.alphaCut.value,
    exportScale: +els.exportScale.value,
    exportFull: els.exportFull.checked,
    live: els.live.checked
  };
}

/* Working dimensions. Pixel size is always defined against the ORIGINAL image,
   so the preview shows the same block structure the export will have; the
   preview cap then scales that down further only for on-screen speed. */
function workDims(opts, full) {
  var w = Math.max(1, Math.round(state.srcW / opts.pixel));
  var h = Math.max(1, Math.round(state.srcH / opts.pixel));
  if (!full) {
    var longEdge = Math.max(w, h);
    if (longEdge > PREVIEW_MAX) {
      var k = PREVIEW_MAX / longEdge;
      w = Math.max(1, Math.round(w * k));
      h = Math.max(1, Math.round(h * k));
    }
  }
  return { w: w, h: h };
}

var workCanvas = null, workCtx = null;

function drawWork(dims, smooth) {
  if (!workCanvas) {
    workCanvas = document.createElement('canvas');
    workCtx = workCanvas.getContext('2d', { willReadFrequently: true });
  }
  workCanvas.width = dims.w;
  workCanvas.height = dims.h;
  workCtx.imageSmoothingEnabled = !!smooth;
  workCtx.imageSmoothingQuality = 'high';
  workCtx.clearRect(0, 0, dims.w, dims.h);
  workCtx.drawImage(state.srcCanvas, 0, 0, state.srcW, state.srcH, 0, 0, dims.w, dims.h);
  return workCtx.getImageData(0, 0, dims.w, dims.h);
}

/* Brightness/contrast/gamma act identically on all three channels, so they
   collapse into one 256-entry table. Saturation needs the whole triple and is
   applied afterwards. */
function buildToneLut(opts) {
  var lut = new Float32Array(256), i, v;
  var bright = opts.brightness * 1.275;                     // ±127.5
  var c = opts.contrast * 2.55;
  var cf = (259 * (c + 255)) / (255 * (259 - c));           // standard contrast factor
  var invGamma = 1 / opts.gamma;
  for (i = 0; i < 256; i++) {
    v = 255 * Math.pow(i / 255, invGamma);
    v = v + bright;
    v = cf * (v - 128) + 128;
    lut[i] = v;                                             // deliberately unclamped
  }
  return lut;
}

function hasAdjustments(opts) {
  return opts.brightness !== 0 || opts.contrast !== 0 ||
         opts.saturation !== 0 || Math.abs(opts.gamma - 1) > 0.001;
}

function nextTick() { return new Promise(function (r) { setTimeout(r, 0); }); }

/* Maps `imageData` in place against `matcher`. Returns the same ImageData, or
   null if a newer render superseded this one mid-flight. */
async function processBuffer(imageData, matcher, opts, token, onProgress) {
  var w = imageData.width, h = imageData.height, d = imageData.data;
  var pr = matcher.pr, pg = matcher.pg, pb = matcher.pb, nearest = matcher.nearest;

  var adjust = hasAdjustments(opts);
  var tone = adjust ? buildToneLut(opts) : null;
  var satAmt = 1 + opts.saturation / 100;

  var mode = opts.dither;
  var amt = opts.ditherAmt;
  if (amt <= 0) mode = 'none';

  var bayer = mode === 'bayer4' ? BAYER4 : (mode === 'bayer8' ? BAYER8 : null);
  var bSize = mode === 'bayer4' ? 4 : 8;
  var bLevels = bSize * bSize;
  /* 0.6 is empirical: enough spread to break banding, not so much that flat
     areas visibly buzz at full strength. */
  var spread = (matcher.meanNN || 32) * amt * 0.6;

  // Two-row error buffers for Floyd–Steinberg, padded by one pixel each side.
  var errCur = null, errNext = null;
  if (mode === 'fs') {
    errCur = new Float32Array((w + 2) * 3);
    errNext = new Float32Array((w + 2) * 3);
  }

  /* Alpha is forced to fully on or fully off, and that is not just a stylistic
     choice. A partially transparent pixel is composited against whatever is
     behind it, so its visible colour is a blend and not a palette entry at
     all — and worse, canvas stores partial alpha premultiplied, so writing an
     exact palette colour into a half-transparent pixel and reading it back
     returns a slightly different value. Hard alpha keeps the output honest:
     every visible pixel is exactly one of the palette colours. */
  var alphaCut = opts.alphaCut == null ? ALPHA_CUTOFF : opts.alphaCut;

  var t0 = performance.now();
  var y, x, i, o, r, g, b, lum, idx, tmp;

  for (y = 0; y < h; y++) {
    var serpentine = mode === 'fs' && (y & 1) === 1;
    for (i = 0; i < w; i++) {
      x = serpentine ? (w - 1 - i) : i;
      o = (y * w + x) * 4;

      if (d[o + 3] < alphaCut) {
        d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
        continue;
      }
      d[o + 3] = 255;

      r = d[o]; g = d[o + 1]; b = d[o + 2];

      if (adjust) {
        r = tone[r]; g = tone[g]; b = tone[b];
        if (opts.saturation !== 0) {
          lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          r = lum + (r - lum) * satAmt;
          g = lum + (g - lum) * satAmt;
          b = lum + (b - lum) * satAmt;
        }
      }

      if (mode === 'fs') {
        var e = (x + 1) * 3;
        r += errCur[e]; g += errCur[e + 1]; b += errCur[e + 2];
      } else if (bayer) {
        var t = (bayer[(y % bSize) * bSize + (x % bSize)] / bLevels - 0.5) * spread;
        r += t; g += t; b += t;
      }

      idx = nearest(r, g, b);
      var nr = pr[idx], ng = pg[idx], nb = pb[idx];

      if (mode === 'fs') {
        var er = (r - nr) * amt, eg = (g - ng) * amt, eb = (b - nb) * amt;
        var dir = serpentine ? -1 : 1;
        var ahead = (x + dir + 1) * 3;
        var below = (x + 1) * 3;
        var behindBelow = (x - dir + 1) * 3;
        var aheadBelow = (x + dir + 1) * 3;

        errCur[ahead]     += er * 0.4375;
        errCur[ahead + 1] += eg * 0.4375;
        errCur[ahead + 2] += eb * 0.4375;

        errNext[behindBelow]     += er * 0.1875;
        errNext[behindBelow + 1] += eg * 0.1875;
        errNext[behindBelow + 2] += eb * 0.1875;

        errNext[below]     += er * 0.3125;
        errNext[below + 1] += eg * 0.3125;
        errNext[below + 2] += eb * 0.3125;

        errNext[aheadBelow]     += er * 0.0625;
        errNext[aheadBelow + 1] += eg * 0.0625;
        errNext[aheadBelow + 2] += eb * 0.0625;
      }

      d[o] = nr; d[o + 1] = ng; d[o + 2] = nb;
    }

    if (mode === 'fs') {
      tmp = errCur; errCur = errNext; errNext = tmp;
      errNext.fill(0);
    }

    if (performance.now() - t0 > YIELD_MS) {
      if (token !== state.renderToken) return null;
      if (onProgress) onProgress((y + 1) / h);
      await nextTick();
      t0 = performance.now();
    }
  }

  if (onProgress) onProgress(1);
  return token === state.renderToken ? imageData : null;
}

/* ---------------------------------------------------------------------------
   7. RENDERING TO SCREEN
   ------------------------------------------------------------------------ */

var renderTimer = null;

function scheduleRender(delay) {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(function () {
    renderTimer = null;
    renderPreview();
  }, delay == null ? 70 : delay);
}

async function renderPreview() {
  if (!state.img) return;
  var opts = readOptions();
  if (!opts.live) { setStatus('Live preview off — press Render full'); return; }
  if (!state.palette.colors.length) {
    setStatus('Palette is empty — add or extract some colours');
    return;
  }

  var token = ++state.renderToken;
  var dims = workDims(opts, false);
  var matcher = buildMatcher(state.palette.colors, opts.metric);

  setBusy(true);
  var started = performance.now();
  var imageData = drawWork(dims, opts.smooth);
  var out = await processBuffer(imageData, matcher, opts, token, setProgress);
  if (!out) { return; }   // superseded — a newer render owns the canvas now

  els.canvasResult.width = dims.w;
  els.canvasResult.height = dims.h;
  els.canvasResult.getContext('2d').putImageData(out, 0, 0);

  state.lastWork = dims;
  setBusy(false);
  setProgress(0);
  els.time.textContent = Math.round(performance.now() - started) + ' ms';
  setStatus('Mapped ' + dims.w + '×' + dims.h + ' to ' + matcher.n + ' colours');
  updateFooter();
  layoutCanvases();
}

/* Full-resolution render, used by export and the "Render full" button. */
async function renderFull(opts) {
  var token = ++state.renderToken;
  var dims = workDims(opts, true);
  var matcher = buildMatcher(state.palette.colors, opts.metric);
  setBusy(true);
  setStatus('Rendering ' + dims.w + '×' + dims.h + '…');
  var imageData = drawWork(dims, opts.smooth);
  var out = await processBuffer(imageData, matcher, opts, token, setProgress);
  setBusy(false);
  setProgress(0);
  if (!out) return null;

  var c = document.createElement('canvas');
  c.width = dims.w;
  c.height = dims.h;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

/* Nearest-neighbour upscale for export. Smoothing must be off or the whole
   point of quantizing is lost on the way out. */
function upscale(canvas, factor) {
  if (factor <= 1) return canvas;
  var c = document.createElement('canvas');
  c.width = canvas.width * factor;
  c.height = canvas.height * factor;
  var ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return c;
}

function layoutCanvases() {
  if (!state.img) return;
  var vp = els.viewport.getBoundingClientRect();
  var pad = 32;
  var scale;
  if (state.zoom === 'fit') {
    scale = Math.min((vp.width - pad) / state.srcW, (vp.height - pad) / state.srcH, 1);
    if (!isFinite(scale) || scale <= 0) scale = 1;
  } else {
    scale = state.zoom;
  }
  state.dispW = Math.max(1, Math.round(state.srcW * scale));
  state.dispH = Math.max(1, Math.round(state.srcH * scale));

  els.stack.style.width = state.dispW + 'px';
  els.stack.style.height = state.dispH + 'px';
  els.canvasOriginal.style.width = state.dispW + 'px';
  els.canvasOriginal.style.height = state.dispH + 'px';
  els.canvasResult.style.width = state.dispW + 'px';
  els.canvasResult.style.height = state.dispH + 'px';

  els.zoomVal.textContent = state.zoom === 'fit'
    ? 'FIT ' + Math.round(scale * 100) + '%'
    : Math.round(scale * 100) + '%';

  applyView();
}

function applyView() {
  var pct = state.split;
  if (state.view === 'before') {
    els.canvasResult.style.clipPath = 'inset(0 0 0 100%)';
    els.splitHandle.hidden = true;
  } else if (state.view === 'after') {
    els.canvasResult.style.clipPath = 'inset(0 0 0 0)';
    els.splitHandle.hidden = true;
  } else {
    els.canvasResult.style.clipPath = 'inset(0 0 0 ' + pct + '%)';
    els.splitHandle.hidden = false;
    els.splitHandle.style.left = pct + '%';
    els.splitHandle.setAttribute('aria-valuenow', String(Math.round(pct)));
  }
  els.tagA.style.display = state.view === 'after' ? 'none' : '';
  els.tagB.style.display = state.view === 'before' ? 'none' : '';

  press(els.viewSplit, state.view === 'split');
  press(els.viewBefore, state.view === 'before');
  press(els.viewAfter, state.view === 'after');
}

/* ---------------------------------------------------------------------------
   8. IMAGE INPUT
   ------------------------------------------------------------------------ */

function loadImageFromBlob(blob, name) {
  if (!blob || !/^image\//.test(blob.type || '')) {
    toast('That does not look like an image file.', true);
    return;
  }
  var reader = new FileReader();
  reader.onerror = function () { toast('Could not read that file.', true); };
  /* A data: URL specifically — a blob: URL created under a file:// origin
     taints the canvas in some browsers, and getImageData then throws. */
  reader.onload = function () { loadImageFromUrl(reader.result, name); };
  reader.readAsDataURL(blob);
}

function loadImageFromUrl(url, name) {
  var img = new Image();
  img.onerror = function () { toast('Could not decode that image.', true); };
  img.onload = function () {
    state.img = img;
    state.name = (name || 'image').replace(/\.[^.]+$/, '') || 'image';
    state.srcW = img.naturalWidth;
    state.srcH = img.naturalHeight;

    state.srcCanvas = document.createElement('canvas');
    state.srcCanvas.width = state.srcW;
    state.srcCanvas.height = state.srcH;
    state.srcCtx = state.srcCanvas.getContext('2d', { willReadFrequently: true });
    state.srcCtx.drawImage(img, 0, 0);

    // "Before" canvas — display only, so cap it.
    var k = Math.min(1, ORIGINAL_MAX / Math.max(state.srcW, state.srcH));
    els.canvasOriginal.width = Math.max(1, Math.round(state.srcW * k));
    els.canvasOriginal.height = Math.max(1, Math.round(state.srcH * k));
    els.canvasOriginal.getContext('2d').drawImage(
      img, 0, 0, els.canvasOriginal.width, els.canvasOriginal.height);

    els.drop.hidden = true;
    els.stack.hidden = false;
    els.dims.textContent = state.srcW + ' × ' + state.srcH;
    state.zoom = 'fit';

    layoutCanvases();
    updateFooter();

    if (!state.palette.colors.length) {
      // Nothing to map against yet — give them a starting point from the image.
      doExtract(false);
    } else {
      scheduleRender(0);
    }
    setStatus('Loaded ' + state.srcW + '×' + state.srcH);
  };
  img.src = url;
}

/* ---------------------------------------------------------------------------
   9. PALETTE UI
   ------------------------------------------------------------------------ */

function renderSwatches() {
  var frag = document.createDocumentFragment();
  state.palette.colors.forEach(function (hex, i) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pm-swatch';
    b.style.background = hex;
    b.title = hex.toUpperCase() + ' — click to edit, drag to reorder';
    b.setAttribute('role', 'listitem');
    b.setAttribute('aria-label', 'Swatch ' + (i + 1) + ': ' + hex);
    b.setAttribute('aria-pressed', state.selected === i ? 'true' : 'false');
    b.dataset.index = String(i);
    b.draggable = true;
    frag.appendChild(b);
  });

  var add = document.createElement('button');
  add.type = 'button';
  add.className = 'pm-swatch pm-swatch--add';
  add.textContent = '+';
  add.title = 'Add a swatch';
  add.id = 'pm-swatch-add';
  frag.appendChild(add);

  els.swatches.innerHTML = '';
  els.swatches.appendChild(frag);

  els.swatchCount.textContent = state.palette.colors.length + ' colour' +
    (state.palette.colors.length === 1 ? '' : 's');

  var open = state.selected >= 0 && state.selected < state.palette.colors.length;
  els.editor.dataset.open = open ? 'true' : 'false';
  if (open) {
    els.editorColor.value = state.palette.colors[state.selected];
    els.editorHex.value = state.palette.colors[state.selected].toUpperCase();
  }
  updateFooter();
}

function renderLibrary() {
  els.lib.innerHTML = '';
  if (!state.library.length) {
    var empty = document.createElement('div');
    empty.className = 'cc-label';
    empty.style.padding = 'var(--cc-space-2)';
    empty.textContent = 'No saved palettes yet';
    els.lib.appendChild(empty);
  }
  state.library.forEach(function (pal) {
    var row = document.createElement('div');
    row.className = 'pm-lib-item';
    row.setAttribute('role', 'listitem');
    row.setAttribute('aria-current', pal.id === state.activeId ? 'true' : 'false');
    row.dataset.id = pal.id;
    row.tabIndex = 0;

    var strip = document.createElement('span');
    strip.className = 'pm-lib-strip';
    pal.colors.slice(0, 8).forEach(function (c) {
      var s = document.createElement('span');
      s.style.background = c;
      strip.appendChild(s);
    });

    var name = document.createElement('span');
    name.className = 'pm-lib-name';
    name.textContent = pal.name || 'Untitled';

    var count = document.createElement('span');
    count.className = 'pm-lib-count';
    count.textContent = pal.colors.length;

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'pm-lib-del';
    del.textContent = '×';
    del.title = 'Delete this palette';
    del.dataset.del = pal.id;

    row.appendChild(strip);
    row.appendChild(name);
    row.appendChild(count);
    row.appendChild(del);
    els.lib.appendChild(row);
  });
  els.libCount.textContent = state.library.length + ' saved';
}

function setPalette(colors, name, id) {
  state.palette.colors = dedupe(colors).slice(0, MAX_COLORS);
  if (name != null) {
    state.palette.name = name;
    els.palName.value = name;
  }
  state.activeId = id || null;
  state.selected = -1;
  renderSwatches();
  renderLibrary();
  saveCurrent();
  scheduleRender(0);
}

function addColors(colors) {
  var merged = dedupe(state.palette.colors.concat(colors)).slice(0, MAX_COLORS);
  state.palette.colors = merged;
  renderSwatches();
  saveCurrent();
  scheduleRender(0);
}

function doExtract(append) {
  if (!state.img) { toast('Load an image first.', true); return; }
  var n = +els.extractN.value;
  // Extraction only needs a representative sample, so work off a small buffer.
  var dims = workDims({ pixel: 1 }, false);
  var data = drawWork(dims, true);
  var colors = extractPalette(data, n);
  if (!colors.length) { toast('Could not read any colours from that image.', true); return; }
  if (append) {
    addColors(colors);
    setStatus('Added ' + colors.length + ' extracted colours');
  } else {
    setPalette(colors, state.palette.name || (state.name + ' ' + colors.length), null);
    setStatus('Extracted ' + colors.length + ' colours');
  }
}

/* ---------------------------------------------------------------------------
   10. PERSISTENCE
   ---------------------------------------------------------------------------
   localStorage can throw (private mode, quota, disabled cookies), so every
   access is guarded and the app degrades to in-memory state.
   ------------------------------------------------------------------------ */

function lsGet(key) {
  try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; }
  catch (e) { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (e) { return false; }
}

function saveLibrary() { lsSet(LS_PALETTES, state.library); }
function saveCurrent() { lsSet(LS_CURRENT, { name: els.palName.value, colors: state.palette.colors, activeId: state.activeId }); }

function saveSettings() {
  lsSet(LS_SETTINGS, {
    theme: document.documentElement.getAttribute('data-cc-theme'),
    metric: els.metric.value,
    dither: els.dither.value,
    ditherAmt: els.ditherAmt.value,
    pixel: els.pixel.value,
    smooth: els.smooth.checked,
    alphaCut: els.alphaCut.value,
    brightness: els.brightness.value,
    contrast: els.contrast.value,
    saturation: els.saturation.value,
    gamma: els.gamma.value,
    exportScale: els.exportScale.value,
    exportFull: els.exportFull.checked,
    live: els.live.checked,
    extractN: els.extractN.value,
    view: state.view,
    split: state.split
  });
}

function loadSettings() {
  var s = lsGet(LS_SETTINGS);
  if (!s) return;
  if (s.theme) { document.documentElement.setAttribute('data-cc-theme', s.theme); els.theme.value = s.theme; }
  if (s.metric) els.metric.value = s.metric;
  if (s.dither) els.dither.value = s.dither;
  if (s.ditherAmt != null) els.ditherAmt.value = s.ditherAmt;
  if (s.pixel != null) els.pixel.value = s.pixel;
  if (s.smooth != null) els.smooth.checked = !!s.smooth;
  if (s.alphaCut != null) els.alphaCut.value = s.alphaCut;
  if (s.brightness != null) els.brightness.value = s.brightness;
  if (s.contrast != null) els.contrast.value = s.contrast;
  if (s.saturation != null) els.saturation.value = s.saturation;
  if (s.gamma != null) els.gamma.value = s.gamma;
  if (s.exportScale != null) els.exportScale.value = s.exportScale;
  if (s.exportFull != null) els.exportFull.checked = !!s.exportFull;
  if (s.live != null) els.live.checked = !!s.live;
  if (s.extractN != null) els.extractN.value = s.extractN;
  if (s.view) state.view = s.view;
  if (s.split != null) state.split = s.split;
  syncSliderLabels();
}

/* ---------------------------------------------------------------------------
   11. EXPORT
   ------------------------------------------------------------------------ */

function exportFilename(ext) {
  var pal = (els.palName.value || 'palette').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  var src = state.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return (src || 'image') + '_' + (pal || 'palette') + '.' + ext;
}

async function buildExportCanvas() {
  var opts = readOptions();
  if (!state.img) { toast('Load an image first.', true); return null; }
  if (!state.palette.colors.length) { toast('Palette is empty.', true); return null; }

  var base;
  if (opts.exportFull) {
    base = await renderFull(opts);
    // renderFull returns null only when a newer render superseded this one.
    if (!base) { toast('Render was interrupted — try again.', true); return null; }
  } else {
    base = els.canvasResult;
    if (!base.width) { toast('Nothing rendered yet.', true); return null; }
  }
  return upscale(base, opts.exportScale);
}

function canvasToBlob(canvas) {
  return new Promise(function (resolve) { canvas.toBlob(resolve, 'image/png'); });
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
}

function downloadText(text, filename, mime) {
  downloadBlob(new Blob([text], { type: mime || 'text/plain' }), filename);
}

async function doDownload() {
  var canvas = await buildExportCanvas();
  if (!canvas) return;
  var blob = await canvasToBlob(canvas);
  downloadBlob(blob, exportFilename('png'));
  setStatus('Downloaded ' + canvas.width + '×' + canvas.height + ' PNG');
}

async function doCopy() {
  var canvas = await buildExportCanvas();
  if (!canvas) return;
  var blob = await canvasToBlob(canvas);
  try {
    if (!navigator.clipboard || !window.ClipboardItem) throw new Error('unsupported');
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })]);
    toast('Copied ' + canvas.width + '×' + canvas.height + ' PNG to the clipboard');
  } catch (e) {
    /* Safari and older Firefox reject image writes. Falling back to a download
       is more useful than an error the user can do nothing about. */
    downloadBlob(blob, exportFilename('png'));
    toast('Clipboard blocked by this browser — downloaded the PNG instead', true);
  }
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg);
  } catch (e) {
    toast('Clipboard blocked by this browser.', true);
  }
}

/* ---------------------------------------------------------------------------
   12. SMALL UI HELPERS
   ------------------------------------------------------------------------ */

var toastTimer = null;
function toast(msg, isError) {
  els.toast.textContent = msg;
  els.toast.className = 'pm-toast' + (isError ? ' pm-toast--error' : '');
  els.toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { els.toast.hidden = true; }, 3200);
}

function setStatus(msg) { els.status.textContent = msg; }
function setProgress(p) { els.progressBar.style.width = Math.round(clamp(p, 0, 1) * 100) + '%'; }
function setBusy(b) { state.busy = b; }
function press(btn, on) { btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }

function updateFooter() {
  els.footSrc.textContent = state.img ? 'SRC ' + state.srcW + '×' + state.srcH : 'SRC —';
  els.footWork.textContent = state.lastWork ? 'WORK ' + state.lastWork.w + '×' + state.lastWork.h : 'WORK —';
  els.footPal.textContent = 'PAL ' + state.palette.colors.length;
  els.footMetric.textContent = els.metric.options[els.metric.selectedIndex].text.split('—')[0].trim().toUpperCase();

  var opts = readOptions();
  if (state.img) {
    var wd = workDims(opts, true);
    els.workDims.textContent = wd.w + '×' + wd.h;
    els.exportDims.textContent = (wd.w * opts.exportScale) + '×' + (wd.h * opts.exportScale) + ' px';
  } else {
    els.workDims.textContent = '—';
    els.exportDims.textContent = '—';
  }
}

function syncSliderLabels() {
  els.ditherAmtVal.textContent = els.ditherAmt.value + '%';
  els.pixelVal.textContent = els.pixel.value + '×';
  els.brightnessVal.textContent = els.brightness.value;
  els.contrastVal.textContent = els.contrast.value;
  els.saturationVal.textContent = els.saturation.value;
  els.gammaVal.textContent = (+els.gamma.value / 100).toFixed(2);
  els.exportScaleVal.textContent = els.exportScale.value + '×';
  els.extractNVal.textContent = els.extractN.value;
  els.alphaCutVal.textContent = els.alphaCut.value;
}

var ZOOM_STEPS = [0.125, 0.25, 0.5, 0.75, 1, 2, 4, 8, 16];

function stepZoom(dir) {
  if (!state.img) return;
  var current = state.zoom === 'fit'
    ? (state.dispW / state.srcW || 1)
    : state.zoom;
  var i, target = null;
  if (dir > 0) {
    for (i = 0; i < ZOOM_STEPS.length; i++) if (ZOOM_STEPS[i] > current + 0.001) { target = ZOOM_STEPS[i]; break; }
  } else {
    for (i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current - 0.001) { target = ZOOM_STEPS[i]; break; }
  }
  if (target == null) return;
  state.zoom = target;
  layoutCanvases();
}

/* ---------------------------------------------------------------------------
   13. WIRING
   ------------------------------------------------------------------------ */

function $(id) { return document.getElementById(id); }

function cacheEls() {
  [
    'theme', 'open', 'file', 'dims', 'status', 'toast',
    'swatches', 'editor', 'palName', 'swatchCount', 'lib', 'libCount',
    'preset', 'importText',
    'metric', 'dither', 'ditherAmt', 'pixel', 'smooth', 'live', 'alphaCut',
    'brightness', 'contrast', 'saturation', 'gamma',
    'exportScale', 'exportFull', 'time', 'workDims', 'exportDims',
    'viewport', 'drop', 'splitHandle', 'zoomVal',
    'extractN'
  ].forEach(function (k) {
    els[k] = $('pm-' + k.replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); }));
  });

  els.stack = $('pm-canvas-stack');
  els.canvasOriginal = $('pm-canvas-original');
  els.canvasResult = $('pm-canvas-result');
  els.progressBar = $('pm-progress-bar');
  els.editorColor = $('pm-editor-color');
  els.editorHex = $('pm-editor-hex');
  els.editorDel = $('pm-editor-del');
  els.viewSplit = $('pm-view-split');
  els.viewBefore = $('pm-view-before');
  els.viewAfter = $('pm-view-after');
  els.tagA = document.querySelector('.pm-split-tag--a');
  els.tagB = document.querySelector('.pm-split-tag--b');
  els.footSrc = $('pm-foot-src');
  els.footWork = $('pm-foot-work');
  els.footPal = $('pm-foot-pal');
  els.footMetric = $('pm-foot-metric');
  els.ditherAmtVal = $('pm-dither-amt-val');
  els.pixelVal = $('pm-pixel-val');
  els.brightnessVal = $('pm-brightness-val');
  els.contrastVal = $('pm-contrast-val');
  els.saturationVal = $('pm-saturation-val');
  els.gammaVal = $('pm-gamma-val');
  els.exportScaleVal = $('pm-export-scale-val');
  els.extractNVal = $('pm-extract-n-val');
  els.alphaCutVal = $('pm-alpha-cut-val');
  els.palFile = $('pm-pal-file');
}

function wireImageInput() {
  els.open.addEventListener('click', function () { els.file.click(); });
  els.file.addEventListener('change', function () {
    if (els.file.files && els.file.files[0]) loadImageFromBlob(els.file.files[0], els.file.files[0].name);
    els.file.value = '';
  });

  document.addEventListener('paste', function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var i, f;
    for (i = 0; i < items.length; i++) {
      if (/^image\//.test(items[i].type)) {
        f = items[i].getAsFile();
        if (f) { e.preventDefault(); loadImageFromBlob(f, f.name || 'pasted'); return; }
      }
    }
    /* No image on the clipboard. If the focus isn't in a text field and the
       text looks like a pile of hex codes, treat it as a palette paste — it's
       the other thing people arrive here with in their clipboard. */
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    var text = e.clipboardData && e.clipboardData.getData('text/plain');
    if (!text) return;
    var parsed = parsePaletteText(text, '');
    if (parsed.colors.length >= 2) {
      e.preventDefault();
      setPalette(parsed.colors, parsed.name || 'Pasted palette', null);
      toast('Imported ' + parsed.colors.length + ' colours from the clipboard');
    }
  });

  ['dragenter', 'dragover'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') < 0) return;
      e.preventDefault();
      document.body.classList.add('pm-dragging');
    });
  });
  ['dragleave', 'dragend'].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      if (e.relatedTarget) return;
      document.body.classList.remove('pm-dragging');
    });
  });
  document.addEventListener('drop', function (e) {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
    e.preventDefault();
    document.body.classList.remove('pm-dragging');
    var f = e.dataTransfer.files[0];
    if (/^image\//.test(f.type)) loadImageFromBlob(f, f.name);
    else loadPaletteFile(f);
  });
}

function loadPaletteFile(file) {
  var reader = new FileReader();
  var isAct = /\.act$/i.test(file.name);
  reader.onload = function () {
    var parsed = isAct
      ? parseActBuffer(reader.result, file.name)
      : parsePaletteText(reader.result, file.name);
    if (!parsed.colors.length) { toast('No colours found in ' + file.name, true); return; }
    setPalette(parsed.colors, parsed.name || file.name, null);
    toast('Imported ' + parsed.colors.length + ' colours from ' + file.name);
  };
  reader.onerror = function () { toast('Could not read ' + file.name, true); };
  if (isAct) reader.readAsArrayBuffer(file);
  else reader.readAsText(file);
}

function wirePaletteUI() {
  els.palName.addEventListener('input', function () {
    state.palette.name = els.palName.value;
    saveCurrent();
  });

  els.swatches.addEventListener('click', function (e) {
    var add = e.target.closest('.pm-swatch--add');
    if (add) {
      var seed = state.palette.colors.length ? state.palette.colors[state.palette.colors.length - 1] : '#888888';
      if (state.palette.colors.length >= MAX_COLORS) { toast('Palette is full at ' + MAX_COLORS + ' colours.', true); return; }
      state.palette.colors.push(seed);
      state.selected = state.palette.colors.length - 1;
      renderSwatches();
      saveCurrent();
      els.editorColor.click();
      return;
    }
    var sw = e.target.closest('.pm-swatch');
    if (!sw || !sw.dataset.index) return;
    var i = +sw.dataset.index;
    state.selected = state.selected === i ? -1 : i;
    renderSwatches();
  });

  // Drag to reorder
  var dragFrom = -1;
  els.swatches.addEventListener('dragstart', function (e) {
    var sw = e.target.closest('.pm-swatch');
    if (!sw || !sw.dataset.index) return;
    dragFrom = +sw.dataset.index;
    sw.classList.add('pm-swatch-drag');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(dragFrom));
  });
  els.swatches.addEventListener('dragover', function (e) {
    if (dragFrom < 0) return;
    e.preventDefault();
    var sw = e.target.closest('.pm-swatch');
    Array.prototype.forEach.call(els.swatches.children, function (c) { c.classList.remove('pm-swatch-over'); });
    if (sw && sw.dataset.index) sw.classList.add('pm-swatch-over');
  });
  els.swatches.addEventListener('drop', function (e) {
    if (dragFrom < 0) return;
    e.preventDefault();
    var sw = e.target.closest('.pm-swatch');
    if (sw && sw.dataset.index) {
      var to = +sw.dataset.index;
      var moved = state.palette.colors.splice(dragFrom, 1)[0];
      state.palette.colors.splice(to, 0, moved);
      state.selected = to;
      saveCurrent();
      scheduleRender(0);
    }
    dragFrom = -1;
    renderSwatches();
  });
  els.swatches.addEventListener('dragend', function () {
    dragFrom = -1;
    renderSwatches();
  });

  els.editorColor.addEventListener('input', function () {
    if (state.selected < 0) return;
    state.palette.colors[state.selected] = normalizeHex(els.editorColor.value) || '#000000';
    els.editorHex.value = state.palette.colors[state.selected].toUpperCase();
    var sw = els.swatches.querySelector('[data-index="' + state.selected + '"]');
    if (sw) sw.style.background = state.palette.colors[state.selected];
    saveCurrent();
    scheduleRender();
  });

  els.editorHex.addEventListener('input', function () {
    if (state.selected < 0) return;
    var h = normalizeHex(els.editorHex.value);
    if (!h) return;
    state.palette.colors[state.selected] = h;
    els.editorColor.value = h;
    var sw = els.swatches.querySelector('[data-index="' + state.selected + '"]');
    if (sw) sw.style.background = h;
    saveCurrent();
    scheduleRender();
  });

  els.editorDel.addEventListener('click', function () {
    if (state.selected < 0) return;
    state.palette.colors.splice(state.selected, 1);
    state.selected = -1;
    renderSwatches();
    saveCurrent();
    scheduleRender(0);
  });

  $('pm-save').addEventListener('click', function () {
    if (!state.palette.colors.length) { toast('Nothing to save — the palette is empty.', true); return; }
    var name = (els.palName.value || '').trim() || 'Untitled';
    var existing = state.activeId && state.library.filter(function (p) { return p.id === state.activeId; })[0];
    if (existing) {
      existing.name = name;
      existing.colors = state.palette.colors.slice();
      toast('Updated "' + name + '"');
    } else {
      var pal = { id: 'p' + Date.now().toString(36), name: name, colors: state.palette.colors.slice() };
      state.library.unshift(pal);
      state.activeId = pal.id;
      toast('Saved "' + name + '"');
    }
    saveLibrary();
    saveCurrent();
    renderLibrary();
  });

  $('pm-dup').addEventListener('click', function () {
    state.activeId = null;
    els.palName.value = (els.palName.value || 'Untitled') + ' copy';
    state.palette.name = els.palName.value;
    saveCurrent();
    renderLibrary();
    toast('Detached — press Save to store it as a new palette');
  });

  $('pm-sort').addEventListener('click', function () {
    state.palette.colors.sort(function (a, b) { return oklabLightness(a) - oklabLightness(b); });
    state.selected = -1;
    renderSwatches();
    saveCurrent();
  });

  $('pm-clear-pal').addEventListener('click', function () {
    setPalette([], els.palName.value, state.activeId);
    setStatus('Palette cleared');
  });

  els.lib.addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]');
    if (del) {
      state.library = state.library.filter(function (p) { return p.id !== del.dataset.del; });
      if (state.activeId === del.dataset.del) state.activeId = null;
      saveLibrary();
      renderLibrary();
      return;
    }
    var row = e.target.closest('.pm-lib-item');
    if (!row) return;
    var pal = state.library.filter(function (p) { return p.id === row.dataset.id; })[0];
    if (pal) setPalette(pal.colors.slice(), pal.name, pal.id);
  });

  els.lib.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    var row = e.target.closest('.pm-lib-item');
    if (!row) return;
    e.preventDefault();
    row.click();
  });

  PRESETS.forEach(function (p, i) {
    var opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = p.name + ' (' + p.colors.length + ')';
    els.preset.appendChild(opt);
  });
  els.preset.addEventListener('change', function () {
    if (els.preset.value === '') return;
    var p = PRESETS[+els.preset.value];
    // Clone, so editing never mutates the preset itself.
    setPalette(p.colors.slice(), p.name, null);
    els.preset.value = '';
    toast('Loaded ' + p.name);
  });

  $('pm-import-paste').addEventListener('click', function () {
    var parsed = parsePaletteText(els.importText.value, '');
    if (!parsed.colors.length) { toast('No colours found in that text.', true); return; }
    setPalette(parsed.colors, parsed.name || 'Imported', null);
    els.importText.value = '';
    toast('Imported ' + parsed.colors.length + ' colours');
  });

  $('pm-import-file').addEventListener('click', function () { els.palFile.click(); });
  els.palFile.addEventListener('change', function () {
    if (els.palFile.files && els.palFile.files[0]) loadPaletteFile(els.palFile.files[0]);
    els.palFile.value = '';
  });

  $('pm-export-hex').addEventListener('click', function () {
    if (!state.palette.colors.length) { toast('Palette is empty.', true); return; }
    downloadText(serializeHex(state.palette), exportFilename('hex'));
  });
  $('pm-export-gpl').addEventListener('click', function () {
    if (!state.palette.colors.length) { toast('Palette is empty.', true); return; }
    var pal = { name: els.palName.value || 'Untitled', colors: state.palette.colors };
    downloadText(serializeGpl(pal), exportFilename('gpl'));
  });
  $('pm-copy-hex').addEventListener('click', function () {
    if (!state.palette.colors.length) { toast('Palette is empty.', true); return; }
    copyText(state.palette.colors.map(function (c) { return c.toUpperCase(); }).join('\n'),
      'Copied ' + state.palette.colors.length + ' hex codes');
  });

  $('pm-extract').addEventListener('click', function () { doExtract(false); });
  $('pm-extract-add').addEventListener('click', function () { doExtract(true); });

  $('pm-eyedropper').addEventListener('click', function () {
    state.eyedropper = !state.eyedropper;
    press($('pm-eyedropper'), state.eyedropper);
    $('pm-eyedropper').textContent = 'Eyedropper: ' + (state.eyedropper ? 'on' : 'off');
    document.body.classList.toggle('pm-eyedropper-on', state.eyedropper);
    setStatus(state.eyedropper ? 'Click the image to sample a colour' : 'Ready');
  });
}

function wireStage() {
  els.stack.addEventListener('click', function (e) {
    if (!state.eyedropper || !state.srcCtx) return;
    var rect = els.canvasOriginal.getBoundingClientRect();
    var x = Math.floor((e.clientX - rect.left) / rect.width * state.srcW);
    var y = Math.floor((e.clientY - rect.top) / rect.height * state.srcH);
    if (x < 0 || y < 0 || x >= state.srcW || y >= state.srcH) return;
    // Sampled from the full-resolution source, not the scaled display canvas.
    var d = state.srcCtx.getImageData(x, y, 1, 1).data;
    var hex = rgbToHex(d[0], d[1], d[2]);
    if (state.palette.colors.indexOf(hex) >= 0) { toast(hex.toUpperCase() + ' is already in the palette'); return; }
    if (state.palette.colors.length >= MAX_COLORS) { toast('Palette is full.', true); return; }
    state.palette.colors.push(hex);
    state.selected = state.palette.colors.length - 1;
    renderSwatches();
    saveCurrent();
    scheduleRender();
    toast('Sampled ' + hex.toUpperCase());
  });

  var dragging = false;
  function setSplitFromEvent(e) {
    var rect = els.stack.getBoundingClientRect();
    state.split = clamp((e.clientX - rect.left) / rect.width * 100, 0, 100);
    applyView();
  }
  els.splitHandle.addEventListener('pointerdown', function (e) {
    dragging = true;
    els.splitHandle.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  els.splitHandle.addEventListener('pointermove', function (e) {
    if (dragging) setSplitFromEvent(e);
  });
  els.splitHandle.addEventListener('pointerup', function (e) {
    dragging = false;
    try { els.splitHandle.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
    saveSettings();
  });
  els.splitHandle.addEventListener('keydown', function (e) {
    var step = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') { state.split = clamp(state.split - step, 0, 100); applyView(); e.preventDefault(); }
    if (e.key === 'ArrowRight') { state.split = clamp(state.split + step, 0, 100); applyView(); e.preventDefault(); }
    if (e.key === 'Home') { state.split = 0; applyView(); e.preventDefault(); }
    if (e.key === 'End') { state.split = 100; applyView(); e.preventDefault(); }
  });

  function setView(v) { state.view = v; applyView(); saveSettings(); }
  els.viewSplit.addEventListener('click', function () { setView('split'); });
  els.viewBefore.addEventListener('click', function () { setView('before'); });
  els.viewAfter.addEventListener('click', function () { setView('after'); });

  $('pm-zoom-in').addEventListener('click', function () { stepZoom(1); });
  $('pm-zoom-out').addEventListener('click', function () { stepZoom(-1); });
  $('pm-zoom-fit').addEventListener('click', function () { state.zoom = 'fit'; layoutCanvases(); });
  $('pm-zoom-1').addEventListener('click', function () { state.zoom = 1; layoutCanvases(); });

  window.addEventListener('resize', function () { if (state.zoom === 'fit') layoutCanvases(); });
}

function wireControls() {
  els.theme.addEventListener('change', function () {
    document.documentElement.setAttribute('data-cc-theme', els.theme.value);
    saveSettings();
  });

  // Anything that changes the mapping re-renders; anything cosmetic doesn't.
  [els.metric, els.dither, els.pixel, els.smooth, els.alphaCut,
   els.brightness, els.contrast, els.saturation, els.gamma, els.ditherAmt].forEach(function (el) {
    el.addEventListener('input', function () {
      syncSliderLabels();
      updateFooter();
      saveSettings();
      scheduleRender();
    });
  });

  [els.exportScale, els.exportFull].forEach(function (el) {
    el.addEventListener('input', function () {
      syncSliderLabels();
      updateFooter();
      saveSettings();
    });
  });

  els.extractN.addEventListener('input', function () { syncSliderLabels(); saveSettings(); });

  els.live.addEventListener('change', function () {
    saveSettings();
    if (els.live.checked) scheduleRender(0);
  });

  $('pm-adjust-reset').addEventListener('click', function () {
    els.brightness.value = 0;
    els.contrast.value = 0;
    els.saturation.value = 0;
    els.gamma.value = 100;
    syncSliderLabels();
    saveSettings();
    scheduleRender(0);
  });

  $('pm-render').addEventListener('click', async function () {
    if (!state.img) { toast('Load an image first.', true); return; }
    if (!state.palette.colors.length) { toast('Palette is empty.', true); return; }
    var opts = readOptions();
    var started = performance.now();
    var canvas = await renderFull(opts);
    if (!canvas) return;
    els.canvasResult.width = canvas.width;
    els.canvasResult.height = canvas.height;
    els.canvasResult.getContext('2d').drawImage(canvas, 0, 0);
    state.lastWork = { w: canvas.width, h: canvas.height };
    els.time.textContent = Math.round(performance.now() - started) + ' ms';
    setStatus('Full render ' + canvas.width + '×' + canvas.height);
    updateFooter();
    layoutCanvases();
  });

  $('pm-download').addEventListener('click', doDownload);
  $('pm-copy').addEventListener('click', doCopy);

  document.addEventListener('keydown', function (e) {
    var tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); doDownload(); }
    else if (e.key === '1') { state.view = 'before'; applyView(); }
    else if (e.key === '2') { state.view = 'split'; applyView(); }
    else if (e.key === '3') { state.view = 'after'; applyView(); }
  });
}

/* ---------------------------------------------------------------------------
   14. INIT
   ------------------------------------------------------------------------ */

function init() {
  cacheEls();
  loadSettings();

  state.library = lsGet(LS_PALETTES) || [];
  var current = lsGet(LS_CURRENT);
  if (current && current.colors && current.colors.length) {
    state.palette.colors = current.colors.slice(0, MAX_COLORS);
    state.palette.name = current.name || '';
    state.activeId = current.activeId || null;
    els.palName.value = state.palette.name;
  } else {
    // First run: a small, unambiguous default so the tool does something the
    // moment an image arrives.
    state.palette.colors = PRESETS[3].colors.slice();   // Sweetie 16
    state.palette.name = PRESETS[3].name;
    els.palName.value = state.palette.name;
  }

  renderSwatches();
  renderLibrary();
  syncSliderLabels();
  updateFooter();
  applyView();

  wireImageInput();
  wirePaletteUI();
  wireStage();
  wireControls();

  // Expose a tiny surface for automated checking — see README.
  window.PaletteMapper = {
    state: state,
    loadImageFromUrl: loadImageFromUrl,
    setPalette: setPalette,
    renderPreview: renderPreview,
    renderFull: renderFull,
    buildExportCanvas: buildExportCanvas,
    readOptions: readOptions,
    parsePaletteText: parsePaletteText,
    buildMatcher: buildMatcher,
    extractPalette: extractPalette
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
