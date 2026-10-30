// pipeline/ae-bridge.js
//
// Minimal driver for the After Effects "MCP Bridge Auto" panel, talking directly
// over its file protocol (the same ae_command.json / ae_mcp_result.json files the
// MCP server uses). This lets the Stage B builder drive AE without going through
// the MCP server process — useful because a standalone Node builder can't call the
// MCP server's tools, but it CAN write the bridge's command file.
//
// Prerequisites: the "MCP Bridge Auto" panel is open in AE with "Auto-run commands"
// ticked, and AE's "Allow Scripts to Write Files and Access Network" is enabled.

const fs = require('fs');
const os = require('os');
const path = require('path');

const BRIDGE_DIR = path.join(os.homedir(), 'Documents', 'ae-mcp-bridge');
const COMMAND_FILE = path.join(BRIDGE_DIR, 'ae_command.json');
const RESULT_FILE = path.join(BRIDGE_DIR, 'ae_mcp_result.json');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null; // mid-write / malformed — caller will poll again
  }
}

/**
 * Send one command to the bridge and wait for its result.
 *
 * The bridge panel polls ae_command.json and runs anything whose status is
 * "pending". We mirror the MCP server's sequence exactly: reset the result file
 * to "waiting" FIRST, then write the pending command, then poll the result file
 * until it leaves the "waiting" state.
 *
 * @param {string} command  bridge command name (e.g. "eval", "createComposition")
 * @param {object} args      command arguments
 * @param {object} [opts]    { timeoutMs = 30000, pollMs = 250 }
 * @returns {Promise<object>} parsed result object written by AE
 */
async function sendCommand(command, args = {}, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pollMs = opts.pollMs ?? 250;
  const retries = opts.retries ?? 1; // the panel can miss a command written in the same
                                     // tick it finishes the previous one (BUG-4) — one
                                     // automatic re-send with a settle delay covers it

  if (!fs.existsSync(BRIDGE_DIR)) {
    throw new Error(
      `Bridge folder not found: ${BRIDGE_DIR}\n` +
      `Is the AE "MCP Bridge Auto" panel installed and open at least once?`
    );
  }

  for (let attempt = 0; ; attempt++) {
    // 1) Reset result so we can unambiguously detect the fresh response.
    fs.writeFileSync(
      RESULT_FILE,
      JSON.stringify({ status: 'waiting', message: 'Waiting for new result from After Effects...' })
    );

    // 2) Write the command (status "pending" is what triggers the polling panel).
    fs.writeFileSync(
      COMMAND_FILE,
      JSON.stringify({ command, args, timestamp: new Date().toISOString(), status: 'pending' }, null, 2)
    );

    // 3) Poll until the bridge overwrites the result (status !== "waiting") or we time out.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const res = readJsonSafe(RESULT_FILE);
      if (res && res.status !== 'waiting') return res;
    }
    if (attempt >= retries) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for AE to answer "${command}" ` +
        `(${attempt + 1} attempt(s)). Confirm the bridge panel is open with ` +
        `"Auto-run commands" ticked.`
      );
    }
    await sleep(750); // settle, then re-send
  }
}

/**
 * Run arbitrary ExtendScript via the bridge's "eval" command (requires the patched
 * bridge). The script's final value is returned: a string is passed through verbatim
 * (so a script can return its own JSON), anything else is JSON-stringified by AE.
 *
 * @param {string} code   ExtendScript source
 * @param {object} [opts] forwarded to sendCommand
 * @returns {Promise<object>} parsed result
 */
async function evalExtendScript(code, opts = {}) {
  return sendCommand('eval', { code }, opts);
}

module.exports = { sendCommand, evalExtendScript, BRIDGE_DIR, COMMAND_FILE, RESULT_FILE };
