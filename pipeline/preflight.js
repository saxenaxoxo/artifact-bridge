#!/usr/bin/env node
// pipeline/preflight.js
//
// Checks that this machine can run the pipeline, and says exactly what to fix.
//
//   node pipeline/preflight.js          checks for the headless path (ingest + .jsx export)
//   node pipeline/preflight.js --live   also checks After Effects + the bridge panel
//
// The headless checks never touch After Effects. The --live checks send one tiny
// read-only ping through the bridge (returns AE's version, changes nothing).

const fs = require('fs');
const os = require('os');
const path = require('path');

function check(name, ok, fix) { return { name, ok: !!ok, fix }; }

async function headlessChecks() {
  const out = [];
  const major = parseInt(process.versions.node, 10);
  out.push(check(`Node.js 18 or newer (found ${process.versions.node})`, major >= 18,
    'install Node.js 18+ from https://nodejs.org and reopen your terminal.'));

  let pw = null;
  try { pw = require('playwright'); } catch (e) {}
  out.push(check('playwright package installed', pw,
    'run `npm install` in the repo folder.'));

  if (pw) {
    let bundled = false;
    try { bundled = fs.existsSync(pw.chromium.executablePath()); } catch (e) {}
    let chrome = false;
    if (!bundled) {
      try { const b = await pw.chromium.launch({ channel: 'chrome' }); await b.close(); chrome = true; } catch (e) {}
    }
    out.push(check(
      bundled ? 'headless Chromium (Playwright)' : (chrome ? 'headless browser (your Google Chrome — Playwright Chromium not installed)' : 'headless browser'),
      bundled || chrome,
      'run `npx playwright install chromium` (or install Google Chrome).'));
  }
  return out;
}

function bridgeScriptInstalled() {
  const roots = process.platform === 'darwin'
    ? ['/Applications']
    : process.platform === 'win32' ? ['C:\\Program Files\\Adobe'] : [];
  for (const root of roots) {
    let entries = [];
    try { entries = fs.readdirSync(root); } catch (e) { continue; }
    for (const d of entries.filter((n) => /^Adobe After Effects/.test(n))) {
      const sub = process.platform === 'win32' ? path.join(root, d, 'Support Files', 'Scripts', 'ScriptUI Panels') : path.join(root, d, 'Scripts', 'ScriptUI Panels');
      const f = path.join(sub, 'mcp-bridge-auto.jsx');
      if (fs.existsSync(f)) return { found: true, where: f, ae: d };
    }
  }
  return { found: false };
}

// true / false, or null when this OS can't be checked
function aeRunning() {
  const { execFileSync } = require('child_process');
  try {
    if (process.platform === 'darwin') return /After Effects/.test(execFileSync('ps', ['-axco', 'command'], { encoding: 'utf8' }));
    if (process.platform === 'win32') return /AfterFX\.exe/i.test(execFileSync('tasklist', [], { encoding: 'utf8' }));
  } catch (e) {}
  return null;
}

async function liveChecks() {
  const { BRIDGE_DIR, evalExtendScript } = require('./ae-bridge');
  const out = [];
  const inst = bridgeScriptInstalled();
  out.push(check(inst.found ? `bridge panel installed (${inst.ae})` : 'bridge panel installed in After Effects', inst.found,
    'run `cd after-effects-mcp && npm install && npm run install-bridge` (it copies mcp-bridge-auto.jsx into AE\'s ScriptUI Panels folder; may need admin rights).'));

  const dirOk = fs.existsSync(BRIDGE_DIR);
  out.push(check(`bridge folder exists (${BRIDGE_DIR.replace(os.homedir(), '~')})`, dirOk,
    'open After Effects, then Window > mcp-bridge-auto.jsx once — the panel creates this folder.'));

  const running = aeRunning();
  if (running !== null) {
    out.push(check('After Effects is running', running, 'open After Effects with a project, then run this again.'));
  }

  if (dirOk && running !== false) {
    let ping = null, err = null;
    try {
      ping = await evalExtendScript('(function(){return JSON.stringify({ok:true,version:app.version})})()', { timeoutMs: 5000, retries: 0 });
    } catch (e) { err = e; }
    const answered = !err;
    out.push(check('bridge panel is open with "Auto-run commands" ticked', answered,
      'in After Effects: Window > mcp-bridge-auto.jsx, tick "Auto-run commands", and keep the panel open. Also enable Settings > Scripting & Expressions > "Allow Scripts to Write Files and Access Network".'));
    if (answered) {
      // the bridge may return our JSON as-is or wrapped/escaped — match loosely
      const text = JSON.stringify(ping);
      const evalOk = /ok\W+true/.test(text);
      const ver = (/version\W+([\d.]+(?:x\d+)?)/.exec(text) || [])[1];
      out.push(check(`bridge accepts raw ExtendScript${ver ? ` (AE ${ver})` : ''}`, evalOk,
        'your installed bridge is an older copy without the `eval` command — reinstall it from this repo\'s after-effects-mcp folder (npm run install-bridge), then reopen the panel.'));
    }
  }
  return out;
}

async function preflight({ live = false, quiet = false } = {}) {
  const results = await headlessChecks();
  if (live) results.push(...await liveChecks());
  const failed = results.filter((r) => !r.ok);
  if (!quiet || failed.length) {
    console.log(`Preflight (${live ? 'live build in After Effects' : 'headless: ingest + .jsx export'})`);
    for (const r of results) {
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`);
      if (!r.ok) console.log(`        fix: ${r.fix}`);
    }
  }
  return failed.length === 0;
}

module.exports = { preflight };

if (require.main === module) {
  preflight({ live: process.argv.includes('--live') }).then((ok) => {
    console.log(ok ? 'All good.' : 'Fix the items marked FAIL, then run this again.');
    process.exit(ok ? 0 : 1);
  });
}
