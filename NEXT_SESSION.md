# Next session

Handover notes. Delete this file once the list is clear.

## TL;DR

The pipeline works end to end. **30 of 85 shots are done**, 55 pending, 0 failed. The last
session fixed the two things that made batches slow and unreliable (see "What changed"), so a
clean cycle is now ~35-50s instead of ~86s, and a miss no longer costs ~10 minutes.

Batch runs use the `profile-renderly` profile (the account with good standing) — the default, so
no flags needed.

## Current state

| | |
| --- | --- |
| Branch | `main` — pushed; `origin/main` is at `26f372c` |
| Done / pending | 30 done, 55 pending, 0 failed |
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

## Remaining work

1. **Run the remaining 55 items.** `npm run ui` / `FlowImagesGen.bat` (paste the shotlist path
   into the Job JSON field — the dropdown only lists `config/`). Chunks of 15.
2. **Decide the upscale tier.** 7 masters have no `_1k`: `S01_03_SCN_PL`, `S08_02_CMP_PL`,
   `S08_03_HYB_PR`, `S08_04_HOST_ZI`, `S08_05_HYB_ZO`, `S08_06_CU_ZI`, `S09_01_SCN_PL`. If 1K is
   wanted: `upscale --set-tier 1k`, then `upscale` over those masters.
3. **Upscaler tuning.** It already ports Renderly's engine (device probe + cache, MAD content
   check, RGB flattening for alpha, GPU → auto → CPU Lanczos). Differences worth testing:
   probe with the configured model/scale instead of a fixed `realesr-animevideov3` x2; skip the
   engine when the source already meets the target; require output ≥ source outside the probe;
   A/B `realesr-animevideov3` + supersample against Renderly's `realesrgan-x4plus` at native 4x.

## Known gotchas (do not re-derive)

- **Never identify a result by tile text or `src`.** Use the `Reuse prompt` control (present only
  on generated tiles) plus byte ownership. `src` changes when a thumbnail lazily loads.
- **A reference tile can mount after the generation and take grid index 0**, pushing the result
  to index 1. Do not require the result to be at index 0.
- **Seed ownership only from the pre-generation baseline.** Hashing during the wait marks the
  result itself as seen — that alone made both items of a run time out.
- **A missed asset costs the full `timeouts.generationMs` (300s), then usually succeeds on
  retry.** Check `debug/error-*.png` before concluding anything about the account.
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
