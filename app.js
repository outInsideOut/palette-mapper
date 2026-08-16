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

var TRANSPARENT = 0xFFFF;  // index-map sentinel; palettes cap at 256 so it can't collide
var TOLERANCE_MAX = 0.4;   // OKLab distance the tolerance slider maps onto at 100%

var LS_PALETTES = 'pm.palettes.v1';
var LS_SETTINGS = 'pm.settings.v1';
var LS_CURRENT  = 'pm.current.v1';
var LS_PRESETS  = 'pm.presets.v1';
var LS_FOLDS    = 'pm.folds.v1';
var LS_CARD_ORDER = 'pm.cardorder.v1';

/* Marker written into exported backup files and checked on import, so a
   palette .json and a backup .json can be told apart on sight. */
var DATA_FILE_FORMAT = 'palette-mapper-data';

var state = {
  img: null,             // HTMLImageElement of the source
  imgSerial: 0,          // bumped per load; keys the denoise cache
  name: 'image',         // source filename stem, used for export naming
  srcCanvas: null,       // full-resolution source, for eyedropper sampling
  srcCtx: null,
  srcW: 0,
  srcH: 0,
  palette: { name: '', colors: [] },
  activeId: null,        // id of the saved palette this was loaded from
  selected: -1,          // index of the swatch open in the editor
  library: [],
  presets: [],           // saved whole-page settings
  activePresetId: null,
  view: 'split',         // split | before | after
  split: 50,             // percent
  zoom: 'fit',           // 'fit' or a number
  dispW: 0,
  dispH: 0,
  eyedropper: false,
  panel: 'none',                // mobile sheet: none | palette | process
  outlineColorTouched: false,   // once true, the picker stops tracking the palette
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

/* OKLab in cylindrical form: lightness, chroma (distance from grey) and hue
   (angle round the colour wheel). Same space, but it separates "how colourful"
   from "which colour", which is what makes a palette sortable by family. */
function oklch(hex) {
  var rgb = hexToRgb(hex) || [0, 0, 0], lab = [0, 0, 0];
  rgbToOklab(rgb[0], rgb[1], rgb[2], lab);
  var h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;
  return {
    hex: hex,
    L: lab[0],
    C: Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]),
    h: h < 0 ? h + 360 : h
  };
}

/* Below this chroma a colour reads as a grey, and its hue angle is numerically
   real but visually meaningless — sorting neutrals by hue is what sprays them
   randomly through an otherwise ordered palette. */
var NEUTRAL_CHROMA = 0.028;
/* A hue step wider than this starts a new family. A single ramp drifts by only
   a few degrees as it lightens, so this can be tight without breaking one up. */
var HUE_FAMILY_GAP = 22;
/* One hue can hold two ramps at different saturations — Sweetie 16's muted
   blue-greys and its vivid blues are the same hue family. A chroma step this
   wide separates them; a single ramp's chroma changes far more gradually. */
var CHROMA_RAMP_GAP = 0.045;

/* Sort a palette into ramps: the greys first, then each hue family in turn,
   every family running dark to light.

   Sorting on lightness alone — which is what this used to do — is a total
   order on one axis, so any two colours that happen to share a lightness sit
   next to each other however unrelated their hues are. That is why a red lands
   between two greens. Grouping by hue first and only then ordering by
   lightness is what produces the ramps artists actually work in. */
function sortIntoRamps(colors) {
  var items = colors.map(oklch);
  var byL = function (a, b) { return a.L - b.L; };

  var neutrals = items.filter(function (c) { return c.C < NEUTRAL_CHROMA; }).sort(byL);
  var chromatic = items.filter(function (c) { return c.C >= NEUTRAL_CHROMA; });
  if (!chromatic.length) return neutrals.map(function (c) { return c.hex; });

  chromatic.sort(function (a, b) { return a.h - b.h; });
  var n = chromatic.length, i, gap;

  /* Cut the wheel at its widest gap before splitting into families. Without
     this the seam falls at 0 degrees, which runs straight through the reds and
     splits that family across both ends of the palette. */
  var widest = -1, cut = 0;
  for (i = 0; i < n; i++) {
    gap = chromatic[(i + 1) % n].h - chromatic[i].h;
    if (gap < 0) gap += 360;
    if (gap > widest) { widest = gap; cut = (i + 1) % n; }
  }

  var families = [], current = [];
  for (i = 0; i < n; i++) {
    var here = chromatic[(cut + i) % n];
    if (current.length) {
      gap = here.h - chromatic[(cut + i - 1 + n) % n].h;
      if (gap < 0) gap += 360;
      if (gap > HUE_FAMILY_GAP) { families.push(current); current = []; }
    }
    current.push(here);
  }
  if (current.length) families.push(current);

  /* Order the families round the wheel from red. The mean is taken as a vector
     so a family straddling 0 degrees averages to roughly 0 rather than to 180. */
  families.forEach(function (f) {
    var x = 0, y = 0;
    f.forEach(function (c) {
      var r = c.h * Math.PI / 180;
      x += Math.cos(r); y += Math.sin(r);
    });
    var m = Math.atan2(y, x) * 180 / Math.PI;
    f.meanHue = m < 0 ? m + 360 : m;
  });
  families.sort(function (a, b) { return a.meanHue - b.meanHue; });

  var out = neutrals;
  families.forEach(function (f) {
    splitByChroma(f).forEach(function (ramp) { out = out.concat(ramp.sort(byL)); });
  });
  return out.map(function (c) { return c.hex; });
}

/* Split one hue family into its separate ramps by looking for a jump in
   chroma, muted ramps first. Without this a family holding both a greyed ramp
   and a saturated one gets sorted by lightness into a single interleaved run,
   which is the same problem as sorting the whole palette by lightness. */
