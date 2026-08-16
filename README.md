# Palette Mapper

![Palette Mapper with a mech illustration mapped to a 64-colour palette, original on the left of the split and the mapped result on the right](screenshot.png)

Paste in an image, build a colour palette, and every pixel snaps to its nearest palette colour.
Tune it live, then download or copy the result.

It runs entirely in your browser. Nothing is uploaded, there's no account, and it works offline
once the page has loaded — which matters if you're putting client artwork through it.

---

## Quick start

1. **Get an image in.** Press <kbd>Ctrl</kbd>+<kbd>V</kbd>, drag a file onto the page, or hit
   *Choose an image*.
2. **Get a palette.** Fastest route: open *Sample from image* and press **Extract**. That pulls
   the most representative colours straight out of your picture. Or load one from *Palette
   presets*.
3. **Tune.** Drag sliders in the right-hand panel and watch the split view update.
4. **Export.** Press **Download**, or **Copy PNG** to put it straight on the clipboard.

The centre view is split: original on the left, mapped on the right. Drag the divider, or press
<kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> for before, split, and after.

---

## Building a palette

Five ways, all in the left-hand panel.

| | How |
| --- | --- |
| **Extract** | Pulls a palette out of the image. Set the count, press *Extract* to replace the palette or *Add to palette* to append. Two methods — see below. |
| **Eyedropper** | Toggle it on and click the image to grab exact colours. It samples the original at full resolution, so what you click is what you get regardless of zoom. |
| **By hand** | Click **+** to add a swatch, click a swatch to edit it with the picker or by typing a hex value. Reorder by dragging, or with the **◀ Move / Move ▶** buttons. |
| **Import** | Paste *any* text containing hex codes — a Lospec page, a CSS file, a column of codes — and they'll be scraped out. Or load a `.hex`, `.gpl`, `.pal`, `.act` or `.json` file. |
| **Presets** | Game Boy, PICO-8, Sweetie 16, CGA 16, Solarized, greyscale ramps and web-safe. |

### Two ways to extract

**Perceptual** samples the image. It finds the colours your picture is actually made of, which
maps with the highest fidelity — but the result is a set of cluster centroids, so it can be
lumpy: five near-identical browns where the image happens to be brown-heavy, and no clean tonal
steps anywhere.

**Colour theory** builds instead of samples. It reads the dominant hue families out of the image
and then *constructs* a ramp for each, using three ideas a painter would recognise:

- **Chroma peaks in the midtones.** Neither very dark nor very light colours can be very
  colourful, so a ramp that holds saturation flat looks chalky at one end and muddy at the other.
  Saturation stays higher in the shadows than the highlights, the way paint behaves.
- **Shadows cool, highlights warm.** Hue drifts toward blue-violet as a ramp darkens and toward
  yellow as it lightens. This is what stops a ramp reading as a flat tint of one colour. Reds
  shade into magenta, greens into teal, blues into cyan. The **Hue shift** slider controls how far
  — set it to 0 for a strictly single-hue ramp.
- **Harmony.** Leave **Harmony** on *Auto* and it uses the hue families the image actually has.
  Pick a scheme and it instead anchors on the image's strongest hue and derives the rest at fixed
  angles round the wheel — complementary at 180°, triadic at 120°, tetradic at 90°, analogous at
  30°, or monochrome for a single hue plus greys.

Every colour is fitted into sRGB by easing saturation back rather than clipping channels, which
would otherwise flatten and skew the saturated end of a ramp. The colour count is always
respected: if the image only has three hue families, you get three longer ramps rather than a
short palette.

It's the better starting point for a designed look; perceptual is the better one for matching a
specific piece of art closely. Extract with one, then hand-edit.

**Sort** reorganises the palette into ramps, the way a hand-built palette is usually laid out:
the greys first running dark to light, then each colour family in turn round the wheel from red,
every family also running dark to light. It splits a family further when it holds both a muted
and a saturated ramp — Sweetie 16's blue-greys and its vivid blues come out as two separate runs
rather than interleaved. Nothing is added or removed, so it's safe to hit at any point.

