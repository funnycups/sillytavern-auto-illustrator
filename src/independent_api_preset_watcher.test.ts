/**
 * Tests for the Independent-API preset list watcher
 */

import {describe, it, expect, vi, beforeEach} from 'vitest';
import {registerIndependentApiPresetWatcher} from './independent_api_preset_watcher';

type Handler = (...args: unknown[]) => void;

interface MockHarness {
  context: SillyTavernContext;
  on: ReturnType<typeof vi.fn>;
  handlers: Map<string, Handler[]>;
  fire: (eventName: string, ...args: unknown[]) => void;
}

function createHarness(): MockHarness {
  const handlers = new Map<string, Handler[]>();
  const on = vi.fn((event: string, cb: Handler) => {
    const list = handlers.get(event) ?? [];
    list.push(cb);
    handlers.set(event, list);
  });
  const eventSource = {
    on,
    once: vi.fn(),
    emit: vi.fn(),
  };
  const eventTypes = {
    PRESET_CHANGED: 'preset_changed',
    PRESET_RENAMED: 'preset_renamed',
    PRESET_DELETED: 'preset_deleted',
    CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
    CONNECTION_PROFILE_CREATED: 'connection_profile_created',
    CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
    CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
  };
  const context = {eventSource, eventTypes} as unknown as SillyTavernContext;

  return {
    context,
    on,
    handlers,
    fire: (eventName: string, ...args: unknown[]) => {
      for (const cb of handlers.get(eventName) ?? []) cb(...args);
    },
  };
}

describe('independent_api_preset_watcher', () => {
  let harness: MockHarness;
  let onChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    harness = createHarness();
    onChange = vi.fn();
  });

  it('subscribes to all preset and connection-profile list events', () => {
    registerIndependentApiPresetWatcher(harness.context, onChange);

    const subscribed = harness.on.mock.calls.map(call => call[0]);
    expect(subscribed).toEqual(
      expect.arrayContaining([
        'preset_changed',
        'preset_renamed',
        'preset_deleted',
        'connection_profile_loaded',
        'connection_profile_created',
        'connection_profile_deleted',
        'connection_profile_updated',
      ])
    );
  });

  it('refreshes on every connection-profile list event', () => {
    registerIndependentApiPresetWatcher(harness.context, onChange);

    for (const eventName of [
      'connection_profile_loaded',
      'connection_profile_created',
      'connection_profile_deleted',
      'connection_profile_updated',
    ]) {
      harness.fire(eventName, {name: 'some-profile'});
    }

    expect(onChange).toHaveBeenCalledTimes(4);
  });

  it('refreshes on openai preset change/rename/delete events', () => {
    registerIndependentApiPresetWatcher(harness.context, onChange);

    harness.fire('preset_changed', {apiId: 'openai', name: 'A'});
    harness.fire('preset_renamed', {
      apiId: 'openai',
      oldName: 'A',
      newName: 'B',
    });
    harness.fire('preset_deleted', {apiId: 'openai', name: 'B'});

    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it('accepts the collection field in addition to apiId', () => {
    registerIndependentApiPresetWatcher(harness.context, onChange);

    harness.fire('preset_changed', {collection: 'openai'});

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores preset events for other API collections', () => {
    registerIndependentApiPresetWatcher(harness.context, onChange);

    harness.fire('preset_changed', {apiId: 'novel'});
    harness.fire('preset_renamed', {apiId: 'kobold'});
    harness.fire('preset_deleted', {apiId: 'textgenerationwebui'});

    expect(onChange).not.toHaveBeenCalled();
  });

  it('skips event names that are absent from eventTypes', () => {
    const partialTypes = {
      PRESET_CHANGED: 'preset_changed',
    };
    const context = {
      eventSource: {on: harness.on, once: vi.fn(), emit: vi.fn()},
      eventTypes: partialTypes,
    } as unknown as SillyTavernContext;

    registerIndependentApiPresetWatcher(context, onChange);

    expect(harness.on).toHaveBeenCalledTimes(1);
    expect(harness.on).toHaveBeenCalledWith(
      'preset_changed',
      expect.any(Function)
    );
  });

  it('does not throw and registers nothing when the event system is unavailable', () => {
    const bareContext = {} as SillyTavernContext;

    expect(() =>
      registerIndependentApiPresetWatcher(bareContext, onChange)
    ).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});
