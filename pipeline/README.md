# Artifact Bridge — pipeline

Deep read/write control of After Effects from Node, over the `mcp-bridge-auto` panel's
file protocol (`~/Documents/ae-mcp-bridge/`), with everything routed through the
bridge's `eval` command. Scene-JSON in → native, editable AE comps out — and any comp
back to scene-JSON. ExtendScript sent to AE is strict ES3 (see `scene-schema.md`).

**Live commands** need AE open with the `mcp-bridge-auto` panel visible and
*Auto-run commands* ticked (`node pipeline/preflight.js --live` checks this). Ingest,
validate and `.jsx` export run headless.

## Capabilities

| task | command |
|---|---|
| Whole pipeline in one go | `node pipeline/artifact-bridge.js <artifact.html> [--jsx out.jsx]` |
| Check this machine | `node pipeline/preflight.js [--live]` |
| Validate a scene JSON | `node pipeline/validate-scene.js <scene.json>` |
| Ping / sanity | `node -e "require('./pipeline/ae-bridge').evalExtendScript('(function(){return JSON.stringify({ok:true})})()').then(r=>console.log(r))"` |
| Deep-dump whole project | `node pipeline/dump-project.js` |
| Deep-dump one comp | `node pipeline/dump-project.js <CompName>` |
| Build a scene live | `node pipeline/build-scene.js [scene.json]` (default `pipeline/sample-scene.json`) |
| Export standalone `.jsx` | `node pipeline/export-jsx.js [scene.json] [out.jsx]` → run via File ▸ Scripts ▸ Run Script File, no server (JSON polyfill embedded) |
| Comp → scene-JSON | `node pipeline/read-comp.js <CompName> [out.scene.json]` (round-trip-able) |
| Artifact → scene-JSON | `node pipeline/ingest-artifact.js <artifact.html> [--out scene.json] [--seconds N] [--scenes] [--hd]` (headless-browser render & sample; `--scenes` steps a chip-based player scene by scene) |
| Verify sample build | `node pipeline/verify-sample.js [_N]` |
| Verify self-test build | `node pipeline/verify-selftest.js [_N]` |
| Verify artifact replica | `node pipeline/verify-artifact.js <scene.json> <dumpPrefix> [_N] [--quiet]` |

## Files

- `ae-bridge.js` — file-protocol driver (`sendCommand`/`evalExtendScript`; auto-retries
  one missed command, builds opt out via `retries: 0`).
- `ae/builder-core.jsx.js` — the ES3 build engine (single source of truth for the live
  eval path and the standalone `.jsx`): comps, nested precomps, text (incl. stroke,
  `sourceText` HOLD keys), shapes (rect/ellipse/star/**path** + Trim Paths),
  solids/nulls/adjustments/images (missing → placeholder), masks, transforms, baked
  keyframes with **segment-based easing** (see schema), expressions (byte-exact),
  effects by matchName (params + keyframes + expressions), parenting, blend modes,
  layer timing, one undo group, `openInViewer()`.
- `ae/read.jsx.js` — recursive deep reader: any property tree → JSON (keyframes with
  interpolation + temporal ease + spatial tangents/roving, expressions, effects,
  masks/paths as Shape data, text docs incl. stroke/justification/leading).
- `read-comp.js` — maps a deep dump back into scene-JSON (best-effort; unknown layer
  sources become placeholder solids, raw trees kept).
- `ingest-artifact.js` — render & sample (30 fps bake, per-line text, SVG policy:
  profile-matched chart → editable path + Trim, other SVGs → PNG image layers).
- `scene-schema.md` — the scene-JSON contract. `ae/effects-matchnames.md` — effect
  matchName reference + gotchas (e.g. Drop Shadow opacity is 0–255).
- `artifact-bridge.js` — one-command runner (preflight → ingest → build or export).
- `preflight.js` — environment checks with plain-language fixes.
- `validate-scene.js` — structural scene-JSON check (used by `npm test`).
- `errors.js` — shared plain-language error reporting (`AB_DEBUG=1` adds stack traces).
- `out/` — generated rasters, notes, dumps and `.jsx` files (git-ignored).

## Safety conventions

Only ADD namespaced comps (existing names version to `_2`, `_3`…) — never overwrite or
delete pre-existing items; `MCP_Test` is read-only; builds are one undo group ("MCP
Build") so a whole build undoes in one ⌘Z.
