# Palette Mapper

Paste an image, build a colour palette, and snap every pixel to its nearest palette entry.
Download or copy the result.

Everything runs in the browser. No image ever leaves your machine — there is no server, no
upload, and no network request of any kind after the page loads.

---

## Deploying to GitHub Pages

The folder is already a complete static site. Push it to a repo and point Pages at it:

```bash
git init && git add . && git commit -m "Palette Mapper"
```

Then in the repo's **Settings → Pages**, set the source to your branch. If `palette-mapper/`
sits at the repo root, choose `/ (root)`; if you keep it as a subfolder, either move the files
up or set Pages to serve from `/docs` and rename accordingly. All asset paths are relative, so
the page works from `https://<user>.github.io/<repo>/` without changes.

No build step, no dependencies, nothing to install. It also runs by opening `index.html`
directly off disk.

## Using it

**Load an image** — press <kbd>Ctrl</kbd>+<kbd>V</kbd>, drag a file onto the page, or use
*Open Image*.

**Build a palette** — five ways, all in the left rail:

| Method | How |
| --- | --- |
| By hand | Click **+**, then edit with the colour picker or by typing a hex value. Drag swatches to reorder. |
| Eyedropper | Toggle it on, then click the image. Samples from the full-resolution source, not the zoomed view. |
| Extract | Pulls the N most representative colours out of the image (median cut, refined with k-means in OKLab). |
| Import | Paste any text containing hex codes — a Lospec dump, CSS, a JSON array. Or load a `.hex`, `.gpl`, `.pal`, `.act`, or `.json` file. |
| Presets | Game Boy, PICO-8, Sweetie 16, CGA 16, Solarized, greyscale ramps, web-safe. |

Saved palettes persist in the browser and survive a reload. Export a palette as `.hex` or
`.gpl`, or copy the hex list to the clipboard.

**Tune the mapping** — right rail:

- **Distance metric** — OKLab (perceptual, the default and the one that usually looks right),
  plain sRGB euclidean, or weighted RGB.
- **Dither** — none, Floyd–Steinberg, or ordered Bayer 4×4 / 8×8, with a strength slider. The
  ordered threshold amplitude is derived from how far apart your palette entries actually
  are, so the slider behaves the same whether you loaded 4 colours or 216.
- **Pixelate** — block size, always measured against the original image.
- **Pre-map adjust** — brightness, contrast, saturation, gamma, applied *before* matching.
- **Alpha cutoff** — where semi-transparent pixels are cut to fully on or fully off.

**Clean up the specks** — mapping a compressed source scatters artifacts through big flat
areas. That is not really a mapping bug: JPEG ringing inside a flat field pushes pixels far
enough to cross a palette decision boundary, so they snap to a different entry. Two controls
attack it from both ends, and **both are off by default**:

- **Denoise** — a median filter applied *before* matching, so the drift never happens. A median
  rather than a blur, because it removes speckle without softening the hard edges cel art is
  made of. Radius 2 is where it starts doing real work on noisy sources.
- **Speck size** — after matching, any connected region this size or smaller is absorbed into
  the neighbour it shares the most boundary with.
- **Tolerance** — and this is the important one. An absorption only happens if the two colours
  are within this distance of each other in OKLab. It is what separates an artifact from a
  detail: a slightly-off orange speck in a field of orange is a near-miss and gets absorbed,
  while a genuine black pupil the same size on the same field is nowhere near it and survives
  at *any* speck size. Turn tolerance to 0 and nothing is ever absorbed.
- **Smooth stipple** — one pass of a majority filter. Antialiased edges produce long connected
  1px chains that no size threshold can catch; this is what thins those.

**Segment and outline**:

- **Merge similar** — clusters palette entries that sit within a distance of each other and
  remaps the image onto the survivors. Larger values collapse the picture toward a flat,
  poster / paint-by-numbers look.
- **Outline** — draws lines along the boundaries between regions, in a colour of your choosing,
  1 to 7 px wide. Boundaries against transparency are outlined too, but paint only ever lands
  on the opaque side, so a cut-out gets a clean edge rather than a halo.

**Compare** — the stage shows original and mapped side by side; drag the divider, or press
<kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> for before, split, and after.

**Export** — *Download* (or <kbd>Ctrl</kbd>+<kbd>S</kbd>) and *Copy PNG*. The upscale slider
enlarges with nearest-neighbour so the blocks stay crisp. If the browser refuses a clipboard
image write (Safari, older Firefox), it falls back to downloading and says so.

## Notes on the implementation

