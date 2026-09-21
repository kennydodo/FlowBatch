# FlowImagesGen

Batch image generation for **Google Flow** (`flow.google.com`) driven by reference images, using
Playwright to automate the real Flow web UI in a persistent Chrome profile.

Give it a list of prompts and a set of reference images, and it will attach the references, submit
the prompt in Flow's **Image** mode, wait for the results, and save the generated stills to disk.

```
refs/character-a.png ─┐
refs/street-style.png ─┴─► Google Flow (Image mode) ─► output/<job>/<item-id>.jpg
```

## Status

Verified end to end against the live Flow UI on **2026-09-21**: Agent mode off, prompt-box settings
(model / aspect ratio / output count), reference upload through the asset picker, generation, and
full-resolution download (1376×768 at 16:9) all work.

Two things to know before you run it at volume:

- **Flow throttles automation.** After roughly eight generations in ten minutes it starts refusing
  with *"We noticed some unusual activity."* The runner detects this, does not retry, and stops the
  batch. Space runs out and keep batches small.
- **Every reference upload becomes a project asset.** Uploading the same file in repeated runs
  creates duplicates in your Flow project. Clean them up in the Flow UI periodically.

## How it works

- A dedicated Chromium profile lives in `profile/`. You sign in to Google **once, by hand**; the
  session is reused on every later run.
- Flow's **Agent mode is ON by default and hides the model / aspect-ratio / output-count controls**.
  The runner switches Agent off, which reveals the prompt-box settings trigger.
- References are attached through the prompt box's Add menu → *Upload media* → the project asset
  picker → *Add to prompt*. This is also why each reference becomes a project asset.
- Results are fetched from the tile's signed CDN URL (`https://flow-content.google/...` or
  `/asb/...`), which serves the full-resolution still without any UI interaction. Flow's own export
  menu is the fallback.
- Flow serves stills as **JPEG**, so file extensions are sniffed from the content, not assumed.
- `config/selectors.json` maps semantic names (`promptBox`, `generateButton`, `assetTile`, …) to
  ordered lists of Playwright selectors, so a Flow UI change is a config edit rather than a code
  change.

## Requirements

