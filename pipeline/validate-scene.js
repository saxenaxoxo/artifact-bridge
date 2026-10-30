#!/usr/bin/env node
// pipeline/validate-scene.js
//
// Structural check of a scene-JSON object against pipeline/scene-schema.md. Catches
// what would make a build fail or silently misbehave (wrong types, bad colours,
// unordered keyframes) without After Effects.
//
//   node pipeline/validate-scene.js <scene.json>

const LAYER_TYPES = ['text', 'shape', 'solid', 'image', 'null', 'adjustment'];
const SHAPE_KINDS = ['rect', 'ellipse', 'star', 'path'];
const TOKENS = ['opacity', 'position', 'scale', 'rotation', 'anchor', 'sourceText'];
const HEX = /^#[0-9A-Fa-f]{6}$/;

const isNum = (v) => typeof v === 'number' && isFinite(v);
const isVec = (v, n) => Array.isArray(v) && v.length >= n && v.every(isNum);

function validateScene(scene) {
  const errs = [];
  const err = (where, msg) => errs.push(`${where}: ${msg}`);

  if (!scene || typeof scene !== 'object') return ['scene: not an object'];
  const c = scene.comp;
  if (!c || typeof c !== 'object') err('comp', 'missing');
  else {
    if (typeof c.name !== 'string' || !c.name) err('comp.name', 'must be a non-empty string');
    for (const k of ['width', 'height']) if (!(Number.isInteger(c[k]) && c[k] > 0)) err(`comp.${k}`, 'must be a positive integer');
    if (!(isNum(c.fps) && c.fps > 0)) err('comp.fps', 'must be a positive number');
    if (!(isNum(c.duration) && c.duration > 0)) err('comp.duration', 'must be a positive number');
    if (c.bg !== undefined && !HEX.test(c.bg)) err('comp.bg', 'must be #RRGGBB');
  }
  if (!Array.isArray(scene.scenes)) { err('scenes', 'must be an array'); return errs; }

  scene.scenes.forEach((sc, si) => {
    const w = `scenes[${si}]`;
    if (typeof sc.name !== 'string') err(`${w}.name`, 'must be a string');
    if (sc.start !== undefined && !isNum(sc.start)) err(`${w}.start`, 'must be a number');
    if (sc.duration !== undefined && !(isNum(sc.duration) && sc.duration > 0)) err(`${w}.duration`, 'must be a positive number');
    if (!Array.isArray(sc.layers)) { err(`${w}.layers`, 'must be an array'); return; }

    sc.layers.forEach((l, li) => {
      const lw = `${w}.layers[${li}] (${l && l.name})`;
      if (!LAYER_TYPES.includes(l.type)) err(lw, `type must be one of ${LAYER_TYPES.join('|')}`);
      if (l.type === 'text') {
        const t = l.text || {};
        if (typeof t.value !== 'string') err(`${lw}.text.value`, 'must be a string');
        if (t.font !== undefined && typeof t.font !== 'string') err(`${lw}.text.font`, 'must be a string');
        if (t.fontFamily !== undefined && typeof t.fontFamily !== 'string') err(`${lw}.text.fontFamily`, 'must be a string');
        if (!(isNum(t.size) && t.size > 0)) err(`${lw}.text.size`, 'must be a positive number');
        if (t.fill !== undefined && !HEX.test(t.fill)) err(`${lw}.text.fill`, 'must be #RRGGBB');
        if (t.justification !== undefined && !['left', 'center', 'right'].includes(t.justification)) err(`${lw}.text.justification`, 'must be left|center|right');
      }
      if (l.type === 'shape') {
        const s = l.shape || {};
        if (!SHAPE_KINDS.includes(s.kind)) err(`${lw}.shape.kind`, `must be one of ${SHAPE_KINDS.join('|')}`);
        if (s.kind !== 'path' && !isVec(s.size, 2)) err(`${lw}.shape.size`, 'must be [w,h]');
        if (s.kind === 'path' && !(s.path && Array.isArray(s.path.vertices) && s.path.vertices.every((v) => isVec(v, 2)))) err(`${lw}.shape.path.vertices`, 'must be [[x,y],...]');
        for (const k of ['fill', 'stroke']) if (s[k] !== undefined && !HEX.test(s[k])) err(`${lw}.shape.${k}`, 'must be #RRGGBB');
      }
      if (l.type === 'solid' && !(l.solid && HEX.test(l.solid.color))) err(`${lw}.solid.color`, 'must be #RRGGBB');
      if (l.type === 'image' && !(l.image && typeof l.image.path === 'string')) err(`${lw}.image.path`, 'must be a string');

      const tr = l.transform || {};
      if (tr.position !== undefined && !isVec(tr.position, 2)) err(`${lw}.transform.position`, 'must be [x,y]');
      if (tr.scale !== undefined && !isVec(tr.scale, 2)) err(`${lw}.transform.scale`, 'must be [sx,sy]');
      if (tr.opacity !== undefined && !(isNum(tr.opacity) && tr.opacity >= 0 && tr.opacity <= 100)) err(`${lw}.transform.opacity`, 'must be 0..100');
      if (tr.anchor !== undefined && tr.anchor !== 'center' && !isVec(tr.anchor, 2)) err(`${lw}.transform.anchor`, 'must be "center" or [x,y]');

      (l.animations || []).forEach((a, ai) => {
        const aw = `${lw}.animations[${ai}]`;
        const p = a.property;
        const okProp = TOKENS.includes(p) || (typeof p === 'string' && p.startsWith('effect:')) || (Array.isArray(p) && p.every((s) => typeof s === 'string'));
        if (!okProp) err(`${aw}.property`, `unknown property ${JSON.stringify(p)}`);
        if (!Array.isArray(a.keyframes) || (!a.keyframes.length && !a.expression)) { err(`${aw}.keyframes`, 'must be a non-empty array'); return; }
        let prev = -Infinity;
        a.keyframes.forEach((k, ki) => {
          if (!isNum(k.t)) err(`${aw}.keyframes[${ki}].t`, 'must be a number');
          else if (k.t < prev) err(`${aw}.keyframes[${ki}].t`, 'keyframes must be in time order');
          prev = k.t;
          if (p === 'sourceText' ? typeof k.v !== 'string'
            : ['position', 'scale', 'anchor'].includes(p) ? !isVec(k.v, 2)
            : ['opacity', 'rotation'].includes(p) ? !isNum(k.v) : false) {
            err(`${aw}.keyframes[${ki}].v`, `wrong value type for ${p}`);
          }
          if (p === 'opacity' && isNum(k.v) && (k.v < 0 || k.v > 100)) err(`${aw}.keyframes[${ki}].v`, 'opacity must be 0..100');
        });
      });
    });
  });
  return errs;
}

module.exports = { validateScene };

if (require.main === module) {
  const fs = require('fs');
  const file = process.argv[2];
  if (!file) { console.error('usage: node pipeline/validate-scene.js <scene.json>'); process.exit(1); }
  const errs = validateScene(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (errs.length) { console.log(`${errs.length} problem(s):\n  ` + errs.join('\n  ')); process.exit(1); }
  console.log('scene JSON is valid');
}
