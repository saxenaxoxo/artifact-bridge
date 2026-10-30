// pipeline/verify-sample.js  (Phase 3 — closed-loop verification of sample-scene.json)
//
// Loads the deep-reader dumps (pipeline/out/dump-{Promo,Intro,Outro}.json) and asserts
// every acceptance-relevant fact from pipeline/sample-scene.json (§12.3): comp settings,
// precomp nesting + start times, layers/order, keyframe times+values, easing influence,
// expressions byte-for-byte, effects + keyframed effect params.
//
//   node pipeline/verify-sample.js          -> prints PASS/FAIL lines, exit 1 on any FAIL

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const SUFFIX = process.argv[2] || ''; // e.g. "_2" to verify dump-Promo_2.json etc.
const load = (n) => JSON.parse(fs.readFileSync(path.join(OUT, `dump-${n}${SUFFIX}.json`), 'utf8'));

let failures = 0;
function check(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); }
  else { failures++; console.log(`FAIL  ${label}${detail !== undefined ? ' — ' + detail : ''}`); }
}
const near = (a, b, tol = 0.05) => typeof a === 'number' && Math.abs(a - b) <= tol;
const nearArr = (a, b, tol = 0.05) =>
  Array.isArray(a) && b.every((bv, i) => near(a[i], bv, tol));

// --- dump-tree helpers (reusable shape) ---
function layerByName(comp, name) { return (comp.layers || []).find((l) => l.name === name); }
function propIn(list, matchName) { return (list || []).find((p) => p.matchName === matchName); }
function groupChild(node, matchName) { return node ? propIn(node.properties, matchName) : undefined; }
function layerProp(layer, ...pathNames) {
  let node = propIn(layer.root, pathNames[0]);
  for (let i = 1; i < pathNames.length && node; i++) node = groupChild(node, pathNames[i]);
  return node;
}
const transform = (layer, leaf) => layerProp(layer, 'ADBE Transform Group', leaf);
const effect = (layer, fxMatch) => layerProp(layer, 'ADBE Effect Parade', fxMatch);

function checkKeys(label, prop, expected) {
  // expected: [{t, v, outInfl?, inInfl?}]  v: number | array
  if (!prop || !prop.keys) { check(label, false, 'property or keys missing'); return; }
  check(`${label}: numKeys=${expected.length}`, prop.numKeys === expected.length, `got ${prop.numKeys}`);
  expected.forEach((ek, i) => {
    const k = prop.keys[i];
    if (!k) { check(`${label} key${i + 1}`, false, 'missing'); return; }
    check(`${label} key${i + 1} t=${ek.t}`, near(k.t, ek.t), `got ${k.t}`);
    const vOk = Array.isArray(ek.v) ? nearArr(k.v, ek.v) : near(k.v, ek.v);
    check(`${label} key${i + 1} v=${JSON.stringify(ek.v)}`, vOk, `got ${JSON.stringify(k.v)}`);
    if (ek.outInfl !== undefined)
      check(`${label} key${i + 1} outEase infl≈${ek.outInfl}`,
        k.outEase && k.outEase[0] && near(k.outEase[0].influence, ek.outInfl, 1),
        `got ${JSON.stringify(k.outEase)}`);
    if (ek.inInfl !== undefined)
      check(`${label} key${i + 1} inEase infl≈${ek.inInfl}`,
        k.inEase && k.inEase[0] && near(k.inEase[0].influence, ek.inInfl, 1),
        `got ${JSON.stringify(k.inEase)}`);
    if (ek.outInterp !== undefined)
      check(`${label} key${i + 1} outInterp=${ek.outInterp}`, k.outInterp === ek.outInterp, `got ${k.outInterp}`);
    if (ek.inInterp !== undefined)
      check(`${label} key${i + 1} inInterp=${ek.inInterp}`, k.inInterp === ek.inInterp, `got ${k.inInterp}`);
  });
}

const promo = load('Promo');
const intro = load('Intro');
const outro = load('Outro');

// ===== master comp =====
check('Promo 1920x1080', promo.width === 1920 && promo.height === 1080, `${promo.width}x${promo.height}`);
check('Promo fps=30', near(promo.frameRate, 30), promo.frameRate);
check('Promo duration=6', near(promo.duration, 6), promo.duration);
check('Promo bg=#0B0B0F', nearArr(promo.bgColor, [0x0b / 255, 0x0b / 255, 0x0f / 255], 0.01), JSON.stringify(promo.bgColor));
check('Promo has 2 layers', promo.numLayers === 2, promo.numLayers);
const introLayer = layerByName(promo, 'Intro' + SUFFIX);
const outroLayer = layerByName(promo, 'Outro' + SUFFIX);
check('Intro precomp nested', !!introLayer);
check('Outro precomp nested', !!outroLayer);
if (introLayer) check('Intro startTime=0', near(introLayer.startTime, 0), introLayer.startTime);
if (outroLayer) check('Outro startTime=3', near(outroLayer.startTime, 3), outroLayer.startTime);