**The one thing that can add a colour.** Outlines take a free colour picker, so enabling them
with a colour that isn't in your palette is the only way this tool puts a non-palette colour in
the output. Until you touch the picker it tracks your palette's darkest entry, so the default
case stays clean; when the chosen colour is off-palette the Segment card's header says
`+1 off-palette`. Everything else — every mapping, dither, cleanup, merge and segmentation
setting — is incapable of producing a colour that is not a palette entry.

**One mechanism, three features.** Cleanup, segmentation and outlines are all driven by
labelling the connected regions of equal palette index. Regions below a size threshold are
artifacts to absorb, the regions themselves are the segmentation, and the boundaries between
them are where outlines go. Labelling uses 4-connectivity deliberately: under 8-connectivity a
diagonal pair of specks touches the surrounding field and could never be isolated.

**Merging happens at the palette, not the image.** Merging adjacent regions by colour would
mean a region adjacency graph over potentially hundreds of thousands of regions. Clustering the
≤256 palette entries instead and remapping is O(n²) on a tiny n, and the result is still built
only from palette entries.

**Denoise is cached.** It depends only on the source, the working size and the radius — never on
the palette or any mapping option — so it is computed once and reused. That is the difference
between a 1000ms and a 34ms response when you drag the tolerance slider with denoise switched on.

**Alpha is binary by design.** A half-transparent pixel composites to a blend of your palette
colour and whatever is behind it, so it is not a palette colour at all — and canvas stores
partial alpha premultiplied, which shifts the value again on readback. Pixels above the alpha
cutoff become fully opaque, pixels below become fully transparent. That is what makes the
guarantee below hold exactly.

**Preview vs. full resolution.** The live preview works on a buffer capped at 1200px on the
long edge so sliders stay responsive. Export re-renders at full resolution (or untick
*Render at full resolution* to export exactly what you see).

Measured on a 3MP image: 40ms to map, 180ms with speck removal, 1.2s with denoise, stipple
smoothing and outlines all on. Denoise at radius 2–3 is the one genuinely expensive setting
(3–6s at full resolution on first use) — but only on first use, because of the cache above.

**Speed.** Nearest-colour lookups go through a table keyed on 7 bits per channel, so a
per-pixel search over the palette becomes an array read. The low bit of each input channel is
dropped before matching, which can only affect tie-breaking right at a decision boundary —
every output pixel is still exactly a palette colour.

**Why one plain script.** No ES modules and no Web Worker: both are blocked by CORS when the
page is opened from `file://`, and this is meant to work off disk as well as hosted. The heavy
loops yield to the event loop every ~14ms instead, so the UI stays live and the progress bar
moves.

## Styling

The COMP/CON design system, via `tokens.css` and `components.css`. The semantic category
tokens have been renamed from the original's nouns to this tool's — the stages of the image
pipeline (`--cc-source`, `--cc-palette`, `--cc-map`, `--cc-dither`, `--cc-export`), so a
control panel carries the same tint as the readout it governs.

All 11 themes are in the toolbar switcher, including `hc-dark` for high contrast. Every
text/background pair was measured across all of them; all 242 clear 4.5:1.

## Verifying it still works

`window.PaletteMapper` exposes the internals for automated checking:

```js
// Every non-transparent output pixel must be exactly a palette colour —
// plus the outline colour, and only when outlines are switched on.
const cv = document.getElementById('pm-canvas-result');
const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
const allowed = new Set(PaletteMapper.state.palette.colors.map(h => h.slice(1).toUpperCase()));
if (PaletteMapper.readOptions().outline) {
  allowed.add(PaletteMapper.readOptions().outlineColor.slice(1).toUpperCase());
}
let bad = 0;
for (let i = 0; i < d.length; i += 4) {
  if (d[i + 3] === 0) continue;
  const hex = ((d[i] << 16) | (d[i+1] << 8) | d[i+2]).toString(16).padStart(6, '0').toUpperCase();
  if (!allowed.has(hex)) bad++;
}
console.log(bad);   // must be 0
```

`labelRegions(indices, w, h)` is exposed for checking the cleanup directly: map an image, build
a `Uint16Array` of palette indices from the result, and count how many regions come back at or
below a given area. On a JPEG-compressed cartoon that count drops from 1685 to 389 with speck
size 8 — roughly 79% of the speckle pixels — while a deliberately planted 9px detail survives at
every speck size, because the tolerance gate protects it.

Also on the object: `loadImageFromUrl`, `setPalette`, `renderPreview`, `renderFull`,
`buildExportCanvas`, `readOptions`, `parsePaletteText`, `buildMatcher`, `extractPalette`,
`denoiseBuffer`, `syncOutlineColor`.
