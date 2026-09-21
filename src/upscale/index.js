import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ROOT } from '../lib/paths.js';
import { log } from '../lib/log.js';
import { readJson, writeJson } from '../lib/json.js';
import { decodePng, encodePng, meanAbsoluteDeviation, resizeLanczos, toRgb } from './png.js';
import {
  cachedGpu,
  deviceNameFromOutput,
  invalidateDeviceCache,
  isAvailable,
  loadDeviceCache,
  notInstalledMessage,
  runEngine,
  saveDeviceCache,
} from './engine.js';

export const SCALES = [1, 2, 3, 4];

/** Which native scales each model ships with. */
const MODEL_SCALES = {
  'realesr-animevideov3': [2, 3, 4],
  'realesrgan-x4plus': [4],
  'realesrgan-x4plus-anime': [4],
};

const CONFIG_FILE = path.join(ROOT, 'config', 'upscale.json');
const LOCAL_FILE = path.join(ROOT, 'config', 'upscale.local.json');

export const UPSCALE_DEFAULTS = {
  // 1x disables upscaling; 2x is the default (720p -> 1440p, i.e. 2K).
  scale: 2,
  model: 'realesr-animevideov3',
  tile: 256,
  cpuFallback: true,
  enginePath: null,
};

/** Drop comment keys so they never leak into API responses. */
function stripComments(value) {
  const result = {};
  for (const [key, entry] of Object.entries(value ?? {})) {
    if (key.startsWith('_')) continue;
    result[key] = entry;
  }
  return result;
}

export function loadUpscaleSettings() {
  const base = stripComments(readJson(CONFIG_FILE, { required: false }));
  const local = stripComments(readJson(LOCAL_FILE, { required: false }));
  return { ...UPSCALE_DEFAULTS, ...base, ...local };
}

/** Persist a change so the choice survives restarts. */
export function saveUpscaleSettings(patch) {
  const local = stripComments(readJson(LOCAL_FILE, { required: false }));
  const next = { ...local, ...patch };
  writeJson(LOCAL_FILE, next);
  return { ...UPSCALE_DEFAULTS, ...stripComments(readJson(CONFIG_FILE, { required: false })), ...next };
}

export function normalizeScale(value) {
  const scale = Number(value);
  if (!Number.isInteger(scale) || !SCALES.includes(scale)) {
    throw new Error(`Upscale scale must be one of ${SCALES.join(', ')} (got "${value}").`);
  }
  return scale;
}

function targetSize(width, height, scale) {
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function writeFlattened(source, destination) {
  const decoded = decodePng(fs.readFileSync(source));
  const rgb = toRgb(decoded);
  fs.writeFileSync(destination, encodePng(rgb));
  return rgb;
}

/**
 * Upscale a PNG by an integer factor.
 *
 * GPU (Real-ESRGAN ncnn-Vulkan) is tried first; the CPU Lanczos path is used
 * when no Vulkan device produces valid output. Every GPU result is compared
 * against the source, because a bad device yields garbage rather than an error.
 */
export function upscaleImage(source, destination, options = {}) {
  const settings = { ...loadUpscaleSettings(), ...options };
  const scale = normalizeScale(settings.scale);
  const model = settings.model ?? UPSCALE_DEFAULTS.model;

  if (!fs.existsSync(source)) throw new Error(`Image not found: ${source}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });

  // 1x is a pass-through: no engine, no resampling.
  if (scale === 1) {
    fs.copyFileSync(source, destination);
    const decoded = decodePng(fs.readFileSync(destination));
    return { width: decoded.width, height: decoded.height, method: 'none', device: null, scale };
  }

  const sourceImage = decodePng(fs.readFileSync(source));
  const target = targetSize(sourceImage.width, sourceImage.height, scale);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-upscale-'));
  const flatPath = path.join(workDir, 'input_rgb.png');
  const outPath = path.join(workDir, 'engine_out.png');

  try {
    const flat = writeFlattened(source, flatPath);
    const nativeScales = MODEL_SCALES[model] ?? [4];
    const engineScale = nativeScales.includes(scale) ? scale : 4;

    if (isAvailable(settings.enginePath)) {
      let gpu = cachedGpu();
      const candidates = [];
      if (gpu !== null) candidates.push(gpu);
      candidates.push(null); // the engine's own device choice as a second chance

      for (const candidate of candidates) {
        fs.rmSync(outPath, { force: true });
        try {
          const result = runEngine({
            source: flatPath,
            destination: outPath,
            model,
            scale: engineScale,
            gpu: candidate,
            tile: settings.tile,
          });
          if (!fs.existsSync(outPath)) continue;

          const produced = decodePng(fs.readFileSync(outPath));
          if (!meanAbsoluteDeviation(flat, toRgb(produced)).ok) {
            // Corrupt tiles: this device cannot be trusted.
            log.debug(`Upscaler device ${candidate} produced output that does not match the source.`);
            invalidateDeviceCache();
            continue;
          }

          const finished =
            engineScale === scale ? produced : resizeLanczos(produced, target.width, target.height);
          fs.writeFileSync(destination, encodePng(finished));

          if (candidate !== null) {
            const cache = loadDeviceCache();
            if (cache.device !== candidate) {
              saveDeviceCache({
                device: candidate,
                name: deviceNameFromOutput(result, candidate),
                kind: cache.kind ?? 'vulkan',
                ts: Date.now() / 1000,
              });
            }
          }

          return {
            width: finished.width,
            height: finished.height,
            method: 'realesrgan',
            device: candidate === null ? 'auto' : deviceNameFromOutput(result, candidate),
            model,
            scale,
          };
        } catch (error) {
          log.debug(`Upscaler attempt on device ${candidate} failed: ${error.message}`);
        }
        if (candidate !== null) invalidateDeviceCache();
      }
      log.warn('No Vulkan device produced valid output; falling back to CPU.');
    } else {
      log.debug(notInstalledMessage());
    }

    if (settings.cpuFallback === false) {
      throw new Error('GPU upscaling failed and the CPU fallback is disabled.');
    }

    const resized = resizeLanczos(flat, target.width, target.height);
    fs.writeFileSync(destination, encodePng(resized));
    return {
      width: resized.width,
      height: resized.height,
      method: 'lanczos',
      device: 'CPU',
      model: null,
      scale,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** "realesrgan (NVIDIA GeForce RTX 3050 Laptop GPU, 2x)" — for logs and the UI. */
export function engineLabel(result) {
  if (!result) return 'unknown';
  if (result.method === 'none') return '1x (no upscale)';
  if (result.method === 'lanczos') return `Lanczos CPU (${result.scale}x)`;
  return `Real-ESRGAN (${result.device}, ${result.scale}x)`;
}

export function describeUpscaler() {
  const settings = loadUpscaleSettings();
  const available = isAvailable(settings.enginePath);
  const cache = loadDeviceCache();
  return {
    ...settings,
    engineAvailable: available,
    deviceName: cache.name ?? null,
    deviceKind: cache.kind ?? null,
  };
}
