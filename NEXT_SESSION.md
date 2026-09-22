# Next session

Handover notes. Delete this file once the list is clear.

## Where things stand

The pipeline works end to end and is verified: reference attachment by name, generation with and
without references, exact-filename PNG output, and 2K upscaling on the GPU. A multi-item batch has
run successfully.

**Batch state** (`state/shotlist.json`): 4 done, 1 failed, 81 pending.

| Item | Status | Note |
| --- | --- | --- |
| `S01_02_CU_ZI` | done | visually verified, references and style applied |
| `S01_03_SCN_PL` | done | |
| `S02_01_HOST_ZI` | done | |
| `S01_01_HYB_PR` | **failed** | prompt too long (2510 chars), refused 3× |
| 81 others | pending | |

Key paths and values:

- Shotlist: `E:\YOUTUBE\PERSONAL FINANCE\These 10 Things At Home Worth Serious Money\shotlist.json`
- Flow project: `https://flow.google.com/project/b9973189-0df6-4e9d-9cf4-2eb4175ff9f8`
  (the shotlist has no `projectUrl`, so pass `--project-url` or it creates a **new project** and
  re-uploads all 27 references)
- References already in that project: `Maya`, `BG_LIVING_ROOM_01`, `BG_GARAGE_01`, plus the
  `character-a` / `street-style` / `alice-*` / `bob-front` test images. Others upload from `E:` on
  first use — the `BG_*.png` set is 14–18 MB each.

## 1. ~~Trim the `style`~~ — DONE

The style was cut from 1858 to **1495 characters** (258 → 200 words). Verified:

| | Before | After |
| --- | --- | --- |
| `style` | 1858 chars | **1495** |
| Total per item | 2273–2536 | **1910–2173** |
| Items over 2420 | 26 | **0** |

277 characters of headroom at the longest prompt, and the load-time length warning is gone. All 85
prompts fit. Keep the style under ~1800 characters when editing it so this stays true.

## 2. Skip-and-continue on over-long prompts

**Not implemented.** A refusal is treated as non-retryable and **aborts the whole batch**, so one
over-long prompt ends the run with the rest left `pending` — 0 images instead of 59.

Flow uses the identical "unusual activity" message for throttling and for over-long prompts, so they
must be told apart by inference: if the refused item's prompt exceeds `maxPromptChars`, it is a
length problem → fail that item and continue; otherwise assume rate limiting → stop.

Files: `src/flow/driver.js` (`waitForNewAssets` sets `retryable: false`), `src/runner/run.js`
(`error.retryable === false` → `aborted = true`).

## 3. Re-run the batch

**Unblocked** — every prompt now fits under the ceiling. `S01_01_HYB_PR` is the only failed item and
81 remain. Run in chunks rather than all 85 at once:

```powershell
npm run generate -- --job "<shotlist>" --limit 15 --project-url "<project url>"
```

Resume skips completed items automatically. Check the account is generating first with:

```powershell
npm run generate -- --job config/jobs.verify.json --only no-ref
```

## 4. Unverified paths

None of these have ever run successfully:

- `refMode: "mention"` — implemented, never exercised.
- **4:3 / 3:4 / 1:1 tier outputs** — shared code path with 9:16 (which works), never run.
- `outputs: 2+` — the `-2` / `-3` naming logic is written, never run.
- `--pause-on-error`, `--fail-fast`, `--headless` — never run.
- **Video mode** — `mode: "video"` is accepted and `ensureMode` handles it, never run.
- Web UI native folder/file dialogs — the API endpoints were tested, the PowerShell dialogs never
  opened.

## 5. Known gotchas (do not re-derive)

- **Never identify a result tile by image `src`.** A tile's `src` changes when its thumbnail lazily
  loads; a 15 MB reference upload was once downloaded as the output under the shot's filename.
  Results require: new tile, not an upload, not matching a reference name, preferably exposing a
  `redo` control. `waitForGridToSettle()` must run after references are attached.
- **Clicking an asset in the library has two behaviours** — it either attaches and closes, or selects
  and needs "Add to prompt". Both occur; the confirm step is conditional.
- **Agent mode must be OFF** or the prompt-box settings trigger is hidden.
- **Model names are prefixes of one another** ("Nano Banana 2" vs "Nano Banana 2 Lite") — matching
  must be exact, never substring.
- **A refusal ends the run**, so check prompt length before blaming throttling.
- Throttle recovery observed: ~4 hours, then ~2h40m. It appears to scale with how hard the account
  was pushed.

## Not wanted

- `shots` metadata (`cues`, `scene`, `motion`, `transition`) — parsed away on purpose.
- No git remote is configured in this clone.
