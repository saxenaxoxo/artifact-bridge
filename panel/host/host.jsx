// Artifact Bridge — host bootstrap (loaded once by CEP via manifest ScriptPath).
//
// Deliberately tiny: the heavy ES3 (builder-core / reader) is injected lazily from the
// panel via evalScript on first use (single source of truth stays pipeline/ae/*). This
// file only provides the health ping and a file-read helper used to load big payloads
// (scene JSON) from temp files — evalScript argument size stays small that way.

function aerPing() {
  var o = '{"ok":true,"version":"' + app.version + '","project":"';
  var p = "untitled";
  try { if (app.project.file) p = app.project.file.fsName; } catch (e) {}
  // JSON polyfill may not be loaded yet — build the tiny payload by hand (ES3-safe).
  o += p.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '","items":' + app.project.numItems + "}";
  return o;
}

// Read a UTF-8 file from disk and return its contents (used to load scene JSON written
// by the panel into /tmp — keeps evalScript payloads tiny regardless of scene size).
function aerReadFile(path) {
  var f = new File(path);
  if (!f.exists) return "__AER_NO_FILE__";
  f.encoding = "UTF-8";
  f.open("r");
  var s = f.read();
  f.close();
  return s;
}

// Engine-loaded marker — the panel injects builder-core + reader + JSON polyfill once
// per AE session and bumps this; later calls skip re-injection.
var __aerEngineVersion = 0;