function splitByChroma(family) {
  if (family.length < 3) return [family];
  var sorted = family.slice().sort(function (a, b) { return a.C - b.C; });
  var ramps = [], current = [sorted[0]], i;
  for (i = 1; i < sorted.length; i++) {
    if (sorted[i].C - sorted[i - 1].C > CHROMA_RAMP_GAP) {
      ramps.push(current);
      current = [];
    }
    current.push(sorted[i]);
  }
  ramps.push(current);
  return ramps;
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
   4b. COLOUR-THEORY EXTRACTION
   ---------------------------------------------------------------------------
   The clustering extractor above answers "which colours is this image actually
   made of" — it samples. This one answers a different question: "what palette
   would an artist build for this image". It reads the dominant hue families
   out of the picture and then *constructs* ramps, rather than returning the
   cluster centroids it happened to land on.

   Three pieces of colour theory do the work:

     - Chroma peaks in the midtones. A ramp that holds chroma constant looks
       chalky at the light end and muddy at the dark end, because neither very
       dark nor very light colours can be very colourful.
     - Shadows cool, highlights warm. Shifting hue toward blue as a ramp
       darkens and toward yellow as it lightens is the oldest trick in
       painting, and it is what stops a ramp reading as a flat tint of one hue.
     - Harmony. Hue relationships at fixed angles round the wheel —
       complementary at 180, triadic at 120 and so on — give a palette a
       deliberate structure instead of whatever the source happened to contain.
   ------------------------------------------------------------------------ */

/* Where hue drifts to at the extremes, in OKLab hue degrees. */
var SHADOW_HUE = 264;      /* blue-violet */
var HIGHLIGHT_HUE = 85;    /* warm yellow */
var HUE_SHIFT_MAX = 18;    /* degrees of drift at the very ends of a ramp */
/* Chroma retained at each end of a ramp, as a fraction of its peak. */
var RAMP_SHADOW_CHROMA = 0.55;
var RAMP_HIGHLIGHT_CHROMA = 0.30;

var HARMONY_SCHEMES = {
  auto:          null,                  /* take the families the image really has */
  complementary: [0, 180],
  split:         [0, 150, 210],
  triadic:       [0, 120, 240],
  tetradic:      [0, 90, 180, 270],
  analogous:     [0, 30, 330],
  monochrome:    [0]
};

function shortestHueStep(from, to) {
  var d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}

/* Reduce chroma until the colour actually fits in sRGB.

   oklabToRgb clamps each channel independently, which for an out-of-gamut
   colour silently changes its hue as well as its chroma — the saturated end of
   a ramp goes flat and drifts. Backing chroma off until the conversion stops
   clipping keeps the hue the ramp asked for. */
function fitToGamut(L, C, hDeg) {
  var rad = hDeg * Math.PI / 180, rgb = [0, 0, 0];
  var lo = 0, hi = C, i, mid;
  var inGamut = function (c) {
    oklabToRgb(L, Math.cos(rad) * c, Math.sin(rad) * c, rgb);
    /* linearToSrgb clamps, so a clipped colour is one that lands exactly on a
       boundary. Re-converting would be exact; testing the boundary is enough. */
    return rgb[0] > 0.001 && rgb[0] < 254.999 &&
           rgb[1] > 0.001 && rgb[1] < 254.999 &&
           rgb[2] > 0.001 && rgb[2] < 254.999;
  };
  if (inGamut(C)) { oklabToRgb(L, Math.cos(rad) * C, Math.sin(rad) * C, rgb); return rgb; }
  for (i = 0; i < 16; i++) {
    mid = (lo + hi) / 2;
    if (inGamut(mid)) lo = mid; else hi = mid;
  }
  oklabToRgb(L, Math.cos(rad) * lo, Math.sin(rad) * lo, rgb);
  return rgb;
}

/* Build one ramp of `steps` colours around a base hue. */
function buildRamp(hueDeg, peakChroma, steps, loL, hiL, shift) {
  var out = [], i, t, L, chroma, hue, drift, target, rgb;
  for (i = 0; i < steps; i++) {
    t = steps === 1 ? 0.5 : i / (steps - 1);
    L = loL + (hiL - loL) * t;

    /* Chroma peaks mid-ramp and falls away at both ends — but never to zero,
       or the ends of every ramp come out pure grey and the whole thing reads
       as a tinted greyscale. The floor is asymmetric because that is how paint
       behaves: shadows stay deep and saturated, highlights wash out toward
       pastel. The 0.65 exponent keeps the shoulders broad rather than pinched. */
    var floor = RAMP_SHADOW_CHROMA + (RAMP_HIGHLIGHT_CHROMA - RAMP_SHADOW_CHROMA) * t;
    chroma = peakChroma * (floor + (1 - floor) * Math.pow(Math.sin(Math.PI * t), 0.65));

    /* Cool the shadows, warm the highlights, strongest at the extremes. */
    drift = (t - 0.5) * 2;                          /* -1 at black, +1 at white */
    target = drift < 0 ? SHADOW_HUE : HIGHLIGHT_HUE;
    hue = hueDeg + shortestHueStep(hueDeg, target) *
          Math.abs(drift) * (HUE_SHIFT_MAX / 180) * shift;

    rgb = fitToGamut(L, chroma, hue);
    out.push(rgbToHex(rgb[0], rgb[1], rgb[2]));
  }
  return out;
}

/* Read the dominant hue families out of an image.

   Hue is weighted by chroma as well as by pixel count: a huge field of near
   grey should not out-vote a small area of vivid colour when deciding what the
   image is *about*, and a grey's hue angle is close to meaningless anyway. */
function dominantHues(samples, want) {
  var BINS = 72, hist = new Float64Array(BINS), i, c;
  var chromaSum = 0, chromaCount = 0;
  var lab = [0, 0, 0];

  for (i = 0; i < samples.length; i++) {
    rgbToOklab(samples[i][0], samples[i][1], samples[i][2], lab);
    var C = Math.sqrt(lab[1] * lab[1] + lab[2] * lab[2]);
    if (C < NEUTRAL_CHROMA) continue;
    var h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;
    if (h < 0) h += 360;
    hist[Math.floor(h / 360 * BINS) % BINS] += C;
    chromaSum += C; chromaCount++;
  }
  var peakChroma = chromaCount ? (chromaSum / chromaCount) * 1.9 : 0.11;

  /* Smooth the histogram so one family does not register as several peaks. */
  var smooth = new Float64Array(BINS);
  for (i = 0; i < BINS; i++) {
    smooth[i] = hist[(i - 1 + BINS) % BINS] * 0.25 + hist[i] * 0.5 + hist[(i + 1) % BINS] * 0.25;
  }

  /* Greedily take the strongest bin, then suppress its neighbourhood so the
     next pick is a genuinely different family rather than the same peak again. */
  var hues = [], SUPPRESS = Math.round(BINS * (HUE_FAMILY_GAP / 360));
  for (c = 0; c < want; c++) {
    var best = -1, bestVal = 0;
    for (i = 0; i < BINS; i++) if (smooth[i] > bestVal) { bestVal = smooth[i]; best = i; }
    if (best < 0) break;
    /* Refine to the weighted centre of the peak rather than the bin centre. */
    var wx = 0, wy = 0;
    for (i = -2; i <= 2; i++) {
      var b = (best + i + BINS) % BINS, ang = (b + 0.5) / BINS * 2 * Math.PI;
      wx += Math.cos(ang) * smooth[b]; wy += Math.sin(ang) * smooth[b];
    }
    var refined = Math.atan2(wy, wx) * 180 / Math.PI;
    hues.push(refined < 0 ? refined + 360 : refined);
    for (i = -SUPPRESS; i <= SUPPRESS; i++) smooth[(best + i + BINS) % BINS] = 0;
  }
  return { hues: hues, peakChroma: clamp(peakChroma, 0.06, 0.22) };
}

/* The colour-theory extractor. Returns a palette of constructed ramps. */
function extractByTheory(imageData, count, scheme, shift) {
  var samples = samplePixels(imageData, EXTRACT_SAMPLES);
  if (!samples.length) return [];

  /* Lightness envelope of the image, so the ramps span what is actually there
     rather than always running pure black to pure white. */
  var lab = [0, 0, 0], loL = 1, hiL = 0, i;
  for (i = 0; i < samples.length; i++) {
    rgbToOklab(samples[i][0], samples[i][1], samples[i][2], lab);
    if (lab[0] < loL) loL = lab[0];
    if (lab[0] > hiL) hiL = lab[0];
  }
  if (hiL - loL < 0.25) { loL = Math.max(0, loL - 0.15); hiL = Math.min(1, hiL + 0.15); }

  /* Aim for ramps of roughly six steps to decide how many hue families to go
     looking for — one of the ramps is the neutrals. */
  var wanted = clamp(Math.round(count / 6), 2, 9);
  var angles = HARMONY_SCHEMES[scheme];
  var found = dominantHues(samples, angles ? 1 : Math.max(1, wanted - 1));
  var baseHues;

  if (angles) {
    /* Anchor the scheme on the image's strongest hue, then repeat the pattern
       outward if more ramps are needed than the scheme has angles. */
    var base = found.hues.length ? found.hues[0] : 0;
    baseHues = [];
    for (i = 0; i < Math.max(1, wanted - 1); i++) {
      var a = angles[i % angles.length];
      var wrap = Math.floor(i / angles.length) * (scheme === 'monochrome' ? 0 : 12);
      baseHues.push((base + a + wrap) % 360);
    }
  } else {
    baseHues = found.hues;
    if (!baseHues.length) baseHues = [0];
  }

  /* Drop hues the scheme repeated — monochrome asks for one hue however many
     ramps were wanted, and emitting it several times would just build the same
     ramp over and over for dedupe to throw away, leaving the palette short. */
  baseHues = baseHues.filter(function (h, idx) {
    return !baseHues.slice(0, idx).some(function (prev) {
      return Math.abs(shortestHueStep(prev, h)) < 5;
    });
  });

  /* Now that the real number of ramps is known, split the requested count
     across them. An image with only three hue families should still hand back
     the number of colours that was asked for — as longer ramps, not as a
     short palette. The remainder goes to the earliest ramps. */
  var totalRamps = baseHues.length + 1;
  var steps = Math.max(3, Math.floor(count / totalRamps));
  var remainder = count - steps * totalRamps;

  var out = [];
  /* Neutrals first, matching the ramp sort's ordering. */
  out = out.concat(buildRamp(0, 0, steps + (remainder-- > 0 ? 1 : 0), loL, hiL, 0));
  baseHues.forEach(function (h) {
    out = out.concat(buildRamp(h, found.peakChroma, steps + (remainder-- > 0 ? 1 : 0),
                               loL, hiL, shift));
  });

  /* Constructed ramps can collide at the very dark and very light ends where
     chroma has fallen to nothing. Trim duplicates and top back up if short. */
  out = dedupe(out);
  return out.slice(0, count);
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
    blackPoint: +els.blackPoint.value,
    whitePoint: +els.whitePoint.value,
    brightness: +els.brightness.value,
    contrast: +els.contrast.value,
    saturation: +els.saturation.value,
    gamma: +els.gamma.value / 100,
    alphaCut: +els.alphaCut.value,
    denoise: +els.denoise.value,
    speck: +els.speck.value,
    tolerance: +els.tolerance.value / 100,
    smoothStipple: els.smoothStipple.checked,
    mergeColors: +els.mergeColors.value,
    outline: els.outline.checked,
    outlineColor: els.outlineColor.value,
    outlineWidth: +els.outlineWidth.value,
    outlineMin: +els.outlineMin.value,
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

/* Levels/brightness/contrast/gamma act identically on all three channels, so
   they collapse into one 256-entry table. Saturation needs the whole triple and
   is applied afterwards.

   The black and white points run first, in levels order: the input range
   [black, white] is stretched to fill 0–255 and everything outside it clips.
   Black point exists mainly to rescue dark linework. Downscaling averages a
   one-pixel black outline together with whatever it sits on, so the line
   arrives at the matcher as a mid grey and matches to some mid palette entry
   instead of the dark one — the outline dissolves. Pulling the black point up
   to just above that blended grey pushes it back to black before matching, and
   the line survives. White point does the same from the other end for washed-out
   highlights, and tightening both is a cleaner way to buy separation than
   contrast, which pivots around mid grey and moves the shadows too.

   The two sliders cannot cross (their ranges don't overlap), but stored settings
   and imported presets are not trustworthy, so the divisor is guarded anyway. */
function buildToneLut(opts) {
  var lut = new Float32Array(256), i, v;
  var bp = clamp(opts.blackPoint || 0, 0, 254);
  var wp = clamp(opts.whitePoint == null ? 255 : opts.whitePoint, bp + 1, 255);
  var levels = bp !== 0 || wp !== 255;
  var scale = 255 / (wp - bp);
  var bright = opts.brightness * 1.275;                     // ±127.5
  var c = opts.contrast * 2.55;
  var cf = (259 * (c + 255)) / (255 * (259 - c));           // standard contrast factor
  var invGamma = 1 / opts.gamma;
  for (i = 0; i < 256; i++) {
    v = i;
    // Clipped to 0–255 here, not just kept positive: the stretched range is the
    // new full range, and pow() below needs a non-negative base regardless.
    if (levels) v = clamp((v - bp) * scale, 0, 255);
    v = 255 * Math.pow(v / 255, invGamma);
    v = v + bright;
    v = cf * (v - 128) + 128;
    lut[i] = v;                                             // deliberately unclamped
  }
  return lut;
}

function hasAdjustments(opts) {
  return opts.blackPoint !== 0 || opts.whitePoint !== 255 ||
         opts.brightness !== 0 || opts.contrast !== 0 ||
         opts.saturation !== 0 || Math.abs(opts.gamma - 1) > 0.001;
}

function nextTick() { return new Promise(function (r) { setTimeout(r, 0); }); }

/* Maps `imageData` in place against `matcher`. Returns
   `{ imageData, indices }` — the index map records which palette entry each
   pixel resolved to, which the cleanup and segmentation passes work on rather
   than re-deriving it from RGB. Returns null if a newer render superseded this
   one mid-flight. */
async function processBuffer(imageData, matcher, opts, token, onProgress) {
  var w = imageData.width, h = imageData.height, d = imageData.data;
  var pr = matcher.pr, pg = matcher.pg, pb = matcher.pb, nearest = matcher.nearest;
  var indices = new Uint16Array(w * h);

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
        indices[y * w + x] = TRANSPARENT;
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
      indices[y * w + x] = idx;
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
  return token === state.renderToken ? { imageData: imageData, indices: indices } : null;
}

/* ---------------------------------------------------------------------------
   6b. DENOISE — the pre-map half of artifact control
   ---------------------------------------------------------------------------
   Speckle in a mapped image usually is not a mapping bug: a compressed source
   has ringing inside its flat fields, and a pixel that drifts far enough to
   cross a palette decision boundary snaps to a different entry. Removing that
   drift before matching is strictly better than repairing it afterwards.

   A median rather than a blur, because this is cel art — a blur would soften
   exactly the hard edges the style is made of, and would create new
   intermediate colours along every one of them for the matcher to quantize.
   ------------------------------------------------------------------------ */
/* Partial sort to the k-th element (Hoare partition). Only the median is
   needed, and fully sorting the window is where a large-radius median filter
   spends most of its time — at radius 3 that is 49 samples per channel per
   pixel, and sorting all of them made the pass several times slower than it
   had to be. */
function quickSelect(a, n, k) {
  var lo = 0, hi = n - 1, pivot, i, j, t;
  while (lo < hi) {
    pivot = a[(lo + hi) >> 1]; i = lo; j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) { t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return a[k];
}

async function denoiseBuffer(imageData, radius, token, onProgress) {
  if (!radius) return imageData;
  var w = imageData.width, h = imageData.height;
  var src = new Uint8ClampedArray(imageData.data);   // read from a copy
  var d = imageData.data;
  var n = (2 * radius + 1) * (2 * radius + 1);
  var wr = new Uint8Array(n), wg = new Uint8Array(n), wb = new Uint8Array(n);
  var mid = n >> 1;
  var t0 = performance.now();
  var y, x, dy, dx, yy, xx, o, c, i, j, v;

  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) {
      o = (y * w + x) * 4;
      if (src[o + 3] === 0) { d[o] = 0; d[o+1] = 0; d[o+2] = 0; d[o+3] = 0; continue; }
      /* Clamp the window to the image once per pixel rather than testing every
         sample. At radius 3 that removes 49 pairs of bounds checks from the
         hot loop, which is where this pass actually spends its time. */
      c = 0;
      var y0 = y - radius, y1 = y + radius, x0 = x - radius, x1 = x + radius;
      if (y0 < 0) y0 = 0;
      if (y1 > h - 1) y1 = h - 1;
      if (x0 < 0) x0 = 0;
      if (x1 > w - 1) x1 = w - 1;
      for (yy = y0; yy <= y1; yy++) {
        var row = yy * w;
        for (xx = x0; xx <= x1; xx++) {
          var so = (row + xx) * 4;
          if (src[so + 3] === 0) continue;   // transparent neighbours don't vote
          wr[c] = src[so]; wg[c] = src[so + 1]; wb[c] = src[so + 2];
          c++;
        }
      }
      if (!c) continue;
      mid = c >> 1;
      d[o] = quickSelect(wr, c, mid);
      d[o + 1] = quickSelect(wg, c, mid);
      d[o + 2] = quickSelect(wb, c, mid);
    }

    if (performance.now() - t0 > YIELD_MS) {
      if (token !== state.renderToken) return null;
      if (onProgress) onProgress((y + 1) / h);
      await nextTick();
      t0 = performance.now();
    }
  }
  return imageData;
}

/* ---------------------------------------------------------------------------
   6c. CLEANUP, SEGMENTATION AND OUTLINES
   ---------------------------------------------------------------------------
   All three are driven by one idea: label the connected regions of equal
   palette index. Regions below a size threshold are artifacts to absorb;
   the regions themselves are the segmentation; and the boundaries between
   them are where outlines go.
   ------------------------------------------------------------------------ */

function postActive(opts) {
  return opts.denoise > 0 || opts.speck > 0 || opts.smoothStipple ||
         opts.mergeColors > 0 || opts.outline;
}
function regionsNeeded(opts) {
  return opts.speck > 0 || opts.outline;
}

/* Squared OKLab distance between two palette entries. The tolerance gate asks
   "are these two colours near-misses of each other", which is a question about
   the palette, not about the original pixel — so no per-pixel buffer is needed
   to answer it. */
function buildPaletteDistances(matcher) {
  var n = matcher.n, lab = new Float32Array(n * 3), tmp = [0, 0, 0], i;
  for (i = 0; i < n; i++) {
    rgbToOklab(matcher.pr[i], matcher.pg[i], matcher.pb[i], tmp);
    lab[i * 3] = tmp[0]; lab[i * 3 + 1] = tmp[1]; lab[i * 3 + 2] = tmp[2];
  }
  return function (a, b) {
    var d0 = lab[a * 3] - lab[b * 3];
    var d1 = lab[a * 3 + 1] - lab[b * 3 + 1];
    var d2 = lab[a * 3 + 2] - lab[b * 3 + 2];
    return Math.sqrt(d0 * d0 + d1 * d1 + d2 * d2);
  };
}

/* Merge palette entries that sit within `threshold` of each other, then remap
   every pixel onto its cluster representative.

   Doing this at the palette level rather than over a region adjacency graph is
   the whole trick: it is O(n^2) on at most 256 colours instead of O(regions^2)
   on potentially hundreds of thousands, and the output is still built only
   from palette entries. */
function mergeSimilarColors(indices, matcher, threshold, dist) {
  var n = matcher.n, parent = new Int32Array(n), i, j;
  for (i = 0; i < n; i++) parent[i] = i;
  function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }

  for (i = 0; i < n; i++) {
    for (j = i + 1; j < n; j++) {
      if (dist(i, j) <= threshold) {
        var ra = find(i), rb = find(j);
        if (ra !== rb) parent[ra > rb ? ra : rb] = ra < rb ? ra : rb;
      }
    }
  }

  var remap = new Uint16Array(n), changed = false;
  for (i = 0; i < n; i++) { remap[i] = find(i); if (remap[i] !== i) changed = true; }
  if (!changed) return false;

  for (i = 0; i < indices.length; i++) {
    if (indices[i] !== TRANSPARENT) indices[i] = remap[indices[i]];
  }
  return true;
}

