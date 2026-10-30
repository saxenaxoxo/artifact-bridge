// pipeline/verify-selftest.js  (Phase 6 — effects/expressions/path/trim/sourceText/mask/hold)
//
//   node pipeline/verify-selftest.js [suffix]   e.g. "" or "_2"
// reads pipeline/out/dump-ST<suffix>.json (the scene precomp dump)

const fs = require('fs');
const path = require('path');
const SUFFIX = process.argv[2] || '';
const dump = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', `dump-ST${SUFFIX}.json`), 'utf8'));

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log(`PASS  ${label}`);
  else { failures++; console.log(`FAIL  ${label}${detail !== undefined ? ' — ' + detail : ''}`); }
};
const near = (a, b, tol = 0.05) => typeof a === 'number' && Math.abs(a - b) <= tol;

const layer = (n) => (dump.layers || []).find((l) => l.name === n);
const propIn = (list, mn) => (list || []).find((p) => p.matchName === mn);
const child = (node, mn) => (node ? propIn(node.properties, mn) : undefined);
const walk = (l, ...mns) => {
  let n = propIn(l.root, mns[0]);
  for (let i = 1; i < mns.length && n; i++) n = child(n, mns[i]);
  return n;
};

// 1. expressions byte-exact
const wig = layer('WigglePos');
const wpos = walk(wig, 'ADBE Transform Group', 'ADBE Position');
const wrot = walk(wig, 'ADBE Transform Group', 'ADBE Rotate Z');
check('wiggle expr exact', wpos && wpos.expression === 'wiggle(3,40)', wpos && JSON.stringify(wpos.expression));
check('wiggle expr enabled', wpos && wpos.expressionEnabled === true);
check('rotation expr exact', wrot && wrot.expression === 'time*30', wrot && JSON.stringify(wrot.expression));

// 2. sourceText hold keys
const counter = layer('Counter');
const srcText = walk(counter, 'ADBE Text Properties', 'ADBE Text Document');
check('sourceText numKeys=3', srcText && srcText.numKeys === 3, srcText && srcText.numKeys);
if (srcText && srcText.keys) {
  const texts = srcText.keys.map((k) => k.v && k.v.text);
  check('sourceText values 0/50/100', JSON.stringify(texts) === '["0","50","100"]', JSON.stringify(texts));
  check('sourceText all hold', srcText.keys.every((k) => k.outInterp === 'hold'),
    JSON.stringify(srcText.keys.map((k) => k.outInterp)));
}

// 3. text stroke
const st = layer('StrokeText');
check('text stroke applied', st && st.text && st.text.applyStroke === true, st && JSON.stringify(st.text));
check('text strokeWidth=3', st && st.text && near(st.text.strokeWidth, 3), st && st.text && st.text.strokeWidth);

// 4. path shape + trim animation
const tp = layer('TrimPath');
const pathProp = walk(tp, 'ADBE Root Vectors Group', 'ADBE Vector Group', 'ADBE Vectors Group', 'ADBE Vector Shape - Group', 'ADBE Vector Shape');
check('path shape present', !!pathProp, 'ADBE Vector Shape not found');
if (pathProp && pathProp.value && pathProp.value.vertices) {
  check('path vertices=3', pathProp.value.vertices.length === 3, JSON.stringify(pathProp.value.vertices));
  check('path open', pathProp.value.closed === false, pathProp.value.closed);
}
const stroke = walk(tp, 'ADBE Root Vectors Group', 'ADBE Vector Group', 'ADBE Vectors Group', 'ADBE Vector Graphic - Stroke');
check('path stroke present', !!stroke);
const trimEnd = walk(tp, 'ADBE Root Vectors Group', 'ADBE Vector Group', 'ADBE Vectors Group', 'ADBE Vector Filter - Trim', 'ADBE Vector Trim End');
check('trim end numKeys=2', trimEnd && trimEnd.numKeys === 2, trimEnd && trimEnd.numKeys);
if (trimEnd && trimEnd.keys) {
  check('trim end 0->100', near(trimEnd.keys[0].v, 0) && near(trimEnd.keys[1].v, 100),
    JSON.stringify(trimEnd.keys.map((k) => k.v)));
  check('trim end key2 eased (in 75)', trimEnd.keys[1].inEase && near(trimEnd.keys[1].inEase[0].influence, 75, 1),
    JSON.stringify(trimEnd.keys[1].inEase));
}

// 5. keyframed effect
const bs = layer('BlurSolid');
const blur = walk(bs, 'ADBE Effect Parade', 'ADBE Gaussian Blur 2', 'ADBE Gaussian Blur 2-0001');
check('blur effect + keys', blur && blur.numKeys === 2, blur && blur.numKeys);
if (blur && blur.keys) {
  check('blur 0->50', near(blur.keys[0].v, 0) && near(blur.keys[1].v, 50), JSON.stringify(blur.keys.map((k) => k.v)));
  check('blur easeInOut both 66', near(blur.keys[0].outEase[0].influence, 66, 1) && near(blur.keys[1].inEase[0].influence, 66, 1),
    JSON.stringify([blur.keys[0].outEase, blur.keys[1].inEase]));
}

// 6. mask + hold key
const mk = layer('Masked');
const maskShape = walk(mk, 'ADBE Mask Parade', 'ADBE Mask Atom', 'ADBE Mask Shape');
check('mask present', !!maskShape, 'ADBE Mask Atom/Shape not found');
if (maskShape && maskShape.value && maskShape.value.vertices) {
  check('mask vertices=4', maskShape.value.vertices.length === 4, JSON.stringify(maskShape.value.vertices));
  check('mask closed', maskShape.value.closed === true);
}
const mop = walk(mk, 'ADBE Transform Group', 'ADBE Opacity');
check('hold key2 outInterp=hold', mop && mop.keys && mop.keys[1].outInterp === 'hold',
  mop && mop.keys && JSON.stringify(mop.keys.map((k) => k.outInterp)));

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
