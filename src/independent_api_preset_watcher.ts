/**
 * Independent-API preset list watcher
 *
 * Keeps the Independent-API mode's Connection Profile and Chat Completion
 * Preset selects in sync with Luker/SillyTavern's global lists. Without
 * this, the selects only repopulate when the settings panel is reopened,
 * so presets created/renamed/deleted elsewhere would not appear until a
 * page refresh.
 *
 * Mirrors the subscription pattern used by Luker's built-in plugins
 * (memory-graph, completion-preset-assistant).
 */

import {createLogger} from './logger';

const logger = createLogger('IndependentApiPresetWatcher');

/** OpenAI chat-completion preset list events (payload carries apiId/collection). */
const OPENAI_PRESET_EVENTS = [
  'PRESET_CHANGED',
  'PRESET_RENAMED',
  'PRESET_DELETED',
] as const;

/** Luker connection-manager profile list events. */
const CONNECTION_PROFILE_EVENTS = [
  'CONNECTION_PROFILE_LOADED',
  'CONNECTION_PROFILE_CREATED',
  'CONNECTION_PROFILE_DELETED',
  'CONNECTION_PROFILE_UPDATED',
] as const;

interface PresetEvent {
  collection?: string;
  apiId?: string;
}

/**
 * OpenAI preset events are emitted for every API collection; only refresh
 * for the OpenAI one, since that is what the chat-completion select lists.
 */
function isOpenAiPresetEvent(event: PresetEvent | undefined): boolean {
  const collection = String(event?.collection || event?.apiId || '').trim();
  return collection === 'openai';
}

/**
 * Subscribe to global preset / connection-profile list changes and invoke
 * `onListChanged` whenever the Independent-API selects need repopulating.
 *
 * @param context - SillyTavern context
 * @param onListChanged - Called when a relevant list has changed
 */
export function registerIndependentApiPresetWatcher(
  context: SillyTavernContext,
  onListChanged: () => void
): void {
  if (!context?.eventSource || !context?.eventTypes) {
    logger.warn(
      'Event system unavailable; independent-API preset lists will not auto-refresh'
    );
    return;
  }

  for (const name of OPENAI_PRESET_EVENTS) {
    const eventName = context.eventTypes[name];
    if (!eventName) continue;
    context.eventSource.on(eventName, (event: PresetEvent | undefined) => {
      if (isOpenAiPresetEvent(event)) onListChanged();
    });
  }

  for (const name of CONNECTION_PROFILE_EVENTS) {
    const eventName = context.eventTypes[name];
    if (!eventName) continue;
    context.eventSource.on(eventName, () => onListChanged());
  }

  logger.info('Independent-API preset list watcher registered');
}