/* One modal-filter iteration. Isolated specks are handled by the region pass,
   but antialiased edges produce long connected 1px chains that no area
   threshold can catch — this is what thins those. */
function smoothStipple(indices, w, h, dist, tolerance) {
  var src = new Uint16Array(indices);
  var counts = {}, x, y, i, dy, dx, yy, xx, v, best, bestCount, k;
  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) {
      i = y * w + x;
      var self = src[i];
      if (self === TRANSPARENT) continue;
      counts = {};
      best = -1; bestCount = 0;
      for (dy = -1; dy <= 1; dy++) {
        yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          xx = x + dx; if (xx < 0 || xx >= w) continue;
          v = src[yy * w + xx];
          if (v === TRANSPARENT) continue;
          k = counts[v] = (counts[v] || 0) + 1;
          if (k > bestCount) { bestCount = k; best = v; }
        }
      }
      // Needs a real majority of the 8-neighbourhood, and a near-miss colour.
      if (best >= 0 && best !== self && bestCount >= 5 && dist(self, best) <= tolerance) {
        indices[i] = best;
      }
    }
  }
}

/* 4-connected component labelling over the index map, with an explicit stack —
   a flat sky in a large image is a single region of millions of pixels, which
   would blow the call stack if this recursed.

   4- rather than 8-connectivity is deliberate: under 8-connectivity a diagonal
   pair of specks touches the surrounding field and can never be isolated as a
   small region. */
function labelRegions(indices, w, h) {
  var labels = new Int32Array(w * h).fill(-1);
  var stack = new Int32Array(w * h);
  var areas = [], regionIndex = [];
  var next = 0, i, sp, p, px, py, self;

  for (i = 0; i < w * h; i++) {
    if (labels[i] >= 0 || indices[i] === TRANSPARENT) continue;
    self = indices[i];
    var label = next++;
    var area = 0;
    sp = 0;
    stack[sp++] = i;
    labels[i] = label;
    while (sp > 0) {
      p = stack[--sp];
      area++;
      px = p % w; py = (p / w) | 0;
      if (px > 0     && labels[p - 1] < 0 && indices[p - 1] === self) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (px < w - 1 && labels[p + 1] < 0 && indices[p + 1] === self) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (py > 0     && labels[p - w] < 0 && indices[p - w] === self) { labels[p - w] = label; stack[sp++] = p - w; }
      if (py < h - 1 && labels[p + w] < 0 && indices[p + w] === self) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    areas.push(area);
    regionIndex.push(self);
  }
  return { labels: labels, areas: areas, regionIndex: regionIndex, count: next };
}

/* Absorb every region at or below `maxArea` into the adjacent region it shares
   the most boundary with — provided the two colours are within tolerance.

   That gate is what separates an artifact from a detail. A slightly-off orange
   speck sitting in a field of orange is a near-miss and gets absorbed; a
   genuine black pupil of the same size on the same field is nowhere near it in
   OKLab and survives at any speck size. */
function absorbSmallRegions(indices, labels, regions, w, h, maxArea, tolerance, dist) {
  var count = regions.count, areas = regions.areas, regionIndex = regions.regionIndex;
  var parent = new Int32Array(count), i;
  for (i = 0; i < count; i++) parent[i] = i;
  function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }

  // Gather the pixels of small regions only, grouped by label via counting sort.
  var small = [];
  for (i = 0; i < count; i++) if (areas[i] <= maxArea) small.push(i);
  if (!small.length) return 0;

  var isSmall = new Uint8Array(count);
  var slot = new Int32Array(count).fill(-1);
  for (i = 0; i < small.length; i++) { isSmall[small[i]] = 1; slot[small[i]] = i; }

  var offsets = new Int32Array(small.length + 1);
  for (i = 0; i < w * h; i++) {
    var l = labels[i];
    if (l >= 0 && isSmall[l]) offsets[slot[l] + 1]++;
  }
  for (i = 0; i < small.length; i++) offsets[i + 1] += offsets[i];
  var cursor = new Int32Array(offsets.subarray(0, small.length));
  var pixels = new Int32Array(offsets[small.length]);
  for (i = 0; i < w * h; i++) {
    var l2 = labels[i];
    if (l2 >= 0 && isSmall[l2]) pixels[cursor[slot[l2]]++] = i;
  }

  // Smallest first, so a speck touching another speck resolves in the right order.
  small.sort(function (a, b) { return areas[a] - areas[b]; });

  var absorbed = 0;
  for (var s = 0; s < small.length; s++) {
    var label = small[s];
    if (find(label) !== label) continue;   // already absorbed into something else
    // Absorbing grows the target; once it is no longer small, leave it alone.
    if (areas[label] > maxArea) continue;

    var start = offsets[slot[label]], end = offsets[slot[label] + 1];
    var tally = {}, bestLabel = -1, bestShared = 0;

    for (i = start; i < end; i++) {
      var p = pixels[i];
      var px = p % w, py = (p / w) | 0;
      var nb0 = px > 0 ? p - 1 : -1, nb1 = px < w - 1 ? p + 1 : -1;
      var nb2 = py > 0 ? p - w : -1, nb3 = py < h - 1 ? p + w : -1;
      for (var k = 0; k < 4; k++) {
        var np = k === 0 ? nb0 : k === 1 ? nb1 : k === 2 ? nb2 : nb3;
        if (np < 0) continue;
        var nl = labels[np];
        if (nl < 0) continue;                      // transparent
        nl = find(nl);
        if (nl === label) continue;
        var t = tally[nl] = (tally[nl] || 0) + 1;
        if (t > bestShared) { bestShared = t; bestLabel = nl; }
      }
    }

    if (bestLabel < 0) continue;
    if (dist(regionIndex[label], regionIndex[bestLabel]) > tolerance) continue;

    /* Only the union-find is updated here, not the pixels. A target can itself
       be absorbed later in the pass, and rewriting eagerly would strand the
       pixels this region just donated — they are not in the target's pixel
       list. One resolution pass at the end follows every chain to its root. */
    parent[label] = bestLabel;
    areas[bestLabel] += areas[label];
    absorbed++;
  }

  if (absorbed) {
    for (i = 0; i < w * h; i++) {
      var l3 = labels[i];
      if (l3 < 0) continue;
      var root = find(l3);
      if (root === l3) continue;
      labels[i] = root;
      indices[i] = regionIndex[root];
    }
  }
  return absorbed;
}