// ===== Intro precomp =====
check('Intro comp 1920x1080', intro.width === 1920 && intro.height === 1080);
check('Intro duration=3', near(intro.duration, 3), intro.duration);
const title = layerByName(intro, 'Title');
check('Title layer exists (text)', !!title && title.isText, title && JSON.stringify({ isText: title.isText }));
if (title) {
  check('Title text="Hello"', title.text && title.text.text === 'Hello', title.text && title.text.text);
  check('Title fontSize=140', title.text && near(title.text.fontSize, 140), title.text && title.text.fontSize);
  check('Title font=Arial-BoldMT', title.text && title.text.font === 'Arial-BoldMT', title.text && title.text.font);
  check('Title fill=#FFFFFF', title.text && nearArr(title.text.fillColor, [1, 1, 1], 0.01), title.text && JSON.stringify(title.text.fillColor));
  check('Title justification=center', title.text && title.text.justification === 'center', title.text && title.text.justification);

  // segment-ease semantics: ease on key k shapes the segment (k-1 -> k)
  checkKeys('Title.opacity', transform(title, 'ADBE Opacity'), [
    { t: 0, v: 0, outInfl: 16.667, outInterp: 'bezier' },              // from key2's easeOut
    { t: 1, v: 100, inInterp: 'bezier', inInfl: 75 },                  // easeOut decelerates INTO key2
  ]);
  checkKeys('Title.position', transform(title, 'ADBE Position'), [
    { t: 0, v: [960, 620], outInfl: 66, outInterp: 'bezier' },         // from key2's easeInOut
    { t: 1, v: [960, 540], inInfl: 66, inInterp: 'bezier' },           // easeInOut
  ]);
  const rot = transform(title, 'ADBE Rotate Z');
  check('Title rotation expression exact', rot && rot.expression === 'Math.sin(time*3)*2', rot && JSON.stringify(rot.expression));
  check('Title rotation expressionEnabled', rot && rot.expressionEnabled === true);

  const ds = effect(title, 'ADBE Drop Shadow');
  check('Title Drop Shadow present', !!ds);
  if (ds) {
    const dist = propIn(ds.properties, 'ADBE Drop Shadow-0004');
    const soft = propIn(ds.properties, 'ADBE Drop Shadow-0005');
    const dsOp = propIn(ds.properties, 'ADBE Drop Shadow-0002');
    check('DropShadow Distance=10', dist && near(dist.value, 10), dist && dist.value);
    check('DropShadow Softness=24', soft && near(soft.value, 24), soft && soft.value);
    check('DropShadow Opacity=160', dsOp && near(dsOp.value, 160), dsOp && dsOp.value);
  }
}

// ===== Outro precomp =====
check('Outro duration=3', near(outro.duration, 3), outro.duration);
const tagline = layerByName(outro, 'Tagline');
const badge = layerByName(outro, 'Badge');
check('Tagline layer exists (text)', !!tagline && tagline.isText);
check('Badge layer exists (shape)', !!badge && badge.isShape);
check('Layer order: Tagline above Badge', tagline && badge && tagline.index < badge.index,
  JSON.stringify({ tagline: tagline && tagline.index, badge: badge && badge.index }));
if (tagline) {
  check('Tagline text', tagline.text && tagline.text.text === 'Made with MCP', tagline.text && tagline.text.text);
  check('Tagline fontSize=90', tagline.text && near(tagline.text.fontSize, 90));
  check('Tagline tracking=2', tagline.text && near(tagline.text.tracking, 2), tagline.text && tagline.text.tracking);
  checkKeys('Tagline.opacity', transform(tagline, 'ADBE Opacity'), [
    { t: 0.3, v: 0, outInfl: 16.667, outInterp: 'bezier' },
    { t: 1.1, v: 100, inInterp: 'bezier', inInfl: 75 },
  ]);
}
if (badge) {
  checkKeys('Badge.scale', transform(badge, 'ADBE Scale'), [
    { t: 0, v: [0, 0], outInfl: 66, outInterp: 'bezier' },             // from key2's easeInOut
    { t: 0.9, v: [100, 100], inInfl: 66, inInterp: 'bezier' },
  ]);
  checkKeys('Badge.opacity', transform(badge, 'ADBE Opacity'), [
    { t: 0, v: 0 },
    { t: 0.5, v: 100 },
  ]);
  const brot = transform(badge, 'ADBE Rotate Z');
  check('Badge rotation expression exact', brot && brot.expression === 'time*30', brot && JSON.stringify(brot.expression));

  // shape contents: Root Vectors Group -> Vector Group -> Vectors Group -> Ellipse + Fill
  const vgroup = layerProp(badge, 'ADBE Root Vectors Group', 'ADBE Vector Group', 'ADBE Vectors Group');
  check('Badge has vector contents group', !!vgroup);
  if (vgroup) {
    const ell = groupChild(vgroup, 'ADBE Vector Shape - Ellipse');
    check('Badge ellipse present', !!ell);
    const size = ell && groupChild(ell, 'ADBE Vector Ellipse Size');
    check('Badge ellipse size=[320,320]', size && nearArr(size.value, [320, 320]), size && JSON.stringify(size.value));
    const fill = groupChild(vgroup, 'ADBE Vector Graphic - Fill');
    check('Badge fill present', !!fill);
    const fillCol = fill && groupChild(fill, 'ADBE Vector Fill Color');
    check('Badge fill=#4F8CFF', fillCol && nearArr(fillCol.value, [0x4f / 255, 0x8c / 255, 1], 0.01), fillCol && JSON.stringify(fillCol.value));
  }

  const gb = effect(badge, 'ADBE Gaussian Blur 2');
  check('Badge Gaussian Blur present', !!gb);
  if (gb) {
    const blur = propIn(gb.properties, 'ADBE Gaussian Blur 2-0001');
    checkKeys('Badge blur.Blurriness', blur, [
      { t: 0, v: 30, outInfl: 16.667, outInterp: 'bezier' },
      { t: 0.8, v: 0, inInterp: 'bezier', inInfl: 75 },
    ]);
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
