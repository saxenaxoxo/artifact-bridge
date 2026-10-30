// pipeline/dump-project.js  (Phase 1)
//
// Reads the AE project (or a single comp) as deep JSON via the bridge's `eval`,
// using the recursive reader in pipeline/ae/read.jsx.js.
//   node pipeline/dump-project.js            -> whole project, deep
//   node pipeline/dump-project.js MCP_Test   -> just that comp, deep
//
// Proof of `eval` + reusable read-back / verification tool for the build engine.

const { evalExtendScript } = require('./ae-bridge');
const { projectDumpScript, compDumpScript } = require('./ae/read.jsx.js');

(async () => {
  const compArg = process.argv[2];
  // No comp arg -> SHALLOW project overview (depth-capped; see BUG-19). Deep reads are
  // per-comp only: pass a comp name and iterate comps for a full-project deep sweep.
  const script = compArg ? compDumpScript(compArg, 12) : projectDumpScript();
  try {
    // project-wide overview can take minutes on key-heavy projects: long timeout and
    // NO auto-retry (a re-sent slow dump just doubles the busy window — BUG-20)
    const res = await evalExtendScript(script, compArg
      ? { timeoutMs: 60000 }
      : { timeoutMs: 600000, retries: 0 });
    if (res && res.status === 'error') {
      console.error('eval reported an error from AE:\n' + JSON.stringify(res, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify(res, null, 2));
  } catch (e) {
    console.error('dump failed: ' + e.message);
    process.exit(1);
  }
})();
