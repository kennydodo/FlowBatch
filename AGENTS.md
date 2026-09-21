# AGENTS.md

Project notes for automated agents working in this repository.

## What this is

A Playwright automation project that drives the Google Flow web UI to batch-generate images from
reference images. Plain Node ESM, no build step, no bundler, no test framework. The only runtime
dependency is `playwright`.

## Commands

```powershell
npm run login                                  # manual Google sign-in into the persistent profile
npm run discover                               # dump Flow DOM to discover/ for selector calibration
npm run doctor                                 # static config/env checks
npm run doctor -- --live --project-url "<url>" # resolve every selector inside a real project
npm run generate -- --job <file> --dry-run     # validate a job without a browser
npm run generate -- --job <file>               # run it
```

`doctor --live` must run **inside a project**; prompt-box controls do not exist on the landing page.

**Be careful with real runs.** They consume the user's Flow quota and Google throttles automation.
Use `--limit 1` and do not run repeated batches while developing. If you see
`Flow refused the generation: ... unusual activity`, stop and tell the user rather than retrying.

Verification after a change (there is no test suite or linter):

```powershell
node -e "for (const f of ['src/lib/args.js','src/lib/config.js','src/lib/context.js','src/lib/errors.js','src/lib/json.js','src/lib/log.js','src/lib/paths.js','src/lib/prompt.js','src/lib/time.js','src/browser/session.js','src/flow/selectors.js','src/flow/driver.js','src/jobs/load.js','src/runner/state.js','src/runner/run.js','commands/login.js','commands/discover.js','commands/doctor.js','commands/generate.js']) await import('./' + f); console.log('ok')" --input-type=module
node src/cli.js doctor
node src/cli.js generate --job config/jobs.example.json --dry-run
node src/cli.js generate --job config/jobs.matrix.example.json --dry-run
```

## Architecture

```
src/cli.js              argv parsing, command dispatch, help text
commands/               one file per CLI command; each exports <name>Command({flags, context, positionals})
src/lib/                logging, config loading, paths, args, JSON, errors, timing, image sniffing
src/browser/session.js  launchPersistentContext + stealth init; returns {context, page}
src/flow/selectors.js   SelectorSet: ordered-candidate resolution with polling
src/flow/driver.js      FlowDriver: every Google Flow interaction lives here
src/jobs/load.js        job file validation and matrix expansion -> flat item list
src/runner/state.js     per-item progress persistence for --resume
src/runner/run.js       batch orchestration, retries, downloads, summary
src/server.js           local HTTP + SSE server that spawns the CLI for the web UI
commands/serve.js       `serve` command; keeps the process alive
ui/index.html           the whole UI: one self-contained file, no build step
config/                 settings.json, selectors.json, example job files
```

The UI is deliberately a thin shell over the CLI: `src/server.js` spawns
`node src/cli.js generate …` and streams its stdout/stderr. It must not grow a second copy of the
generation logic. Native folder/file pickers run through PowerShell because a browser cannot expose a
real filesystem path to the server.

## Verified Google Flow facts (2026-09-21)

These were established by probing the live signed-in UI. Do not "fix" them from memory of the docs:

- The app is Angular Material with **no `data-testid` attributes**. Controls are labelled with
  `aria-label`, and custom elements carry stable tag names (`flow-rich-text-editor`,
  `flow-grid-tile-container`, `flow-toggles`, `flow-image-ingredient-chip`).
- **Agent mode is ON by default, persists per project, and hides the prompt-box settings trigger.**
  `button.agent-mode-chip` exposes state via `aria-pressed`. Toggling must be idempotent — a blind
  click flips it back.
- With Agent off, `button.settings-trigger-button` opens a `flow-prompt-box-settings` overlay holding
  **all** of mode (`flow-toggles[aria-label='Mode']`), aspect ratio, output count and the model menu.
  Toggle selection is `aria-checked`, not `aria-pressed`.
- The prompt box is `flow-rich-text-editor .ProseMirror[contenteditable='true']`.
- Clicking the prompt-box `+` (`button.add-menu-trigger`) opens Flow's **asset library inline**
  (`flow-add-menu-asset-list`, search `input[aria-label='Search assets']`, rows
  `button.asset-item[role='option']` with `span.asset-title`). It creates **no file input** — do not
  click "Upload media" just to browse.
- **"Upload media" lives inside that library** and is the only thing that spawns the hidden
  `input[type=file]`. Click it only when a file must actually be uploaded.
