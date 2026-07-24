/**
 * Wand Menu Module
 *
 * Registers an "Auto Illustrator: Generate for last message" icon into
 * SillyTavern's extension wand menu (`#extensionsMenu`). The icon appears
 * only when both:
 *   - `settings.enabled` is true
 *   - `settings.promptGenerationMode` is `'independent-api'`
 * Otherwise the icon is removed from the DOM (not just hidden).
 *
 * Clicking the icon runs the Independent-API pipeline against the last
 * assistant message via `runIndependentPipelineForMessage` — the same
 * pipeline the automatic MESSAGE_RECEIVED path uses.
 *
 * Edge cases surface as `toastr.warning` toasts (streaming active, no
 * assistant message, empty message text). No silent fallbacks.
 */

import {createLogger} from './logger';
import {t} from './i18n';
import {sessionManager} from './session_manager';
import {isIndependentApiMode} from './mode_utils';
import {runIndependentPipelineForMessage} from './message_handler';
import {loadSettings} from './settings';

const logger = createLogger('WandMenu');

const WAND_BUTTON_ID = 'auto_illustrator_wand_button';
const EXTENSIONS_MENU_ID = 'extensionsMenu';

/**
 * Idempotent add/remove of the wand icon based on current settings.
 *
 * Safe to call:
 *   - during initial extension load (once the DOM is ready)
 *   - after every settings save
 *
 * Repeated calls with the same settings are no-ops (DOM presence is
 * checked before every mutation).
 */
export function syncWandMenuVisibility(
  settings: AutoIllustratorSettings
): void {
  const shouldShow =
    settings.enabled && isIndependentApiMode(settings.promptGenerationMode);
  const existing = document.getElementById(WAND_BUTTON_ID);

  if (shouldShow && !existing) {
    registerWandButton();
  } else if (!shouldShow && existing) {
    existing.remove();
    logger.info(
      'Wand button removed (extension disabled or not in independent-API mode)'
    );
  }
}

function registerWandButton(): void {
  const container = document.getElementById(EXTENSIONS_MENU_ID);
  if (!container) {
    // The wand menu DOM is created by SillyTavern before extension
    // `init()` runs, so this should never fire during normal boot.
    // If it does, surface it — indicates a load-order regression.
    logger.warn(
      `#${EXTENSIONS_MENU_ID} not found in DOM; wand button not registered`
    );
    return;
  }

  const btn = document.createElement('div');
  btn.id = WAND_BUTTON_ID;
  btn.classList.add('list-group-item', 'flex-container', 'flexGap5');

  const icon = document.createElement('div');
  icon.classList.add(
    'fa-solid',
    'fa-wand-magic-sparkles',
    'extensionsMenuExtensionButton'
  );

  const label = document.createElement('span');
  label.textContent = t('wand.generateForLastAssistant');

  btn.appendChild(icon);
  btn.appendChild(label);
  btn.addEventListener('click', handleWandClick);
  container.appendChild(btn);

  logger.info('Wand button registered');
}

/**
 * Click handler: validates preconditions, then hands off to the shared
 * Independent-API pipeline. All failure modes surface as toast warnings —
 * the button never silently does nothing.
 */
async function handleWandClick(): Promise<void> {
  const context = SillyTavern.getContext();

  // Streaming guard: don't stomp on an in-flight session.
  if (sessionManager.isActive()) {
    toastr.warning(t('toast.wandBlockedStreaming'), t('extensionName'), {
      timeOut: 4000,
    });
    return;
  }

  // Find the last assistant message.
  const messageId = findLastAssistantMessageId(context);
  if (messageId === -1) {
    toastr.warning(t('toast.wandNoAssistantMessage'), t('extensionName'), {
      timeOut: 4000,
    });
    return;
  }

  // Empty guard: surface as toast (F1 also short-circuits at the service
  // layer, but the toast tells the user *why* nothing happened).
  const message = context.chat?.[messageId];
  if (!message?.mes || message.mes.trim() === '') {
    toastr.warning(t('toast.wandEmptyMessage'), t('extensionName'), {
      timeOut: 4000,
    });
    return;
  }

  // Read the freshest settings straight from context (in case the user
  // just changed them). loadSettings is the single source of truth for
  // how the plugin materialises its settings from `context.extensionSettings`.
  const settings = loadSettings(context);

  logger.info(`Wand triggered for message ${messageId}`);
  toastr.info(t('toast.wandStarted'), t('extensionName'), {timeOut: 3000});

  try {
    await runIndependentPipelineForMessage(messageId, context, settings);
    toastr.success(t('toast.wandComplete'), t('extensionName'), {
      timeOut: 3000,
    });
  } catch (err) {
    logger.error('Wand manual trigger failed', err);
    toastr.error(
      t('toast.wandFailed', {error: String(err)}),
      t('extensionName')
    );
  }
}

/**
 * Walks the chat backwards to find the last assistant message
 * (not user, not system). Returns `-1` if none exists.
 */
export function findLastAssistantMessageId(
  context: SillyTavernContext
): number {
  const chat = context.chat ?? [];
  for (let i = chat.length - 1; i >= 0; i--) {
    const m = chat[i];
    if (m && !m.is_user && !m.is_system) return i;
  }
  return -1;
}
