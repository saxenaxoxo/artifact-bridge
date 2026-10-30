# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - Unreleased

### Added
- One-command runner `pipeline/artifact-bridge.js`: artifact to scene JSON, then a live build in After Effects or, with `--jsx`, a standalone script.
- `pipeline/preflight.js`, which checks Node, the browser and (with `--live`) After Effects and the bridge panel, and says what to fix.
- Try-me artifact `examples/demo.html` and the scene JSON it produces.
- Headless `npm test`, plus `pipeline/validate-scene.js` for checking scene JSON against the schema.
- Ingest records the CSS font family and weight. The builder uses that font when After Effects has it installed, and otherwise falls back with a warning.
- Ingest options `--out` and `--seconds`. Ingest falls back to an installed Google Chrome when Playwright's Chromium is missing.
- Plain-language errors (what broke, which file, what to try) in ingest, build and export.
- README, CONTRIBUTING and a bug report template.
- MIT licence.

### Fixed
- The load-mode comp background now comes from the artifact's `#stage` background instead of a fixed colour.
- Pill radii (`border-radius: 999px`) are clamped the way CSS clamps them.
- Translucent boxes that fade in keep their transparency.
- Single-line text in a wider box (left-aligned, right-aligned or RTL) is placed at its rendered position.

### Changed
- The project is renamed to Artifact Bridge, including the panel's display name.
