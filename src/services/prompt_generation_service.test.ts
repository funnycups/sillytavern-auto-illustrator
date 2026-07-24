/**
 * Tests for Prompt Generation Service
 */

import {describe, it, expect, vi, beforeEach} from 'vitest';
import {generatePromptsForMessage} from './prompt_generation_service';

describe('prompt_generation_service', () => {
  let mockContext: SillyTavernContext;
  let mockSettings: AutoIllustratorSettings;

  beforeEach(() => {
    // Create mock context with generateTask (Luker API)
    mockContext = {
      generateTask: vi.fn(),
    } as unknown as SillyTavernContext;

    // Create mock settings
    mockSettings = {
      maxPromptsPerMessage: 5,
      promptGenerationMode: 'llm-post',
    } as AutoIllustratorSettings;
  });

  describe('generatePromptsForMessage', () => {
    describe('empty-message short-circuit', () => {
      it('returns [] and does not call generateTask for empty string', async () => {
        const result = await generatePromptsForMessage(
          '',
          mockContext,
          mockSettings
        );

        expect(result).toEqual([]);
        expect(mockContext.generateTask).not.toHaveBeenCalled();
      });

      it('returns [] and does not call generateTask for whitespace-only string', async () => {
        const result = await generatePromptsForMessage(
          '   \n\t  \r\n',
          mockContext,
          mockSettings
        );

        expect(result).toEqual([]);
        expect(mockContext.generateTask).not.toHaveBeenCalled();
      });

      it('returns [] and does not call generateTask when messageText is undefined', async () => {
        const result = await generatePromptsForMessage(
          undefined as unknown as string,
          mockContext,
          mockSettings
        );

        expect(result).toEqual([]);
        expect(mockContext.generateTask).not.toHaveBeenCalled();
      });

      it('empty-message short-circuit runs before Luker-availability check', async () => {
        // Give a context without generateTask — normally this would throw,
        // but the empty-message guard runs first and returns [].
        const bareContext = {} as SillyTavernContext;

        const result = await generatePromptsForMessage(
          '',
          bareContext,
          mockSettings
        );

        expect(result).toEqual([]);
      });
    });

    describe('memory-graph recall injection', () => {
      // Helper: capture the system prompt sent to generateTask so we can
      // inspect what the {{MEMORY_RECALL}} placeholder collapsed to.
      function lastSystemPrompt(): string {
        const call = vi.mocked(mockContext.generateTask!).mock.calls[0];
        const taskMessages = (call?.[0] as {taskMessages: Array<{role: string; content: string}>})
          .taskMessages;
        const system = taskMessages.find(m => m.role === 'system');
        return system?.content ?? '';
      }

      const emptyLlmResponse = '---END---';

      beforeEach(() => {
        vi.mocked(mockContext.generateTask!).mockResolvedValue({
          assistantText: emptyLlmResponse,
        });
      });

      it('collapses {{MEMORY_RECALL}} to empty when getExtensionApi is missing (standard SillyTavern)', async () => {
        // Bare context: no getExtensionApi field at all
        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        const sys = lastSystemPrompt();
        expect(sys).not.toContain('{{MEMORY_RECALL}}');
        expect(sys).not.toContain('## Memory Recall Context');
      });

      it('collapses {{MEMORY_RECALL}} to empty when memory-graph extension is not registered', async () => {
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue(undefined);

        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        const sys = lastSystemPrompt();
        expect(sys).not.toContain('## Memory Recall Context');
      });

      it('collapses {{MEMORY_RECALL}} to empty when getLastRecallProjection is absent on the api', async () => {
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue({/* no methods */});

        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        expect(lastSystemPrompt()).not.toContain('## Memory Recall Context');
      });

      it('collapses {{MEMORY_RECALL}} to empty when getLastRecallProjection returns null', async () => {
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue({
            getLastRecallProjection: vi.fn().mockResolvedValue(null),
          });

        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        expect(lastSystemPrompt()).not.toContain('## Memory Recall Context');
      });

      it('collapses {{MEMORY_RECALL}} to empty and warns when getLastRecallProjection throws', async () => {
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue({
            getLastRecallProjection: vi
              .fn()
              .mockRejectedValue(new Error('luker api broke')),
          });

        // Should not throw — the exception is caught and treated as "no data"
        await expect(
          generatePromptsForMessage('some story text', mockContext, mockSettings)
        ).resolves.toBeDefined();

        expect(lastSystemPrompt()).not.toContain('## Memory Recall Context');
      });

      it('collapses {{MEMORY_RECALL}} to empty when both packets are empty strings', async () => {
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue({
            getLastRecallProjection: vi.fn().mockResolvedValue({
              at: 1_700_000_000_000,
              blocks: {corePacket: '   ', focusPacket: ''},
            }),
          });

        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        expect(lastSystemPrompt()).not.toContain('## Memory Recall Context');
      });

      it('renders only the Always-Injected sub-block when only corePacket is present', async () => {
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue({
            getLastRecallProjection: vi.fn().mockResolvedValue({
              at: 1_700_000_000_000,
              blocks: {
                corePacket: '| name | value |\n|---|---|\n| A | 1 |',
                focusPacket: '',
              },
            }),
          });

        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        const sys = lastSystemPrompt();
        expect(sys).toContain('## Memory Recall Context');
        expect(sys).toContain('### Always-Injected');
        expect(sys).toContain('| A | 1 |');
        expect(sys).not.toContain('### Recall-Selected');
      });

      it('renders only the Recall-Selected sub-block when only focusPacket is present', async () => {
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue({
            getLastRecallProjection: vi.fn().mockResolvedValue({
              at: 1_700_000_000_000,
              blocks: {
                corePacket: '',
                focusPacket: '### Recall Table\n| id | note |\n|---|---|\n| n1 | hi |',
              },
            }),
          });

        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        const sys = lastSystemPrompt();
        expect(sys).toContain('## Memory Recall Context');
        expect(sys).toContain('### Recall-Selected');
        expect(sys).toContain('| n1 | hi |');
        expect(sys).not.toContain('### Always-Injected');
      });

      it('renders both sub-blocks in order when both packets are present', async () => {
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue({
            getLastRecallProjection: vi.fn().mockResolvedValue({
              at: 1_700_000_000_000,
              blocks: {
                corePacket: 'CORE_CONTENT_MARKER',
                focusPacket: 'FOCUS_CONTENT_MARKER',
              },
            }),
          });

        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        const sys = lastSystemPrompt();
        const coreIdx = sys.indexOf('### Always-Injected');
        const focusIdx = sys.indexOf('### Recall-Selected');
        expect(coreIdx).toBeGreaterThan(-1);
        expect(focusIdx).toBeGreaterThan(coreIdx);
        expect(sys).toContain('CORE_CONTENT_MARKER');
        expect(sys).toContain('FOCUS_CONTENT_MARKER');
      });

      it('places the Memory Recall Context block before the ## Instructions section', async () => {
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue({
            getLastRecallProjection: vi.fn().mockResolvedValue({
              at: 1_700_000_000_000,
              blocks: {corePacket: 'CORE', focusPacket: 'FOCUS'},
            }),
          });

        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        const sys = lastSystemPrompt();
        const recallIdx = sys.indexOf('## Memory Recall Context');
        const instructionsIdx = sys.indexOf('## Instructions');
        expect(recallIdx).toBeGreaterThan(-1);
        expect(instructionsIdx).toBeGreaterThan(-1);
        expect(recallIdx).toBeLessThan(instructionsIdx);
      });

      it('passes the SillyTavern context through to getLastRecallProjection', async () => {
        const getLastRecallProjection = vi.fn().mockResolvedValue(null);
        (mockContext as unknown as {getExtensionApi: (n: string) => unknown}).getExtensionApi =
          vi.fn().mockReturnValue({getLastRecallProjection});

        await generatePromptsForMessage(
          'some story text',
          mockContext,
          mockSettings
        );

        expect(getLastRecallProjection).toHaveBeenCalledWith(mockContext);
      });
    });

    it('should parse valid plain text response with single prompt', async () => {
      const messageText = 'She walked through the forest under the moonlight.';
      const llmResponse = `---PROMPT---
TEXT: 1girl, forest, moonlight, highly detailed
INSERT_AFTER: through the forest
INSERT_BEFORE: under the moonlight
REASONING: Key visual scene
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('1girl, forest, moonlight, highly detailed');
      expect(result[0].insertAfter).toBe('through the forest');
      expect(result[0].insertBefore).toBe('under the moonlight');
    });

    it('should parse valid plain text response with multiple prompts', async () => {
      const messageText = 'Complex scene with multiple events.';
      const llmResponse = `---PROMPT---
TEXT: first scene
INSERT_AFTER: event one
INSERT_BEFORE: event two
REASONING: First moment
---PROMPT---
TEXT: second scene
INSERT_AFTER: event two
INSERT_BEFORE: event three
REASONING: Second moment
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('first scene');
      expect(result[1].text).toBe('second scene');
    });

    it('should handle response with explanatory text before/after', async () => {
      const messageText = 'Test message.';
      const llmResponse = `Here are the prompts:
---PROMPT---
TEXT: test prompt
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Test scene
---END---
Hope this helps!`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('test prompt');
    });

    it('should return empty array when LLM returns no prompts', async () => {
      const messageText = 'No visual content here.';
      const llmResponse = '---END---';

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(0);
    });

    it('should return empty array on malformed response', async () => {
      const messageText = 'Test message.';
      const llmResponse = 'This is not a valid format at all';

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(0);
    });

    it('should return empty array when response missing prompts', async () => {
      const messageText = 'Test message.';
      const llmResponse = `Some text but no prompts
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(0);
    });

    it('should skip prompts with missing required fields', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: valid prompt
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Valid
---PROMPT---
TEXT: missing insertAfter
INSERT_BEFORE: message
REASONING: Invalid
---PROMPT---
TEXT: another valid
INSERT_AFTER: another
INSERT_BEFORE: test
REASONING: Valid too
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(2);
      expect(result[0].text).toBe('valid prompt');
      expect(result[1].text).toBe('another valid');
    });

    it('should skip prompts with empty fields', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: valid prompt
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Valid
---PROMPT---
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Missing TEXT field entirely
---PROMPT---
TEXT: another invalid
INSERT_AFTER: test
REASONING: Missing INSERT_BEFORE field
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('valid prompt');
    });

    it('should respect maxPromptsPerMessage limit', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: prompt1
INSERT_AFTER: a
INSERT_BEFORE: b
REASONING: First
---PROMPT---
TEXT: prompt2
INSERT_AFTER: c
INSERT_BEFORE: d
REASONING: Second
---PROMPT---
TEXT: prompt3
INSERT_AFTER: e
INSERT_BEFORE: f
REASONING: Third
---PROMPT---
TEXT: prompt4
INSERT_AFTER: g
INSERT_BEFORE: h
REASONING: Fourth
---PROMPT---
TEXT: prompt5
INSERT_AFTER: i
INSERT_BEFORE: j
REASONING: Fifth
---PROMPT---
TEXT: prompt6
INSERT_AFTER: k
INSERT_BEFORE: l
REASONING: Sixth (should be cut off)
---PROMPT---
TEXT: prompt7
INSERT_AFTER: m
INSERT_BEFORE: n
REASONING: Seventh (should be cut off)
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      // Settings has maxPromptsPerMessage = 5
      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(5);
      expect(result.map(p => p.text)).toEqual([
        'prompt1',
        'prompt2',
        'prompt3',
        'prompt4',
        'prompt5',
      ]);
    });

    it('should handle maxPromptsPerMessage limit of 1', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: prompt1
INSERT_AFTER: a
INSERT_BEFORE: b
REASONING: First
---PROMPT---
TEXT: prompt2
INSERT_AFTER: c
INSERT_BEFORE: d
REASONING: Second
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      mockSettings.maxPromptsPerMessage = 1;

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('prompt1');
    });

    it('should return empty array when generateRaw throws error', async () => {
      const messageText = 'Test message.';

      vi.mocked(mockContext.generateTask!).mockRejectedValue(
        new Error('LLM error')
      );

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(0);
    });

    it('should throw error when generateRaw is not available', async () => {
      const messageText = 'Test message.';
      const contextWithoutGenerateRaw = {} as SillyTavernContext;

      await expect(
        generatePromptsForMessage(
          messageText,
          contextWithoutGenerateRaw,
          mockSettings
        )
      ).rejects.toThrow('LLM generation not available');
    });

    it('should trim whitespace from prompt fields', async () => {
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT:    prompt with spaces
INSERT_AFTER:   before
INSERT_BEFORE:   after
REASONING:   reason
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('prompt with spaces');
      expect(result[0].insertAfter).toBe('before');
      expect(result[0].insertBefore).toBe('after');
    });

    it('should handle prompts with special characters', async () => {
      const messageText = 'Test message with "quotes" and special chars.';
      const llmResponse = `---PROMPT---
TEXT: prompt with "quotes" and $pecial chars
INSERT_AFTER: message with "quotes"
INSERT_BEFORE: and special
REASONING: Test special characters
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('prompt with "quotes" and $pecial chars');
      expect(result[0].insertAfter).toBe('message with "quotes"');
    });

    it('should handle Unicode characters in prompts', async () => {
      const messageText = '她走进花园。玫瑰盛开着。';
      const llmResponse = `---PROMPT---
TEXT: 1个女孩，花园，详细
INSERT_AFTER: 走进花园。
INSERT_BEFORE: 玫瑰盛开
REASONING: 中文测试
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('1个女孩，花园，详细');
      expect(result[0].insertAfter).toBe('走进花园。');
      expect(result[0].insertBefore).toBe('玫瑰盛开');
    });

    it('does not leak reasoning field into output even if LLM emits REASONING', async () => {
      // Contract: REASONING is no longer part of our output schema. If the
      // model still emits it (backward compat), the parser silently ignores
      // it and the returned suggestion object must not carry a `reasoning`
      // property.
      const messageText = 'Test message.';
      const llmResponse = `---PROMPT---
TEXT: test prompt
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: this line must not appear in the output object
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect('reasoning' in result[0]).toBe(false);
    });

    it('should handle markdown code blocks', async () => {
      const messageText = 'Test message.';
      const llmResponse = `\`\`\`
---PROMPT---
TEXT: test prompt
INSERT_AFTER: test
INSERT_BEFORE: message
REASONING: Test
---END---
\`\`\``;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('test prompt');
    });

    it('should handle newlines in field values', async () => {
      const messageText = 'Test\n\nmessage with newlines.';
      const llmResponse = `---PROMPT---
TEXT: test prompt
INSERT_AFTER: Test

INSERT_BEFORE: message with newlines
REASONING: Handles newlines naturally
---END---`;

      vi.mocked(mockContext.generateTask!).mockResolvedValue({
        assistantText: llmResponse,
      });

      const result = await generatePromptsForMessage(
        messageText,
        mockContext,
        mockSettings
      );

      expect(result).toHaveLength(1);
      expect(result[0].text).toBe('test prompt');
      // The regex captures only the first line for INSERT_AFTER/INSERT_BEFORE
      expect(result[0].insertAfter).toBe('Test');
      expect(result[0].insertBefore).toBe('message with newlines');
    });
  });
});
