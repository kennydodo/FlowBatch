# Next session

Handover notes. Delete this file once the list is clear.

## TL;DR

The pipeline works. **23 of 85 shots are done**, 62 pending. Batch runs should use the
`profile-renderly` profile (the account with good standing) — now the default, so no flags needed.

## Current state

| | |
| --- | --- |
| Branch | **`experiment/no-reload`** (9 commits, nothing pushed) |
| Fallback | `main` — pre-experiment, tag `known-good-before-no-reload` |
| Done / pending | 23 done, 62 pending, 0 failed |
| Default profile | `profile-renderly` → **koogunyemi@gmail.com** (set via the new Settings page) |
| Upscale tier | 1K → 1920×1080, supersampled |
| Outputs | `output/shotlist/<file>.png` master + `_1k.png` |

The shotlist: `E:\YOUTUBE\PERSONAL FINANCE\These 10 Things At Home Worth Serious Money\shotlist.json`
Project: `https://flow.google.com/project/772a62aa-c204-4473-a27b-5e106a7f0b06`

## The thing that mattered most: account standing

Generation is gated by **reCAPTCHA Enterprise** and the score belongs to the **signed-in account**.
Measured directly, same code and settings:

- `koogunyemi@gmail.com` (paid account) → generates normally
- `japanliveshealthy@gmail.com` → refused every time, ~3s, *"We noticed some unusual activity"*

That refusal is **not** a rate limit: waiting does not help, and each attempt lowers the standing
further. Do not retry it. `--agent on` is the escape hatch on a distrusted session, and switching
account is the real fix.

## 1. Verify the reference-dimension guard (untested)

The last commit adds a check rejecting a result tile whose pixel size matches a reference image,
after one item (S08_01) saved a copy of its background instead of the generation. **This has not
been exercised against a live generation.** Run a few items and confirm every master is 1376×768:

```powershell
npm run generate -- --job "<shotlist>" --limit 5
```

then check `output/shotlist` — any master that is not 1376×768 is a wrong-tile save. S08_01 was reset
to pending so it will be retried.

## 2. Run the rest

`npm run ui` or `FlowImagesGen.bat` — the page works and uses the saved profile. The job dropdown only
lists `config/`, so paste the shotlist path into the Job JSON field. Chunks of 15 have run clean
(15/15, no refusals).

## 3. Housekeeping

- **Nothing is pushed.** 9 commits on `experiment/no-reload`; decide whether to merge to `main`.
- `profile-fresh` and `profile-test` are dead (~300 MB) and can be deleted.
- `profile-renderly` is a **copy** of Renderly's profile. It works, but a dedicated profile signed in
  as `koogunyemi@gmail.com` would be cleaner and avoids sharing a session with Renderly.
- `output/shotlist` has a few `_2k.png` files from when the tier was 2K, and `S01_01_HYB_PR-1*` was
  removed. Harmless.

## Known gotchas (do not re-derive)

- **Agent mode OFF is the default and preferred** — it keeps per-item model/ratio/output control. It
  works on a healthy account. On a distrusted one it is what tips a generation over; `--agent on`
  then works, but hides the prompt-box settings, which then come from the project panel (gear icon).
- **Never identify a result tile by image `src`.** A tile's `src` changes when its thumbnail lazily
  loads. Results need: new tile, not an upload, not matching a reference name, not echoing a
  reference's dimensions, and carrying the `redo` control.
- **The Flow page loads once per batch.** Between items the composer is cleared in place. Do not
  reintroduce a per-item reload — 84 reloads per batch is what most likely flagged the old account.
- **Ingredient chips live in `flow-ingredient-bar`, not inside the editor.** Select-all in the editor
  does not remove them; each chip has its own remove control that must be clicked.
- **Model names are prefixes of one another** ("Nano Banana 2" vs "Nano Banana 2 Lite") — matching
  must be exact.
- **Prompt length ceiling is ~2450 characters** for style + scene combined.
- Deleting a `running` item's status is unnecessary — stale `running` resets to `pending` on load.

## Not wanted

- `shots` metadata (`cues`, `scene`, `motion`, `transition`) — parsed away on purpose.
- `refMode: "mention"` — implemented, never verified; `reuse` is what works.
