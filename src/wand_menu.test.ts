/**
 * Tests for Wand Menu Module
 */

import {describe, it, expect, beforeEach, vi, afterEach} from 'vitest';
import {syncWandMenuVisibility, findLastAssistantMessageId} from './wand_menu';

// Mock dependencies
vi.mock('./logger', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('./i18n', () => ({
  t: (key: string, replacements?: Record<string, string | number>) => {
    if (!replacements) return key;
    // Simple mock: append replacements for debug clarity
    return `${key} ${JSON.stringify(replacements)}`;
  },
}));

vi.mock('./session_manager', () => ({
  sessionManager: {
    isActive: vi.fn(() => false),
  },
}));

vi.mock('./mode_utils', () => ({
  isIndependentApiMode: (mode: string) =>
    mode === 'independent-api' || mode === 'llm-post',
}));

vi.mock('./message_handler', () => ({
  runIndependentPipelineForMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./settings', () => ({
  loadSettings: vi.fn(() => ({
    enabled: true,
    promptGenerationMode: 'independent-api',
  })),
}));

// Globals
(global as unknown as {SillyTavern: unknown}).SillyTavern = {
  getContext: vi.fn(),
};

(global as unknown as {toastr: unknown}).toastr = {
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
};

const WAND_BUTTON_ID = 'auto_illustrator_wand_button';
const EXTENSIONS_MENU_ID = 'extensionsMenu';

describe('wand_menu', () => {
  beforeEach(() => {
    // Fresh DOM per test
    document.body.innerHTML = `<div id="${EXTENSIONS_MENU_ID}"></div>`;
    vi.clearAllMocks();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('syncWandMenuVisibility', () => {
    it('registers the wand button when enabled and in independent-API mode', () => {
      syncWandMenuVisibility({
        enabled: true,
        promptGenerationMode: 'independent-api',
      } as AutoIllustratorSettings);

      const btn = document.getElementById(WAND_BUTTON_ID);
      expect(btn).not.toBeNull();
      expect(btn?.parentElement?.id).toBe(EXTENSIONS_MENU_ID);
    });

    it('does not register the button in shared-API mode', () => {
      syncWandMenuVisibility({
        enabled: true,
        promptGenerationMode: 'shared-api',
      } as AutoIllustratorSettings);

      expect(document.getElementById(WAND_BUTTON_ID)).toBeNull();
    });

    it('does not register the button when the extension is disabled', () => {
      syncWandMenuVisibility({
        enabled: false,
        promptGenerationMode: 'independent-api',
      } as AutoIllustratorSettings);

      expect(document.getElementById(WAND_BUTTON_ID)).toBeNull();
    });

    it('removes the button when mode toggles from independent to shared', () => {
      syncWandMenuVisibility({
        enabled: true,
        promptGenerationMode: 'independent-api',
      } as AutoIllustratorSettings);
      expect(document.getElementById(WAND_BUTTON_ID)).not.toBeNull();

      syncWandMenuVisibility({
        enabled: true,
        promptGenerationMode: 'shared-api',
      } as AutoIllustratorSettings);
      expect(document.getElementById(WAND_BUTTON_ID)).toBeNull();
    });

    it('removes the button when extension is disabled after registration', () => {
      syncWandMenuVisibility({
        enabled: true,
        promptGenerationMode: 'independent-api',
      } as AutoIllustratorSettings);
      expect(document.getElementById(WAND_BUTTON_ID)).not.toBeNull();

      syncWandMenuVisibility({
        enabled: false,
        promptGenerationMode: 'independent-api',
      } as AutoIllustratorSettings);
      expect(document.getElementById(WAND_BUTTON_ID)).toBeNull();
    });

    it('is idempotent — repeated calls with the same settings do not duplicate the button', () => {
      const settings = {
        enabled: true,
        promptGenerationMode: 'independent-api',
      } as AutoIllustratorSettings;

      syncWandMenuVisibility(settings);
      syncWandMenuVisibility(settings);
      syncWandMenuVisibility(settings);

      const all = document.querySelectorAll(`#${WAND_BUTTON_ID}`);
      expect(all.length).toBe(1);
    });

    it('is a no-op when #extensionsMenu is not in the DOM', () => {
      document.body.innerHTML = ''; // no menu container at all

      // Must not throw
      syncWandMenuVisibility({
        enabled: true,
        promptGenerationMode: 'independent-api',
      } as AutoIllustratorSettings);

      expect(document.getElementById(WAND_BUTTON_ID)).toBeNull();
    });
  });

  describe('button click behaviour', () => {
    let mockContext: SillyTavernContext;
    let sessionManagerModule: {
      sessionManager: {isActive: ReturnType<typeof vi.fn>};
    };
    let messageHandlerModule: {
      runIndependentPipelineForMessage: ReturnType<typeof vi.fn>;
    };
    let settingsModule: {loadSettings: ReturnType<typeof vi.fn>};

    beforeEach(async () => {
      mockContext = {
        chat: [
          {mes: 'user asks a question', is_user: true, name: 'User'},
          {mes: 'assistant replies at length', is_user: false, name: 'AI'},
        ],
      } as unknown as SillyTavernContext;

      (
        global as unknown as {
          SillyTavern: {getContext: ReturnType<typeof vi.fn>};
        }
      ).SillyTavern.getContext = vi.fn().mockReturnValue(mockContext);

      sessionManagerModule = (await import('./session_manager')) as unknown as {
        sessionManager: {isActive: ReturnType<typeof vi.fn>};
      };
      messageHandlerModule = (await import('./message_handler')) as unknown as {
        runIndependentPipelineForMessage: ReturnType<typeof vi.fn>;
      };
      settingsModule = (await import('./settings')) as unknown as {
        loadSettings: ReturnType<typeof vi.fn>;
      };

      // Reset mock implementations (clearAllMocks only clears call history,
      // not the return values set by prior tests via mockReturnValue).
      sessionManagerModule.sessionManager.isActive.mockReturnValue(false);
      messageHandlerModule.runIndependentPipelineForMessage.mockResolvedValue(
        undefined
      );
      settingsModule.loadSettings.mockReturnValue({
        enabled: true,
        promptGenerationMode: 'independent-api',
      });

      // Register the button so we can click it
      syncWandMenuVisibility({
        enabled: true,
        promptGenerationMode: 'independent-api',
      } as AutoIllustratorSettings);
    });

    async function clickWandButton(): Promise<void> {
      const btn = document.getElementById(WAND_BUTTON_ID);
      expect(btn).not.toBeNull();
      btn!.click();
      // Wait for the async click handler to settle
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    it('shows a warning and does not run pipeline when streaming is active', async () => {
      sessionManagerModule.sessionManager.isActive.mockReturnValue(true);

      await clickWandButton();

      expect(toastr.warning).toHaveBeenCalledWith(
        'toast.wandBlockedStreaming',
        expect.anything(),
        expect.anything()
      );
      expect(
        messageHandlerModule.runIndependentPipelineForMessage
      ).not.toHaveBeenCalled();
    });

    it('shows a warning when there is no assistant message in chat', async () => {
      (mockContext as {chat: unknown[]}).chat = [
        {mes: 'user only', is_user: true, name: 'User'},
      ];

      await clickWandButton();

      expect(toastr.warning).toHaveBeenCalledWith(
        'toast.wandNoAssistantMessage',
        expect.anything(),
        expect.anything()
      );
      expect(
        messageHandlerModule.runIndependentPipelineForMessage
      ).not.toHaveBeenCalled();
    });

    it('shows a warning when the last assistant message is empty', async () => {
      (mockContext as {chat: unknown[]}).chat = [
        {mes: 'user asks', is_user: true, name: 'User'},
        {mes: '', is_user: false, name: 'AI'},
      ];

      await clickWandButton();

      expect(toastr.warning).toHaveBeenCalledWith(
        'toast.wandEmptyMessage',
        expect.anything(),
        expect.anything()
      );
      expect(
        messageHandlerModule.runIndependentPipelineForMessage
      ).not.toHaveBeenCalled();
    });

    it('shows a warning when the last assistant message is whitespace-only', async () => {
      (mockContext as {chat: unknown[]}).chat = [
        {mes: '   \n\t  ', is_user: false, name: 'AI'},
      ];

      await clickWandButton();

      expect(toastr.warning).toHaveBeenCalledWith(
        'toast.wandEmptyMessage',
        expect.anything(),
        expect.anything()
      );
      expect(
        messageHandlerModule.runIndependentPipelineForMessage
      ).not.toHaveBeenCalled();
    });

    it('runs the pipeline against the last assistant message when everything is valid', async () => {
      await clickWandButton();

      expect(
        messageHandlerModule.runIndependentPipelineForMessage
      ).toHaveBeenCalledTimes(1);
      // messageId=1 is the assistant message in our fixture chat
      const [messageId, ctxArg, settingsArg] =
        messageHandlerModule.runIndependentPipelineForMessage.mock.calls[0];
      expect(messageId).toBe(1);
      expect(ctxArg).toBe(mockContext);
      expect(settingsArg.enabled).toBe(true);

      expect(toastr.success).toHaveBeenCalledWith(
        'toast.wandComplete',
        expect.anything(),
        expect.anything()
      );
    });

    it('picks the LAST assistant message when there are multiple', async () => {
      (mockContext as {chat: unknown[]}).chat = [
        {mes: 'user 1', is_user: true, name: 'User'},
        {mes: 'ai reply 1', is_user: false, name: 'AI'},
        {mes: 'user 2', is_user: true, name: 'User'},
        {mes: 'ai reply 2 (target)', is_user: false, name: 'AI'},
      ];

      await clickWandButton();

      const [messageId] =
        messageHandlerModule.runIndependentPipelineForMessage.mock.calls[0];
      expect(messageId).toBe(3);
    });

    it('skips system messages when finding the last assistant', async () => {
      (mockContext as {chat: unknown[]}).chat = [
        {mes: 'ai reply', is_user: false, name: 'AI'},
        {mes: 'system note', is_user: false, is_system: true, name: 'System'},
      ];

      await clickWandButton();

      const [messageId] =
        messageHandlerModule.runIndependentPipelineForMessage.mock.calls[0];
      expect(messageId).toBe(0); // the AI reply, not the system note
    });

    it('shows an error toast when the pipeline throws', async () => {
      messageHandlerModule.runIndependentPipelineForMessage.mockRejectedValueOnce(
        new Error('boom')
      );

      await clickWandButton();

      expect(toastr.error).toHaveBeenCalledWith(
        expect.stringContaining('toast.wandFailed'),
        expect.anything()
      );
    });
  });

  describe('findLastAssistantMessageId', () => {
    it('returns -1 when the chat is empty', () => {
      const ctx = {chat: []} as unknown as SillyTavernContext;
      expect(findLastAssistantMessageId(ctx)).toBe(-1);
    });

    it('returns -1 when the chat has no assistant messages', () => {
      const ctx = {
        chat: [
          {mes: 'user 1', is_user: true},
          {mes: 'system note', is_system: true, is_user: false},
        ],
      } as unknown as SillyTavernContext;
      expect(findLastAssistantMessageId(ctx)).toBe(-1);
    });

    it('returns the index of the sole assistant message', () => {
      const ctx = {
        chat: [
          {mes: 'user', is_user: true},
          {mes: 'ai', is_user: false},
        ],
      } as unknown as SillyTavernContext;
      expect(findLastAssistantMessageId(ctx)).toBe(1);
    });

    it('returns the index of the LAST assistant message when multiple exist', () => {
      const ctx = {
        chat: [
          {mes: 'ai 1', is_user: false},
          {mes: 'user 1', is_user: true},
          {mes: 'ai 2', is_user: false},
          {mes: 'user 2', is_user: true},
          {mes: 'ai 3', is_user: false},
        ],
      } as unknown as SillyTavernContext;
      expect(findLastAssistantMessageId(ctx)).toBe(4);
    });

    it('skips system messages when searching backwards', () => {
      const ctx = {
        chat: [
          {mes: 'ai', is_user: false},
          {mes: 'sys', is_user: false, is_system: true},
        ],
      } as unknown as SillyTavernContext;
      expect(findLastAssistantMessageId(ctx)).toBe(0);
    });

    it('handles undefined chat gracefully', () => {
      const ctx = {} as unknown as SillyTavernContext;
      expect(findLastAssistantMessageId(ctx)).toBe(-1);
    });
  });
});
