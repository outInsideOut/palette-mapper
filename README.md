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

**Compare** — the stage shows original and mapped side by side; drag the divider, or press
<kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> for before, split, and after.

**Export** — *Download* (or <kbd>Ctrl</kbd>+<kbd>S</kbd>) and *Copy PNG*. The upscale slider
enlarges with nearest-neighbour so the blocks stay crisp. If the browser refuses a clipboard
image write (Safari, older Firefox), it falls back to downloading and says so.

## Notes on the implementation

**Alpha is binary by design.** A half-transparent pixel composites to a blend of your palette
colour and whatever is behind it, so it is not a palette colour at all — and canvas stores
partial alpha premultiplied, which shifts the value again on readback. Pixels above the alpha
cutoff become fully opaque, pixels below become fully transparent. That is what makes the
guarantee below hold exactly.

**Preview vs. full resolution.** The live preview works on a buffer capped at 1200px on the
long edge so sliders stay responsive. Export re-renders at full resolution (or untick
*Render at full resolution* to export exactly what you see). A 3MP image with
Floyd–Steinberg takes about 100ms.

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
// Every non-transparent output pixel must be exactly a palette colour.
const cv = document.getElementById('pm-canvas-result');
const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
const allowed = new Set(PaletteMapper.state.palette.colors.map(h => h.slice(1).toUpperCase()));
let bad = 0;
for (let i = 0; i < d.length; i += 4) {
  if (d[i + 3] === 0) continue;
  const hex = ((d[i] << 16) | (d[i+1] << 8) | d[i+2]).toString(16).padStart(6, '0').toUpperCase();
  if (!allowed.has(hex)) bad++;
}
console.log(bad);   // must be 0
```

Also on the object: `loadImageFromUrl`, `setPalette`, `renderPreview`, `renderFull`,
`buildExportCanvas`, `readOptions`, `parsePaletteText`, `buildMatcher`, `extractPalette`.
