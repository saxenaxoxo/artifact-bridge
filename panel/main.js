/* Artifact Bridge — panel logic (Node-in-CEP).
 *
 * Reuses the proven pipeline end to end (spec §1 — nothing reimplemented):
 *   ingest  = spawn node pipeline/ingest-artifact.js (Playwright render & sample)
 *   build   = evalScript( JSON polyfill + BUILDER_CORE ) into the OPEN project
 *   verify  = host-side per-comp scoped dumps (depth-capped reader) → spawn
 *             pipeline/verify-artifact.js — the same closed loop as the CLI
 *   chat    = spawn the locally-authenticated `claude` CLI (Max plan, no API key),
 *             stream-json output, session continuity via --resume
 *
 * Safety (spec §8): builds only ADD namespaced comps (builder versions names, one undo
 * group, openInViewer); reads are per-comp scoped (BUG-19 hardening); no credentials.
 */
/* global CSInterface, SystemPath */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execFileSync } = require("child_process");

const cs = new CSInterface();

// ── DOM ──────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const statusDot = $("status-dot");
const hostInfo = $("host-info");
const dropzone = $("dropzone");
const fileInput = $("file-input");
const pickBtn = $("pick-file");
const pickedName = $("picked-name");
const buildBtn = $("build-btn");
const cancelBtn = $("cancel-btn");
const scenesToggle = $("scenes-toggle");
const progressWrap = $("progress");
const progressBar = $("progress-bar");
const logEl = $("log");
const chatLog = $("chat-log");
const chatForm = $("chat-form");
const chatText = $("chat-text");
const chatSend = $("chat-send");
const autonomyToggle = $("autonomy-toggle");
const footer = $("footer");

// ── Repo + binary discovery (cached) ────────────────────────────────────────
function findRepoRoot() {
  const isRepo = (p) => fs.existsSync(path.join(p, "pipeline", "ae", "builder-core.jsx.js"));
  // CEP reports the SYMLINK path for a symlinked install — resolve it first, then take
  // the parent (extension dir IS repo/panel). realpathSync also handles the plain case.
  const extDir = cs.getSystemPath(SystemPath.EXTENSION);
  let real = extDir;
  try { real = fs.realpathSync(extDir); } catch (e) { /* keep extDir */ }
  for (const dir of [path.resolve(real, ".."), path.resolve(extDir, "..")]) {
    if (isRepo(dir)) return dir;
  }
  // Copied install: install-panel.sh writes repo.json beside the manifest.
  try {
    const j = JSON.parse(fs.readFileSync(path.join(extDir, "repo.json"), "utf8"));
    if (j.root && isRepo(j.root)) return j.root;
  } catch (e) { /* fall through */ }
  return null;
}

function findBinary(name) {
  const cacheKey = `aer.bin.${name}`;
  const cached = localStorage.getItem(cacheKey);
  if (cached && fs.existsSync(cached)) return cached;
  const candidates = [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, path.join(os.homedir(), `.claude/local/${name}`)];
  let found = candidates.find((p) => fs.existsSync(p)) ?? null;
  if (!found) {
    try {
      // login shell so the user's real PATH (nvm, homebrew, npm-global) is in effect
      found = execFileSync("/bin/zsh", ["-lc", `which ${name}`], { encoding: "utf8" }).trim() || null;
      if (found && !fs.existsSync(found)) found = null;
    } catch (e) { found = null; }
  }
  if (found) localStorage.setItem(cacheKey, found);
  return found;
}

const REPO = findRepoRoot();
const NODE_BIN = findBinary("node");
let CLAUDE_BIN = null; // lazy — only needed for chat

// ── Logging helpers ──────────────────────────────────────────────────────────
function log(line, cls) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = line + "\n";
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}
function setProgress(pct) {
  progressWrap.hidden = pct == null;
  if (pct != null) progressBar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
}

// ── ExtendScript plumbing ────────────────────────────────────────────────────
function evalES(script) {
  return new Promise((resolve, reject) => {
    cs.evalScript(script, (res) => {
      if (res === "EvalScript error.") reject(new Error("ExtendScript threw (EvalScript error)"));
      else resolve(res);
    });
  });
}

