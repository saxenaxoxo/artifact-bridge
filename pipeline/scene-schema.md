# Scene-JSON schema (Stage B — final)

A single JSON object that fully describes an **editable, animated** After Effects
scene: master comp, nested precomps, layers, transforms, keyframes **with easing**,
expressions, and effects. The builder (`build-scene.js`) compiles it to one ES3
ExtendScript and runs it via the bridge's `eval`; `export-jsx.js` emits the same as a
standalone `.jsx`. Both share `pipeline/ae/builder-core.jsx.js`.

## Top level
```jsonc
{
  "comp":   { ... },      // master composition
  "scenes": [ { ... } ]   // each scene -> a real PRECOMP nested in the master comp
}
```

### `comp`
| field | type | default | notes |
|---|---|---|---|
| `name` | string | `"Scene"` | versioned if it exists (`Scene_2`); never overwrites |
| `width`,`height` | int | 1920×1080 | px |
| `fps` | number | 30 | |
| `duration` | number | 10 | seconds |
| `bg` | `#RRGGBB` | `#000000` | comp background color |

### `scenes[]` → one precomp each
| field | type | default | notes |
|---|---|---|---|
| `name` | string | `Scene N` | precomp name (also versioned) |
| `start` | number | 0 | seconds on the master timeline (precomp layer `startTime`) |
| `duration` | number | `comp.duration` | precomp length |
| `layers[]` | array | `[]` | first entry = top layer |

### `layers[]`
| field | type | notes |
|---|---|---|
| `type` | `text`\|`shape`\|`solid`\|`image`\|`null`\|`adjustment` | required |
| `name` | string | layer name |
| `parent` | string | name of another layer in the same precomp to parent to |
| `startTime`,`inPoint`,`outPoint` | number | optional layer timing (seconds) within its precomp |
| `blendMode` | string | e.g. `add`,`screen`,`multiply` (mapped to `BlendingMode`) |
| `threeD` | bool | enable 3D |
| `text` | object | `{ "value","font","size","fill":"#RRGGBB","stroke"?,"tracking"?,"justification":"left"|"center"|"right","leading"?:px }` |
| `shape` | object | `{ "kind":"rect"|"ellipse"|"star"|"path","size":[w,h],"fill":"#RRGGBB","stroke"?,"strokeWidth"?,"roundness"?,"path"?,"trim"? }` — `path`: `{ "vertices":[[x,y]…],"inTangents"?,"outTangents"?,"closed"? }` (layer-local coords); `trim`: `{ "start"?,"end"?,"offset"? }` adds Trim Paths (animate via path addressing) |
| `masks` | array | `[{ "vertices":[[x,y]…],"inTangents"?,"outTangents"?,"closed"?,"mode":"add"|"subtract"|"intersect","inverted"?,"opacity"?,"name"? }]` |
| `solid` | object | `{ "color":"#RRGGBB" }` (size defaults to comp size) |
| `image` | object | `{ "path":"/abs/or/rel" }`; missing/not-found → labeled placeholder solid (never hard-fails) |
| `transform` | object | base static transform (below) |
| `animations[]` | array | keyframed/expression-driven properties (below) |
| `expressions` | object | static expressions keyed by property token, e.g. `{ "rotation":"time*30" }` |
| `effects[]` | array | effects by matchName (below) |

**`transform`** (all optional; AE defaults if omitted):
```jsonc
{ "anchor": "center" | [x,y], "position": [x,y], "scale": [sx,sy], "rotation": deg, "opacity": 0..100 }
```
`anchor:"center"` resolves to the layer's content center.

### Property tokens
Used by `animations[].property` and keys of `expressions`:
`opacity` · `position` · `scale` · `rotation` · `anchor`.
Advanced addressing (any property, incl. effect params):
- `"effect:<matchName>:<paramNameOrIndex>"` — a parameter of an applied effect.
- `["ADBE Transform Group","ADBE Position"]` — a literal matchName **path** array, resolved from the layer root.

### `animations[]`
```jsonc
{ "property": "<token | effect:… | path[]>",
  "keyframes": [ { "t": seconds, "v": <value>, "ease": "linear|easeIn|easeOut|easeInOut|[x1,y1,x2,y2]", "hold"?: true } ],
  "expression"?: "ES expression string"   // if present, sets an expression instead of/in addition to keys
}
```
- `v`: number for `opacity`/`rotation`; `[x,y]` for `position`/`scale`/`anchor`; effect params
  per their type; a **string** for `sourceText` (text layers; keys are always HOLD).
- `ease` per keyframe — **segment semantics, backward-looking**: the ease on key *k*
  shapes the segment **arriving** at *k* (from *k−1* to *k*), matching CSS-transition
  intent. `easeOut` → decelerate into *k* (k.in influence 75); `easeIn` → accelerate out
  of *k−1* (k−1.out 75); `easeInOut` → both ends 66; `[x1,y1,x2,y2]` → k−1.out = x1·100,
  k.in = (1−x2)·100. Ease on the first keyframe is ignored (no preceding segment).
  Default `linear`. `hold:true` on key *k* freezes the value from *k* to the next key.
- An animated `property` overrides the matching static `transform` value.
- Extra property token: `sourceText` (animated text content, e.g. count-up numbers).

### `effects[]`
```jsonc
{ "matchName": "ADBE Gaussian Blur 2",
  "name"?: "Blur",
  "params"?: { "Blurriness": 12, "2": [..] },        // static params by NAME or 1-based index
  "animations"?: [ { "property": "Blurriness", "keyframes": [...] , "expression"?: "..." } ] }
```
Param resolution: try `effect.property(name)`, then `effect.property(index)`. Unknown
params are logged and skipped (never crash). matchName reference:
`pipeline/ae/effects-matchnames.md`.

## Conventions / rules
- **Colors** `#RRGGBB` → AE `[r,g,b]` floats 0–1. **Time** seconds → frames via `fps`.
- **Coords** top-left origin (AE comp pixels).
- **`scenes[] → precomps`**: each scene is built as its own comp, then added to the
  master as a layer at `scene.start` (true, editable nesting).
- **Idempotent**: existing comp name → `Name_2`; **never** overwrites or deletes.
- **Image fallback**: missing/not-found `image.path` → labeled placeholder solid.
- **Expressions** set `prop.expression = str; prop.expressionEnabled = true;` exactly.
- Whole build runs inside one `app.beginUndoGroup("MCP Build")` … `endUndoGroup()`.
- The builder calls `master.openInViewer()` at the end so the result is visible.
