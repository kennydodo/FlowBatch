import fs from 'node:fs';
import path from 'node:path';

import { sleep, timestampSlug } from '../lib/time.js';
import { ensureParent, slugify } from '../lib/paths.js';
import { mimeForExtension, sniffImageExtension } from '../lib/image.js';
import { log } from '../lib/log.js';
import { GenerationError, TimeoutError } from '../lib/errors.js';
import { SelectorSet } from './selectors.js';

const REFERENCE_CONFIRM_MS = 20000;

/**
 * Normalise a model label for comparison: drop the leading emoji and any icon
 * text, collapse whitespace, and lowercase.
 */
function normalizeModelName(value) {
  return String(value ?? '')
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export class FlowDriver {
  constructor({ page, context, selectors, settings }) {
    this.page = page;
    this.context = context;
    this.selectors = selectors instanceof SelectorSet ? selectors : new SelectorSet(selectors);
    this.settings = settings;
    this.timeouts = settings.timeouts;
    this.downloads = [];
    // Filenames already uploaded into the project during this run, so repeated
    // items reuse the asset instead of creating duplicates.
    this.uploadedRefNames = new Set();
    this.page.on('download', (download) => this.downloads.push(download));
  }

  // ---------------------------------------------------------------- helpers

  find(key, options = {}) {
    return this.selectors.find(this.page, key, {
      timeout: this.timeouts.selectorMs,
      ...options,
    });
  }

  exists(key, options = {}) {
    return this.selectors.exists(this.page, key, options);
  }

  async labelOf(locator) {
    const text = await locator.innerText().catch(() => '');
    const aria = await locator.getAttribute('aria-label').catch(() => '');
    return `${text} ${aria ?? ''}`.replace(/\s+/g, ' ').trim();
  }

  /**
   * Flow menu entries often carry a leading emoji (e.g. "🍌 Nano Banana Pro"),
   * so exact accessible-name matching is unreliable. Try exact first, then
   * case-insensitive substring.
   */
  async findByText(text, { timeout = 5000, required = true, root = this.page } = {}) {
    const quoted = JSON.stringify(String(text));
    const candidates = [
      `role=menuitem[name=${quoted} i]`,
      `role=option[name=${quoted} i]`,
      `[role='menuitem']:has-text(${quoted})`,
      `[role='option']:has-text(${quoted})`,
      `mat-button-toggle:has-text(${quoted})`,
      `button:has-text(${quoted})`,
      `text=${quoted}`,
    ];
    const scoped = new SelectorSet({ transient: candidates });
    return scoped.find(root, 'transient', { timeout, required });
  }

  // ------------------------------------------------------------- navigation

  async goto() {
    await this.page
      .goto(this.settings.flowUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.timeouts.navigationMs,
      })
      .catch((error) => log.warn(`Navigation warning: ${error.message.split('\n')[0]}`));
    await sleep(1500);
    await this.dismissConsent();
  }

  /**
   * The cookie consent bar overlays the prompt-box controls and swallows clicks,
   * so it has to go before anything in the prompt box can be used.
   */
  async dismissConsent() {
    const banner = await this.selectors.find(this.page, 'consentDismiss', {
      timeout: 2500,
      required: false,
    });
    if (!banner) return false;
    await banner.locator.click({ timeout: 4000 }).catch(() => {});
    await sleep(500);
    log.debug('Dismissed the cookie consent banner.');
    return true;
  }

  /** Open a specific project directly instead of relying on the landing redirect. */
  async openProject(url) {
    log.info(`Opening project ${url}`);
    await this.page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs })
      .catch((error) => log.warn(`Navigation warning: ${error.message.split('\n')[0]}`));
    await sleep(3000);
    await this.dismissConsent();
    await this.waitForPromptBox({ timeout: this.timeouts.readyMs });
  }

  async signInState({ timeoutMs = 5000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.exists('signedIn', { timeout: 0 })) return 'in';
      if (await this.exists('signedOut', { timeout: 0 })) return 'out';
      if (Date.now() >= deadline) return 'unknown';
      await sleep(500);
    }
  }

  /**
   * Lenient sign-in check: falls back to "a prompt box exists on the Flow host"
   * when the signedIn/signedOut selectors are not calibrated yet. Never reports
   * a signed-in state from the marketing page or from an accounts.google.com
   * challenge page.
   */
  async looksSignedIn() {
    const state = await this.signInState({ timeoutMs: 4000 });
    if (state !== 'unknown') return state;

    const url = this.page.url();
    if (/accounts\.google\.com/.test(url)) return 'challenge';
    if (!/^https?:\/\/([a-z0-9-]+\.)*flow\.google\.com\//i.test(url)) return 'unknown';
    if (/\/about(\/|$|\?)/i.test(url)) return 'out';
    if (await this.exists('promptBox', { timeout: 0 })) return 'in';
    return 'unknown';
  }

  async waitForPromptBox({ timeout } = {}) {
    return this.find('promptBox', { timeout: timeout ?? this.timeouts.readyMs });
  }

  async reload() {
    await this.page.reload({ waitUntil: 'domcontentloaded', timeout: this.timeouts.navigationMs });
    await sleep(1200);
    await this.dismissConsent();
    await this.waitForPromptBox();
  }

  async isInsideProject() {
    if (/\/project\//.test(this.page.url())) return true;
    const hasPrompt = await this.exists('promptBox', { timeout: 0 });
    if (!hasPrompt) return false;
    const hasNewProject = await this.exists('newProjectButton', { timeout: 0 });
    return !hasNewProject;
  }

  async findProjectCard(name) {
    for (const selector of this.selectors.candidates('projectCard')) {
      const card = this.page.locator(selector).filter({ hasText: name }).first();
      if ((await card.count().catch(() => 0)) > 0 && (await card.isVisible().catch(() => false))) {
        return card;
      }
    }
    return null;
  }

  async ensureProject(name) {
    if (await this.isInsideProject()) {
      log.debug('Already inside a Flow project.');
      return;
    }

    if (name) {
      const card = await this.findProjectCard(name);
      if (card) {
        log.info(`Opening project "${name}".`);
        await card.click();
        await sleep(1500);
        await this.waitForPromptBox();
        return;
      }
      log.warn(`Project "${name}" was not found in the project list; creating a new project instead.`);
    }

    log.info('Creating a new Flow project.');
    const button = await this.find('newProjectButton');
    await button.locator.click();
    await sleep(2000);
    await this.waitForPromptBox();
  }

  // ---------------------------------------------------------------- settings

  /**
   * Agent mode is ON by default and persists per project. With Agent ON the
   * prompt box only exposes "Add ingredients" + "Start generation"; the model,
   * aspect-ratio and output-count controls (button.settings-trigger-button) are
   * hidden. The batch runner therefore turns Agent OFF for the standard prompt
   * box. This is idempotent, unlike a blind click on the toggle chip.
   */
  async agentModeState() {
    const found = await this.selectors.find(this.page, 'agentToggle', { timeout: 3000, required: false });
    if (!found) return 'unknown';
    const pressed = await found.locator.getAttribute('aria-pressed').catch(() => null);
    if (pressed === 'true') return 'on';
    if (pressed === 'false') return 'off';
    return 'unknown';
  }

  async ensureAgentMode(enabled) {
    const wanted = enabled ? 'true' : 'false';
    const found = await this.selectors.find(this.page, 'agentToggle', { timeout: 8000, required: false });
    if (!found) {
      log.warn('Could not find the Agent mode toggle; leaving Agent as-is.');
      return false;
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const pressed = await found.locator.getAttribute('aria-pressed').catch(() => null);
      if (pressed === wanted) {
        log.debug(`Agent mode is ${enabled ? 'on' : 'off'}.`);
        return true;
      }
      await found.locator.click({ force: true }).catch(() => {});
      await sleep(700);
    }
    const final = await found.locator.getAttribute('aria-pressed').catch(() => null);
    if (final === wanted) return true;
    log.warn(`Could not set Agent mode to ${enabled ? 'on' : 'off'} (aria-pressed=${final}).`);
    return false;
  }

  async openSettingsOverlay() {
    // Idempotent: clicking the trigger while the overlay is already open would
    // close it again, leaving nothing to configure.
    if (await this.selectors.exists(this.page, 'settingsOverlay', { timeout: 0 })) {
      return null;
    }
    const button = await this.find('settingsTriggerButton', { timeout: 8000 });
    await button.locator.click();
    await sleep(600);
    return button;
  }

  async closeSettingsOverlay() {
    await this.page.keyboard.press('Escape').catch(() => {});
    await sleep(400);
  }

  /** The "🍌 Nano Banana 2 Lite · 16:9 · x2" summary shown on the settings trigger. */
  async settingsSummary() {
    const found = await this.selectors.find(this.page, 'settingsTriggerButton', {
      timeout: 2500,
      required: false,
    });
    if (!found) return null;
    return (await found.locator.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  }

  async ensureMode(mode) {
    const key = mode === 'image' ? 'modeImageOption' : mode === 'video' ? 'modeVideoOption' : null;
    if (!key) throw new Error(`Unsupported generation mode "${mode}". Use "image" or "video".`);
    const option = await this.find(key, { timeout: 8000 });
    if (await this.#isToggleChecked(option.locator)) return true;
    await option.locator.click();
    await sleep(500);
    return true;
  }

  /** Flow's mat-button-toggle buttons expose selection via aria-checked. */
  async #isToggleChecked(locator) {
    const checked = await locator.getAttribute('aria-checked').catch(() => null);
    if (checked === 'true') return true;
    const pressed = await locator.getAttribute('aria-pressed').catch(() => null);
    return pressed === 'true';
  }

  /**
   * Model names are prefixes of one another ("Nano Banana 2" vs "Nano Banana 2
   * Lite"), so substring matching would silently pick the wrong model. Compare
   * normalised labels for equality instead, and say so when only a near match
   * exists.
   */
  async selectModel(name) {
    if (!name) return true;
    const wanted = normalizeModelName(name);
    const button = await this.find('modelFamilyButton', { timeout: 8000 });

    const current = normalizeModelName(await this.modelButtonLabel(button.locator));
    if (current === wanted) {
      log.debug(`Model already set to "${name}".`);
      return true;
    }

    await button.locator.click();
    await sleep(700);

    const items = this.page.locator("[role='menuitem']");
    const count = await items.count().catch(() => 0);
    let exact = -1;
    let first = -1;
    const seen = [];

    for (let index = 0; index < count; index += 1) {
      const raw = (await items.nth(index).innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      seen.push(raw);
      if (first < 0) first = index;
      if (normalizeModelName(raw) === wanted) {
        exact = index;
        break;
      }
    }

    const chosen = exact >= 0 ? exact : first;
    if (chosen < 0) {
      await this.page.keyboard.press('Escape').catch(() => {});
      log.warn(`No model named "${name}" in the model menu (saw: ${seen.join(', ')}). Keeping the current model.`);
      return false;
    }
    if (exact < 0) {
      log.warn(`No exact model named "${name}"; falling back to "${seen[0]}".`);
    }

    await items.nth(chosen).click();
    await sleep(600);
    return true;
  }

  /** The model button's own text, without the trailing icon ligature. */
  async modelButtonLabel(locator) {
    return locator
      .evaluate((element) => {
        const clone = element.cloneNode(true);
        clone.querySelectorAll('mat-icon').forEach((icon) => icon.remove());
        return clone.textContent ?? '';
      })
      .catch(() => '');
  }

  async setAspectRatio(ratio) {
    if (!ratio) return true;
    const group = await this.find('aspectRatioGroup', { timeout: 6000 });
    const option = await group.locator.locator(`button:has-text(${JSON.stringify(ratio)})`).first();
    if ((await option.count().catch(() => 0)) === 0) {
      log.warn(`Aspect ratio "${ratio}" is not offered by the current mode; keeping the current ratio.`);
      return false;
    }
    if (await this.#isToggleChecked(option)) return true;
    await option.click();
    await sleep(500);
    return true;
  }

  async setOutputCount(count) {
    if (!count || count < 1) return true;
    const group = await this.find('outputCountGroup', { timeout: 6000 });
    const option = await group.locator.locator(`button:has-text(${JSON.stringify(`x${count}`)})`).first();
    if ((await option.count().catch(() => 0)) === 0) {
      log.warn(`Output count x${count} is not offered; keeping the current count.`);
      return false;
    }
    if (await this.#isToggleChecked(option)) return true;
    await option.click();
    await sleep(500);
    return true;
  }

  /**
   * Flow's Agent mode must be OFF for the standard prompt box: only then does
   * the settings trigger (model / aspect ratio / output count) appear. Mode,
   * model, ratio and count all live inside that one overlay.
   */
  // ------------------------------------------------- project default settings

  /**
   * Agent mode ON is the mode Flow actually allows automated sessions to
   * generate in. With it ON the prompt-box settings trigger is hidden, so the
   * model / aspect ratio / output count come from the PROJECT defaults, which
   * this panel edits.
   */
  async openProjectSettings() {
    const button = await this.find('projectSettingsButton', { timeout: 8000 });
    // The panel is a sidebar and the trigger does not always register first
    // time, so retry before giving up.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await button.locator.click({ force: true }).catch(() => {});
      await sleep(1600);
      if (await this.selectors.exists(this.page, 'projectAspectGroup', { timeout: 4000 })) return true;
    }
    throw new Error('The project settings panel did not open. Calibrate "projectSettingsButton".');
  }

  async projectModelLabel() {
    const found = await this.selectors.find(this.page, 'projectModelButton', { timeout: 4000, required: false });
    if (!found) return '';
    return this.modelButtonLabel(found.locator);
  }

  async setProjectModel(name) {
    const found = await this.selectors.find(this.page, 'projectModelButton', { timeout: 5000 });
    await found.locator.click();
    await sleep(800);
    const option = await this.findByText(name, { timeout: 6000, required: false });
    if (!option) {
      log.warn(`Project default model "${name}" was not found in the model menu.`);
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }
    await option.locator.click();
    await sleep(600);
    return true;
  }

  /** Returns true when the value had to change. */
  async setProjectToggle(groupKey, label) {
    const group = await this.find(groupKey, { timeout: 5000 });
    const option = group.locator.locator(`button:has-text(${JSON.stringify(label)})`).first();
    if ((await option.count().catch(() => 0)) === 0) {
      log.warn(`Project setting "${label}" is not offered.`);
      return false;
    }
    if (await this.#isToggleChecked(option)) return false;
    await option.click();
    await sleep(400);
    return true;
  }

  async saveProjectSettings() {
    const save = await this.selectors.find(this.page, 'projectSettingsSave', { timeout: 5000, required: false });
    if (!save) {
      log.warn('No Save control in the project settings panel; changes may not persist.');
      return false;
    }
    await save.locator.click();
    await sleep(1200);
    return true;
  }

  /**
   * The panel is a sidebar that covers the composer, so it MUST be closed or
   * every later step fails to find the prompt box. Verified rather than assumed.
   */
  async closeProjectSettings() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!(await this.selectors.exists(this.page, 'projectAspectGroup', { timeout: 0 }))) return true;
      const close = await this.selectors.find(this.page, 'projectSettingsClose', { timeout: 2500, required: false });
      if (close) await close.locator.click({ force: true }).catch(() => {});
      else await this.page.keyboard.press('Escape').catch(() => {});
      await sleep(700);
    }
    const stillOpen = await this.selectors.exists(this.page, 'projectAspectGroup', { timeout: 0 });
    if (stillOpen) log.warn('The project settings panel would not close; the composer may be covered.');
    return !stillOpen;
  }

  /**
   * Bring the project's image defaults in line with the job. Only writes when
   * something actually differs, so a run does not re-save on every item.
   */
  async applyProjectDefaults({ model, aspectRatio, outputs }) {
    await this.openProjectSettings();
    let changed = false;

    if (model) {
      const current = await this.projectModelLabel();
      if (normalizeModelName(current) !== normalizeModelName(model)) {
        changed = (await this.setProjectModel(model)) || changed;
      }
    }
    if (aspectRatio) changed = (await this.setProjectToggle('projectAspectGroup', aspectRatio)) || changed;
    if (outputs) changed = (await this.setProjectToggle('projectOutputGroup', `x${outputs}`)) || changed;

    if (changed) {
      await this.saveProjectSettings();
      log.info('Updated the project defaults for image generation.');
    }
    const label = await this.projectModelLabel();
    await this.closeProjectSettings();
    if (label) log.info(`Project image defaults: ${label.replace(/\s+/g, ' ').trim()}`);
    return true;
  }

  async applyGenerationSettings({ mode, model, aspectRatio, outputs, agent }) {
    // Agent ON is the default because Agent OFF is refused outright for an
    // automated session ("unusual activity"), which no amount of waiting fixes.
    if (agent !== false) {
      await this.ensureAgentMode(true);
      return this.applyProjectDefaults({ model, aspectRatio, outputs });
    }

    await this.ensureAgentMode(false);

    const summary = await this.settingsSummary();
    const alreadyMatches =
      summary !== null &&
      (!model || summary.includes(model)) &&
      (!aspectRatio || summary.includes(aspectRatio)) &&
      (!outputs || summary.includes(`x${outputs}`)) &&
      (mode === 'image' ? /Nano Banana|Imagen/i.test(summary) : !/Nano Banana|Imagen/i.test(summary));
    if (alreadyMatches) {
      log.debug(`Prompt-box settings already match: ${summary}`);
      return true;
    }

    await this.openSettingsOverlay();
    await this.ensureMode(mode ?? 'image');
    await this.selectModel(model);
    await this.setAspectRatio(aspectRatio);
    await this.setOutputCount(outputs);
    await this.closeSettingsOverlay();
    const after = await this.settingsSummary();
    if (after) log.info(`Prompt-box settings: ${after}`);
    return true;
  }

  // ------------------------------------------------------------------ prompt

  async clearPrompt() {
    const box = await this.find('promptBox');
    await box.locator.click();
    await this.page.keyboard.press('Control+A').catch(() => {});
    await this.page.keyboard.press('Delete').catch(() => {});
    await sleep(150);
  }

  async setPrompt(text) {
    const box = await this.find('promptBox');
    await box.locator.click();
    await this.page.keyboard.press('Control+A').catch(() => {});
    await this.page.keyboard.press('Delete').catch(() => {});
    await sleep(120);
    try {
      await box.locator.fill(text);
    } catch {
      await box.locator.click();
      await this.page.keyboard.type(text, { delay: 8 });
    }
    await sleep(200);
  }

  /** Append text at the end of the prompt box without clearing it. */
  async typePrompt(text) {
    if (!text) return;
    const box = await this.find('promptBox');
    await box.locator.click();
    await this.page.keyboard.press('End').catch(() => {});
    await this.page.keyboard.type(text, { delay: 8 });
    await sleep(200);
  }

  // -------------------------------------------------------------- references

  async pickFileInput() {
    const inputs = this.page.locator('input[type=file]');
    const count = await inputs.count().catch(() => 0);
    let fallback = null;
    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      const accept = (await input.getAttribute('accept').catch(() => '')) ?? '';
      if (accept === '' || /image/i.test(accept)) return input;
      fallback = fallback ?? input;
    }
    return fallback;
  }

  /**
   * Reference images go in through the prompt box's Add menu:
   *   button[aria-label="Add ingredients to the prompt box"]
   *     -> "Upload media"            (opens the project asset picker)
   *     -> hidden input[type=file]   (uploads into the project; the new asset is
   *                                   auto-selected in the picker)
   *     -> "Add to prompt"           (attaches the selection as ingredients)
   *
   * Uploading through the picker means each reference becomes a project asset.
   * Re-running the same refs therefore creates duplicates in the project.
   */
  /**
   * Clicking the prompt box's "+" opens Flow's asset library **inline**: search,
   * category navigation and the project's asset list. It does NOT create a file
   * input, so no upload dialog is involved.
   *
   * "Upload media" is a separate button *inside* that library whose only job is
   * to spawn the hidden file input; it is clicked only when a file really has to
   * be uploaded.
   */
  async openAssetLibrary() {
    const addButton = await this.find('addIngredientsButton', { timeout: 8000 });
    await addButton.locator.click();

    let ready = await this.selectors.find(this.page, 'assetPickerSearch', { timeout: 8000, required: false });
    if (!ready) ready = await this.selectors.find(this.page, 'assetPickerItem', { timeout: 5000, required: false });
    if (!ready) {
      throw new Error(
        'Clicking the prompt-box "+" did not open the asset library. Calibrate "assetPickerSearch" / ' +
          '"assetPickerItem" in config/selectors.json.',
      );
    }
    await sleep(600);
  }

  async pickerIsOpen() {
    return this.selectors.exists(this.page, 'assetPickerDialog', { timeout: 0 });
  }

  /** Wait until the picker has marked the freshly uploaded assets as selected. */
  async waitForUploadToSettle({ expected = 1, timeout = 120000 } = {}) {
    const deadline = Date.now() + timeout;
    let lastLogged = 0;
    while (Date.now() < deadline) {
      const selected = await this.page
        .locator("button.asset-item[role='option'][aria-selected='true'], .asset-item-active")
        .count()
        .catch(() => 0);
      if (selected >= expected) {
        await sleep(800);
        return true;
      }
      if (Date.now() - lastLogged > 15000) {
        lastLogged = Date.now();
        log.debug(`Waiting for upload to finish (${selected}/${expected} selected)…`);
      }
      if (!(await this.pickerIsOpen())) {
        // The picker closed itself, which means it accepted the upload.
        return true;
      }
      await sleep(700);
    }
    return false;
  }

  /**
   * Upload path: open the library, then use its "Upload media" button to reach
   * the hidden file input. The freshly uploaded asset is left selected and must
   * be confirmed with "Add to prompt".
   */
  async attachUploadedFiles(files) {
    await this.openAssetLibrary();

    const mediaOption = await this.find('addMediaOption', { timeout: 8000, required: false });
    if (!mediaOption) {
      await this.page.keyboard.press('Escape').catch(() => {});
      throw new Error(
        'The asset library did not offer "Upload media". Calibrate "addMediaOption" in config/selectors.json.',
      );
    }
    await mediaOption.locator.click();

    const input = await this.waitForFileInput(8000);
    if (!input) {
      throw new Error('No file input appeared after choosing "Upload media". Calibrate "fileInput" in config/selectors.json.');
    }
    await input.setInputFiles(files);
    // Flow must upload and thumbnail the file before it can be attached. Large
    // references (the BG_*.png set is 14-18 MB each) need real time here, so
    // wait for the picker to actually mark the upload as selected.
    const settled = await this.waitForUploadToSettle({ expected: files.length });
    if (!settled) {
      log.warn(
        `Uploaded ${files.length} file(s) but the picker did not mark them as selected within the timeout; ` +
          'attempting to attach anyway.',
      );
    }
    for (const file of files) this.uploadedRefNames.add(path.basename(file));

    if (!(await this.pickerIsOpen())) {
      log.debug('Picker closed after upload; assuming the assets were attached.');
      return;
    }
    const attach = await this.findByText('Add to prompt', { timeout: 15000, required: false });
    if (!attach) {
      await this.page.keyboard.press('Escape').catch(() => {});
      throw new Error(
        'The asset picker did not offer "Add to prompt". Calibrate "addToPromptButton" in config/selectors.json.',
      );
    }
    await attach.locator.click();
    await sleep(1500);
  }

  /**
   * Reuse path: searching for an asset and clicking it attaches it to the prompt
   * and closes the picker in one action - no "Add to prompt" step.
   *
   * Prefers an exact title match ("Maya") over an exact filename match
   * ("Maya.png") over the first fuzzy hit, so a name never attaches the wrong
   * asset when the project holds similarly named files.
   */
  async attachExistingAsset(name) {
    await this.openAssetLibrary();
    const search = await this.find('assetPickerSearch', { timeout: 6000 });
    await search.locator.fill('');
    await search.locator.fill(name);
    await sleep(1800);

    let items = null;
    for (const selector of this.selectors.candidates('assetPickerItem')) {
      const candidate = this.page.locator(selector);
      if ((await candidate.count().catch(() => 0)) > 0) {
        items = candidate;
        break;
      }
    }
    if (!items) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }

    const count = await items.count();
    let chosen = -1;
    let fuzzy = -1;
    for (let index = 0; index < count; index += 1) {
      const title = (await items
        .nth(index)
        .locator("span.asset-title, .asset-title")
        .first()
        .innerText()
        .catch(() => '') ?? ''
      ).trim();
      if (!title) continue;
      if (fuzzy < 0) fuzzy = index;
      const stem = title.replace(/\.[a-z0-9]+$/i, '');
      if (title === name || stem === name) {
        chosen = index;
        break;
      }
    }
    if (chosen < 0) chosen = fuzzy;
    if (chosen < 0) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return false;
    }

    await items.nth(chosen).click().catch(() => {});
    await sleep(1800);

    // Clicking a result either attaches it and closes the library, or selects it
    // and shows a preview that still needs "Add to prompt". Both happen, so the
    // confirm step is conditional rather than assumed.
    if (await this.pickerIsOpen()) {
      const attach = await this.findByText('Add to prompt', { timeout: 8000, required: false });
      if (attach) {
        await attach.locator.click().catch(() => {});
        await sleep(1500);
      }
    }

    // Never leave an overlay covering the prompt box.
    if (await this.pickerIsOpen()) {
      await this.page.keyboard.press('Escape').catch(() => {});
      await sleep(500);
    }
    return true;
  }

  /** Close the asset library if it is still on screen. */
  async closeAssetLibrary() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (!(await this.pickerIsOpen())) return true;
      await this.page.keyboard.press('Escape').catch(() => {});
      await sleep(500);
    }
    return !(await this.pickerIsOpen());
  }

  /**
   * Attach reference images to the prompt box.
   *
   * `refs` is a list of `{ name, path }`: `name` is the asset name inside the
   * Flow project, `path` is the local file to upload if that name is missing.
   *
   * Flow has no direct file-to-prompt path, so its asset picker is used either
   * way. `mode` decides which route is taken per reference:
   *   reuse  - attach the existing project asset by name; upload the local file
   *            only when the name is not found (default, self-healing)
   *   assets - attach by name only; never upload
   *   upload - always upload the local file
   *
   * Each reference is handled in its own picker session. That is deliberate:
   * uploading several files at once only ever attaches the first one.
   */
  async addReferences(refs, { mode = 'reuse' } = {}) {
    if (!refs || refs.length === 0) return true;

    const before = await this.selectors.count(this.page, 'promptReferenceChip');
    log.debug(
      `References (${mode}): ${refs
        .map((ref) => `${ref.name}${ref.path ? '' : ' [project-only]'}`)
        .join(', ')}`,
    );

    for (const ref of refs) {
      if (mode !== 'upload') {
        const attached = await this.attachExistingAsset(ref.name);
        if (attached) {
          log.debug(`Attached project asset "${ref.name}".`);
          continue;
        }
        if (mode === 'assets') {
          log.warn(`Reference "${ref.name}" is not in the project's assets, and refMode "assets" never uploads.`);
          continue;
        }
        if (!ref.path) {
          log.warn(`Reference "${ref.name}" is not in the project's assets and has no local path to upload.`);
          continue;
        }
        log.debug(`"${ref.name}" not found in the project; uploading ${path.basename(ref.path)}.`);
      }

      if (!ref.path) {
        log.warn(`Reference "${ref.name}" has no local path; skipping.`);
        continue;
      }
      await this.attachUploadedFiles([ref.path]);
    }

    const confirmed = await this.waitForReferences(before + refs.length);
    if (!confirmed) {
      // Generating without the intended reference would silently produce the
      // wrong image, so fail the item and let the runner retry it.
      await this.closeAssetLibrary();
      throw new GenerationError(
        `Attached ${refs.length} reference(s) but could not confirm them in the prompt box; refusing to ` +
          'generate without them. Calibrate "promptReferenceChip" if this is a false alarm.',
        { retryable: true },
      );
    }
    return true;
  }

  async waitForFileInput(timeout) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const input = await this.pickFileInput();
      if (input) return input;
      if (Date.now() >= deadline) return null;
      await sleep(300);
    }
  }

  /**
   * Detach every ingredient from the composer.
   *
   * The chips live in `flow-ingredient-bar`, NOT inside the ProseMirror
   * editable, so a select-all in the editor does not remove them. Each chip
   * carries its own remove control that has to be clicked.
   */
  async detachAllReferences({ max = 12 } = {}) {
    for (let attempt = 0; attempt < max; attempt += 1) {
      const count = await this.selectors.count(this.page, 'promptReferenceChip');
      if (count === 0) return true;

      const remove = await this.selectors.find(this.page, 'promptReferenceRemoveButton', {
        timeout: 2500,
        required: false,
      });
      if (!remove) {
        log.warn('No control found to detach an attached reference.');
        return false;
      }
      // The overlay is transparent until hovered, so force the click.
      await remove.locator.click({ force: true }).catch(() => {});
      await sleep(600);
    }
    return (await this.selectors.count(this.page, 'promptReferenceChip')) === 0;
  }

  /**
   * Reset the composer in place for the next item.
   *
   * Reloading the whole Flow app before every item is slow and unlike anything a
   * human does - it was the largest behavioural difference from the Renderly
   * driver, which loads the page once per batch. Clearing the composer achieves
   * the same clean state; a reload stays available as a fallback and via
   * `generation.resetBetweenItems: "reload"`.
   */
  async clearComposerForNextItem() {
    await this.closeAssetLibrary();
    await this.page.keyboard.press('Escape').catch(() => {});
    await sleep(300);

    // References first: clicking the editor while a chip sits under the cursor
    // can open the chip preview instead of placing the caret.
    const detached = await this.detachAllReferences();
    await this.clearPrompt();

    const remaining = await this.selectors.count(this.page, 'promptReferenceChip');
    if (remaining > 0) log.warn(`${remaining} reference(s) still attached after clearing.`);
    return detached && remaining === 0;
  }

  /** "Clear prompt" wipes both the text and every attached ingredient. */
  async clearPromptAndReferences() {
    const button = await this.selectors.find(this.page, 'clearPromptButton', {
      timeout: 3000,
      required: false,
    });
    if (button) {
      await button.locator.click().catch(() => {});
      await sleep(600);
      return true;
    }
    // No clear control in this version of the UI - do it by hand.
    await this.detachAllReferences();
    await this.clearPrompt();
    return (await this.selectors.count(this.page, 'promptReferenceChip')) === 0;
  }

  async waitForReferences(expected) {
    const deadline = Date.now() + REFERENCE_CONFIRM_MS;
    while (Date.now() < deadline) {
      const count = await this.selectors.count(this.page, 'promptReferenceChip');
      if (count >= expected) return true;
      await sleep(400);
    }
    log.warn(
      `Uploaded ${expected} reference image(s) but could not confirm them in the prompt box. ` +
        'Calibrate "promptReferenceChip" if generations ignore the references.',
    );
    return false;
  }

  async mentionReferences(names) {
    if (!names || names.length === 0) return true;
    const box = await this.find('promptBox');
    for (const name of names) {
      await box.locator.click();
      await this.page.keyboard.press('End').catch(() => {});
      await this.page.keyboard.type(`@${name}`, { delay: 30 });
      await sleep(700);
      const suggestion = await this.findByText(name, { timeout: 2500, required: false });
      if (suggestion) await suggestion.locator.click();
      else await this.page.keyboard.press('Enter').catch(() => {});
      await this.page.keyboard.type(' ');
      await sleep(200);
    }
    return true;
  }

  // -------------------------------------------------------------- generation

  async generate() {
    // An open popover (the asset library, a menu) covers the Generate button and
    // makes the click time out, so clear anything still on screen first.
    await this.closeAssetLibrary();
    await this.page.keyboard.press('Escape').catch(() => {});
    await sleep(300);

    const button = await this.find('generateButton', { requireEnabled: true, timeout: 15000 });
    await button.locator.click({ timeout: 20000 });
  }

  async snapshotAssets() {
    const redoSelectors = this.selectors.candidates('tileRedoButton');
    for (const selector of this.selectors.candidates('assetTile')) {
      const tiles = this.page.locator(selector);
      const count = await tiles.count().catch(() => 0);
      if (count === 0) continue;

      const entries = [];
      for (let index = 0; index < count; index += 1) {
        const info = await tiles
          .nth(index)
          .evaluate(
            (node, redoSel) => {
              const img = node.tagName === 'IMG' ? node : node.querySelector('img');
              const src = img ? img.currentSrc || img.getAttribute('src') || '' : '';
              // The redo control ("Reuse prompt") exists only on a generated
              // result, so it is the discriminator - but it must be read from the
              // DOM. innerText is empty on these tiles, and the textContent
              // fallback concatenates the icon ligatures into
              // "favoriteredomore_vert" with no word boundary to match on, which
              // is why a text regex missed real results.
              const canRedo = redoSel.some((sel) => {
                try {
                  return node.matches(sel) || Boolean(node.querySelector(sel));
                } catch {
                  return false;
                }
              });
              return {
                key: src || node.getAttribute('data-testid') || node.getAttribute('id') || '',
                text: (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
                hasImage: Boolean(src) && /^https?:/i.test(src),
                canRedo,
                width: img ? img.naturalWidth : 0,
                height: img ? img.naturalHeight : 0,
              };
            },
            redoSelectors,
          )
          .catch(() => ({ key: '', text: '' }));
        // Uploaded references are labelled with their filename; generated stills
        // are not. Used to keep uploads out of "new result" detection.
        const uploaded = /\.(png|jpe?g|webp|gif|heic?|mp4|m4v|mov|avi|3gp)\b/i.test(info.text);
        // Flow reports a refused generation inside the tile itself.
        const failed = /\b(failed|unusual activity|not been charged|try again)\b/i.test(info.text);
        // Generated tiles offer "redo"; uploaded references never do.
        const canRedo = info.canRedo === true;
        entries.push({
          index,
          key: info.key || `#${index}`,
          text: info.text,
          uploaded,
          failed,
          canRedo,
          hasImage: info.hasImage,
          width: info.width,
          height: info.height,
        });
      }
      // The grid is a virtual scroller, so only rendered tiles are present.
      return { selector, entries };
    }
    return { selector: null, entries: [] };
  }

  /**
   * Flow reports a refused generation in a transient tile and in a page-level
   * message; neither is a normal "no result" state, so both are surfaced with
   * the reason instead of a generic timeout.
   */
  async detectRefusal() {
    const found = await this.selectors.find(this.page, 'generationRefusal', {
      timeout: 0,
      required: false,
    });
    if (!found) return null;
    const text = (await found.locator.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
    return text || 'Flow reported a failed generation.';
  }

  /**
   * Wait until the grid stops changing, so reference uploads have finished
   * adding their tiles before the "before" snapshot is taken.
   */
  async waitForGridToSettle({ stableForMs = 3000, timeoutMs = 40000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastSignature = null;
    let stableSince = Date.now();
    let snapshot = await this.snapshotAssets();

    while (Date.now() < deadline) {
      const signature = snapshot.entries.map((entry) => entry.key).join('|');
      if (signature !== lastSignature) {
        lastSignature = signature;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= stableForMs) {
        return snapshot;
      }
      await sleep(700);
      snapshot = await this.snapshotAssets();
    }
    return snapshot;
  }

  async waitForNewAssets(before, expected, { timeout, excludeNames = [], referenceSizes = [] } = {}) {
    const beforeKeys = new Set(before.entries.map((entry) => entry.key));
    // Reference tiles can appear or re-render after the snapshot; never mistake
    // one for a generated result.
    // Reference tiles are labelled with their filename ("Maya.png"), while a
    // generated still is auto-named after the prompt ("Maya holding perfume
    // bottles"). Match the filename form only: a bare-name substring test threw
    // away real results whenever the prompt happened to name the reference.
    const excluded = excludeNames
      .flatMap((name) => [name, name.replace(/\.[a-z0-9]+$/i, '')])
      .filter(Boolean)
      .map(
        (name) =>
          new RegExp(
            `${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(png|jpe?g|webp|gif|heic?|mp4|m4v|mov|avi|3gp)\\b`,
            'i',
          ),
      );
    const isExcluded = (entry) => excluded.some((pattern) => pattern.test(entry.text));

    // A reference tile can also render with an empty label, which no name check
    // can catch. A generated still is never the same pixel size as a reference,
    // so a candidate that echoes a reference's dimensions is not a result.
    const echoesReference = (entry) =>
      entry.width > 0 &&
      entry.height > 0 &&
      referenceSizes.some((size) => size.width === entry.width && size.height === entry.height);
    const deadline = Date.now() + (timeout ?? this.timeouts.generationMs);
    const settleMs = expected > 1 ? 15000 : 6000;

    let latest = before;
    let added = [];
    let seen = 0;
    let lastGrowthAt = Date.now();

    for (;;) {
      const snapshot = await this.snapshotAssets();
      if (snapshot.entries.length > 0) latest = snapshot;

      // New, non-upload tiles that carry a real image are candidates. Prefer ones
      // offering "redo", which only generated results do.
      const fresh = latest.entries.filter(
        (entry) =>
          !beforeKeys.has(entry.key) && !entry.uploaded && !isExcluded(entry) && !echoesReference(entry),
      );
      // Require the "redo" control that only generated tiles carry. Falling back
      // to any image-bearing tile is how a reference got saved as a result, so a
      // tile that cannot be positively identified is not accepted - the item
      // times out and is retried instead.
      const candidates = fresh.filter((entry) => entry.hasImage && entry.canRedo);
      // For a single output, only the NEWEST tile can be the result. An older
      // tile that lazily swaps to its full-res variant looks new but is not one,
      // and cannot be downloaded - which is how a run saved one good image and
      // then failed on a phantom second.
      const newest = candidates.filter((entry) => entry.index === 0);
      added = expected === 1 && newest.length > 0 ? newest : candidates;

      // A refused generation shows up as a new tile, not as a new image.
      const refusal = fresh.find((entry) => entry.failed) ?? null;
      const pageRefusal = refusal ? null : await this.detectRefusal();
      const refused = refusal ?? (pageRefusal ? { text: pageRefusal } : null);
      if (refused) {
        const throttled = /unusual activity/i.test(refused.text);
        throw new GenerationError(
          throttled
            ? `Flow refused the generation: "${refused.text}". Google is throttling this account ` +
              '(automated activity detected). Wait before retrying, lower the request rate, and avoid ' +
              'running large batches back to back.'
            : `Flow reported a failed generation: "${refused.text}".`,
          { retryable: !throttled },
        );
      }

      if (added.length > seen) {
        seen = added.length;
        lastGrowthAt = Date.now();
        log.debug(`New assets detected: ${added.length}${expected ? `/${expected}` : ''}`);
      }

      const generating = await this.exists('generatingIndicator', { timeout: 0 });
      const settled =
        added.length >= expected || (added.length > 0 && !generating && Date.now() - lastGrowthAt >= settleMs);
      if (settled) return { ...latest, added };

      if (added.length === 0) {
        const banner = await this.selectors.find(this.page, 'errorBanner', {
          timeout: 0,
          required: false,
        });
        if (banner) {
          const text = (await banner.locator.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          if (text) throw new GenerationError(`Flow reported an error while generating: ${text}`);
        }
      }

      if (Date.now() >= deadline) break;
      await sleep(1500);
    }

    if (added.length > 0) return { ...latest, added };
    throw new TimeoutError(
      `Timed out after ${Math.round((timeout ?? this.timeouts.generationMs) / 1000)}s waiting for a new asset. ` +
        'Check the open browser window; if the generation finished, calibrate "assetTile".',
    );
  }

  // ---------------------------------------------------------------- download

  async awaitDownload(startIndex, destPath) {
    const deadline = Date.now() + this.timeouts.downloadMs;
    while (Date.now() < deadline) {
      if (this.downloads.length > startIndex) {
        const download = this.downloads[startIndex];
        ensureParent(destPath);
        // Copy the file Playwright already persisted rather than saveAs(), which
        // fails if the originating page has since navigated or closed.
        const source = await download.path().catch(() => null);
        if (source) {
          fs.copyFileSync(source, destPath);
          return true;
        }
        const ok = await download
          .saveAs(destPath)
          .then(() => true)
          .catch(() => false);
        return ok;
      }
      await sleep(250);
    }
    return false;
  }

  async downloadAsset(tileIndex, destPath, { selector }) {
    const start = this.downloads.length;
    const tile = this.page.locator(selector).nth(tileIndex);
    await tile.scrollIntoViewIfNeeded().catch(() => {});
    await tile.hover().catch(() => {});
    await sleep(300);

    const menu = await this.selectors.find(tile, 'assetMenuButton', { timeout: 2500, required: false });
    if (menu) {
      await menu.locator.click().catch(() => {});
      const item = await this.selectors.find(this.page, 'downloadMenuItem', {
        timeout: 4000,
        required: false,
      });
      if (item) {
        await item.locator.click().catch(() => {});
        if (await this.awaitDownload(start, destPath)) return { method: 'menu' };
      }
      await this.page.keyboard.press('Escape').catch(() => {});
    }

    await tile.click().catch(() => {});
    await sleep(1500);
    await this.page.keyboard.press('Control+D').catch(() => {});
    if (await this.awaitDownload(start, destPath)) {
      await this.page.keyboard.press('Escape').catch(() => {});
      return { method: 'shortcut' };
    }
    await this.page.keyboard.press('Escape').catch(() => {});
    return { method: null };
  }

  /**
   * Non-destructive fallback: the tile's <img> points at a signed CDN URL that
   * the browser context can fetch with its own cookies. No UI interaction, so
   * it cannot disturb the page.
   */
  async fetchAssetBytes(tileIndex, { selector }) {
    const src = await this.page
      .locator(selector)
      .nth(tileIndex)
      .evaluate((node) => {
        const img = node.tagName === 'IMG' ? node : node.querySelector('img');
        return img ? img.currentSrc || img.getAttribute('src') || '' : '';
      })
      .catch(() => '');
    if (!src || !/^https?:/i.test(src)) return null;
    const response = await this.context.request.get(src).catch(() => null);
    if (!response || !response.ok()) return null;
    const body = await response.body().catch(() => null);
    return body && body.length > 0 ? body : null;
  }

  /**
   * Re-encode an image as PNG using the browser's own canvas, so no image library
   * is needed. Flow only exports JPEG, but jobs routinely ask for .png.
   * Returns false (leaving the caller to keep the original) on any failure.
   */
  async convertToPng(inputPath, outputPath) {
    const bytes = fs.readFileSync(inputPath);
    const mime = mimeForExtension(sniffImageExtension(inputPath));
    const dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;

    const base64 = await this.page
      .evaluate(async (url) => {
        const image = new Image();
        image.src = url;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        return canvas.toDataURL('image/png').split(',')[1] ?? '';
      }, dataUrl)
      .catch(() => '');

    if (!base64) return false;
    const png = Buffer.from(base64, 'base64');
    // A valid PNG always starts with this signature.
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return false;
    fs.writeFileSync(outputPath, png);
    return true;
  }

  // ------------------------------------------------------------------ debug

  async dumpDebug(tag, dirs) {
    const base = path.join(dirs.debugDir, `${slugify(tag)}-${timestampSlug()}`);
    ensureParent(`${base}.png`);
    await this.page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => {});
    const html = await this.page.content().catch(() => '');
    fs.writeFileSync(`${base}.html`, html, 'utf8');
    return { screenshot: `${base}.png`, html: `${base}.html` };
  }
}