/* Paint region boundaries. Edges are found on the final label map, so they
   follow the cleaned-up, merged regions rather than raw mapping noise.

   TWO INVARIANTS, both load-bearing:

   1. Every boundary segment paints exactly ONE pixel. The scan looks only
      right and down, so each segment is visited once and once only, and each
      visit marks a single pixel. A boundary can therefore never be stroked
      twice — once from each side — however the regions are shaped.

      Note what this does *not* claim: two different boundaries lying one pixel
      apart still paint two adjacent pixels, because they are two real edges.
      A one-pixel-wide region between two others produces exactly that, and it
      is what reads as a "doubled" outline. `minArea` is the control for it —
      the sliver stops qualifying and neither of its boundaries is drawn.

   2. Paint never lands on a transparent pixel. Where a region meets
      transparency the mark goes to whichever side is opaque, so a cut-out gets
      a clean edge rather than a halo hanging in the empty space.

   A boundary qualifies when the SMALLER of its two regions meets `minArea`;
   transparency counts as qualifying, so a big region keeps its silhouette. */
function drawOutlines(imageData, labels, w, h, colorHex, width, areas, minArea) {
  var rgb = hexToRgb(colorHex) || [0, 0, 0];
  var edge = new Uint8Array(w * h);
  var x, y, i;

  // Transparent (-1) qualifies; a real region has to earn it on area.
  function qualifies(label) {
    return label < 0 || !minArea || areas[label] >= minArea;
  }

  /* Mark one side of the boundary between `a` and `b`. Prefers the opaque
     pixel; with both opaque it takes `a`, the up/left one, so the choice is
     deterministic and the stroke lands consistently. */
  function mark(a, b) {
    var la = labels[a], lb = labels[b];
    if (la === lb) return;
    if (la < 0 && lb < 0) return;                 // empty space either side
    if (!qualifies(la) || !qualifies(lb)) return;
    edge[la < 0 ? b : a] = 1;
  }

  for (y = 0; y < h; y++) {
    for (x = 0; x < w; x++) {
      i = y * w + x;
      if (x < w - 1) mark(i, i + 1);
      if (y < h - 1) mark(i, i + w);
    }
  }

  // Widen by dilating, again never crossing into transparent pixels.
  for (var pass = 1; pass < width; pass++) {
    var grown = new Uint8Array(edge);
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (edge[i] || labels[i] < 0) continue;
        if ((x > 0 && edge[i - 1]) || (x < w - 1 && edge[i + 1]) ||
            (y > 0 && edge[i - w]) || (y < h - 1 && edge[i + w])) grown[i] = 1;
      }
    }
    edge = grown;
  }

  var d = imageData.data;
  for (i = 0; i < w * h; i++) {
    if (!edge[i]) continue;
    var o = i * 4;
    d[o] = rgb[0]; d[o + 1] = rgb[1]; d[o + 2] = rgb[2]; d[o + 3] = 255;
  }
}

function writeIndices(imageData, indices, matcher) {
  var d = imageData.data, pr = matcher.pr, pg = matcher.pg, pb = matcher.pb;
  for (var i = 0; i < indices.length; i++) {
    var o = i * 4, idx = indices[i];
    if (idx === TRANSPARENT) { d[o] = 0; d[o+1] = 0; d[o+2] = 0; d[o+3] = 0; continue; }
    d[o] = pr[idx]; d[o + 1] = pg[idx]; d[o + 2] = pb[idx]; d[o + 3] = 255;
  }
}

/* Runs everything after mapping. Returns the ImageData, or null if superseded.

   `areaScale` is the working buffer's share of the full-resolution buffer.
   Area thresholds are authored against the source's true resolution and scaled
   through it, because the preview is capped at PREVIEW_MAX and an absolute
   pixel count would otherwise mean something different in each — a 2x
   downscale covers 4x the relative area, so the preview cleaned up far harder
   than the export and the two disagreed. At full resolution this is 1. */
async function postProcess(imageData, indices, matcher, opts, token, onProgress, areaScale) {
  if (!opts.speck && !opts.smoothStipple && !opts.mergeColors && !opts.outline) return imageData;

  var w = imageData.width, h = imageData.height;
  var dist = buildPaletteDistances(matcher);
  var tolerance = opts.tolerance * TOLERANCE_MAX;
  var scale = areaScale == null ? 1 : areaScale;
  var scaleArea = function (v) { return v > 0 ? Math.max(1, Math.round(v * scale)) : 0; };
  var speckArea = scaleArea(opts.speck);
  var outlineMinArea = scaleArea(opts.outlineMin);

  /* Each stage here is a single synchronous sweep, so yielding between them
     unconditionally would cost a clamped macrotask apiece — real money on a
     preview that finishes in single-digit milliseconds. Yield only once enough
     work has actually accumulated to be worth handing the UI a frame. */
  var mark = performance.now();
  async function breathe(p) {
    if (token !== state.renderToken) return false;
    if (onProgress) onProgress(p);
    if (performance.now() - mark > YIELD_MS) {
      await nextTick();
      mark = performance.now();
    }
    return token === state.renderToken;
  }

  if (opts.smoothStipple) smoothStipple(indices, w, h, dist, tolerance);
  if (!await breathe(0.3)) return null;

  if (opts.mergeColors > 0) mergeSimilarColors(indices, matcher, opts.mergeColors / 100 * TOLERANCE_MAX, dist);
  if (!await breathe(0.45)) return null;

  var regions = null;
  if (regionsNeeded(opts)) {
    regions = labelRegions(indices, w, h);
    if (!await breathe(0.7)) return null;

    if (opts.speck > 0) {
      absorbSmallRegions(indices, regions.labels, regions, w, h, speckArea, tolerance, dist);
      if (!await breathe(0.85)) return null;
    }
  }

  writeIndices(imageData, indices, matcher);

  if (opts.outline && regions) {
    drawOutlines(imageData, regions.labels, w, h, opts.outlineColor, opts.outlineWidth,
                 regions.areas, outlineMinArea);
  }

  if (onProgress) onProgress(1);
  return token === state.renderToken ? imageData : null;
}

/* ---------------------------------------------------------------------------
   7. RENDERING TO SCREEN
   ------------------------------------------------------------------------ */

/* Denoise -> map -> clean up / segment / outline. Shared by the preview and
   the full-resolution render so the two can never drift apart. Returns the
   finished ImageData, or null if a newer render superseded this one.

   Progress is split across the three stages by rough cost so the bar advances
   smoothly rather than sitting still through the expensive one. */
var denoiseCache = null;

async function runPipeline(dims, matcher, opts, token) {
  var span = function (from, to) {
    return function (p) { setProgress(from + (to - from) * p); };
  };

  var imageData = drawWork(dims, opts.smooth);

  if (opts.denoise > 0) {
    /* Denoising depends only on the source, the working size and the radius —
       never on the palette, metric, dither or any cleanup setting. Caching it
       keeps dragging those sliders interactive even at a radius that takes
       seconds to compute, which is otherwise the one setting that makes the
       tool feel broken. */
    var key = [state.imgSerial, dims.w, dims.h, opts.smooth ? 1 : 0, opts.denoise].join(':');
    if (denoiseCache && denoiseCache.key === key) {
      imageData.data.set(denoiseCache.data);
    } else {
      imageData = await denoiseBuffer(imageData, opts.denoise, token, span(0, 0.35));
      if (!imageData) return null;
      denoiseCache = { key: key, data: new Uint8ClampedArray(imageData.data) };
    }
  }

  var mapped = await processBuffer(imageData, matcher, opts, token,
    span(opts.denoise > 0 ? 0.35 : 0, postActive(opts) ? 0.8 : 1));
  if (!mapped) return null;

  /* Area thresholds are authored at the source's resolution; the preview works
     on a smaller buffer, so they are scaled by its share of the full one. */
  var full = workDims(opts, true);
  var areaScale = (dims.w * dims.h) / (full.w * full.h);

  return await postProcess(mapped.imageData, mapped.indices, matcher, opts, token,
                           span(0.8, 1), areaScale);
}

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
  var out = await runPipeline(dims, matcher, opts, token);
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
  var out = await runPipeline(dims, matcher, opts, token);
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
    state.imgSerial++;
    denoiseCache = null;
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

  // The off-palette outline notice depends on the palette, so refresh it here.
  updateStageNotes();

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