let engineLoaded = false;
async function ensureEngine() {
  if (engineLoaded) return;
  const v = await evalES("String(typeof __aerEngineVersion !== 'undefined' ? __aerEngineVersion : 0)");
  if (v !== "1") {
    const bc = require(path.join(REPO, "pipeline", "ae", "builder-core.jsx.js"));
    const rd = require(path.join(REPO, "pipeline", "ae", "read.jsx.js"));
    await evalES(bc.JSON_POLYFILL + "\n" + bc.BUILDER_CORE + "\n" + rd.READER_CORE + "\n__aerEngineVersion = 1; String(__aerEngineVersion)");
  }
  engineLoaded = true;
}

// ── Health check ─────────────────────────────────────────────────────────────
async function healthCheck() {
  try {
    const raw = await evalES("aerPing()");
    const info = JSON.parse(raw);
    statusDot.className = "dot ok";
    statusDot.title = "Connected";
    const proj = info.project === "untitled" ? "untitled project" : path.basename(info.project);
    hostInfo.textContent = `AE ${info.version} · ${proj} · ${info.items} item(s)`;
  } catch (e) {
    statusDot.className = "dot err";
    statusDot.title = String(e);
    hostInfo.textContent = "can't reach AE — reopen the panel";
  }
  if (!REPO) {
    log("Repo not found — run panel/install-panel.sh from the repo (it records the path).", "err");
    buildBtn.disabled = true;
  }
  footer.textContent = `repo: ${REPO ? path.basename(REPO) + " ✓" : "NOT FOUND"} · node: ${NODE_BIN ? "✓" : "missing"}`;
}

// ── Build flow ───────────────────────────────────────────────────────────────
let artifactPath = null;
let currentChild = null;

function setArtifact(p) {
  if (!p) return;
  if (!/\.html?$/i.test(p)) { log(`Not an HTML artifact: ${p}`, "err"); return; }
  artifactPath = p;
  pickedName.textContent = path.basename(p);
  buildBtn.disabled = !REPO || !NODE_BIN;
}

dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("armed"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("armed"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("armed");
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f && f.path) setArtifact(f.path);
  else log("Couldn't read the dropped file's path — use “choose a file…” instead.", "err");
});
pickBtn.addEventListener("click", () => {
  // Native dialog via CEP's fs API — always yields absolute paths (the <input> fallback
  // exists for environments where showOpenDialogEx is unavailable).
  const cep = window.cep;
  if (cep && cep.fs && cep.fs.showOpenDialogEx) {
    const r = cep.fs.showOpenDialogEx(false, false, "Choose an HTML artifact", REPO ? path.join(REPO, "inputs") : "", ["html", "htm"]);
    if (r && r.data && r.data[0]) setArtifact(decodeURI(String(r.data[0]).replace("file://", "")));
  } else fileInput.click();
});
fileInput.addEventListener("change", () => {
  const f = fileInput.files && fileInput.files[0];
  if (f && f.path) setArtifact(f.path);
});

function spawnLogged(bin, args, opts, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { ...opts, env: { ...process.env, PATH: `${path.dirname(bin)}:${process.env.PATH || "/usr/bin:/bin"}` } });
    currentChild = child;
    cancelBtn.hidden = false;
    let buf = "";
    const feed = (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) onLine(line);
      }
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => { currentChild = null; cancelBtn.hidden = true; reject(e); });
    child.on("close", (code, signal) => {
      if (buf.trim()) onLine(buf.trim());
      currentChild = null;
      cancelBtn.hidden = true;
      if (signal) reject(new Error(`cancelled (${signal})`));
      else if (code === 0) resolve();
      else reject(new Error(`${path.basename(bin)} exited ${code}`));
    });
  });
}

cancelBtn.addEventListener("click", () => {
  if (currentChild) { currentChild.kill("SIGTERM"); log("Cancelled.", "err"); }
});

