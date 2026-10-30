// pipeline/export-jsx.js  (Phase 3 — portable build path)
//
// Emits a standalone .jsx (scene-JSON embedded + the same builder-core) that builds
// the comp via File > Scripts > Run Script File, with NO server/bridge needed.
//
//   node pipeline/export-jsx.js [scene.json] [out.jsx]
//   defaults: pipeline/sample-scene.json -> pipeline/out/<sceneName>.jsx

const fs = require('fs');
const path = require('path');
const { standaloneJsx } = require('./ae/builder-core.jsx.js');
const { BridgeError, fail } = require('./errors');

const scenePath = process.argv[2] || path.join(__dirname, 'sample-scene.json');
let scene;
try { scene = JSON.parse(fs.readFileSync(scenePath, 'utf8')); }
catch (e) {
  fail('export', new BridgeError(e.code === 'ENOENT' ? 'The scene JSON file does not exist.' : 'The scene JSON could not be parsed.', {
    file: path.resolve(scenePath), tryThis: 'run ingest first (npm run ingest -- <artifact.html>) or check the path.', cause: e,
  }));
}

const base = (scene.comp && scene.comp.name ? scene.comp.name : 'scene').replace(/[^A-Za-z0-9_-]/g, '_');
const outPath = process.argv[3] || path.join(__dirname, 'out', base + '.jsx');
const jsx = standaloneJsx(scene);

try {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, jsx);
} catch (e) {
  fail('export', new BridgeError('Could not write the .jsx file.', { file: path.resolve(outPath), tryThis: 'check the folder exists and is writable.', cause: e }));
}
console.log('wrote ' + outPath + ' (' + jsx.length + ' bytes)');
