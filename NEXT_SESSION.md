# Next session

Handover notes. Delete this file once the list is clear.

## FROZEN CONTRACT with WhisperRadar (do not change silently)

WhisperRadar spawns this CLI and needs the Flow project URL back. Agreed
2026-09-23. Changing the marker or the report schema means updating BOTH sides
and this note.

**1. Marker (convenience, manual runs).** One un-prefixed stdout line as soon
as the project is known:

```
FLOW_PROJECT_URL=https://flow.google.com/project/<uuid>
```

**2. Report file (the actual contract).** WhisperRadar passes a path it owns;
we write it ATOMICALLY (temp + rename) as soon as the project exists - NOT at
exit, so it survives a later crash:

```
node src/cli.js prepare --job <job.json> --report D:\...\data\studio\5\flow_prepare.json
```

```json
{
  "schemaVersion": 1,
  "projectUrl": "https://flow.google.com/project/<uuid>",
  "projectId": "<uuid>",
  "project": "<name>",
  "created": true,
  "jobName": "wr-5",
  "preparedAt": "2026-09-23T16:46:55Z",
  "refs": [
    { "name": "CH_MAYA", "kind": "character", "status": "uploaded", "path": "..." },
    { "name": "BG_BATHROOM_01", "kind": "environment", "status": "reused", "path": null }
  ]
}
```

`refs[].status` is one of `uploaded | reused | generated | missing`.

**3. Ownership.** The report is the INTERFACE. WhisperRadar persists
`projectUrl`/`projectId` on the production row and mirrors `projectUrl` into
the job it owns. The job's `projectUrl` is regenerated from the DB, so it is
never the source of truth and a job rewrite cannot lose the URL.

**4. Ref mode.** When every ref reports present, the generation stage runs
`refMode: "assets"` (attach by name, never upload); otherwise `reuse`.

**5. Do not** write `projectUrl` into the job ourselves (`--write-url` stays
optional) - that would make two writers on a WhisperRadar-owned file.

## TL;DR

The pipeline works end to end. **30 of 85 shots are done**, 55 pending, 0 failed. The last
session fixed the two things that made batches slow and unreliable (see "What changed"), so a
clean cycle is now ~35-50s instead of ~86s, and a miss no longer costs ~10 minutes.

Batch runs use the `profile-renderly` profile (the account with good standing) — the default, so
no flags needed.

**New (2026-09-23, late):** a single-item run took **7m33s** from `Generating` to `Saved` with no
retry, no salvage warning and a correct 1376x768 master — far past the 300s generation timeout,
which should have fired. Unexplained; this is Remaining work **#1**.

The download/refusal misreport from the earlier notes is **fixed and merged** — see "What changed".

## Current state