buildBtn.addEventListener("click", async () => {
  if (!artifactPath) return;
  buildBtn.disabled = true;
  logEl.textContent = "";
  try {
    // 1) Ingest (render & sample in headless Chromium) — the proven pipeline, untouched.
    setProgress(5);
    log(`▸ Ingesting ${path.basename(artifactPath)} (${scenesToggle.checked ? "scene mode" : "load mode"})…`);
    // --hd: delivery resolution (stage short side -> 1080; 9:16 stages -> exactly 1080x1920)
    const ingestArgs = [path.join(REPO, "pipeline", "ingest-artifact.js"), artifactPath, "--hd"];
    if (scenesToggle.checked) ingestArgs.push("--scenes");
    await spawnLogged(NODE_BIN, ingestArgs, { cwd: REPO }, (l) => { log("  " + l); setProgress(Math.min(45, 5 + logEl.childElementCount * 2)); });

    const scenePath = artifactPath.replace(/\.html?$/i, ".scene.json");
    if (!fs.existsSync(scenePath)) throw new Error(`ingest produced no scene JSON at ${scenePath}`);
    const scene = JSON.parse(fs.readFileSync(scenePath, "utf8"));
    log(`✓ scene JSON: ${scene.scenes.length} scenes, comp ${scene.comp.width}x${scene.comp.height}, ${scene.comp.duration}s`, "ok");

    // 2) Build into the OPEN project — engine via evalScript; scene loaded host-side
    //    from a temp file so the evalScript payload stays tiny at any scene size.
    setProgress(50);
    log("▸ Building into the open project…");
    await ensureEngine();
    const tmp = path.join(os.tmpdir(), `aer-scene-${Date.now()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(scene));
    const buildRes = JSON.parse(await evalES(
      `(function(){ var raw = aerReadFile(${JSON.stringify(tmp)});` +
      ` if (raw === "__AER_NO_FILE__") return '{"ok":false,"error":"temp scene file missing"}';` +
      ` return JSON.stringify(mcpBuildScene(JSON.parse(raw))); })()`,
    ));
    fs.unlinkSync(tmp);
    if (!buildRes.ok) throw new Error(`build failed: ${buildRes.error}`);
    log(`✓ built ${buildRes.master} (+${buildRes.created.length} precomps)${buildRes.warnings.length ? ` · ${buildRes.warnings.length} warning(s)` : ""}`, "ok");
    for (const w of buildRes.warnings.slice(0, 5)) log("  ⚠ " + w);

    // 3) Self-verify — scoped per-comp dumps written host-side, then the REAL verifier.
    setProgress(70);
    log("▸ Verifying (reader → verify-artifact.js)…");
    const vsuf = buildRes.master.slice(scene.comp.name.length); // "" or "_2" etc. (versioned rebuilds)
    const outDir = path.join(REPO, "pipeline", "out");
    fs.mkdirSync(outDir, { recursive: true });
    const dumpTo = async (compName, file) => {
      const r = await evalES(
        `(function(){ var c = mcpFindComp(${JSON.stringify(compName)}); if (!c) return "no-comp";` +
        ` var s = JSON.stringify(mcpReadComp(c, 12)); var f = new File(${JSON.stringify(file)});` +
        ` f.encoding = "UTF-8"; f.open("w"); f.write(s); f.close(); return "ok:" + s.length; })()`,
      );
      if (!r.startsWith("ok:")) throw new Error(`dump of ${compName}: ${r}`);
    };
    await dumpTo(buildRes.master, path.join(outDir, "dump-PANEL-master.json"));
    for (const created of buildRes.created) {
      const sceneName = created.slice(0, created.length - vsuf.length);
      const suffix = sceneName.replace(`${scene.comp.name}_`, "");
      await dumpTo(created, path.join(outDir, `dump-PANEL-${suffix}${vsuf}.json`));
    }
    setProgress(90);
    let verdict = "";
    await spawnLogged(
      NODE_BIN,
      [path.join(REPO, "pipeline", "verify-artifact.js"), scenePath, "PANEL", ...(vsuf ? [vsuf] : []), "--quiet"],
      { cwd: REPO },
      (l) => { verdict = l; if (/FAIL/.test(l)) log("  " + l, "err"); },
    ).catch((e) => { throw new Error(`verification failed — ${verdict || e.message}`); });
    log(`✓ verified: ${verdict}`, "ok");
    setProgress(100);
    log(`Done — ${buildRes.master} is open in the viewer.`, "ok");
    await healthCheck(); // refresh item count
  } catch (e) {
    log(String(e.message || e), "err");
    setProgress(null);
  } finally {
    buildBtn.disabled = false;
    setTimeout(() => setProgress(null), 1500);
  }
});

// ── Claude chat ──────────────────────────────────────────────────────────────
let sessionId = null;
let chatBusy = false;

function chatMsg(cls, text) {
  const div = document.createElement("div");
  div.className = `msg ${cls}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
  return div;
}

const PANEL_SYSTEM_PROMPT =
  "You are embedded in 'Artifact Bridge', a CEP panel inside After Effects. The user works on the OPEN AE " +
  "project. To read or modify AE, use the existing pipeline in this repo via Bash — e.g. " +
  "`node pipeline/dump-project.js <CompName>` (scoped deep read), `node pipeline/build-scene.js <scene.json>` " +
  "(build), `node pipeline/read-comp.js <CompName>` (comp → scene JSON), or targeted evals via " +
  "pipeline/ae-bridge.js evalExtendScript (ES3 only — see pipeline/scene-schema.md). HARD RULES: only ADD " +
  "namespaced comps; NEVER delete/overwrite the user's existing comps; never deep-dump the whole project " +
  "(per-comp reads only); builds run in one undo group. Keep answers short — you're in a narrow panel.";

async function sendChat(text) {
  if (chatBusy) return;
  if (!CLAUDE_BIN) CLAUDE_BIN = findBinary("claude");
  if (!CLAUDE_BIN) { chatMsg("err", "claude CLI not found on this machine — install/auth it, then retry."); return; }
  chatBusy = true;
  chatSend.disabled = true;
  chatMsg("user", text);
  const thinking = chatMsg("sys", "…");

  const args = ["-p", text, "--output-format", "stream-json", "--verbose", "--append-system-prompt", PANEL_SYSTEM_PROMPT];
  if (sessionId) args.push("--resume", sessionId);
  if (autonomyToggle.checked) args.push("--dangerously-skip-permissions");
  else args.push("--permission-mode", "acceptEdits");

  let answer = null;
  try {
    await spawnLogged(CLAUDE_BIN, args, { cwd: REPO }, (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch (e) { return; } // non-JSON noise (verbose banners)
      if (ev.type === "system" && ev.session_id) sessionId = ev.session_id;
      if (ev.type === "assistant" && ev.message && Array.isArray(ev.message.content)) {
        for (const block of ev.message.content) {
          if (block.type === "text" && block.text.trim()) {
            if (!answer) { answer = chatMsg("claude", block.text); thinking.remove(); }
            else answer.textContent += "\n" + block.text;
          } else if (block.type === "tool_use") {
            chatMsg("tool", `⚙ ${block.name}${block.input && block.input.command ? `: ${String(block.input.command).slice(0, 90)}` : ""}`);
          }
        }
        chatLog.scrollTop = chatLog.scrollHeight;
      }
      if (ev.type === "result") {
        if (ev.session_id) sessionId = ev.session_id;
        if (ev.is_error && ev.result) chatMsg("err", String(ev.result).slice(0, 400));
        else if (!answer && ev.result) { thinking.remove(); answer = chatMsg("claude", String(ev.result)); }
      }
    });
  } catch (e) {
    chatMsg("err", String(e.message || e));
  } finally {
    thinking.remove();
    chatBusy = false;
    chatSend.disabled = false;
    healthCheck(); // chat may have changed the project — refresh the header
  }
}

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = chatText.value.trim();
  if (!text) return;
  chatText.value = "";
  sendChat(text);
});
chatText.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

// ── boot ─────────────────────────────────────────────────────────────────────
healthCheck();
