// pipeline/errors.js
//
// Plain-language failures for every pipeline step: what broke, which file, what to
// try. The stack trace is printed last, as secondary detail (set AB_DEBUG=1 to see it).

class BridgeError extends Error {
  /**
   * @param {string} what  one sentence: what broke
   * @param {object} [o]   { file, tryThis, cause }
   */
  constructor(what, o = {}) {
    super(what);
    this.name = 'BridgeError';
    this.file = o.file;
    this.tryThis = o.tryThis;
    this.cause = o.cause;
  }
}

function report(step, err) {
  const e = err instanceof BridgeError ? err : explain(err);
  const lines = [``, `Artifact Bridge: ${step} failed`, `  What broke: ${e.message}`];
  if (e.file) lines.push(`  File:       ${e.file}`);
  if (e.tryThis) lines.push(`  Try:        ${e.tryThis}`);
  console.error(lines.join('\n'));
  const detail = e.cause || (err instanceof BridgeError ? null : err);
  if (detail && detail.stack) {
    if (process.env.AB_DEBUG) console.error('\n  Details:\n' + detail.stack.replace(/^/gm, '    '));
    else console.error('  (set AB_DEBUG=1 for the full error details)');
  }
}

// map common raw errors to plain language
function explain(err) {
  const msg = String((err && err.message) || err);
  if (/Executable doesn't exist|browserType\.launch/.test(msg)) {
    return new BridgeError('No headless browser available to render the artifact.', {
      tryThis: 'run `npx playwright install chromium` (or install Google Chrome), then retry.',
      cause: err,
    });
  }
  if (/Cannot find module 'playwright'/.test(msg)) {
    return new BridgeError('The playwright package is not installed.', { tryThis: 'run `npm install` in the repo folder.', cause: err });
  }
  if (err && err.code === 'ENOENT') {
    return new BridgeError('A file or folder was not found.', { file: err.path, tryThis: 'check the path and spelling.', cause: err });
  }
  if (err instanceof SyntaxError && /JSON/.test(msg)) {
    return new BridgeError('A scene JSON file is not valid JSON.', { tryThis: 're-run ingest to regenerate it, or fix the JSON by hand.', cause: err });
  }
  return new BridgeError(msg, { cause: err });
}

function fail(step, err, code = 1) {
  report(step, err);
  process.exit(code);
}

module.exports = { BridgeError, report, explain, fail };
