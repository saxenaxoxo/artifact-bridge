// pipeline/read-comp.js  (Phase 4 — existing comp -> editable scene-JSON)
//
// Points the deep reader at any comp and maps the raw property tree into the
// scene-JSON schema, so real projects can be read / modified / rebuilt.
//
//   node pipeline/read-comp.js <CompName> [out.scene.json]
//
// Best-effort mapping (per plan §8): text layers, transforms with keyframes+easing,
// expressions, effects (params by matchName, incl. keyframed params), simple shape
// contents (rect/ellipse + fill). Unknown layer types become labeled placeholder
// solids; complex shape trees are kept as `_rawContents` so nothing is lost.

const fs = require('fs');
const path = require('path');
const { evalExtendScript } = require('./ae-bridge');
const { compDumpScript } = require('./ae/read.jsx.js');

// ---------- helpers over the dump shape ----------
const propIn = (list, mn) => (list || []).find((p) => p.matchName === mn);
const groupChild = (node, mn) => (node ? propIn(node.properties, mn) : undefined);

function hexFromColor(c) {
  if (!Array.isArray(c)) return undefined;
  const h = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return ('#' + h(c[0]) + h(c[1]) + h(c[2])).toUpperCase();
}

function mapKeyframes(prop) {
  return prop.keys.map((k) => {
    const kf = { t: k.t, v: k.v };
    if (k.outInterp === 'hold') kf.hold = true;
    else if (k.inInterp === 'bezier' || k.outInterp === 'bezier') {
      // builder's array-ease inverse: outI = x1*100, inI = (1-x2)*100
      const outI = (k.outEase && k.outEase[0] && k.outEase[0].influence) || 16.667;
      const inI = (k.inEase && k.inEase[0] && k.inEase[0].influence) || 16.667;
      kf.ease = [outI / 100, 0, 1 - inI / 100, 1];
    }
    return kf;
  });
}

const TRANSFORM_TOKENS = {
  'ADBE Anchor Point': 'anchor',
  'ADBE Position': 'position',
  'ADBE Scale': 'scale',
  'ADBE Rotate Z': 'rotation',
  'ADBE Opacity': 'opacity',
};

function mapTransformAndAnimations(layer) {
  const transform = {};
  const animations = [];
  const tg = propIn(layer.root, 'ADBE Transform Group');
  if (!tg) return { transform, animations };
  for (const [mn, token] of Object.entries(TRANSFORM_TOKENS)) {
    const p = groupChild(tg, mn);
    if (!p) continue;
    const anim = { property: token };
    let used = false;
    if (p.numKeys > 0) { anim.keyframes = mapKeyframes(p); used = true; }
    else if (p.value !== null && p.value !== undefined) transform[token] = p.value;
    if (p.expression) { anim.expression = p.expression; used = true; }
    if (used) animations.push(anim);
  }
  return { transform, animations };
}

function mapEffects(layer) {
  const parade = propIn(layer.root, 'ADBE Effect Parade');
  if (!parade || !parade.properties || !parade.properties.length) return undefined;
  const out = [];
  for (const fx of parade.properties) {
    if (!fx || fx.kind !== 'group') continue;
    const ef = { matchName: fx.matchName, name: fx.name, params: {}, animations: [] };
    for (const p of fx.properties || []) {
      if (!p || p.kind !== 'property' || !p.matchName) continue;
      if (p.numKeys > 0 || p.expression) {
        const anim = { property: p.matchName };
        if (p.numKeys > 0) anim.keyframes = mapKeyframes(p);
        if (p.expression) anim.expression = p.expression;
        ef.animations.push(anim);
      } else if (p.value !== null && p.value !== undefined) {
        ef.params[p.matchName] = p.value;
      }
    }
    if (!Object.keys(ef.params).length) delete ef.params;
    if (!ef.animations.length) delete ef.animations;
    out.push(ef);
  }
  return out.length ? out : undefined;
}

