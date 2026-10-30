# Artifact Bridge — dockable AE panel

A CEP panel (Chromium + Node inside After Effects) wrapping the repo's pipeline:
drop an HTML artifact → it renders & samples it headlessly, builds the scenes as native
comps into the **open project**, and self-verifies with the deep reader. Plus an
embedded **Claude** chat (your already-authenticated local `claude` CLI — Max plan, no
API key) that can read/edit the open project through the same pipeline.

## Install (once, ~30s, no sudo)

```bash
./panel/install-panel.sh        # symlink install (live dev)
```

Quit AE fully (⌘Q), reopen, then **Window ▸ Extensions ▸ Artifact Bridge**. The panel
docks like any native panel and persists across projects and restarts.

## Use

- **Build from artifact** — drop an `.html` (or *choose a file…*), keep **scene mode**
  on for multi-scene/chip-player explainers, press **Build**. Watch ingest → build →
  verify in the log. The master comp auto-opens. Existing comps are never touched —
  names version (`X`, `X_2`, …) and each build is ONE undo group (⌘Z undoes it all).
- **Claude** — chat about the open project: *"build examples/demo.html"*,
  *"make scene 3 two seconds longer"*, *"read MCP_Test and report its keyframes"*.
  **full autonomy** ON lets it run pipeline commands without per-step prompts; OFF
  restricts it to file edits (it will still answer read-only questions).

## How it's wired (reuses `pipeline/*`, nothing reimplemented)

| step | mechanism |
|---|---|
| ingest | `spawn node pipeline/ingest-artifact.js <file> [--scenes]` |
| build | `evalScript(JSON polyfill + BUILDER_CORE)` → `mcpBuildScene(scene)` into `app.project` |
| verify | host writes per-comp scoped dumps (depth-capped reader) → `node pipeline/verify-artifact.js … PANEL` |
| chat | `spawn claude -p … --output-format stream-json` (session kept via `--resume`) |

Safety rails carried over: only ADD namespaced comps; per-comp scoped reads (never a
whole-project deep dump); one undo group per build; no credentials stored anywhere.

## Notes

- Requires `node` on the machine (found via login shell; cached). Chat requires the
  `claude` CLI to be installed + authenticated.
- The install uses `PlayerDebugMode=1` (unsigned local extension). For distribution
  beyond this machine, package as a signed ZXP (`ZXPSignCmd`) later.
- If the panel ever shows "Repo not found", re-run `install-panel.sh` from the repo.