- Node.js 20 or newer
- Google Chrome installed (Google is far more likely to allow sign-in from real Chrome than from
  Playwright's bundled Chromium)
- A Google account with access to Google Flow

## Install

```powershell
cd D:\Repos\FlowImagesGen
npm install
```

Only one dependency is used: `playwright`.

## Quick start

```powershell
# 1. Sign in once. A browser window opens; finish the Google sign-in flow and it closes itself.
npm run login

# 2. Check config, and resolve every selector against the live page.
npm run doctor -- --live --project-url "<your project url>"

# 3. See the plan without spending anything.
npm run generate -- --job config/jobs.smoke.json --dry-run

# 4. Generate. Start with one item.
npm run generate -- --job config/jobs.smoke.json
```

`refs/` ships with generated 512×512 placeholder images so the examples run immediately. Replace
them with real reference images.

### Pointing a job at a project

Flow's landing page redirects into your most recent project after a few seconds, which is slow and
not always deterministic. Set `projectUrl` on a job to open a project directly:

```json
{ "projectUrl": "https://flow.google.com/project/<project-id>" }
```

You can also set `projectUrl` in `config/settings.json` to make it the default for `doctor --live`.

## Job files

A job is a JSON file. The recommended shape maps **asset names** to local files and lists the images
to generate:

```json
{
  "name": "scenes-example",
  "projectUrl": "https://flow.google.com/project/<project-id>",
  "outputsDir": "output/scenes-example",

  "refs": {
    "Maya": "E:/YOUTUBE/PERSONAL FINANCE/Refs/Maya.png",
    "Dana": "E:/YOUTUBE/PERSONAL FINANCE/Refs/Dana.png",
    "BG_LIVING_ROOM_01": "E:/YOUTUBE/PERSONAL FINANCE/Refs/BG_LIVING_ROOM_01.png"
  },

  "defaults": {
    "mode": "image",
    "agent": false,
    "model": "Nano Banana 2 Lite",
    "aspectRatio": "16:9",
    "outputs": 1,
    "refMode": "reuse"
  },

  "images": [
    {
      "file": "S01_01_HYB_PR.png",
      "prompt": "Maya stands at the open glass door of her grandmother's display cabinet...",
      "refs": ["Maya", "BG_LIVING_ROOM_01"]
    },
    {
      "file": "S01_02_CU_ZI.png",
      "prompt": "Close-up of Maya's hands holding an ornate floral porcelain plate...",
      "refs": ["Maya"]
    }
  ]
}
```

**`refs` is a name → path map.** The name is what the asset is called inside the Flow project; the
path is only used to upload the file when that name is not found there. An item's `refs` are those
names. A name absent from the map is still usable — it is attached from the project as-is, which is
why `BG_LIVING_ROOM_01` would work even if it were omitted from the map.

Local paths are **optional**. If a mapped file is missing, the job still loads; the tool simply
cannot upload it, and says so if the name is also absent from the project.

### Matrix (many prompts × many reference sets)

`matrix.prompts` is crossed with every entry of `matrix.refSets`, producing
`prompts.length × refSets.length` items with ids like `p2-alice`.

```json
{
  "name": "example-matrix",
  "outputsDir": "output/example-matrix",
  "defaults": { "aspectRatio": "16:9", "outputs": 2 },
  "matrix": {
    "prompts": ["Full-body studio shot of the character.", "Close-up portrait."],
    "refSets": {
      "alice": ["refs/alice-front.png", "refs/alice-side.png"],
      "bob": ["refs/bob-front.png"]
    }
  }
}
```

### Item fields

| Field | Default | Notes |
| --- | --- | --- |
| `file` | — | Output filename. The extension is replaced with the real format after download. |
| `id` | `file` stem, else `item-N` | State key for resume. Must be unique. |
| `prompt` | — | Required. |
| `refs` | `defaults.refs` | Asset names, resolved through the top-level `refs` map. `[]` means no references. |
| `mode` | `image` | `image` or `video`. |
| `agent` | `false` | Keep this false; Agent mode hides the settings the runner needs. |
| `model` | `defaults.model` | As shown in Flow, e.g. `Nano Banana 2 Lite`, `Nano Banana 2`, `Nano Banana Pro`. |
| `aspectRatio` | `defaults.aspectRatio` | Image mode offers `16:9`, `4:3`, `1:1`, `3:4`, `9:16`. |
| `outputs` | `defaults.outputs` | Positive integer (`x1`–`x4`). |
| `refMode` | `reuse` | `reuse`, `upload`, `assets` or `mention` (see below). |
| `retries` | `defaults.retries` | Extra attempts after the first failure. |
| `timeoutMs` | `settings.timeouts.generationMs` | Per-item generation timeout. |

### Reference handling modes

The mode only decides how a named reference reaches Flow.

| Mode | Behaviour | Verified |
| --- | --- | --- |
| `reuse` (default) | Attach the project asset **by name**; upload the local file only when the name is missing. Self-healing, and creates no duplicates once seeded. | yes |
| `assets` | Attach by name only; never upload. | yes |
| `upload` | Always upload the local file. Duplicates project assets. | yes |
| `mention` | Types `@<name>` into the prompt. Unverified against the current UI. | no |

`reuse` is right for this workflow: the first run seeds the project from the local files, and every
later run attaches by name with **zero new assets** (measured: 31 tiles before and after attaching
`Maya` + `BG_LIVING_ROOM_01`).

### Multiple references per prompt

Flow supports several ingredients at once — four were attached simultaneously during testing. Each
reference is attached in its own picker session, because uploading several files in one call only
ever attaches the first one. Expect roughly 5–10 seconds per reference, plus upload time for new
files (the `BG_*.png` set is 14–18 MB each).

When searching, an exact title match wins over an exact filename match over the first fuzzy hit, so
`Maya` never attaches `Maya_alt.png` by accident.

### What actually happens when references are attached

The prompt box's **`+` button opens Flow's asset library inline** — search, category navigation and
the project's asset list. It does **not** create a file input, so nothing resembling an upload dialog
is involved:

```
+ sign only   ->  library open, asset list visible, fileInputs: 0
click an asset ->  attached to prompt, library closes, fileInputs: 0
```

**"Upload media" is a separate button *inside* that library.** Its only job is to spawn the hidden
`input[type=file]`, so it is clicked only when a file genuinely has to be uploaded. That means:

- `reuse` and `assets` modes **never touch "Upload media"** and never open a file dialog.
- Only `upload` mode — or a `reuse` run whose name is missing from the project — does.

Attaching an existing asset and uploading a new one behave differently; both were measured:

| Action | Result |
| --- | --- |
| Click an asset in the library | Attaches immediately and closes the library. No *Add to prompt*. |
| Upload via "Upload media" | Leaves the asset selected; needs an explicit *Add to prompt*. |

A synthetic drag-and-drop onto the prompt box was also tried and is rejected by Flow, so the library
is the only route — but for references already in the project it is a single click.

## CLI reference

| Command | Purpose |
| --- | --- |
| `login` | Open the persistent profile and wait for a manual Google sign-in. |
| `discover` | Dump the Flow DOM to `discover/` to calibrate selectors. |
| `doctor` | Check environment and config; with `--live`, resolve every selector. |
| `generate` | Run a batch job. |

`generate` options:

| Flag | Meaning |
| --- | --- |
| `--job <file>` | Job file to run (required). |
| `--only <id,id>` | Run only these item ids. |
| `--limit <n>` | Run at most `n` items. |
| `--no-resume` | Re-run items already marked `done`. |
| `--reset-state` | Clear stored state first. |
| `--dry-run` | Print the plan without launching a browser. |
| `--fail-fast` | Stop at the first failed item. |
| `--pause-on-error` | Keep the browser open and wait for Enter after a failure. |
| `--no-dump-on-error` | Skip the screenshot + HTML capture in `debug/`. |
| `--keep-open` | Leave the browser open when the run finishes. |

`discover` options: `--wait <s>`, `--navigate <url>`, `--click <selector>` (repeatable),
`--dump <selector>` (repeatable), `--agent <on|off>`, `--upload <file>` (repeatable), `--html`.

Global: `--log-level <debug|info|warn|error>`, `--no-color`, `--channel <chrome|msedge>`,
`--headless`, `--url <url>`.

## Outputs, state and resume

- Generated stills: `output/<job>/<file stem>.<real extension>`. The stem comes from the item's
  `file` (or `id`), but the **extension is sniffed from the actual bytes** — Flow exports JPEG, so a
  job asking for `S01_01_HYB_PR.png` is written as `S01_01_HYB_PR.jpg`. Multiple outputs become
  `<stem>-1.jpg`, `<stem>-2.jpg`.
- Progress: `state/<job>.json`, written after every item. Re-running a job skips completed items;
  use `--no-resume` or `--reset-state` to force a re-run.
- Failure captures: `debug/error-<item-id>-<timestamp>.png` and `.html`.

## Rate limits and throttling

Google actively detects this kind of automation. The observed refusal is:

```
Failed
We noticed some unusual activity. Please visit the Help Center for more information.
You have not been charged for this generation.
```

The runner reports this verbatim, marks it **not retryable**, and stops the batch so it does not
make things worse. Remaining items stay `pending` and will be picked up on the next run.

Mitigations, in order of effect:

1. Wait — the throttle is time-based and lifts on its own.
2. Raise `generation.delayBetweenItemsMs` (default 20000) so generations are spaced out.
3. Keep batches small and avoid repeated back-to-back runs.
4. Use `--limit` to run a few items at a time.

## Calibrating selectors

The current selectors are verified against Flow as of 2026-09-21. When Flow's UI changes:

1. Run `npm run discover -- --agent off` and read `discover/flow-<timestamp>.md` — a table of every
   visible interactive element with suggested selectors.
2. To see inside a popover, click into it first:
   `npm run discover -- --agent off --click 'button.settings-trigger-button' --dump 'div.settings-content-overlay'`
3. Put the working selector at the **front** of the matching array in `config/selectors.json`.
4. Run `npm run doctor -- --live --project-url "<project url>"` to confirm what matched.
5. For machine-local tweaks use `config/selectors.local.json` (gitignored); its entries replace the
   base entries for the same key.

Keys verified to resolve on a freshly loaded project: `promptBox`, `agentToggle`,
`settingsTriggerButton`, `generateButton`, `assetTile`, `assetMenuButton`, `addIngredientsButton`,
`projectTitle`, `projectCard`, `signedIn`.

Keys that only exist inside an open popover or after a reference is attached — `doctor --live`
reports these as `[SKIP]` rather than failing: `settingsOverlay`, `modeImageOption`,
`aspectRatioGroup`, `outputCountGroup`, `modelFamilyButton`, `modelMenu`, `addMediaOption`,
`addToPromptButton`, `promptReferenceChip`, `generatingIndicator`, `errorBanner`.

## Getting good results with reference images

From Google's own Flow guidance:

- Use clean references: a subject or product on a plain or segmented background.
- Keep location and style references free of unintended extra subjects.
- Keep references consistent with each other (same wardrobe, lighting, viewpoint) for a character.
- Make the prompt complement the references rather than contradict them.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Google refuses sign-in | Use real Chrome (`browser.channel: "chrome"`) and avoid `--headless` for login. |
| `Flow refused the generation: ... unusual activity` | You are throttled. Wait, then raise `delayBetweenItemsMs`. |
| `Could not locate the Flow UI element "x"` | Re-run `npm run discover` and update that key. |
| `Generated the asset but could not save it` | Calibrate `assetTile`; check `debug/` for the grid state. |
| Settings never applied | Ensure `agent` is `false`; the settings trigger is hidden while Agent mode is on. |
| Project fills with duplicate uploads | Expected with `refMode: "upload"`. Delete the extras in Flow. |

## Limitations

- It drives the web UI, so it is only as stable as Flow's markup. Calibration is ongoing
  maintenance.
- Generation is sequential, and Google throttles rapid automated runs.
- Automating a Google product may conflict with its terms of service. Use your own account, keep
  volumes reasonable, and review Flow's terms before running large batches.
