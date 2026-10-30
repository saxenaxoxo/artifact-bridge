// pipeline/verify-artifact.js  (Phase 5 — replica vs scene-JSON ground-truth check)
//
//   node pipeline/verify-artifact.js <scene.json> <dumpPrefix>
//   e.g. node pipeline/verify-artifact.js inputs/explainer_….scene.json SPR
// Expects pipeline/out/dump-<prefix>-master.json and dump-<prefix>-<sceneSuffix>.json
// (suffix = scene name after the comp-name prefix, e.g. "s1", "Background").
//
// Asserts: master comp settings + precomp nesting/start times; per scene: layer
// count/names/types, baked keyframe counts and endpoint values within tolerance,
// static positions vs sampled boxes, text content, sourceText keys, trim keys.

const fs = require('fs');
const path = require('path');

const sceneJson = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const prefix = process.argv[3] || 'SPR';
const VSUF = (process.argv[4] && !process.argv[4].startsWith('--')) ? process.argv[4] : ''; // rebuild version suffix, e.g. _2
const OUT = path.join(__dirname, 'out');
const load = (n) => JSON.parse(fs.readFileSync(path.join(OUT, `dump-${prefix}-${n}.json`), 'utf8'));

let pass = 0, fails = 0;
const silentPass = process.argv.includes('--quiet');
function check(label, cond, detail) {
  if (cond) { pass++; if (!silentPass) console.log(`PASS  ${label}`); }
  else { fails++; console.log(`FAIL  ${label}${detail !== undefined ? ' — ' + detail : ''}`); }
}
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) <= tol;
const nearVec = (a, b, tol) => Array.isArray(a) && b.every((bv, i) => near(a[i], bv, tol));

const propIn = (list, mn) => (list || []).find((p) => p.matchName === mn);
const child = (n, mn) => (n ? propIn(n.properties, mn) : undefined);
const walk = (l, ...mns) => {
  let n = propIn(l.root, mns[0]);
  for (let i = 1; i < mns.length && n; i++) n = child(n, mns[i]);
  return n;
};
const TOKEN_MN = { opacity: 'ADBE Opacity', position: 'ADBE Position', scale: 'ADBE Scale', rotation: 'ADBE Rotate Z', anchor: 'ADBE Anchor Point' };

// ---- master
const master = load('master');
const comp = sceneJson.comp;
check('master dims', master.width === comp.width && master.height === comp.height, `${master.width}x${master.height}`);
check('master fps', near(master.frameRate, comp.fps, 0.01), master.frameRate);
check('master duration', near(master.duration, comp.duration, 0.05), master.duration);
check('master nests all scenes', master.numLayers === sceneJson.scenes.length, `${master.numLayers} vs ${sceneJson.scenes.length}`);
for (const sc of sceneJson.scenes) {
  const lay = (master.layers || []).find((l) => l.name === sc.name + VSUF);
  check(`master has ${sc.name + VSUF}`, !!lay);
  if (lay) check(`${sc.name} startTime=${sc.start}`, near(lay.startTime, sc.start, 0.034), lay.startTime);
}

// ---- per scene
for (const sc of sceneJson.scenes) {
  const suffix = sc.name.replace(comp.name + '_', '');
  let dump;
  try { dump = load(suffix + VSUF); } catch (e) { check(`dump ${suffix} loads`, false, e.message); continue; }
  check(`${suffix}: layer count ${sc.layers.length}`, dump.numLayers === sc.layers.length, dump.numLayers);
  sc.layers.forEach((wl, wi) => {
    const dl = (dump.layers || []).find((l) => l.name === wl.name);
    check(`${suffix}: layer "${wl.name}"`, !!dl, 'missing');
    if (!dl) return;
    // order: scene layers[0] should be index 1 (top)
    check(`${suffix}: "${wl.name}" stacking`, dl.index === wi + 1, `index ${dl.index} != ${wi + 1}`);
    const hasSourceTextAnim = (wl.animations || []).some((a) => a.property === 'sourceText');
    if (wl.type === 'text' && !hasSourceTextAnim) { // sourceText layers read back the t=0 hold key
      const firstLine = (wl.text.value || '').split('\r')[0];
      check(`${suffix}: "${wl.name}" text`, dl.text && (dl.text.text || '').split(/[\r\n\x03]/)[0] === firstLine,
        dl.text && JSON.stringify(dl.text.text));
      check(`${suffix}: "${wl.name}" fontSize`, dl.text && near(dl.text.fontSize, wl.text.size, 0.6), dl.text && dl.text.fontSize);
    }
    if (wl.type === 'image') {
      check(`${suffix}: "${wl.name}" is footage layer`, !dl.isText && !dl.isShape && dl.matchName === 'ADBE AV Layer', dl.matchName);
    }
    const tg = 'ADBE Transform Group';
    // static position within tolerance of sampled box center
    if (wl.transform && Array.isArray(wl.transform.position)) {
      const p = walk(dl, tg, 'ADBE Position');
      check(`${suffix}: "${wl.name}" static pos`, p && nearVec(p.value, wl.transform.position, 1.5),
        p && JSON.stringify(p.value) + ' vs ' + JSON.stringify(wl.transform.position));
    }
    for (const an of wl.animations || []) {
      let p, label;
      if (Array.isArray(an.property)) { p = walk(dl, ...an.property); label = 'trim'; }
      else if (an.property === 'sourceText') { p = walk(dl, 'ADBE Text Properties', 'ADBE Text Document'); label = 'sourceText'; }
      else { p = walk(dl, tg, TOKEN_MN[an.property]); label = an.property; }
      if (!an.keyframes) continue;
      check(`${suffix}: "${wl.name}" ${label} numKeys=${an.keyframes.length}`, p && p.numKeys === an.keyframes.length, p && p.numKeys);
      if (p && p.keys && label !== 'sourceText') {
        const w0 = an.keyframes[0], wN = an.keyframes[an.keyframes.length - 1];
        const k0 = p.keys[0], kN = p.keys[p.keys.length - 1];
        const tol = label === 'position' ? 1.5 : 1.0;
        const v0ok = Array.isArray(w0.v) ? nearVec(k0.v, w0.v, tol) : near(k0.v, w0.v, tol);
        const vNok = Array.isArray(wN.v) ? nearVec(kN.v, wN.v, tol) : near(kN.v, wN.v, tol);
        check(`${suffix}: "${wl.name}" ${label} endpoints`, v0ok && vNok,
          JSON.stringify([k0.v, kN.v]) + ' vs ' + JSON.stringify([w0.v, wN.v]));
        check(`${suffix}: "${wl.name}" ${label} key times`, near(k0.t, w0.t, 0.034) && near(kN.t, wN.t, 0.034),
          JSON.stringify([k0.t, kN.t]));
      }
      if (p && p.keys && label === 'sourceText') {
        const texts = p.keys.map((k) => k.v && k.v.text);
        const want = an.keyframes.map((k) => k.v);
        check(`${suffix}: "${wl.name}" sourceText first/last`, texts[0] === want[0] && texts[texts.length - 1] === want[want.length - 1],
          JSON.stringify([texts[0], texts[texts.length - 1]]) + ' vs ' + JSON.stringify([want[0], want[want.length - 1]]));
      }
    }
    if (wl.effects) {
      for (const ef of wl.effects) {
        const fx = walk(dl, 'ADBE Effect Parade', ef.matchName);
        check(`${suffix}: "${wl.name}" effect ${ef.matchName}`, !!fx, 'missing');
      }
    }
  });
}

console.log(`\n${pass} passed, ${fails} failed`);
process.exit(fails === 0 ? 0 : 1);
