# Effect matchName reference

The builder adds effects by **matchName** (`layer.property("ADBE Effect Parade").addProperty(matchName)`)
and sets/keyframes params by **name or 1-based index**. matchNames are stable across
AE versions; display names are localized, so prefer matchName.

> If a matchName you need isn't here, drop the effect on a layer once in AE and read it
> back with `node pipeline/dump-project.js <comp>` — the deep reader prints the effect's
> `matchName` and every param's `name`/`matchName`/index. Never guess silently.

## Known-good starters
| Effect | matchName | useful params (name) |
|---|---|---|
| Gaussian Blur | `ADBE Gaussian Blur 2` | `Blurriness`, `Blur Dimensions`, `Repeat Edge Pixels` |
| Fast Box Blur | `ADBE Box Blur2` | `Blur Radius`, `Iterations` |
| Drop Shadow | `ADBE Drop Shadow` | `Shadow Color`, `Opacity`, `Direction`, `Distance`, `Softness` |
| Glow | `ADBE Glo2` | `Glow Threshold`, `Glow Radius`, `Glow Intensity` |
| Fill | `ADBE Fill` | `Color`, `Opacity` |
| Tint | `ADBE Tint` | `Map Black To`, `Map White To`, `Amount to Tint` |
| Tritone | `ADBE Tritone` | `Highlights`, `Midtones`, `Shadows` |
| Levels | `ADBE Easy Levels2` | `Channel`, `Input Black`, `Input White`, `Gamma` |
| Pro Levels | `ADBE Pro Levels2` | (per-channel histogram params) |
| Brightness & Contrast | `ADBE Brightness & Contrast 2` | `Brightness`, `Contrast`, `Use Legacy` |
| Hue/Saturation | `ADBE HUE SATURATION` | `Channel Control`, `Master Hue`, `Master Saturation`, `Master Lightness` |
| Curves | `ADBE CurvesCustom` | `Curves` (custom value) |
| Gradient Ramp | `ADBE Ramp` | `Start of Ramp`, `Start Color`, `End of Ramp`, `End Color`, `Ramp Shape` |
| Roughen Edges | `ADBE Roughen Edges` | `Edge Type`, `Border`, `Scale`, `Evolution` |
| CC Composite | `ADBE CC Composite` | `Opacity`, `Composite Original` |
| Transform (effect) | `ADBE Geometry2` | `Scale`, `Rotation`, `Position`, `Opacity` |

## Notes
- Color params expect `[r,g,b]` floats 0–1 (use the builder's hex→rgb).
- Angle params (e.g. Drop Shadow `Direction`) are degrees.
- To **keyframe/expression** an effect param, use `effects[].animations[]` (resolved
  inside the effect) or the top-level `"effect:<matchName>:<paramNameOrIndex>"` token.
- Param index is 1-based and effect-local (index 1 is usually the first visible control).

## Gotchas (verified live)
- **Drop Shadow `Opacity` is 0–255 internally**, not percent: `setValue(160)` ≈ 63% in
  the UI. Read back raw (160) by the deep reader. Scale accordingly when authoring.
