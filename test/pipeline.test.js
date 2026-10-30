// Headless tests: ingest the demo artifact, validate the scene JSON against the
// schema, export a standalone .jsx, and exercise the builder's font lookup with a
// mocked After Effects. No After Effects needed. Run: npm test

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { validateScene } = require('../pipeline/validate-scene');
const { BUILDER_CORE, standaloneJsx } = require('../pipeline/ae/builder-core.jsx.js');

const ROOT = path.join(__dirname, '..');
const DEMO = path.join(ROOT, 'examples', 'demo.html');
const EXPECTED = require('../examples/demo.scene.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-bridge-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const node = (script, args) => spawnSync(process.execPath, [path.join(ROOT, 'pipeline', script), ...args], { encoding: 'utf8' });

let scene;

test('ingest renders examples/demo.html to scene JSON', () => {
  const out = path.join(tmp, 'demo.scene.json');
  const r = node('ingest-artifact.js', [DEMO, '--out', out]);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  scene = JSON.parse(fs.readFileSync(out, 'utf8'));
});

test('scene JSON matches scene-schema.md', () => {
  assert.deepStrictEqual(validateScene(scene), []);
  assert.deepStrictEqual(validateScene(EXPECTED), [], 'committed examples/demo.scene.json');
});

test('demo produces the expected layers (names, types, text, shapes)', () => {
  const summary = (s) => s.scenes[0].layers.map((l) => [l.name, l.type, l.text && l.text.value, l.text && l.text.fontFamily, l.shape && l.shape.kind]);
  assert.deepStrictEqual(summary(scene), summary(EXPECTED));
  assert.strictEqual(scene.comp.bg, '#101014', 'comp background comes from the #stage background');
});

test('motion is baked to keyframes', () => {
  const L = scene.scenes[0].layers;
  const anim = (name, prop) => (L.find((l) => l.name === name).animations || []).find((a) => a.property === prop);
  const title = anim('main title_3', 'position');
  assert.ok(title && title.keyframes.length > 2, 'title slides up');
  const ys = title.keyframes.map((k) => k.v[1]);
  assert.ok(Math.max(...ys) - ys.at(-1) > 30, 'title rises ~40 px into place');
  assert.ok(anim('main dot_2', 'scale'), 'dot pops in');
  const count = anim('main count_8', 'sourceText');
  assert.strictEqual(count.keyframes.at(-1).v, '100%', 'count-up ends at 100%');
  const glass = anim('main glass_6', 'opacity');
  assert.strictEqual(glass.keyframes.at(-1).v, 25, 'translucent fill folded into opacity');
});

test('export writes a standalone .jsx that parses', () => {
  const out = path.join(tmp, 'demo.jsx');
  const r = node('export-jsx.js', [path.join(tmp, 'demo.scene.json'), out]);
  assert.strictEqual(r.status, 0, r.stderr + r.stdout);
  const jsx = fs.readFileSync(out, 'utf8');
  assert.doesNotThrow(() => new Function(jsx));
  assert.strictEqual(jsx, standaloneJsx(scene));
});

test('ingest explains a missing #stage in plain language', () => {
  const bad = path.join(tmp, 'no-stage.html');
  fs.writeFileSync(bad, '<!doctype html><p>hi</p>');
  const r = node('ingest-artifact.js', [bad, '--out', path.join(tmp, 'x.json')]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /What broke: The artifact has no element with id="stage"/);
  assert.match(r.stderr, /Try:/);
});

// builder font lookup, run against a mocked AE text document
function styleText(ts, installed) {
  const doc = {};
  const tp = { value: doc, setValue() {} };
  const layer = { name: 'L', property: () => ({ property: () => tp }) };
  const ctx = vm.createContext({
    app: { fonts: { getFontsByFamilyNameAndStyleName: (fam, style) => (installed[fam + '/' + style] ? [{ postScriptName: installed[fam + '/' + style] }] : []) } },
  });
  vm.runInContext(BUILDER_CORE, ctx);
  const result = { warnings: [] };
  ctx.mcpStyleText(layer, ts, result);
  return { font: doc.font, warnings: result.warnings };
}

test('builder uses the installed CSS font family', () => {
  const r = styleText({ value: 'x', size: 10, font: 'Arial-BoldMT', fontFamily: 'Helvetica Neue', fontWeight: 700 }, { 'Helvetica Neue/Bold': 'HelveticaNeue-Bold' });
  assert.deepStrictEqual(r, { font: 'HelveticaNeue-Bold', warnings: [] });
});

test('builder falls back and warns when the font is not installed', () => {
  const r = styleText({ value: 'x', size: 10, font: 'ArialMT', fontFamily: 'Nope Sans', fontWeight: 400 }, {});
  assert.strictEqual(r.font, 'ArialMT');
  assert.match(r.warnings[0], /font 'Nope Sans' \(weight 400\) not found in AE; used ArialMT/);
});
