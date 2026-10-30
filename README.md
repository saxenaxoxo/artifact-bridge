# Artifact Bridge - Claude artifacts to After Effects compositions

Turn an HTML design or animation (a Claude artifact, or any self-contained page) into a native, editable After Effects comp: real text layers, shape layers and keyframes, not a video.

## What it does

Everything in this list was run and checked headlessly for this release (`npm test` plus manual runs). It did not need After Effects.

- **Renders the artifact in a headless browser and samples it at 30 fps.** Element boxes, opacity and text are captured, then baked into position, opacity, scale and source-text keyframes.
- **Writes a scene JSON** (documented in [`pipeline/scene-schema.md`](pipeline/scene-schema.md)) that describes the comp, its layers and the animation.
- **Maps HTML to AE layer types:**
  - text becomes text layers, with size, weight, tracking, alignment and the CSS font family
  - wrapped paragraphs become one text layer per rendered line
  - boxes with a background or border become rectangle or ellipse shape layers, with corner roundness and stroke
  - pills keep their label as a text layer on top
  - counting numbers become source-text hold keyframes
- **Exports a standalone `.jsx`.** Anyone can build the comp with *File > Scripts > Run Script File*, with no bridge and no server.
- **One command for the whole pipeline**, with a preflight that tells you exactly what to fix when something is missing.
- **Right-to-left text survives ingest.** An Arabic sample kept its text, logical line order and right alignment in the scene JSON. How After Effects renders it has not been tested.

## Quick start

You need Node.js 18 or newer, plus either Google Chrome or Playwright's Chromium. Developed on macOS.

```bash
npm install
npx playwright install chromium   # optional if Google Chrome is installed
npm run preflight
```

### Make a standalone `.jsx` (no After Effects needed now)

```bash
node pipeline/artifact-bridge.js examples/demo.html --jsx demo.jsx
```

Then in After Effects: *File > Scripts > Run Script File...* and pick `demo.jsx`.

### Build live into the open After Effects project

The live path talks to After Effects through the bridge panel from [after-effects-mcp](after-effects-mcp/), which is bundled in this repo.

1. Install the bridge panel once: `cd after-effects-mcp && npm install && npm run install-bridge`. This copies `mcp-bridge-auto.jsx` into AE's *ScriptUI Panels* folder and may need admin rights.
2. In After Effects, turn on *Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network*.
3. Open *Window > mcp-bridge-auto.jsx* and tick **Auto-run commands**. Keep the panel open.
4. Check the setup, then build:

```bash
npm run preflight -- --live
node pipeline/artifact-bridge.js examples/demo.html
```

Builds only ever add new comps. An existing name gets a version suffix (`Demo_Replica_2`), and each build is a single undo step. The live build was not re-run for this release (see Status).

### Options

| flag | what it does |
|---|---|
| `--jsx out.jsx` | write a standalone script instead of building live |
| `--seconds N` | how long to sample the page from load (default 2.6) |
| `--scenes` | step through a chip-based scene player, one precomp per scene (see `pipeline/ingest-artifact.js` for the expected markup) |
| `--hd` | scale the comp to delivery size (short side 1080 px) |
| `--replace` | live build only: remove comps from earlier builds of the same scene first |

Each stage also runs on its own: `npm run ingest`, `npm run export`, `npm run build`, `npm run verify`. See [`pipeline/README.md`](pipeline/README.md).

### Making your own artifact work

Put everything that should end up in the comp inside one fixed-size element with `id="stage"`, for example `<div id="stage" style="position:relative;width:1280px;height:720px">`. The stage size becomes the comp size. Keep the page self-contained and let the motion settle within the sampling window. [`examples/demo.html`](examples/demo.html) is a working template.

## Limits

These describe what the code does today.

- **Only what is inside `#stage` is captured.** Load mode samples a fixed window (`--seconds`), so motion after it is cut and loops become a single pass.
- **Motion is baked, not reinterpreted.** Keyframes come from sampled frames at 30 fps, simplified to the points that matter. The original CSS easing curves are not recreated as AE easing.
- **Rotation, skew and 3D transforms are not captured.** The element's bounding box is sampled instead, so a rotating element turns into position and scale changes.
- **Gradients are approximated by their first colour stop.** In `--scenes` mode, the stage background is rebuilt as a solid with Gradient Ramp.
- **Translucent backgrounds become layer opacity.** For a fading box, the fill's alpha is folded into its opacity keyframes.
- **Corners use one radius.** Box-shadows, filters (blur and others), blend modes, `clip-path`, `mask-image` and `::before`/`::after` are not converted. Per-side borders become one stroke, taken from the widest side.
- **Inline SVGs are rasterized to PNG image layers.** The exception is a chart path matched by the `--scenes` profile, which becomes an editable shape path with Trim Paths. Only `M` and `C` path commands are parsed for that.
- **`<img>`, `<video>`, `<audio>` and `<canvas>` are skipped.**
- **Inline spans inside a text block are folded into the parent text layer.** Their own colour is lost.
- **Fonts:** ingest records the CSS family and weight. The builder looks them up through AE's font API (After Effects 24.0 or newer) and falls back to Arial with a build warning when the font is not installed. That lookup was tested against a mocked AE, not a live one.
- **The load-mode comp background is the comp's background colour, not a layer.** It does not appear in alpha renders.
- **Image layers reference PNGs in `pipeline/out/assets` by absolute path.** On another machine they build as labeled placeholder solids.
- **Right-to-left text is untested in After Effects.**
- **Windows is untested.**

## Also in this repo

- `pipeline/read-comp.js` reads an existing comp back into scene JSON, and `pipeline/dump-project.js` deep-dumps a project. Both need the live bridge.
- `pipeline/verify-artifact.js`, `verify-sample.js` and `verify-selftest.js` check a live build against its scene JSON, using dumps from the deep reader. They need After Effects.
- `panel/` is a dockable After Effects panel (CEP) that wraps the same pipeline: drop an HTML file, then build and verify. It also has an embedded chat that drives a locally installed `claude` CLI. See [`panel/README.md`](panel/README.md).

None of these were re-run for this release.

## Status

This project is not under active development. Open an issue to request an update or feature.

## License

MIT, see [LICENSE](LICENSE). The bundled `after-effects-mcp/` keeps its own MIT licence (copyright Dakkshin).

## Credits

- Built on Dakkshin's after-effects-mcp (MIT): https://github.com/Dakkshin/after-effects-mcp
- Vibe coded with Claude Code.
