// pipeline/build-scene.js  (Phase 3 — live build path)
//
// Reads a scene-JSON file, compiles it to ExtendScript via builder-core, runs it
// through the bridge's `eval`, and prints the build result. The master comp appears
// live in the open AE project and auto-opens in the viewer.
//
//   node pipeline/build-scene.js [path/to/scene.json] [--replace]
//   (default scene: pipeline/sample-scene.json)
//
// --replace: before building, remove project comps whose names EXACTLY match this
// scene's master/scene names, so repeated rebuilds of the same scene don't accumulate
// versioned duplicates (Promo_2, Promo_3 …). Opt-in: it deletes same-named comps from
// earlier runs of the SAME scene — don't use it if you keep your own comps under
// these exact names. Without the flag, the engine versions names and never deletes.

const fs = require('fs');
const path = require('path');
const { evalExtendScript } = require('./ae-bridge');
const { buildSceneScript, jsonForES3 } = require('./ae/builder-core.jsx.js');
const { BridgeError, fail } = require('./errors');

(async () => {
  const args = process.argv.slice(2).filter((a) => a !== '--replace');
  const replace = process.argv.includes('--replace');
  const scenePath = args[0] || path.join(__dirname, 'sample-scene.json');
  let scene;
  try { scene = JSON.parse(fs.readFileSync(scenePath, 'utf8')); }
  catch (e) {
    fail('build', new BridgeError(e.code === 'ENOENT' ? 'The scene JSON file does not exist.' : 'The scene JSON could not be parsed.', {
      file: path.resolve(scenePath), tryThis: 'run ingest first (npm run ingest -- <artifact.html>) or check the path.', cause: e,
    }));
  }

  try {
    if (replace) {
      const names = [scene.comp && scene.comp.name, ...(scene.scenes || []).map((s) => s.name)].filter(Boolean);
      const rmScript = '(function(){ var names = ' + jsonForES3(names) + '; var removed = [];' +
        ' for (var i = app.project.numItems; i >= 1; i--) { var it = app.project.item(i);' +
        '   if (!(it instanceof CompItem)) continue;' +
        '   for (var n = 0; n < names.length; n++) { if (it.name === names[n]) { removed.push(it.name); it.remove(); break; } } }' +
        ' return JSON.stringify({removed: removed}); })()';
      const rm = await evalExtendScript(rmScript, { timeoutMs: 60000, retries: 0 });
      console.log('replace pre-pass: ' + JSON.stringify(rm));
    }
    // retries:0 — a re-sent build would duplicate comps if AE was merely slow
    const res = await evalExtendScript(buildSceneScript(scene), { timeoutMs: 300000, retries: 0 });
    console.log(JSON.stringify(res, null, 2));
    if (res && (res.ok === false || res.status === 'error')) {
      fail('build', new BridgeError('After Effects reported an error while building the comp: ' + (res.error || res.message || 'see the result above'), {
        file: path.resolve(scenePath), tryThis: 'read the error above; if it names a layer, check that layer in the scene JSON.',
      }));
    }
    if (res && res.warnings && res.warnings.length) console.log(`built with ${res.warnings.length} warning(s) — listed above under "warnings".`);
  } catch (e) {
    fail('build', /Bridge folder not found|Timed out/.test(e.message)
      ? new BridgeError(e.message.split('\n')[0], { tryThis: 'run `npm run preflight -- --live`: it checks the bridge panel and tells you exactly what to fix.', cause: e })
      : e);
  }
})();
