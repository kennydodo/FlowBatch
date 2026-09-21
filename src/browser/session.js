import { chromium } from 'playwright';
import { log } from '../lib/log.js';

/**
 * Applied before any page script runs. Keeps the persistent profile looking like
 * a normal browser session so Google sign-in is less likely to be refused.
 */
function stealthInit() {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
  }
}

export async function launchSession(settings, { headless } = {}) {
  const dirs = settings.dirs;
  const browserConfig = settings.browser ?? {};

  const args = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,OptimizationGuideModelDownloading',
    ...(browserConfig.extraArgs ?? []),
  ];

  const baseOptions = {
    headless: headless ?? browserConfig.headless ?? false,
    viewport: browserConfig.viewport ?? { width: 1512, height: 950 },
    locale: browserConfig.locale ?? 'en-US',
    acceptDownloads: true,
    downloadsPath: dirs.downloadsDir,
    slowMo: browserConfig.slowMo ?? 0,
    ignoreHTTPSErrors: true,
    args,
  };
  if (browserConfig.timezoneId) baseOptions.timezoneId = browserConfig.timezoneId;
  if (browserConfig.userAgent) baseOptions.userAgent = browserConfig.userAgent;

  const attempts = [];
  if (browserConfig.channel) attempts.push({ ...baseOptions, channel: browserConfig.channel });
  attempts.push(baseOptions);

  let context = null;
  let lastError = null;

  for (const options of attempts) {
    try {
      context = await chromium.launchPersistentContext(dirs.profileDir, options);
      if (options.channel) {
        log.debug(`Browser launched with channel "${options.channel}".`);
      } else {
        log.warn(
          'Browser launched with Playwright\'s bundled Chromium. Google may refuse sign-in from it; ' +
            'install Chrome or set browser.channel in config/settings.json.',
        );
      }
      break;
    } catch (error) {
      lastError = error;
      if (options.channel) {
        log.warn(`Could not launch channel "${options.channel}": ${String(error.message).split('\n')[0]}`);
      }
    }
  }

  if (!context) throw lastError ?? new Error('Could not launch a browser session.');

  await context.addInitScript(stealthInit);
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(settings.timeouts?.selectorMs ?? 10000);

  return { context, page };
}

export async function closeSession(context) {
  if (!context) return;
  await context.close().catch((error) => log.debug(`Close warning: ${error.message}`));
}