| | |
| --- | --- |
| Branch | `main` at `9b6c266` (prepare + the #4 fix merged); `origin/main` is behind at `26f372c` |
| Done / pending | 30 done, 55 pending, 0 failed |
| Prepare command | `node src/cli.js prepare --job <job> --report <path>` — the WhisperRadar contract |
| Default profile | `profile-renderly` → **koogunyemi@gmail.com** (change it on the web UI Settings page) |
| Upscale tier | **off** locally → masters only, no `_1k` |
| Outputs | `output/shotlist/<file>.png` master (+ `_1k.png` when the tier is on) |

The shotlist: `E:\YOUTUBE\PERSONAL FINANCE\These 10 Things At Home Worth Serious Money\shotlist.json`
Project: `https://flow.google.com/project/772a62aa-c204-4473-a27b-5e106a7f0b06`

## What changed last session

1. **`f17dc95` — result tiles are identified by their redo control, not text.** `innerText` is
   empty on `flow-grid-tile-container`, so the `textContent` fallback concatenates the hotbar
   icons into `favoriteredomore_vert` with no word boundary; the old `/\bredo\b/` test matched
   only by luck, so ~1 result in 3 was never accepted. The retry no longer reloads Flow, and
   `delayBetweenItemsMs` dropped 20s → 5s.
2. **`c704830` — byte ownership.** Every image on the page when a generation starts is hashed
   (sha1); a result is the newest non-reference tile whose bytes were never seen, served from
   `flow-content.google/image` (not the `flow.google.com/asb` placeholder host). This is what
   Renderly does, and it is what makes a reference tile impossible to save as a result.
3. **`26f372c` — the OS file chooser is intercepted.** Clicking "Upload media" opened the native
   Windows file dialog and `setInputFiles` never dismissed it, so it sat on screen for the rest
   of the run. `generate()` also dismisses any CDK popover, and ownership is seeded **only** from
   the pre-generation baseline.
4. **`ddd2f56` — the `prepare` command.** Opens or creates a job's Flow project, prints
   `FLOW_PROJECT_URL=`, writes the report atomically as soon as the project exists (before the
   reference work), then gets every reference into the gallery (`uploaded`/`reused`/`missing`) and
   clears the chips it leaves behind. It never generates. This is the FlowImagesGen half of the
   frozen contract at the top of this file.
5. **`2436332` — refusals are scoped to the attempt.** `detectRefusal()` and the `errorBanner`
   check both matched anywhere in the app (including `main :text-is('Failed')`), so one stale
   "You have not been charged for this generation" failed 16 consecutive WhisperRadar items twice
   each while Flow was generating every one of them. `generate()` now tags every alert already on
   screen (`markStaleAlerts`) and only a banner appearing AFTER the click counts (`freshAlert`).
6. **`2436332`/`9b6c266` — salvage and download retry.** A result that cannot be claimed before
   the deadline is salvaged instead of discarded (it still requires the redo control, so a
   reference can never be salvaged), and the download is retried up to 3x, re-resolving the tile
   each time because it moves as the grid changes. The timeout message now says "detection
   timeout, not a refusal".

## Remaining work

1. **INVESTIGATE: a 7m33s item that should have timed out.** On 2026-09-23 a single-item run
   (`state/merged-check.json`, item `MERGED_01`, throwaway project) went `Generating` 20:16:16 →
   `Saved` 20:23:49 = **7m33s**, with `attempts=1`, no retry, no salvage warning and a correct
   1376x768 master. `timeouts.generationMs` is 300000, so `waitForNewAssets` should have broken at
   300s and then either salvaged (logs a warning) or thrown (triggers a retry). Neither happened,
   so **the deadline was not honoured** — that is the puzzle, more than the slow generation.

   Measured on the same page (40 tiles): `snapshotAssets` 0.3s, `markStaleAlerts` 0.1s,
   `freshAlert` 0.1s, `noteSeenAssets` baseline 10.7s — none of the new code explains it. Every
   other run that day was 19-44s.

   Suspects, in order: (a) `fetchBytes` (src/flow/driver.js) has **no request timeout**, so a
   stalled CDN request blocks a poll indefinitely — add a timeout and a log line; (b) `generate()`
   is uninstrumented between the `Generating` log and `waitForNewAssets` — time
   `closeAssetLibrary`, `dismissOverlays`, the `requireEnabled` button wait and `markStaleAlerts`;
   (c) Flow genuinely queued the generation for ~7 minutes (the account had done ~15 test
   generations that day). Add per-poll timing to `waitForNewAssets` and re-run one item.
2. **Run the remaining 55 items.** `npm run ui` / `FlowImagesGen.bat` (paste the shotlist path
   into the Job JSON field — the dropdown only lists `config/`). Chunks of 15.
3. **Decide the upscale tier.** Tiers are now `off|1k|2k|4k` delivering **1920x1080, 2560x1440 and
   3840x2160** (2K moved off DCI 2048x1080 and 3K is gone — commit `d1c1922`). Current state:
   26 masters have `_1k.png`; 7 have no upscale at all (`S01_03_SCN_PL`, `S08_02_CMP_PL`,
   `S08_03_HYB_PR`, `S08_04_HOST_ZI`, `S08_05_HYB_ZO`, `S08_06_CU_ZI`, `S09_01_SCN_PL`); and 3 carry
   a `_2k.png` at the **old 2048x1080** size (`S01_02_CU_ZI`, `S01_03_SCN_PL`, `S02_01_HOST_ZI`)
   which must be re-upscaled if 2K is the target. Pick one with `upscale --set-tier <t>`, then
   `upscale` over `output/shotlist`.

   **WhisperRadar side:** its `FLOWIMAGESGEN_TIERS` maps level `3 -> "3k"`, which now fails; it wants
   `{0:"off",1:"1k",2:"2k",4:"4k"}`. Its `render_resolution` labels already match the new sizes.
4. **Upscaler tuning.** It already ports Renderly's engine (device probe + cache, MAD content
   check, RGB flattening for alpha, GPU → auto → CPU Lanczos). Differences worth testing:
   probe with the configured model/scale instead of a fixed `realesr-animevideov3` x2; skip the
   engine when the source already meets the target; require output ≥ source outside the probe;
   A/B `realesr-animevideov3` + supersample against Renderly's `realesrgan-x4plus` at native 4x.
