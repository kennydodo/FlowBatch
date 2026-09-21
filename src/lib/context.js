import path from 'node:path';

import { loadSelectors, loadSettings, prepareRuntimeDirs } from './config.js';
import { ROOT } from './paths.js';

/**
 * Load config, apply CLI overrides, and make sure runtime directories exist.
 */
export function buildContext(flags = {}) {
  const configDir = path.join(ROOT, 'config');
  const settings = loadSettings(configDir);
  const selectors = loadSelectors(configDir);

  if (flags.headless !== undefined) settings.browser.headless = Boolean(flags.headless);
  if (typeof flags.channel === 'string') settings.browser.channel = flags.channel;
  if (flags.slowmo !== undefined) settings.browser.slowMo = Number(flags.slowmo);
  if (typeof flags.url === 'string') settings.flowUrl = flags.url;

  prepareRuntimeDirs(settings);

  return { settings, selectors, dirs: settings.dirs, configDir };
}