Palettes you **Save** go to the *Library* and stay there between sessions. You can export one as
`.hex` or `.gpl` to use in Aseprite, Photoshop or GIMP, or **Copy list** to grab the hex codes.

> **Tip** — extracting first and then hand-editing usually beats starting from scratch. Extract
> 16–64 colours, delete the ones you don't want, then nudge the rest.

---

## The controls

### Mapping

**Distance metric** decides what "nearest colour" means.

- **OKLab** is perceptual and the right default — it matches how your eye judges closeness.
- **sRGB** is a straight numerical match. It can hold saturated colours better on flat graphic
  work, and it's worth trying when OKLab looks muted.
- **Weighted RGB** sits between the two.

Switch between them and watch the split — on some images they're indistinguishable, on others
the difference is obvious.

**Alpha cutoff** sets where semi-transparent pixels become fully solid or fully invisible. Raise
it to bite harder into soft edges and cut a subject cleanly off its background; lower it to keep
more of the fringe.

### Dither

Scatters pixels between two palette colours to fake shades you don't have.

- **None** — right for flat, cel-shaded or graphic art.
- **Floyd–Steinberg** — organic, photographic. The usual choice for photos and paintings.
- **Bayer 4×4 / 8×8** — a regular crosshatch, for a deliberately retro or print-screen look.

**Strength** dials the effect back. Dithering is most useful with small palettes; with 64 colours
you often want none at all.

### Pixelate

**Pixel size** sets how many source pixels become one output block. This is measured against your
*original* image, so the preview shows exactly the block structure the export will have.

**Average when downscaling** blends each block into one colour (usually what you want). Turn it
off to sample a single pixel per block, which keeps edges harsher and colours more original.

> **Tip** — pixel size and export **Upscale** are separate on purpose. Pixel size 5 on a 1024px
> image gives a true 205px pixel-art file; set Upscale to 5 to blow it back up to roughly its
> original dimensions with crisp square blocks. (Sizes that don't divide evenly shift the final
> dimensions by a pixel or two.)

### Pre-map adjust

Brightness, contrast, saturation and gamma, applied **before** matching. This is often the
difference between a muddy result and a good one: if your palette is darker than your image,
pulling brightness down first gives the matcher something closer to work with. **Reset** puts
them all back.

### Clean up

Mapping a compressed source (a JPEG, or anything saved off the web) scatters stray pixels through
large flat areas. That's not really a mapping fault — JPEG ringing nudges pixels far enough to
cross a decision boundary, so they snap to a different colour. Two controls attack it, and both
start switched off.

- **Denoise** smooths the image *before* matching so the stray pixels never happen. It's a median
  filter, so it removes speckle without softening hard edges. Radius 2 is where it starts doing
  real work.
- **Speck size** removes stray patches *after* matching, absorbing anything this size or smaller
  into whatever surrounds it.
- **Tolerance** is the important one. A patch is only absorbed if its colour is close to its
  neighbour's. That's what separates an artifact from a detail — a slightly-off orange speck in a
  field of orange gets absorbed, while a deliberate black pupil the same size survives, because
  black is nowhere near orange. At 0 nothing is ever absorbed.
- **Smooth stipple** cleans the ragged single-pixel chains that form along antialiased edges,
  which are too stringy for a size filter to catch.

> **Recipe for a compressed source** — Denoise 1, Speck size 8, Tolerance 50–60, Smooth stipple
> on. On a JPEG cartoon that removes roughly 80% of the speckle while leaving the linework alone.

### Segment

**Merge similar** collapses palette colours that are close to each other, flattening the image
toward a poster or paint-by-numbers look. Push it far enough and you'll get down to a handful of
colours.

**Outline regions** draws lines along the borders between colour areas, in any colour you pick,
1 to 7 px wide.

**Min region** decides how big an area has to be before it earns an outline. Leave it at 0 and
every boundary gets a line, including around every speck — which is what makes outlines look
thick and doubled, since a sliver between two areas contributes two lines a pixel apart. Raise it
until the small stuff drops out and only the shapes you care about are drawn.

---

## Exporting

**Download** saves a PNG (also <kbd>Ctrl</kbd>+<kbd>S</kbd>). **Copy PNG** puts it on the
clipboard — if your browser refuses, it downloads instead and tells you.

