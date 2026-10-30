#!/usr/bin/env node
// pipeline/artifact-bridge.js — the one-command front door
//
//   node pipeline/artifact-bridge.js <artifact.html> [--scenes] [--hd] [--seconds N] [--replace]
//       preflight -> ingest (artifact -> scene JSON) -> build the comp live in the
//       open After Effects project (needs the bridge panel with Auto-run ticked)
//
//   node pipeline/artifact-bridge.js <artifact.html> --jsx <out.jsx> [--scenes] [--hd] [--seconds N]
//       preflight -> ingest -> write a standalone .jsx. No After Effects needed now;
//       later run it in AE via File > Scripts > Run Script File.
//
// Each stage prints what it is doing and where its files land. Stages run the
// existing pipeline scripts unchanged, so every stage can also be run on its own.

const path = require('path');
const { spawnSync } = require('child_process');
const { preflight } = require('./preflight');
const { BridgeError, fail } = require('./errors');

const USAGE = 'usage: node pipeline/artifact-bridge.js <artifact.html> [--jsx out.jsx] [--scenes] [--hd] [--seconds N] [--replace]';

function parseArgs(argv) {
  const o = { html: null, jsx: null, scenes: false, hd: false, seconds: null, replace: false, sceneOut: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--jsx') o.jsx = argv[++i];
    else if (a === '--scene-out') o.sceneOut = argv[++i];
    else if (a === '--seconds') o.seconds = argv[++i];
    else if (a === '--scenes') o.scenes = true;
    else if (a === '--hd') o.hd = true;
    else if (a === '--replace') o.replace = true;
    else if (a === '-h' || a === '--help') { console.log(USAGE); process.exit(0); }
    else if (a.startsWith('--')) throw new BridgeError(`Unknown option ${a}.`, { tryThis: USAGE });
    else if (!o.html) o.html = a;
  }
  if (!o.html) throw new BridgeError('No artifact given.', { tryThis: USAGE });
  if (o.jsx === undefined) throw new BridgeError('--jsx needs an output path.', { tryThis: USAGE });
  return o;
}

// run a pipeline script with inherited output; a failing script has already
// printed its own plain-language error, so just stop with its exit code
function run(script, args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), ...args], { stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
}

(async () => {
  const o = parseArgs(process.argv.slice(2));
  const live = !o.jsx;
  const html = path.resolve(o.html);
  const sceneJson = o.sceneOut ? path.resolve(o.sceneOut) : html.replace(/\.html?$/i, '') + '.scene.json';
  const total = 3;

  console.log(`\n[1/${total}] Preflight (${live ? 'live build in After Effects' : 'standalone .jsx, After Effects not needed'})`);
  if (!(await preflight({ live, quiet: true }))) process.exit(1);
  console.log('  ok');

  console.log(`\n[2/${total}] Ingest: ${html}`);
  const ingestArgs = [html, '--out', sceneJson];
  if (o.scenes) ingestArgs.push('--scenes');
  if (o.hd) ingestArgs.push('--hd');
  if (o.seconds) ingestArgs.push('--seconds', o.seconds);
  run('ingest-artifact.js', ingestArgs);
  console.log(`  scene JSON:    ${sceneJson}`);
  console.log(`  rasters/notes: ${path.join(__dirname, 'out')}`);

  if (live) {
    console.log(`\n[3/${total}] Build in After Effects (open project; new comps only, one undo step)`);
    run('build-scene.js', o.replace ? [sceneJson, '--replace'] : [sceneJson]);
    console.log('\nDone. The master comp is open in the AE viewer.');
  } else {
    const jsx = path.resolve(o.jsx);
    console.log(`\n[3/${total}] Export standalone .jsx`);
    run('export-jsx.js', [sceneJson, jsx]);
    console.log(`\nDone. In After Effects: File > Scripts > Run Script File... > ${jsx}`);
    console.log('Note: image layers point at absolute paths in pipeline/out/assets on this machine; elsewhere they build as labeled placeholder solids.');
  }
})().catch((e) => fail('artifact-bridge', e));
