import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

import { log } from '../lib/log.js';
import { ROOT } from '../lib/paths.js';
import { sleep } from '../lib/time.js';
import { GenerationError } from '../lib/errors.js';
import { sniffImageExtension } from '../lib/image.js';
import { STATUS } from './state.js';

function resolveGenSettings(item, settings) {
  const gen = settings.generation ?? {};
  return {
    mode: item.mode ?? gen.mode ?? 'image',
    model: item.model ?? gen.model ?? null,
    aspectRatio: item.aspectRatio ?? gen.aspectRatio ?? null,
    outputs: Math.max(1, Number(item.outputs ?? gen.outputs ?? 1) || 1),
    agent: item.agent ?? gen.agent === true,
  };
}

export function selectItems(items, { only, limit, resume, state }) {
  let selected = items;
  if (only && only.length > 0) {
    const wanted = new Set(only);
    const missing = [...wanted].filter((id) => !items.some((item) => item.id === id));
    if (missing.length > 0) throw new Error(`--only referenced unknown item id(s): ${missing.join(', ')}`);
    selected = selected.filter((item) => wanted.has(item.id));
  }
  if (limit && limit > 0) selected = selected.slice(0, limit);
  if (resume && state) selected = selected.filter((item) => !state.isDone(item.id));
  return selected;
}

async function pauseForInspection(message) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(`${message}\nPress Enter to continue...`);
  } finally {
    rl.close();
  }
}

export function printPlan(job, items, settings) {
  log.heading(`Plan for job "${job.name}"`);
  log.raw(`  project     : ${job.project ?? '(new project each run)'}`);
  log.raw(`  outputs dir : ${path.relative(ROOT, job.outputsDir)}`);
  log.raw(`  items       : ${items.length}`);
  for (const item of items) {
    const gen = resolveGenSettings(item, settings);
    log.raw(
      `  - ${item.outputName.padEnd(24)} ${gen.mode}/${gen.aspectRatio ?? 'default'} x${gen.outputs} ` +
        `refs=[${item.refNames.join(', ')}] :: ${item.prompt.slice(0, 60)}${item.prompt.length > 60 ? '…' : ''}`,
    );
  }
}

