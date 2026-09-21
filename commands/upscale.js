import fs from 'node:fs';
import path from 'node:path';

import { fromRoot, ROOT } from '../src/lib/paths.js';
import { log } from '../src/lib/log.js';
import { intFlag } from '../src/lib/args.js';
import { describeUpscaler, engineLabel, loadUpscaleSettings, saveUpscaleSettings, upscaleImage } from '../src/upscale/index.js';

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

export async function upscaleCommand({ flags, positionals }) {
  // `--set-scale` remembers the choice without processing anything.
  if (flags['set-scale'] !== undefined) {
    const saved = saveUpscaleSettings({ scale: intFlag(flags, 'set-scale', 2) });
    log.ok(`Upscale level saved as ${saved.scale}x. It will be used for future runs.`);
    return 0;
  }

  if (positionals.length === 0) {
    const info = describeUpscaler();
    log.heading('Upscaler');
    log.raw(`  engine   : ${info.engineAvailable ? 'realesrgan-ncnn-vulkan' : 'NOT INSTALLED'}`);
    log.raw(`  device   : ${info.deviceName ?? 'auto-detect on first use'}`);
    log.raw(`  scale    : ${info.scale}x (default)`);
    log.raw(`  model    : ${info.model}`);
    log.raw(`  fallback : ${info.cpuFallback ? 'CPU Lanczos' : 'disabled'}`);
    log.raw('');
    log.raw('Usage: node src/cli.js upscale <file-or-folder> [more...] [--scale 1|2|3|4] [--out <dir>]');
    log.raw('       node src/cli.js upscale --set-scale 3');
    return 0;
  }

  const settings = loadUpscaleSettings();
  const scale = flags.scale !== undefined ? intFlag(flags, 'scale', settings.scale) : settings.scale;
  const model = typeof flags.model === 'string' ? flags.model : settings.model;
  const outDir = typeof flags.out === 'string' ? fromRoot(flags.out) : null;

  const inputs = collectInputs(positionals);
  if (inputs.length === 0) {
    log.warn('No PNG files found to upscale.');
    return 0;
  }

  if (flags.save === true) {
    saveUpscaleSettings({ scale, model });
    log.info(`Saved ${scale}x / ${model} as the default.`);
  }

  log.heading(`Upscaling ${inputs.length} image(s) at ${scale}x`);
  let failed = 0;

  for (const input of inputs) {
    const destination = outDir
      ? path.join(outDir, path.basename(input))
      : path.join(path.dirname(input), path.basename(input, path.extname(input)) + `_${scale}x.png`);

    try {
      const started = Date.now();
      const result = upscaleImage(input, destination, { scale, model });
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
