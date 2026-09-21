import fs from 'node:fs';
import path from 'node:path';

import { fromRoot, ROOT } from '../src/lib/paths.js';
import { log } from '../src/lib/log.js';
import {
  TIERS,
  describeUpscaler,
  engineLabel,
  loadUpscaleSettings,
  normalizeTier,
  saveUpscaleSettings,
  upscaleImage,
} from '../src/upscale/index.js';

function collectInputs(targets) {
  const files = [];
  for (const target of targets) {
    const resolved = fromRoot(target);
    if (!resolved || !fs.existsSync(resolved)) {
      throw new Error(`Not found: ${target}`);
    }
    if (fs.statSync(resolved).isDirectory()) {
      for (const entry of fs.readdirSync(resolved)) {
        if (/\.png$/i.test(entry)) files.push(path.join(resolved, entry));
      }
    } else {
      files.push(resolved);
    }
  }
  return files;
}

function printInfo() {
  const info = describeUpscaler();
  log.heading('Upscaler');
  log.raw(`  engine      : ${info.engineAvailable ? 'realesrgan-ncnn-vulkan' : 'NOT INSTALLED'}`);
  log.raw(`  device      : ${info.deviceName ?? 'auto-detect on first use'}`);
  log.raw(`  tier        : ${TIERS[info.tier]?.label ?? info.tier} (default)`);
  log.raw(`  model       : ${info.model}`);
  log.raw(`  supersample : ${info.supersample ? 'yes' : 'no'}`);
  log.raw(`  fit         : ${info.fit}`);
  log.raw(`  fallback    : ${info.cpuFallback ? 'CPU Lanczos' : 'disabled'}`);
  log.raw('');
  log.raw('  tier  target for 16:9   other ratios (long side)');
  for (const tier of info.tiers) {
    log.raw(`  ${tier.label.padEnd(4)}  ${tier.sixteenNine.padEnd(16)}  ${tier.aspect}`);
  }
  log.raw('');
  log.raw('Usage: node src/cli.js upscale <file-or-folder> [more...] [--tier 1k|2k|3k|4k|off]');
  log.raw('       node src/cli.js upscale --set-tier 4k');
}

export async function upscaleCommand({ flags, positionals }) {
  // `--set-tier` remembers the choice without processing anything.
  const requested = flags['set-tier'] ?? flags['set-scale'];
  if (requested !== undefined) {
    const saved = saveUpscaleSettings({ tier: normalizeTier(requested === true ? '2k' : requested) });
    log.ok(`Upscale tier saved as ${TIERS[saved.tier]?.label ?? saved.tier}. Future runs will use it.`);
    return 0;
  }

  if (positionals.length === 0) {
    printInfo();
    return 0;
  }

  const settings = loadUpscaleSettings();
  const tier = normalizeTier(flags.tier ?? flags.scale ?? settings.tier);
  const model = typeof flags.model === 'string' ? flags.model : settings.model;
  const outDir = typeof flags.out === 'string' ? fromRoot(flags.out) : null;
  const fit = typeof flags.fit === 'string' ? flags.fit : settings.fit;

  const inputs = collectInputs(positionals);
  if (inputs.length === 0) {
    log.warn('No PNG files found to upscale.');
    return 0;
  }

  if (flags.save === true) {
    saveUpscaleSettings({ tier, model, fit });
    log.info(`Saved ${tier} / ${model} / fit=${fit} as the default.`);
  }

  log.heading(`Upscaling ${inputs.length} image(s) to ${TIERS[tier]?.label ?? tier}`);
  let failed = 0;

  for (const input of inputs) {
    const destination = outDir
      ? path.join(outDir, path.basename(input))
      : path.join(path.dirname(input), `${path.basename(input, path.extname(input))}_${tier}.png`);

    try {
      const started = Date.now();
      const result = upscaleImage(input, destination, {
        tier,
        model,
        fit,
        tile: settings.tile,
        cpuFallback: settings.cpuFallback,
        supersample: settings.supersample,
        enginePath: settings.enginePath,
      });
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      log.ok(
        `${path.relative(ROOT, input)} -> ${path.relative(ROOT, destination)} ` +
          `${result.width}x${result.height} via ${engineLabel(result)} (${seconds}s)`,
      );
    } catch (error) {
      failed += 1;
      log.error(`${path.basename(input)}: ${error.message}`);
    }
  }

  return failed > 0 ? 1 : 0;
}