export async function runJob({ job, driver, state, settings, options }) {
  fs.mkdirSync(job.outputsDir, { recursive: true });

  const items = selectItems(job.items, {
    only: options.only,
    limit: options.limit,
    resume: options.resume,
    state,
  });

  if (items.length === 0) {
    log.info('Nothing to do — every selected item is already complete. Use --no-resume to re-run.');
    return { ok: 0, failed: 0, skipped: 0, results: [] };
  }

  if (options.dryRun) {
    printPlan(job, items, settings);
    log.info('Dry run complete; nothing was generated.');
    return { ok: 0, failed: 0, skipped: 0, results: [] };
  }

  if (job.projectUrl) {
    await driver.openProject(job.projectUrl);
  } else {
    await driver.goto();
  }

  const signIn = await driver.looksSignedIn();
  if (signIn === 'out') {
    throw new Error(
      'Flow is showing a signed-out page. Run `npm run login` first so the persistent profile holds a Google session.',
    );
  }
  if (signIn === 'challenge') {
    throw new Error(
      'Google is asking for extra verification (accounts.google.com). Run `npm run login -- --confirm` and ' +
        'complete the "Verify it\'s you" step, then retry.',
    );
  }
  if (signIn === 'unknown') {
    log.warn('Could not confirm the signed-in state (calibrate "signedIn"/"signedOut"). Continuing anyway.');
  }

  if (!job.projectUrl) {
    await driver.ensureProject(job.project);
  }

  const gen = settings.generation ?? {};
  const globalRetries = Number(gen.retries ?? 0);
  const retryDelayMs = Number(gen.retryDelayMs ?? 5000);
  const delayBetweenItemsMs = Number(gen.delayBetweenItemsMs ?? 0);
  const resetMode = gen.resetBetweenItems ?? 'reload';
  const reapply = gen.reapplySettingsAfterReset !== false;

  let ok = 0;
  let failed = 0;
  let aborted = false;
  const results = [];
  let firstItem = true;

  for (const item of items) {
    log.heading(`Item ${item.id} (${item.index + 1}/${job.items.length})`);
    const genSettings = resolveGenSettings(item, settings);
    const expected = genSettings.outputs;
    const refMode = item.refMode ?? job.refMode ?? gen.refMode ?? 'upload';
    const retries = Number(item.retries ?? globalRetries);

    aborted = false;
    let attempt = 0;
    let lastError = null;
    let succeeded = false;

    while (attempt <= retries && !succeeded) {
      attempt += 1;
      state.update(item.id, { status: STATUS.running, attempts: attempt, error: null });
      state.save();

      try {
        if (!firstItem && resetMode === 'reload') {
          log.debug('Reloading the project to reset the prompt box.');
          await driver.reload();
          if (reapply) await driver.applyGenerationSettings(genSettings);
        } else if (firstItem) {
          await driver.applyGenerationSettings(genSettings);
        }

        if (refMode === 'mention') {
          await driver.clearPrompt();
          await driver.typePrompt(item.prompt);
          await driver.mentionReferences(item.refNames);
        } else {
          await driver.setPrompt(item.prompt);
          await driver.addReferences(item.refs, { mode: refMode });
        }

        // Snapshot AFTER the references are attached: uploading a reference also
        // adds a tile to the project grid, which must not be mistaken for a
        // generated result.
        await sleep(2500);
        const before = await driver.snapshotAssets();
        log.debug(`Assets before generation: ${before.entries.length}`);

        log.info(
          `Generating (${genSettings.mode}, ${genSettings.aspectRatio ?? 'default ratio'}, x${expected}, ${item.refs.length} ref(s))…`,
        );
        await driver.generate();

        const outcome = await driver.waitForNewAssets(before, expected, {
          timeout: item.timeoutMs ?? settings.timeouts.generationMs,
        });

        const saved = [];
        for (let index = 0; index < outcome.added.length; index += 1) {
          const entry = outcome.added[index];
          const current = await driver.snapshotAssets();
          const match = current.entries.find((candidate) => candidate.key === entry.key);
          const tileIndex = match ? match.index : entry.index;
          const selector = current.selector ?? outcome.selector;

          // The job's `file` field names the output exactly, extension included.
          // Several results for one item get a numeric suffix before the extension.
          const requested = item.outputFile ?? `${item.outputName}.png`;
          const requestedExt = path.extname(requested).toLowerCase();
          const requestedStem = path.basename(requested, path.extname(requested));
          const stem = outcome.added.length > 1 ? `${requestedStem}-${index + 1}` : requestedStem;
          let tempPath = path.join(job.outputsDir, `${stem}.download`);

          // The tile's signed CDN URL serves the full-resolution still and needs
          // no UI interaction, so try it first and fall back to the export menu.
          let download = { method: null };
          const body = await driver.fetchAssetBytes(tileIndex, { selector });
          if (body) {
            fs.writeFileSync(tempPath, body);
            download = { method: 'cdn' };
          } else {
            download = await driver.downloadAsset(tileIndex, tempPath, { selector });
          }
          if (!download.method) {
            throw new GenerationError(
              'Generated the asset but could not save it. Calibrate "assetMenuButton" and "downloadMenuItem".',
            );
          }

          // Flow only exports JPEG. When the job asked for .png, re-encode it so
          // the file's name and its contents agree.
          const sourceExt = sniffImageExtension(tempPath);
          let finalExt = sourceExt;
          if (requestedExt === '.png' && sourceExt !== '.png') {
            const pngPath = `${tempPath}.png`;
            const converted = await driver.convertToPng(tempPath, pngPath).catch(() => false);
            if (converted) {
              fs.rmSync(tempPath, { force: true });
              tempPath = pngPath;
              finalExt = '.png';
            } else {
              log.warn(`Could not convert ${stem} to PNG; saving as ${sourceExt} instead.`);
            }
          } else if (requestedExt && requestedExt !== sourceExt) {
            finalExt = sourceExt;
          }

          const destPath = path.join(job.outputsDir, `${stem}${finalExt}`);
          fs.renameSync(tempPath, destPath);
          saved.push(destPath);
          log.ok(`Saved ${path.relative(ROOT, destPath)} (via ${download.method})`);
        }

        state.update(item.id, { status: STATUS.done, files: saved, error: null });
        state.save();
        succeeded = true;
        ok += 1;
        results.push({ id: item.id, status: STATUS.done, files: saved });
      } catch (error) {
        lastError = error;
        const message = String(error.message ?? error);
        log.error(`Attempt ${attempt}/${retries + 1} failed for "${item.id}": ${message.split('\n')[0]}`);

        if (options.dumpOnError !== false) {
          const dump = await driver.dumpDebug(`error-${item.id}`, settings.dirs).catch(() => null);
          if (dump) log.info(`Debug capture: ${path.relative(ROOT, dump.screenshot)}`);
        }

        // Refusals that Flow will keep refusing (throttling, policy blocks) must
        // not be retried, and must stop the batch rather than make it worse.
        if (error.retryable === false) {
          log.error('This failure is not retryable; stopping the batch after this item.');
          aborted = true;
          break;
        }

        const willRetry = attempt <= retries;
        if (willRetry) {
          log.warn(`Retrying "${item.id}" in ${Math.round(retryDelayMs / 1000)}s…`);
          await sleep(retryDelayMs);
          // With resetMode "reload" the next attempt reloads anyway; only recover here for "clear".
          if (resetMode !== 'reload') {
            await driver.reload().catch(() => {});
            if (reapply) await driver.applyGenerationSettings(genSettings).catch(() => {});
          }
        }
      }
    }

    if (!succeeded) {
      state.update(item.id, { status: STATUS.failed, error: String(lastError?.message ?? lastError) });
      state.save();
      failed += 1;
      results.push({ id: item.id, status: STATUS.failed, error: String(lastError?.message ?? lastError) });

      if (options.pauseOnError ?? gen.pauseOnError) {
        await pauseForInspection(`Paused after failure on "${item.id}".`);
      }
      if (options.failFast) {
        log.error('Stopping early because --fail-fast is set.');
        break;
      }
    }

    if (aborted) break;
    firstItem = false;
    if (delayBetweenItemsMs > 0) await sleep(delayBetweenItemsMs);
  }

  const counts = state.counts();
  log.heading('Summary');
  log.raw(
    `  done=${counts.done} failed=${counts.failed} pending=${counts.pending} skipped=${counts.skipped} ` +
      `(this run: ok=${ok} failed=${failed})`,
  );
  log.raw(`  outputs: ${path.relative(ROOT, job.outputsDir)}`);
  log.raw(`  state  : ${path.relative(ROOT, state.filePath)}`);

  return { ok, failed, skipped: counts.skipped, results };
}