/* Until the user picks their own, the outline colour follows the palette's
   darkest entry — which is what an outline usually wants to be, and keeps the
   default case from introducing an off-palette colour. */
function syncOutlineColor() {
  if (state.outlineColorTouched || !state.palette.colors.length) return;
  var darkest = state.palette.colors[0], best = Infinity, i, l;
  for (i = 0; i < state.palette.colors.length; i++) {
    l = oklabLightness(state.palette.colors[i]);
    if (l < best) { best = l; darkest = state.palette.colors[i]; }
  }
  els.outlineColor.value = darkest;
}

function setPalette(colors, name, id) {
  state.palette.colors = dedupe(colors).slice(0, MAX_COLORS);
  if (name != null) {
    state.palette.name = name;
    els.palName.value = name;
  }
  state.activeId = id || null;
  state.selected = -1;
  syncOutlineColor();
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
  var theory = els.extractMethod.value === 'theory';
  var colors = theory
    ? extractByTheory(data, n, els.extractScheme.value, +els.extractShift.value / 100)
    : extractPalette(data, n);
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
   9b. PRESETS — the whole page's processing settings, saved under a name
   ---------------------------------------------------------------------------
   Deliberately NOT included: theme, view mode, split position, zoom and the
   live-preview toggle. Those describe how you are looking at the work, not how
   the image is processed — having a preset repaint the whole app or throw away
   your zoom would be a surprise, not a feature.
   ------------------------------------------------------------------------ */

var PRESET_CONTROLS = [
  'pm-metric', 'pm-dither', 'pm-dither-amt', 'pm-pixel', 'pm-smooth', 'pm-alpha-cut',
  'pm-black-point', 'pm-white-point', 'pm-brightness', 'pm-contrast', 'pm-saturation', 'pm-gamma',
  'pm-denoise', 'pm-speck', 'pm-tolerance', 'pm-smooth-stipple',
  'pm-merge-colors', 'pm-outline', 'pm-outline-color', 'pm-outline-width', 'pm-outline-min',
  'pm-export-scale', 'pm-export-full'
];

/* Built-ins store only what they change and are layered over the factory
   defaults, so adding a control later cannot leave them holding a stale value
   for a setting they never had an opinion about. */
var BUILTIN_PRESETS = [
  { id: 'b-cel', name: 'Clean cel art', settings: {
      'pm-metric': 'oklab', 'pm-dither': 'none', 'pm-denoise': '1',
      'pm-speck': '12', 'pm-tolerance': '60', 'pm-smooth-stipple': true } },
  { id: 'b-flat', name: 'Flat poster', settings: {
      'pm-dither': 'none', 'pm-merge-colors': '30', 'pm-speck': '24',
      'pm-tolerance': '70', 'pm-denoise': '1' } },
  { id: 'b-ink', name: 'Ink lines', settings: {
      'pm-dither': 'none', 'pm-merge-colors': '25', 'pm-speck': '16',
      'pm-tolerance': '65', 'pm-outline': true, 'pm-outline-width': '2',
      'pm-outline-min': '24' } },
  { id: 'b-pixel', name: 'Pixel art 8×', settings: {
      'pm-pixel': '8', 'pm-dither': 'none', 'pm-smooth': true,
      'pm-speck': '2', 'pm-tolerance': '50', 'pm-export-scale': '8' } },
  { id: 'b-photo', name: 'Photo dither', settings: {
      'pm-dither': 'fs', 'pm-dither-amt': '100', 'pm-pixel': '1',
      'pm-denoise': '0', 'pm-speck': '0' } }
];

var DEFAULT_SETTINGS = null;   // captured at init, before stored settings load

function captureSettings() {
  var o = {};
  PRESET_CONTROLS.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    o[id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  return o;
}

function applySettings(s) {
  PRESET_CONTROLS.forEach(function (id) {
    if (!(id in s)) return;
    var el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!s[id];
    else el.value = s[id];
  });
  syncSliderLabels();
  updateFooter();
  saveSettings();
  scheduleRender(0);
}

function sameSettings(a, b) {
  if (!a || !b) return false;
  for (var i = 0; i < PRESET_CONTROLS.length; i++) {
    var k = PRESET_CONTROLS[i];
    /* While the outline colour is still tracking the palette's darkest entry
       it is derived, not chosen — comparing it would report every palette as a
       modification and the note would never read "Defaults". */
    if (k === 'pm-outline-color' && !state.outlineColorTouched) continue;
    if (String(a[k]) !== String(b[k])) return false;
  }
  return true;
}

function allPresets() { return BUILTIN_PRESETS.concat(state.presets); }

function renderPresetList() {
  var sel = els.setup;
  sel.innerHTML = '';
  var blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Load a preset…';
  sel.appendChild(blank);

  var mk = function (label, list) {
    if (!list.length) return;
    var group = document.createElement('optgroup');
    group.label = label;
    list.forEach(function (p) {
      var o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name + (p.palette ? ' ◦' : '');
      group.appendChild(o);
    });
    sel.appendChild(group);
  };
  mk('Built in', BUILTIN_PRESETS);
  mk('Saved', state.presets);
  sel.value = state.activePresetId || '';
}

/* The header note answers "is what I am looking at still the preset I loaded?" */
function updatePresetNote() {
  if (!els.setupNote) return;
  var current = captureSettings();
  var active = state.activePresetId
    ? allPresets().filter(function (p) { return p.id === state.activePresetId; })[0]
    : null;

  if (active) {
    var full = Object.assign({}, DEFAULT_SETTINGS, active.settings);
    els.setupNote.textContent = active.name + (sameSettings(current, full) ? '' : ' · modified');
  } else if (DEFAULT_SETTINGS && sameSettings(current, DEFAULT_SETTINGS)) {
    els.setupNote.textContent = 'Defaults';
  } else {
    els.setupNote.textContent = 'Custom';
  }
}

function applyPreset(id) {
  var p = allPresets().filter(function (x) { return x.id === id; })[0];
  if (!p) return;
  applySettings(Object.assign({}, DEFAULT_SETTINGS, p.settings));
  /* Restore whether the outline colour was deliberately chosen. Without this a
     preset that carries its own outline colour would have it overwritten by
     the palette's darkest entry the moment the preset's palette loads below. */
  state.outlineColorTouched = !!p.outlineColorTouched;
  if (p.palette && els.setupPalette.checked && p.palette.colors && p.palette.colors.length) {
    setPalette(p.palette.colors.slice(), p.palette.name, null);
  }
  state.activePresetId = id;
  els.setupName.value = p.name;
  renderPresetList();
  updatePresetNote();
  saveSettings();
  toast('Loaded "' + p.name + '"');
}

function savePreset() {
  var name = (els.setupName.value || '').trim();
  if (!name) { toast('Give the preset a name first.', true); return; }

  var existing = state.presets.filter(function (p) {
    return p.name.toLowerCase() === name.toLowerCase();
  })[0];

  var payload = {
    settings: captureSettings(),
    outlineColorTouched: !!state.outlineColorTouched,
    palette: els.setupPalette.checked && state.palette.colors.length
      ? { name: els.palName.value || 'Untitled', colors: state.palette.colors.slice() }
      : null
  };

  if (existing) {
    existing.settings = payload.settings;
    existing.palette = payload.palette;
    existing.outlineColorTouched = payload.outlineColorTouched;
    state.activePresetId = existing.id;
    toast('Updated "' + name + '"');
  } else {
    var preset = { id: 's' + Date.now().toString(36), name: name,
                   settings: payload.settings, palette: payload.palette,
                   outlineColorTouched: payload.outlineColorTouched };
    state.presets.unshift(preset);
    state.activePresetId = preset.id;
    toast('Saved "' + name + '"');
  }
  lsSet(LS_PRESETS, state.presets);
  renderPresetList();
  updatePresetNote();
  saveSettings();
}

function deletePreset() {
  var id = state.activePresetId;
  if (!id) { toast('No preset selected.', true); return; }
  if (/^b-/.test(id)) { toast('Built-in presets cannot be deleted.', true); return; }
  var p = state.presets.filter(function (x) { return x.id === id; })[0];
  state.presets = state.presets.filter(function (x) { return x.id !== id; });
  state.activePresetId = null;
  lsSet(LS_PRESETS, state.presets);
  els.setupName.value = '';
  renderPresetList();
  updatePresetNote();
  saveSettings();
  if (p) toast('Deleted "' + p.name + '"');
}

function resetToDefaults() {
  applySettings(DEFAULT_SETTINGS);
  state.activePresetId = null;
  els.setupName.value = '';
  renderPresetList();
  updatePresetNote();
  saveSettings();
  setStatus('Settings reset to defaults');
}

/* --- Your saved work as a file --------------------------------------------
   Presets and the palette library otherwise only exist in localStorage, which
   is one cache clear — or one new browser — away from gone. Export writes both
   to a plain JSON file; import reads one back, on this machine or another.

   Both halves travel together because they refer to each other: a preset can
   carry a palette, and splitting them across two files is how you end up with
   half a backup.
   ------------------------------------------------------------------------ */

function dataFilename() {
  return 'palette-mapper-' + new Date().toISOString().slice(0, 10) + '.json';
}

function countLabel(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

function exportData() {
  if (!state.presets.length && !state.library.length) {
    toast('Nothing saved to export yet.', true);
    return;
  }
  var payload = {
    format: DATA_FILE_FORMAT,
    version: 1,
    exported: new Date().toISOString(),
    /* Built-in presets and the built-in palettes aren't written: every copy of
       the page already has them, and a stale copy in a file would only fight
       the current one on import. */
    presets: state.presets,
    palettes: state.library
  };
  downloadText(JSON.stringify(payload, null, 2), dataFilename(), 'application/json');

  var parts = [];
  if (state.presets.length) parts.push(countLabel(state.presets.length, 'preset', 'presets'));
  if (state.library.length) parts.push(countLabel(state.library.length, 'palette', 'palettes'));
  toast('Exported ' + parts.join(' and '));
}

/* Colours out of a file go through the same normaliser as pasted text, so
   '#0f0', '0F0' and rubbish all end up either a full #rrggbb or dropped. */
function sanitizeColors(raw) {
  var colors = [];
  if (!Array.isArray(raw)) return colors;
  raw.forEach(function (c) {
    if (colors.length >= MAX_COLORS) return;
    var hex = typeof c === 'string' ? normalizeHex(c) : null;
    if (hex) colors.push(hex);
  });
  return colors;
}

function sanitizePalette(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var colors = sanitizeColors(raw.colors);
  if (!colors.length) return null;
  return {
    id: newId('p'),
    name: (typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '') || 'Untitled',
    colors: colors
  };
}

/* Nothing from a file is trusted: only known control ids survive, only the
   value types the controls actually take, and colours must parse as hex. A
   preset that carries nothing usable is dropped rather than half-applied. */
function sanitizePreset(raw) {
  if (!raw || typeof raw !== 'object') return null;

  var name = typeof raw.name === 'string' ? raw.name.trim().slice(0, 40) : '';
  if (!name) return null;

  var src = (raw.settings && typeof raw.settings === 'object') ? raw.settings : {};
  var settings = {}, kept = 0;
  PRESET_CONTROLS.forEach(function (id) {
    if (!(id in src)) return;
    var v = src[id];
    if (typeof v === 'boolean') { settings[id] = v; kept++; }
    else if (typeof v === 'number' && isFinite(v)) { settings[id] = String(v); kept++; }
    else if (typeof v === 'string') { settings[id] = v; kept++; }
  });
  if (!kept) return null;

  var palette = null;
  if (raw.palette && typeof raw.palette === 'object') {
    var colors = sanitizeColors(raw.palette.colors);
    if (colors.length) {
      palette = { name: String(raw.palette.name || 'Untitled').slice(0, 40), colors: colors };
    }
  }

  return {
    id: newId('s'),
    name: name,
    settings: settings,
    palette: palette,
    outlineColorTouched: !!raw.outlineColorTouched
  };
}

/* Ids from the file are discarded and reissued — nothing imported may collide
   with a built-in preset or with something already saved here. */
var idSeq = 0;
function newId(prefix) {
  return prefix + Date.now().toString(36) + '-' + (idSeq++).toString(36);
}

/* Both lists merge by name, the way Save does — re-importing your own file
   after a few edits updates those entries instead of doubling them, and an
   import never touches anything you named something else. */
function mergeByName(list, incoming, apply) {
  var fresh = [], updated = 0, skipped = 0;
  incoming.forEach(function (raw) {
    var item = apply.clean(raw);
    if (!item) { skipped++; return; }
    var existing = list.filter(function (x) {
      return String(x.name).toLowerCase() === item.name.toLowerCase();
    })[0];
    if (existing) { apply.onto(existing, item); updated++; }
    else fresh.push(item);
  });
  return { list: fresh.concat(list), added: fresh.length, updated: updated, skipped: skipped };
}

function tally(label, r) {
  var parts = [];
  if (r.added) parts.push(r.added + ' added');
  if (r.updated) parts.push(r.updated + ' updated');
  if (r.skipped) parts.push(r.skipped + ' skipped');
  return parts.length ? label + ': ' + parts.join(', ') : '';
}

function importData(data, label) {
  /* A bare array is read as presets — that was the shape of the first files
     this wrote, and it is the only thing a top-level array could sensibly be. */
  var presetsIn = Array.isArray(data) ? data
    : (data && Array.isArray(data.presets)) ? data.presets : null;
  var palettesIn = (data && Array.isArray(data.palettes)) ? data.palettes : null;
  if (!presetsIn && !palettesIn) { toast('No presets or palettes found in ' + label, true); return; }

  var pres = mergeByName(state.presets, presetsIn || [], {
    clean: sanitizePreset,
    onto: function (existing, item) {
      existing.settings = item.settings;
      existing.palette = item.palette;
      existing.outlineColorTouched = item.outlineColorTouched;
    }
  });
  var pals = mergeByName(state.library, palettesIn || [], {
    clean: sanitizePalette,
    onto: function (existing, item) { existing.colors = item.colors; }
  });

  if (!pres.added && !pres.updated && !pals.added && !pals.updated) {
    toast('Nothing usable in ' + label, true);
    return;
  }

  var stored = true;
  if (pres.added || pres.updated) {
    state.presets = pres.list;
    stored = lsSet(LS_PRESETS, state.presets) && stored;
    renderPresetList();
    updatePresetNote();
  }
  if (pals.added || pals.updated) {
    state.library = pals.list;
    stored = lsSet(LS_PALETTES, state.library) && stored;
    renderLibrary();
  }

  toast([tally('Presets', pres), tally('Palettes', pals)]
    .filter(function (s) { return s; }).join(' · '));
  setStatus(stored
    ? 'Imported from ' + label
    : 'Imported from ' + label + ' — could not be saved to this browser');
}

function loadDataFile(file) {
  var reader = new FileReader();
  reader.onerror = function () { toast('Could not read ' + file.name, true); };
  reader.onload = function () {
    var data;
    try { data = JSON.parse(reader.result); }
    catch (e) { toast(file.name + ' is not valid JSON.', true); return; }
    importData(data, file.name);
  };
  reader.readAsText(file);
}

/* ---------------------------------------------------------------------------
   9c. THE CARD RAILS — folding and reordering
   ---------------------------------------------------------------------------
   Eleven cards is more than fits a laptop rail at once, and which of them
   matter depends entirely on what you are doing. So: clicking a card's header
   collapses it to its title band, and dragging a header moves the card — up
   and down its own rail, or across to the other one. Both are remembered.

   Pointer events rather than HTML5 drag-and-drop, unlike the swatches above:
   `dragstart` never fires on touch, and a card is exactly the kind of thing
   someone rearranges on a tablet. The cost is doing the hit-testing by hand.
   ------------------------------------------------------------------------ */

function cardSections() {
  return [].slice.call(document.querySelectorAll('.pm-section[data-card]'));
}

function cardId(section) { return section.getAttribute('data-card'); }
function cardTitle(section) {
  var t = section.querySelector('.pm-section-title');
  return t ? t.textContent : 'Card';
}

/* --- Folding -------------------------------------------------------------
   Two levels fold on one mechanism: whole cards, and the sub-sections inside
   the few cards that carry a second job (Library's import and export halves,
   Segment's outline block). A sub-section is just another element with an id
   and a collapsed flag, so the only thing that differs is which button
   carries the state — and both ids share one list in storage, since they are
   ids of things that are collapsed and nothing else about them matters.
   ------------------------------------------------------------------------ */

function foldables() {
  return [].slice.call(document.querySelectorAll('.pm-section[data-card], .pm-group[data-group]'));
}

function foldId(el) {
  return el.getAttribute('data-card') || el.getAttribute('data-group');
}

/* Each card has exactly one .pm-fold (in its header) and each group exactly
   one .pm-subfold, so neither lookup can reach into the other's territory. */
function foldButton(el) {
  return el.classList.contains('pm-group')
    ? el.querySelector('.pm-subfold')
    : el.querySelector('.pm-fold');
}

function setFold(el, collapsed) {
  el.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
  var btn = foldButton(el);
  if (btn) btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function saveFolds() {
  lsSet(LS_FOLDS, foldables()
    .filter(function (el) { return el.getAttribute('data-collapsed') === 'true'; })
    .map(foldId));
}

/* --- Order -------------------------------------------------------------- */

function railKey(rail) { return rail === els.railRight ? 'right' : 'left'; }

function saveCardOrder() {
  var order = { left: [], right: [] };
  cardSections().forEach(function (s) {
    var rail = s.closest('.pm-rail');
    if (rail) order[railKey(rail)].push(cardId(s));
  });
  lsSet(LS_CARD_ORDER, order);
}

function applyCardOrder() {
  var saved = lsGet(LS_CARD_ORDER);
  if (!saved) return;
  [['left', els.railLeft], ['right', els.railRight]].forEach(function (pair) {
    var list = saved[pair[0]];
    if (!Array.isArray(list)) return;
    list.forEach(function (id) {
      /* Searched across the whole page, not just this rail — that is what lets
         a card that was dragged to the other side come back to it. */
      var sec = document.querySelector('.pm-section[data-card="' + id + '"]');
      if (sec) pair[1].appendChild(sec);
    });
  });
  /* Anything the saved order doesn't name — a card added to the page in a
     later version — keeps its place in the markup, which leaves it above the
     restored ones rather than silently missing. */
}

/* Move a card one place within its rail. This is the keyboard path, and the
   reason the drag isn't the only way: Alt+Arrow on a focused header. */
function moveCard(section, dir) {
  var rail = section.closest('.pm-rail');
  if (!rail) return;
  var sibling = dir < 0 ? section.previousElementSibling : section.nextElementSibling;
  if (!sibling) { setStatus(cardTitle(section) + ' is already at the ' + (dir < 0 ? 'top' : 'bottom')); return; }
  if (dir < 0) rail.insertBefore(section, sibling);
  else rail.insertBefore(sibling, section);
  saveCardOrder();
  /* Moving a node in the DOM can drop focus, and a keyboard user who has just
     pressed Alt+Down needs to still be on the card to press it again. */
  var btn = section.querySelector('.pm-fold');
  if (btn) btn.focus();
  section.scrollIntoView({ block: 'nearest' });
  setStatus('Moved ' + cardTitle(section) + ' ' + (dir < 0 ? 'up' : 'down'));
}

/* --- Dragging ----------------------------------------------------------- */

var cardDrag = null;       // the drag in progress, or null
var justDragged = false;   // suppresses the fold click that follows a drag

var DRAG_SLOP = 5;         // px of movement before a press becomes a drag
var EDGE_ZONE = 56;        // px from a rail edge where it starts auto-scrolling
var EDGE_SPEED = 10;       // px per frame

function railUnder(x, y) {
  var el = document.elementFromPoint(x, y);
  return el ? el.closest('.pm-rail') : null;
}

/* Where would the card land if it were dropped here? The first card whose
   middle is below the pointer — the standard insertion rule, and the reason
   the layout under the pointer reads as the result rather than a preview. */
function placeCard(rail, y) {
  var section = cardDrag.section;
  var before = null;
  [].slice.call(rail.children).forEach(function (child) {
    if (before || child === section || !child.hasAttribute('data-card')) return;
    var r = child.getBoundingClientRect();
    if (y < r.top + r.height / 2) before = child;
  });
  // Already exactly there — moving the node again would only cost a reflow.
  if (section.parentNode === rail && before === section.nextElementSibling) return;
  rail.insertBefore(section, before);
}

function edgeScroll() {
  if (!cardDrag || !cardDrag.active) return;
  var rail = cardDrag.rail;
  if (rail && cardDrag.scrollDir) {
    var before = rail.scrollTop;
    rail.scrollTop += cardDrag.scrollDir * EDGE_SPEED;
    // Scrolling moves the cards under a stationary pointer, so re-place.
    if (rail.scrollTop !== before) placeCard(rail, cardDrag.y);
  }
  requestAnimationFrame(edgeScroll);
}

function startCardDrag(e, section, fromGrip) {
  if (e.button != null && e.button !== 0) return;          // left button only
  if (e.pointerType === 'touch' && !fromGrip) return;      // touch drags by the grip
  if (e.target.closest('button:not(.pm-fold), input, select, a')) return;
  cardDrag = {
    section: section,
    id: e.pointerId,
    x: e.clientX, y: e.clientY,
    fromX: e.clientX, fromY: e.clientY,
    rail: section.closest('.pm-rail'),
    scrollDir: 0,
    active: false
  };
}

function moveCardDrag(e) {
  var d = cardDrag;
  if (!d || e.pointerId !== d.id) return;
  d.x = e.clientX;
  d.y = e.clientY;

  if (!d.active) {
    if (Math.abs(e.clientX - d.fromX) < DRAG_SLOP && Math.abs(e.clientY - d.fromY) < DRAG_SLOP) return;
    d.active = true;
    d.section.setAttribute('data-dragging', 'true');
    document.body.classList.add('pm-card-drag');
    requestAnimationFrame(edgeScroll);
  }
  e.preventDefault();

  var rail = railUnder(e.clientX, e.clientY) || d.rail;
  d.rail = rail;
  placeCard(rail, e.clientY);

  var r = rail.getBoundingClientRect();
  d.scrollDir = e.clientY < r.top + EDGE_ZONE ? -1
    : e.clientY > r.bottom - EDGE_ZONE ? 1 : 0;
}

function endCardDrag(e) {
  var d = cardDrag;
  if (!d || (e && e.pointerId !== d.id)) return;
  cardDrag = null;
  if (!d.active) return;
  d.section.removeAttribute('data-dragging');
  document.body.classList.remove('pm-card-drag');
  saveCardOrder();
  /* The pointerup is about to become a click on the header. That click means
     "fold" only if the press stayed still. */
  justDragged = true;
  setTimeout(function () { justDragged = false; }, 0);
}

function wireCards() {
  applyCardOrder();

  var stored = lsGet(LS_FOLDS);
  if (!Array.isArray(stored)) stored = [];

  /* Cards and sub-sections share the fold wiring; only cards go on to get the
     drag and the Alt+Arrow keys. */
  foldables().forEach(function (el) {
    setFold(el, stored.indexOf(foldId(el)) !== -1);
    var btn = foldButton(el);
    if (!btn) return;
    btn.addEventListener('click', function () {
      if (justDragged) return;
      setFold(el, el.getAttribute('data-collapsed') !== 'true');
      saveFolds();
    });
  });

  cardSections().forEach(function (section) {
    var header = section.querySelector('.cc-card-header');
    var btn = section.querySelector('.pm-fold');
    if (!header || !btn) return;

    btn.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    btn.title = 'Click to fold — drag, or Alt+↑/↓, to move this card';
    btn.addEventListener('keydown', function (e) {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      moveCard(section, e.key === 'ArrowUp' ? -1 : 1);
    });

    header.addEventListener('pointerdown', function (e) {
      startCardDrag(e, section, !!e.target.closest('.pm-grip'));
    });
  });

  /* The rest of the gesture is watched on the document rather than the header:
     the pointer leaves a 25px band immediately, and a drag that stops tracking
     the moment it does is worse than no drag at all. */
  document.addEventListener('pointermove', moveCardDrag);
  document.addEventListener('pointerup', endCardDrag);
  document.addEventListener('pointercancel', endCardDrag);
  window.addEventListener('blur', function () { endCardDrag(null); });
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
    denoise: els.denoise.value,
    speck: els.speck.value,
    tolerance: els.tolerance.value,
    smoothStipple: els.smoothStipple.checked,
    mergeColors: els.mergeColors.value,
    outline: els.outline.checked,
    outlineColor: els.outlineColor.value,
    outlineWidth: els.outlineWidth.value,
    outlineMin: els.outlineMin.value,
    outlineColorTouched: state.outlineColorTouched,
    blackPoint: els.blackPoint.value,
    whitePoint: els.whitePoint.value,
    brightness: els.brightness.value,
    contrast: els.contrast.value,
    saturation: els.saturation.value,
    gamma: els.gamma.value,
    exportScale: els.exportScale.value,
    exportFull: els.exportFull.checked,
    live: els.live.checked,
    extractN: els.extractN.value,
    extractMethod: els.extractMethod.value,
    extractScheme: els.extractScheme.value,
    extractShift: els.extractShift.value,
    activePresetId: state.activePresetId,
    setupPalette: els.setupPalette.checked,
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
  if (s.denoise != null) els.denoise.value = s.denoise;
  if (s.speck != null) els.speck.value = s.speck;
  if (s.tolerance != null) els.tolerance.value = s.tolerance;
  if (s.smoothStipple != null) els.smoothStipple.checked = !!s.smoothStipple;
  if (s.mergeColors != null) els.mergeColors.value = s.mergeColors;
  if (s.outline != null) els.outline.checked = !!s.outline;
  if (s.outlineColor) els.outlineColor.value = s.outlineColor;
  if (s.outlineWidth != null) els.outlineWidth.value = s.outlineWidth;
  if (s.outlineMin != null) els.outlineMin.value = s.outlineMin;
  state.outlineColorTouched = !!s.outlineColorTouched;
  if (s.blackPoint != null) els.blackPoint.value = s.blackPoint;
  if (s.whitePoint != null) els.whitePoint.value = s.whitePoint;
  if (s.brightness != null) els.brightness.value = s.brightness;
  if (s.contrast != null) els.contrast.value = s.contrast;
  if (s.saturation != null) els.saturation.value = s.saturation;
  if (s.gamma != null) els.gamma.value = s.gamma;
  if (s.exportScale != null) els.exportScale.value = s.exportScale;
  if (s.exportFull != null) els.exportFull.checked = !!s.exportFull;
  if (s.live != null) els.live.checked = !!s.live;
  if (s.extractN != null) els.extractN.value = s.extractN;
  if (s.extractMethod) els.extractMethod.value = s.extractMethod;
  if (s.extractScheme) els.extractScheme.value = s.extractScheme;
  if (s.extractShift != null) els.extractShift.value = s.extractShift;
  if (s.activePresetId) state.activePresetId = s.activePresetId;
  if (s.setupPalette != null) els.setupPalette.checked = !!s.setupPalette;
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
  els.blackPointVal.textContent = +els.blackPoint.value ? els.blackPoint.value : 'Off';
  els.whitePointVal.textContent = +els.whitePoint.value < 255 ? els.whitePoint.value : 'Off';
  els.brightnessVal.textContent = els.brightness.value;
  els.contrastVal.textContent = els.contrast.value;
  els.saturationVal.textContent = els.saturation.value;
  els.gammaVal.textContent = (+els.gamma.value / 100).toFixed(2);
  els.exportScaleVal.textContent = els.exportScale.value + '×';
  els.extractNVal.textContent = els.extractN.value;
  els.extractShiftVal.textContent = els.extractShift.value + '%';
  els.alphaCutVal.textContent = els.alphaCut.value;

  var dn = +els.denoise.value;
  els.denoiseVal.textContent = dn ? (dn * 2 + 1) + '×' + (dn * 2 + 1) : 'Off';
  els.speckVal.textContent = +els.speck.value ? els.speck.value + ' px' : 'Off';
  els.toleranceVal.textContent = els.tolerance.value + '%';
  els.mergeColorsVal.textContent = +els.mergeColors.value ? els.mergeColors.value : 'Off';
  /* Each step past the first dilates the edge outward on both sides, so the
     painted band is 2n-1 wide. Report the width actually drawn. */
  els.outlineWidthVal.textContent = (+els.outlineWidth.value * 2 - 1) + ' px';
  els.outlineMinVal.textContent = +els.outlineMin.value ? '≥ ' + els.outlineMin.value + ' px' : 'Off';
  updateStageNotes();
  // Every control change routes through here, so this is where "still the
  // preset I loaded?" gets re-answered.
  updatePresetNote();
}

/* The two new cards summarise themselves in their header, so their state is
   readable when the rail is scrolled past them. */
function updateStageNotes() {
  var parts = [];
  if (+els.denoise.value) parts.push('denoise ' + els.denoise.value);
  if (+els.speck.value) parts.push('≤' + els.speck.value + 'px');
  if (els.smoothStipple.checked) parts.push('stipple');
  els.cleanNote.textContent = parts.length ? parts.join(' · ') : 'Off';

  var seg = [];
  if (+els.mergeColors.value) seg.push('merge ' + els.mergeColors.value);
  if (els.outline.checked) {
    seg.push('outline ' + (+els.outlineWidth.value * 2 - 1) + 'px');
    if (+els.outlineMin.value) seg.push('≥' + els.outlineMin.value + 'px');
    /* Outlines take a free colour, so they are the one thing that can put a
       colour in the output that is not in the palette. Say so rather than let
       the tool's central claim quietly stop being true. */
    if (state.palette.colors.indexOf(normalizeHex(els.outlineColor.value)) < 0) {
      seg.push('+1 off-palette');
    }
  }
  els.segmentNote.textContent = seg.length ? seg.join(' · ') : 'Off';
}

/* --- Mobile panels -------------------------------------------------------
   Below the breakpoint the rails are sheets that slide over the stage, driven
   by the bottom nav. `data-panel` on <body> is the single source of truth; the
   CSS does the rest. */
function setPanel(which) {
  state.panel = which;
  if (which === 'none') document.body.removeAttribute('data-panel');
  else document.body.setAttribute('data-panel', which);
  press(els.navImage, which === 'none');
  press(els.navPalette, which === 'palette');
  press(els.navProcess, which === 'process');
  /* A sheet that has slid off-screen is still in the DOM, so without `inert`
     its buttons stay in the tab order — and aria-hidden over focusable content
     is exactly the combination that strands a keyboard user on a control they
     cannot see. `inert` takes care of both. */
  setHidden(els.railLeft, which !== 'palette');
  setHidden(els.railRight, which !== 'process');
}

function setHidden(el, hidden) {
  if (hidden) {
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('inert', '');
  } else {
    el.removeAttribute('aria-hidden');
    el.removeAttribute('inert');
  }
}

/* The sheets only exist below the breakpoint. Above it both rails are always
   on screen, so leaving aria-hidden on them would hide half the app from a
   screen reader on a desktop resize. */
function syncPanelForWidth() {
  var mobile = window.matchMedia('(max-width: 900px)').matches;
  if (!mobile) {
    document.body.removeAttribute('data-panel');
    state.panel = 'none';
    setHidden(els.railLeft, false);
    setHidden(els.railRight, false);
    press(els.navImage, true);
    press(els.navPalette, false);
    press(els.navProcess, false);
  } else {
    setPanel(state.panel || 'none');
  }
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
    'denoise', 'speck', 'tolerance', 'smoothStipple',
    'mergeColors', 'outline', 'outlineColor', 'outlineWidth', 'outlineMin',
    'cleanNote', 'segmentNote',
    'setup', 'setupName', 'setupPalette', 'setupNote', 'setupFile',
    'blackPoint', 'whitePoint', 'brightness', 'contrast', 'saturation', 'gamma',
    'exportScale', 'exportFull', 'time', 'workDims', 'exportDims',
    'viewport', 'drop', 'splitHandle', 'zoomVal',
    'extractN', 'extractMethod', 'extractScheme', 'extractShift'
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
  els.editorLeft = $('pm-editor-left');
  els.editorRight = $('pm-editor-right');
  els.navImage = $('pm-nav-image');
  els.navPalette = $('pm-nav-palette');
  els.navProcess = $('pm-nav-process');
  els.scrim = $('pm-scrim');
  els.railLeft = document.querySelector('.pm-rail--left');
  els.railRight = document.querySelector('.pm-rail--right');
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
  els.blackPointVal = $('pm-black-point-val');
  els.whitePointVal = $('pm-white-point-val');
  els.brightnessVal = $('pm-brightness-val');
  els.contrastVal = $('pm-contrast-val');
  els.saturationVal = $('pm-saturation-val');
  els.gammaVal = $('pm-gamma-val');
  els.exportScaleVal = $('pm-export-scale-val');
  els.extractNVal = $('pm-extract-n-val');
  els.extractShiftVal = $('pm-extract-shift-val');
  els.alphaCutVal = $('pm-alpha-cut-val');
  els.denoiseVal = $('pm-denoise-val');
  els.speckVal = $('pm-speck-val');
  els.toleranceVal = $('pm-tolerance-val');
  els.mergeColorsVal = $('pm-merge-colors-val');
  els.outlineWidthVal = $('pm-outline-width-val');
  els.outlineMinVal = $('pm-outline-min-val');
  els.palFile = $('pm-pal-file');
}

function wireImageInput() {
  els.open.addEventListener('click', function () { els.file.click(); });
  /* Ctrl+V does not exist on a phone, so the drop zone needs its own way in. */
  $('pm-drop-open').addEventListener('click', function () { els.file.click(); });
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

/* An exported backup is JSON full of hex codes, so left to itself the palette
   parser would happily scrape them into one flat palette. The format marker
   written on export says what the file really is. */
function asDataFile(text) {
  var data;
  try { data = JSON.parse(text); }
  catch (e) { return null; }
  if (!data || data.format !== DATA_FILE_FORMAT) return null;
  return (Array.isArray(data.presets) || Array.isArray(data.palettes)) ? data : null;
}

function loadPaletteFile(file) {
  var reader = new FileReader();
  var isAct = /\.act$/i.test(file.name);
  reader.onload = function () {
    if (!isAct) {
      var backup = asDataFile(reader.result);
      if (backup) { importData(backup, file.name); return; }
    }
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

  function moveSwatch(delta) {
    var from = state.selected;
    if (from < 0) return;
    var to = from + delta;
    if (to < 0 || to >= state.palette.colors.length) return;
    var moved = state.palette.colors.splice(from, 1)[0];
    state.palette.colors.splice(to, 0, moved);
    state.selected = to;
    renderSwatches();
    saveCurrent();
    scheduleRender(0);
  }
  els.editorLeft.addEventListener('click', function () { moveSwatch(-1); });
  els.editorRight.addEventListener('click', function () { moveSwatch(1); });

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
    state.palette.colors = sortIntoRamps(state.palette.colors);
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

  window.addEventListener('resize', function () {
    syncPanelForWidth();
    if (state.zoom === 'fit') layoutCanvases();
  });

  els.navImage.addEventListener('click', function () { setPanel('none'); });
  els.navPalette.addEventListener('click', function () {
    setPanel(state.panel === 'palette' ? 'none' : 'palette');
  });
  els.navProcess.addEventListener('click', function () {
    setPanel(state.panel === 'process' ? 'none' : 'process');
  });
  els.scrim.addEventListener('click', function () { setPanel('none'); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.panel !== 'none') setPanel('none');
  });
}

function wireControls() {
  els.theme.addEventListener('change', function () {
    document.documentElement.setAttribute('data-cc-theme', els.theme.value);
    saveSettings();
  });

  // Anything that changes the mapping re-renders; anything cosmetic doesn't.
  [els.metric, els.dither, els.pixel, els.smooth, els.alphaCut,
   els.blackPoint, els.whitePoint, els.brightness, els.contrast, els.saturation, els.gamma, els.ditherAmt,
   els.denoise, els.speck, els.tolerance, els.smoothStipple,
   els.mergeColors, els.outline, els.outlineWidth, els.outlineMin].forEach(function (el) {
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

  /* Harmony and hue shift only mean anything to the constructed ramps, so they
     grey out when the sampling method is selected rather than sitting there
     looking live and doing nothing. */
  function syncExtractMode() {
    var theory = els.extractMethod.value === 'theory';
    els.extractScheme.disabled = !theory;
    els.extractShift.disabled = !theory;
  }
  els.extractMethod.addEventListener('change', function () { syncExtractMode(); saveSettings(); });
  els.extractScheme.addEventListener('change', saveSettings);
  els.extractShift.addEventListener('input', function () { syncSliderLabels(); saveSettings(); });
  syncExtractMode();

  els.setup.addEventListener('change', function () {
    if (els.setup.value) applyPreset(els.setup.value);
  });
  $('pm-setup-save').addEventListener('click', savePreset);
  $('pm-setup-delete').addEventListener('click', deletePreset);
  $('pm-setup-reset').addEventListener('click', resetToDefaults);
  $('pm-setup-export').addEventListener('click', exportData);
  $('pm-setup-import').addEventListener('click', function () { els.setupFile.click(); });
  els.setupFile.addEventListener('change', function () {
    if (els.setupFile.files && els.setupFile.files[0]) loadDataFile(els.setupFile.files[0]);
    els.setupFile.value = '';   // so re-picking the same file fires again
  });
  els.setupName.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); savePreset(); }
  });
  // Re-saving with the palette box toggled changes what a preset carries.
  els.setupPalette.addEventListener('change', saveSettings);

  /* Touching the picker opts out of tracking the palette's darkest entry. */
  els.outlineColor.addEventListener('input', function () {
    state.outlineColorTouched = true;
    updateStageNotes();
    saveSettings();
    scheduleRender();
  });

  els.live.addEventListener('change', function () {
    saveSettings();
    if (els.live.checked) scheduleRender(0);
  });

  $('pm-adjust-reset').addEventListener('click', function () {
    els.blackPoint.value = 0;
    els.whitePoint.value = 255;
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
  /* Snapshot the markup's own values before anything stored overwrites them —
     this is what "Defaults" restores to, and what built-in presets layer on. */
  DEFAULT_SETTINGS = captureSettings();
  loadSettings();

  state.library = lsGet(LS_PALETTES) || [];
  state.presets = lsGet(LS_PRESETS) || [];
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

  syncOutlineColor();
  renderSwatches();
  renderLibrary();
  renderPresetList();
  syncSliderLabels();
  updateFooter();
  applyView();

  var activePreset = allPresets().filter(function (p) { return p.id === state.activePresetId; })[0];
  if (activePreset) els.setupName.value = activePreset.name;
  updatePresetNote();
  syncPanelForWidth();

  wireImageInput();
  wirePaletteUI();
  wireStage();
  wireControls();
  wireCards();

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
    extractPalette: extractPalette,
    extractByTheory: extractByTheory,
    buildRamp: buildRamp,
    fitToGamut: fitToGamut,
    oklch: oklch,
    sortIntoRamps: sortIntoRamps,
    labelRegions: labelRegions,
    denoiseBuffer: denoiseBuffer,
    syncOutlineColor: syncOutlineColor,
    captureSettings: captureSettings,
    applyPreset: applyPreset,
    savePreset: savePreset,
    resetToDefaults: resetToDefaults,
    exportData: exportData,
    importData: importData,
    sanitizePreset: sanitizePreset,
    sanitizePalette: sanitizePalette,
    setFold: setFold,
    moveCard: moveCard,
    saveCardOrder: saveCardOrder,
    BUILTIN_PRESETS: BUILTIN_PRESETS
  };
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();
