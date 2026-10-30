# Contributing

This project is not under active development, but issues and small pull requests are welcome.

## Setup

```bash
npm install
npm run preflight
npm test
```

`npm test` runs headless with no After Effects. It ingests `examples/demo.html`, validates the scene JSON against `pipeline/scene-schema.md`, exports a `.jsx` and checks the builder's font lookup against a mocked AE.

## Changes that touch After Effects

The build engine (`pipeline/ae/builder-core.jsx.js`) emits ExtendScript, which must stay strict ES3. That means no `let`/`const`, no arrow functions and no template literals inside the emitted code. Because the engine source sits inside a JavaScript template literal, avoid backslashes in it.

If you change the builder or the reader, run a live check in After Effects with the bridge panel open (see the README):

```bash
npm run preflight -- --live
node pipeline/artifact-bridge.js examples/demo.html
```

Then look at the comp in the viewer. For deeper checks, the `pipeline/verify-*.js` scripts compare a build against its scene JSON (see `pipeline/README.md`).

## Pull requests

- Keep each PR to one change and explain what you tested.
- If ingest output changes on purpose, regenerate the example: `node pipeline/ingest-artifact.js examples/demo.html`.
- Do not commit anything from `pipeline/out/`.

## Reporting bugs

Use the bug report template. Include your After Effects version, your OS and the smallest artifact that shows the problem.