function mapShape(layer) {
  // simple case: first vector group with a Rect or Ellipse + Fill -> editable shape spec
  const root = propIn(layer.root, 'ADBE Root Vectors Group');
  const grp = root && groupChild(root, 'ADBE Vector Group');
  const cont = grp && groupChild(grp, 'ADBE Vectors Group');
  if (cont) {
    const ell = groupChild(cont, 'ADBE Vector Shape - Ellipse');
    const rect = groupChild(cont, 'ADBE Vector Shape - Rect');
    const fill = groupChild(cont, 'ADBE Vector Graphic - Fill');
    const fillCol = fill && groupChild(fill, 'ADBE Vector Fill Color');
    const stroke = groupChild(cont, 'ADBE Vector Graphic - Stroke');
    if (ell || rect) {
      const sizeProp = ell ? groupChild(ell, 'ADBE Vector Ellipse Size') : groupChild(rect, 'ADBE Vector Rect Size');
      const spec = {
        kind: ell ? 'ellipse' : 'rect',
        size: (sizeProp && sizeProp.value) || [100, 100],
      };
      if (fillCol && fillCol.value) spec.fill = hexFromColor(fillCol.value);
      if (rect) {
        const r = groupChild(rect, 'ADBE Vector Rect Roundness');
        if (r && r.value) spec.roundness = r.value;
      }
      if (stroke) {
        const sc = groupChild(stroke, 'ADBE Vector Stroke Color');
        const sw = groupChild(stroke, 'ADBE Vector Stroke Width');
        if (sc && sc.value) spec.stroke = hexFromColor(sc.value);
        if (sw && sw.value) spec.strokeWidth = sw.value;
      }
      return { shape: spec };
    }
  }
  return { shape: { kind: 'rect', size: [100, 100] }, _rawContents: root }; // fallback: keep raw tree
}

function mapLayer(layer) {
  const spec = { name: layer.name };
  if (layer.isText) {
    spec.type = 'text';
    const t = layer.text || {};
    spec.text = {
      value: t.text || '',
      font: t.font,
      size: t.fontSize,
      fill: hexFromColor(t.fillColor) || '#FFFFFF',
      tracking: t.tracking,
      justification: ['left', 'center', 'right'].includes(t.justification) ? t.justification : undefined,
    };
  } else if (layer.isShape) {
    spec.type = 'shape';
    Object.assign(spec, mapShape(layer));
  } else {
    // AV layer (solid/footage/precomp) — source colors aren't in the property tree;
    // rebuild as a labeled placeholder solid so geometry/animation still round-trips.
    spec.type = 'solid';
    spec.solid = { color: '#808080' };
    spec._note = 'non-text/shape source approximated as solid (round-trip limitation)';
  }
  if (layer.parent) spec.parent = layer.parent;
  if (layer.startTime) spec.startTime = layer.startTime;
  const { transform, animations } = mapTransformAndAnimations(layer);
  if (Object.keys(transform).length) spec.transform = transform;
  if (animations.length) spec.animations = animations;
  const effects = mapEffects(layer);
  if (effects) spec.effects = effects;
  return spec;
}

function dumpToScene(dump, newName) {
  return {
    comp: {
      name: newName || dump.name + '_RT',
      width: dump.width,
      height: dump.height,
      fps: dump.frameRate,
      duration: dump.duration,
      bg: hexFromColor(dump.bgColor) || '#000000',
    },
    scenes: [{
      name: (newName || dump.name + '_RT') + '_layers',
      start: 0,
      duration: dump.duration,
      layers: (dump.layers || []).filter((l) => !l.error).map(mapLayer),
    }],
  };
}

module.exports = { dumpToScene, mapLayer, mapKeyframes };

if (require.main === module) {
  (async () => {
    const compName = process.argv[2];
    if (!compName) { console.error('usage: node pipeline/read-comp.js <CompName> [out.scene.json]'); process.exit(1); }
    const outPath = process.argv[3] || path.join(__dirname, 'out', compName + '.scene.json');
    const res = await evalExtendScript(compDumpScript(compName, 12), { timeoutMs: 60000 });
    if (!res || res.error || res.status === 'error') {
      console.error('read failed: ' + JSON.stringify(res)); process.exit(1);
    }
    const scene = dumpToScene(res);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(scene, null, 2));
    console.log('wrote ' + outPath);
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