**Upscale** enlarges with hard square edges, so pixel art stays crisp. **Render at full
resolution** re-processes the original at full size on export; untick it to export exactly the
(smaller) image you see in the preview.

The header of the Export card always shows the dimensions you'll actually get.

---

## Presets

The **Presets** card saves every processing setting on the page under a name — metric, dither,
pixelate, adjustments, clean up, segment, outlines and export scale. Tick *Include palette* and
the palette travels with it, so one preset can carry an entire look.

Five to start from: **Clean cel art**, **Flat poster**, **Ink lines**, **Pixel art 8×** and
**Photo dither**. They leave your palette alone and can't be deleted.

The card header tells you where you stand — `Defaults`, `Custom`, the preset's name, or
`Ink lines · modified` once you change something. **Defaults** puts every control back.

Theme, zoom and view mode deliberately aren't saved in a preset — those are how you're looking at
the work, not how the image is processed.

### Taking your work with you

Your presets and your palette **Library** live in this browser's storage, which a cache clear, a
different browser or a new machine all take with them. **Export .json** writes both to one file you
keep — every saved preset with its settings and its palette, and every palette in the library.
**Import .json** reads one back.

Both halves travel together on purpose: a preset can carry a palette, and splitting them across two
files is how you end up with half a backup.

Everything is matched by name on import. A preset or palette whose name you already have is
updated, anything new is added, and nothing you named something else is touched — so exporting,
editing elsewhere and re-importing is safe to repeat. The built-in presets and palettes aren't
exported; every copy of the page already has them.

You can also just drop an exported file onto the page, or feed it to *Import file* in the Library
card — it's recognised as a backup rather than scraped for hex codes.

---

## Handy to know

- **Keyboard** — <kbd>Ctrl</kbd>+<kbd>V</kbd> paste, <kbd>Ctrl</kbd>+<kbd>S</kbd> download,
  <kbd>1</kbd>/<kbd>2</kbd>/<kbd>3</kbd> before/split/after, arrows nudge the split divider.
- **Fold a card** — click any card's header to collapse it to its title band, click again to open
  it. Keeps the rails down to the handful of controls you actually use.
- **Move a card** — drag a card by its header to reorder it, either within its own rail or across
  to the other one, so the tools you reach for most sit where you want them. On a touch screen drag
  by the grip (⠿) at the right of the header — a finger anywhere else on the header still scrolls
  the panel. From the keyboard, focus a header and press <kbd>Alt</kbd>+<kbd>↑</kbd> /
  <kbd>Alt</kbd>+<kbd>↓</kbd>.
- The layout you end up with — the order of the cards and which ones are folded — is remembered
  between visits.
- **Paste a palette** — pasting text that contains hex codes, rather than an image, loads them as
  a palette. Copy a row of swatches off a palette site and paste straight into the page.
- **What you see is what you export.** The preview works on a smaller copy for speed, but the
  cleanup and outline size thresholds are measured against your original's resolution, so a speck
  that vanishes in the preview vanishes in the export too.
- **Transparency is all-or-nothing.** Every visible pixel is exactly one of your palette colours,
  which means half-transparent pixels can't survive — they'd blend into something that isn't in
  your palette at all. The alpha cutoff is where you control that line.
- **The one exception** — outlines use a free colour picker, so an outline colour that isn't in
  your palette is the only way a non-palette colour reaches the export. The picker follows your
  palette's darkest colour until you change it, and the Segment header warns you with
  `+1 off-palette` when it's not one of yours.
- **First denoise is slow** on a big image (a few seconds at radius 2–3), then instant — the
  result is reused while you adjust everything else.
- **Themes** — eleven of them in the top-right, including a high-contrast one.
- **On a phone** — the image gets the whole screen and the panels slide up from the bar at the
  bottom. The sheet deliberately stops short of full height so you can watch the image change
  while dragging a slider.

---

## Running and hosting it

Open `index.html` and it works. To put it online, push the folder to a repo and point **GitHub
Pages** at it — there's no build step and no dependencies. All paths are relative, so it works
from `https://yourname.github.io/yourrepo/` unchanged.