- Two different attach behaviours, both measured:
  - clicking an **existing** asset attaches it and closes the library immediately, no "Add to prompt";
  - **uploading** leaves the asset selected and requires clicking **"Add to prompt"**.
- Synthetic drag-and-drop of a `File` onto the prompt box is **rejected** by Flow, so the library is
  the only route. `refMode` only controls whether files are re-uploaded: `reuse` (attach by name,
  upload only when missing), `assets` (never upload), `upload` (always upload).
- Items with `refs: []` must never open the library at all.
- `reuse`/`assets` must produce **zero** new project tiles; that is the regression test for this
  area.
- `input[aria-label='Editable text']` is the **project title**, not the prompt box.
- The grid is a **virtual scroller**: only rendered tiles exist in the DOM.
- **Uploaded references also appear as grid tiles**, labelled with their filename. Generated stills
  are not. `snapshotAssets` records `uploaded` / `hasImage` / `failed` so uploads and refused
  generations are not mistaken for results.
- Flow exports stills as **JPEG**; the extension is sniffed from the bytes.
- Tile `<img>` srcs are signed CDN URLs that `context.request` can fetch, giving full resolution with
  no UI interaction. This is the primary download path.
- A cookie consent bar overlays the prompt-box controls and swallows clicks; `dismissConsent()` must
  run after every navigation.
- The landing page redirects into the last project only after ~15s. Prefer `projectUrl`.
- Google throttles automated runs with *"We noticed some unusual activity"* inside the tile. It is
  detected and treated as non-retryable so the batch stops instead of making it worse.

## Job schema

The primary shape is `refs` (name → local path) plus `images` (items with `file`, `prompt`, `refs`
as **names**). `items` (with `id`) and `matrix` are also accepted, as is a legacy `refs` array of
paths. Item `refs` resolve through the top-level map; a name that is not in the map is treated as an
existing project asset. Missing local files are a warning, never an error — attach-by-name still
works. `item.outputName` comes from `file`; the final extension is always sniffed from the bytes.

A top-level `style` string is applied to every prompt (`stylePosition: "prefix" | "suffix"`).
Unrecognised top-level and `defaults` keys, and extra arrays such as an editorial `shots` list, must
produce a **warning** — never be dropped silently.

Real-world files need two encoding defences, both in place: strip a leading UTF-8 **BOM** in
`readJson` (else `JSON.parse` throws), and detect **mojibake** (UTF-8 read as CP1252, `—` → `â€”`)
via `src/lib/text.js`, warning with a count and offering `--repair-encoding` / `repairEncoding: true`.
`commands/repair.js` fixes the file itself (BOM + mojibake, `.bak` backup, idempotent).

Output naming: `item.outputFile` is the **exact** `file` value from the job, extension included, and
the file is written under that name. Flow only exports JPEG, so a `.png` request is re-encoded with
`FlowDriver.convertToPng`, which uses the browser's canvas — do not add an image library for this.

## Hard rules

1. **Never hardcode a page selector in JavaScript.** Every selector belongs in
   `config/selectors.json` as an ordered candidate list, accessed through
   `FlowDriver.find(key)` / `Selectors.find()`. If you need a new element, add a new key.
2. **Fail with an actionable error.** Use `SelectorError(key, candidates, details)` so the message
   names the key, lists the candidates, and points at `npm run discover`.
3. **Keep `npm run discover` useful.** It is the primary calibration tool; new interaction points
   should be discoverable from its DOM inventory.
4. **No new dependencies** without a clear reason. Config, args, logging and JSON helpers are
   hand-rolled on purpose.
5. **No comments unless they explain non-obvious intent.** Match the existing sparse style.
6. **Do not commit** unless explicitly asked. `profile/`, `output/`, `state/`, `debug/`,
   `discover/`, `downloads/` and `refs/*` are gitignored runtime data.
7. Local overrides go in `config/settings.local.json` and `config/selectors.local.json` (gitignored);
   never edit committed config to hold machine-specific values.

## Conventions

- ESM only, `import`/`export`, two-space indent, single quotes, trailing commas, semicolons.
- Errors are classes in `src/lib/errors.js`; user-facing failures return a non-zero exit code from
  `commands/*`, never a bare `throw` from `src/cli.js` (it catches and logs).
- Logging goes through `src/lib/log.js`; never `console.log` directly.
- `FlowDriver` is the only place that touches Playwright page APIs. Runner and commands talk to it
  in semantic terms (`setPrompt`, `addReferences`, `generate`, `waitForNewAssets`, `downloadAsset`).
- Paths from config are resolved with `fromRoot()` so they may be absolute or project-relative.