5. **FIXED, verify only: the download/refusal misreport.** The 156-item WhisperRadar batch
   (2026-09-23, `state/wr-5.json`, project `a84875f5-e27c-4bb2-a60c-2d558f24d92b`) had 16
   consecutive items fail twice each with
   `"error": "Flow reported a failed generation: \"You have not been charged for this generation\"."`
   while the project held **~24 more images than were saved**. Cause: the page-wide refusal and
   `errorBanner` checks attributed a stale banner to whichever item happened to be running — see
   "What changed" 5 and 6. Fixed by `2436332` + `9b6c266`: refusals are scoped to the attempt, an
   unclaimed result is salvaged, and the download is retried 3x.

   Verified by a live alert-scoping test (stale banner ignored, new banner still caught) and a
   2-item regression run. **Not yet observed triggering:** the salvage path and the download-retry
   path — watch for them in the next real batch. The 16 orphan images in that project are still
   there.

## Known gotchas (do not re-derive)

- **Never identify a result by tile text or `src`.** Use the `Reuse prompt` control (present only
  on generated tiles) plus byte ownership. `src` changes when a thumbnail lazily loads.
- **A reference tile can mount after the generation and take grid index 0**, pushing the result
  to index 1. Do not require the result to be at index 0.
- **Seed ownership only from the pre-generation baseline.** Hashing during the wait marks the
  result itself as seen — that alone made both items of a run time out.
- **`files: []` plus a policy message means the DOWNLOAD failed, not the generation.** A stale
  page banner is no longer attributed to the item (see "What changed" 5), but if this shape shows
  up again, check Flow's grid for the image before re-running — a re-run leaves a duplicate.
- **A missed asset normally costs the full `timeouts.generationMs` (300s), then succeeds on
  retry.** Check `debug/error-*.png` before concluding anything about the account. Note the
  2026-09-23 run where that 300s deadline did **not** fire — Remaining work #1.
- **`fetchBytes` (src/flow/driver.js) has no request timeout.** A stalled CDN request can block a
  poll silently, which looks exactly like a hang with no retry — Remaining work #1.
- **Account standing is the gate.** `koogunyemi@gmail.com` generates normally;
  `japanliveshealthy@gmail.com` is refused every time in ~3s and each attempt lowers the score
  further — do not retry it. `--agent on` is the escape hatch on a distrusted session.
- **`maxCooldowns: 0` (and `cooldownSeconds: 0` locally) means a refusal STOPS the batch** rather
  than waiting — intentional, since the block is a reCAPTCHA score on the profile.
- **Agent mode OFF is the default and preferred** — it keeps per-item model/ratio/output control.
- **The Flow page loads once per batch.** Between items the composer is cleared in place; do not
  reintroduce a per-item reload.
- **Ingredient chips live in `flow-ingredient-bar`, not inside the editor.** Select-all in the
  editor does not remove them; each chip has its own remove control.
- **Model names are prefixes of one another** ("Nano Banana 2" vs "Nano Banana 2 Lite") — matching
  must be exact.
- **Prompt length ceiling is ~2450 characters** for style + scene combined.
- Deleting a `running` item's status is unnecessary — stale `running` resets to `pending` on load.

## Not wanted

- `shots` metadata (`cues`, `scene`, `motion`, `transition`) — parsed away on purpose.
- `refMode: "mention"` — implemented, never verified; `reuse` is what works.

## Housekeeping

- `profile-fresh` (58 MB) and `profile-test` (0 MB) are dead and can be deleted.
- `debug/` holds stale failure captures (screenshots + HTML) that can be cleared.
- The throwaway test project `358ac03f-de30-4726-9302-c57ce29572ce` holds ~17 refs and ~10 test
  images; delete it in Flow if it is not wanted.
- `profile-renderly` is a copy of Renderly's profile and is shared with it; a dedicated profile
  signed in as `koogunyemi@gmail.com` would isolate the two tools' reCAPTCHA signals.
