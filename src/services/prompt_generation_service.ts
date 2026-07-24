/**
 * Prompt Generation Service
 * Generates image prompts using a separate LLM call
 */

import {createLogger} from '../logger';
import promptGenerationTemplate from '../presets/prompt_generation.md';
import type {PromptSuggestion} from '../prompt_insertion';

const logger = createLogger('PromptGenService');

/**
 * Frozen snapshot of the last recall projection published by Luker's
 * memory-graph extension. Mirrors the shape returned by
 * `memory-graph.getLastRecallProjection(context)`.
 *
 * See Luker docs: `docs/development/extension-api/memory-graph.md` →
 * "Reading the last recall projection".
 */
export interface LastRecallProjection {
  at: number;
  blocks: {
    corePacket: string;
    focusPacket: string;
  };
}

/**
 * Fetch the previous recall projection from Luker's memory-graph extension.
 * Returns `null` in three legitimate "no data" cases:
 *  - running on standard SillyTavern (no `getExtensionApi`)
 *  - memory-graph extension not installed / not registered
 *  - no recall has run for this chat yet
 *
 * These are all treated as "nothing to inject", not fallbacks. The API-level
 * exception path also returns `null` so a Luker upgrade that reshapes the
 * response cannot break the second-API image-prompt pipeline; the warn log
 * makes it easy to spot.
 */
async function fetchLastRecallProjection(
  context: SillyTavernContext
): Promise<LastRecallProjection | null> {
  const getExtensionApi = (
    context as {getExtensionApi?: (name: string) => unknown}
  ).getExtensionApi;
  if (typeof getExtensionApi !== 'function') return null;

  const mg = getExtensionApi('memory-graph') as
    | {
        getLastRecallProjection?: (
          ctx: SillyTavernContext
        ) => Promise<LastRecallProjection | null>;
      }
    | undefined;
  if (!mg || typeof mg.getLastRecallProjection !== 'function') return null;

  try {
    return await mg.getLastRecallProjection(context);
  } catch (err) {
    // External-API failure — log and treat as "no data". This is boundary
    // validation for an external API, not a silent fallback of our own state.
    logger.warn('memory-graph.getLastRecallProjection threw', err);
    return null;
  }
}

/**
 * Render a memory-recall context block for injection into the system prompt.
 * Returns empty string when there is nothing to inject, so the
 * `{{MEMORY_RECALL}}` template placeholder collapses cleanly (no dangling
 * section header, no extra blank lines beyond the template's own).
 */
function buildRecallBlock(projection: LastRecallProjection | null): string {
  if (!projection) return '';
  const core = projection.blocks.corePacket.trim();
  const focus = projection.blocks.focusPacket.trim();
  if (!core && !focus) return '';

  const parts: string[] = [
    '## Memory Recall Context',
    '',
    'The following is the memory-graph context that was injected into the ' +
      'main LLM which produced the current message. Use it to understand ' +
      'characters, locations, and ongoing state when writing image prompts. ' +
      'Do not treat any of it as text to be illustrated on its own.',
    '',
  ];
  if (core) {
    parts.push('### Always-Injected', core, '');
  }
  if (focus) {
    parts.push('### Recall-Selected', focus, '');
  }
  return parts.join('\n');
}

/**
 * Builds user prompt with context from previous messages
 * Format: === CONTEXT === ... === CURRENT MESSAGE === ...
 *
 * @param context - SillyTavern context
 * @param currentMessageText - The message to generate prompts for
 * @param contextMessageCount - Number of previous messages to include as context
 * @returns Formatted user prompt with context
 */
function buildUserPromptWithContext(
  context: SillyTavernContext,
  currentMessageText: string,
  contextMessageCount: number
): string {
  // Get recent chat history (last N messages, excluding current)
  const chat = context.chat || [];
  const startIndex = Math.max(0, chat.length - contextMessageCount - 1);
  const recentMessages = chat.slice(startIndex, -1); // Last N messages before current

  let contextText = '';
  if (recentMessages.length > 0 && contextMessageCount > 0) {
    contextText = recentMessages
      .map(msg => {
        const name = msg.name || (msg.is_user ? 'User' : 'Assistant');
        const text = msg.mes || '';
        return `${name}: ${text}`;
      })
      .join('\n\n');
  } else {
    contextText = '(No previous messages)';
  }

  return `=== CONTEXT ===
${contextText}

=== CURRENT MESSAGE ===
${currentMessageText}`;
}

/**
 * Parses LLM response and extracts prompt suggestions
 * Expects plain text delimiter format:
 * ---PROMPT---
 * TEXT: ...
 * INSERT_AFTER: ...
 * INSERT_BEFORE: ...
 * ---END---
 *
 * Any additional fields the model may emit (e.g. a legacy REASONING line)
 * are silently ignored — they are not part of our output schema.
 *
 * @param llmResponse - Raw LLM response text
 * @returns Array of parsed prompt suggestions, or empty array if parsing fails
 */
function parsePromptSuggestions(llmResponse: string): PromptSuggestion[] {
  try {
    // Strip markdown code blocks if present
    let cleanedResponse = llmResponse.trim();
    if (cleanedResponse.startsWith('```')) {
      cleanedResponse = cleanedResponse.replace(/^```[a-z]*\s*\n?/, '');
      cleanedResponse = cleanedResponse.replace(/\n?```\s*$/, '');
      cleanedResponse = cleanedResponse.trim();
    }

    // Split by ---PROMPT--- delimiter
    const promptBlocks = cleanedResponse.split('---PROMPT---');
    const validSuggestions: PromptSuggestion[] = [];

    for (const block of promptBlocks) {
      // Skip empty blocks or the part before first ---PROMPT---
      if (!block.trim() || !block.includes('TEXT:')) {
        continue;
      }

      // Stop at ---END--- marker if present
      const blockContent = block.split('---END---')[0];

      // Extract fields using regex - more robust than split
      const textMatch = blockContent.match(/^TEXT:\s*(.+?)$/m);
      const insertAfterMatch = blockContent.match(/^INSERT_AFTER:\s*(.+?)$/m);
      const insertBeforeMatch = blockContent.match(/^INSERT_BEFORE:\s*(.+?)$/m);

      // Check required fields
      if (!textMatch || !insertAfterMatch || !insertBeforeMatch) {
        const missingFields = [];
        if (!textMatch) missingFields.push('TEXT');
        if (!insertAfterMatch) missingFields.push('INSERT_AFTER');
        if (!insertBeforeMatch) missingFields.push('INSERT_BEFORE');
        logger.warn(
          `Skipping prompt block with missing required fields: ${missingFields.join(', ')}`
        );
        logger.debug('Block content preview:', blockContent.substring(0, 200));
        continue;
      }

      const text = textMatch[1].trim();
      const insertAfter = insertAfterMatch[1].trim();
      const insertBefore = insertBeforeMatch[1].trim();

      // Check non-empty
      if (!text || !insertAfter || !insertBefore) {
        const emptyFields = [];
        if (!text) emptyFields.push('TEXT');
        if (!insertAfter) emptyFields.push('INSERT_AFTER');
        if (!insertBefore) emptyFields.push('INSERT_BEFORE');
        logger.warn(
          `Skipping prompt block with empty fields: ${emptyFields.join(', ')}`
        );
        logger.debug('Block content preview:', blockContent.substring(0, 200));
        continue;
      }

      validSuggestions.push({
        text,
        insertAfter,
        insertBefore,
      });
    }

    logger.info(
      `Parsed ${validSuggestions.length} valid suggestions from LLM response`
    );
    return validSuggestions;
  } catch (error) {
    logger.error('Failed to parse LLM response:', error);
    logger.debug('Raw response:', llmResponse);
    return [];
  }
}

/**
 * Generates image prompts for a message using separate LLM call
 *
 * Uses context.generateRaw() to analyze the message text and suggest
 * image prompts with context-based insertion points.
 *
 * @param messageText - The complete message text to analyze
 * @param context - SillyTavern context
 * @param settings - Extension settings
 * @returns Array of prompt suggestions, or empty array on failure
 *
 * @example
 * const suggestions = await generatePromptsForMessage(
 *   "She walked through the forest under the pale moonlight.",
 *   context,
 *   settings
 * );
 * // Returns: [{
 * //   text: "1girl, forest, moonlight, highly detailed",
 * //   insertAfter: "through the forest",
 * //   insertBefore: "under the pale"
 * // }]
 */
export async function generatePromptsForMessage(
  messageText: string,
  context: SillyTavernContext,
  settings: AutoIllustratorSettings
): Promise<PromptSuggestion[]> {
  // Empty-message short-circuit: skip the LLM call entirely for
  // whitespace-only input. Applies to both the automatic MESSAGE_RECEIVED
  // path and the wand-menu manual trigger, since both funnel through here.
  if (!messageText || messageText.trim() === '') {
    logger.info('Skipping prompt generation: message text is empty');
    return [];
  }

  logger.info('Generating image prompts using separate LLM call');
  logger.debug(`Message length: ${messageText.length} characters`);

  // Check for LLM availability (Luker provides context.generateTask)
  if (typeof context.generateTask !== 'function') {
    logger.error('context.generateTask not available (Luker is required)');
    throw new Error('LLM generation not available: Luker is required');
  }

  // Build system prompt with all instructions from template
  let systemPrompt = promptGenerationTemplate;

  // Replace FREQUENCY_GUIDELINES with user's custom or default
  const frequencyGuidelines = settings.llmFrequencyGuidelines || '';
  systemPrompt = systemPrompt.replace(
    '{{FREQUENCY_GUIDELINES}}',
    frequencyGuidelines
  );

  // Replace PROMPT_WRITING_GUIDELINES with user's custom or default
  const promptWritingGuidelines = settings.llmPromptWritingGuidelines || '';
  systemPrompt = systemPrompt.replace(
    '{{PROMPT_WRITING_GUIDELINES}}',
    promptWritingGuidelines
  );

  // Splice the memory-graph recall block directly into the system prompt,
  // immediately before `## Instructions`. Kept out of the template file so
  // prompt_generation.md stays a pure task spec — nothing in the on-disk
  // preset references memory-graph. When there is nothing to inject, the
  // template is untouched.
  const recallProjection = await fetchLastRecallProjection(context);
  const recallBlock = buildRecallBlock(recallProjection);
  if (recallBlock) {
    systemPrompt = systemPrompt.replace(
      '## Instructions',
      `${recallBlock}\n## Instructions`
    );
  }

  // Build user prompt with context and current message
  const contextMessageCount = settings.contextMessageCount || 10;
  const userPrompt = buildUserPromptWithContext(
    context,
    messageText,
    contextMessageCount
  );

  logger.debug('Calling LLM for prompt generation (using generateTask)');
  logger.debug('Context message count:', contextMessageCount);
  logger.debug('User prompt length:', userPrompt.length);
  logger.debug(
    'Connection profile:',
    settings.independentApiPresetName || '(current)'
  );
  logger.debug(
    'Chat completion preset:',
    settings.independentLlmPresetName || '(current)'
  );
  logger.trace('User prompt:', userPrompt);

  // Call LLM via Luker's generateTask, routing through user-chosen connection
  // profile / chat completion preset when set (empty = chat's current config).
  let llmResponse: string;
  try {
    const result = await context.generateTask({
      taskMessages: [
        {role: 'system', content: systemPrompt},
        {role: 'user', content: userPrompt},
      ],
      apiPresetName: String(settings.independentApiPresetName || '').trim(),
      llmPresetName: String(settings.independentLlmPresetName || '').trim(),
      includeCharacterCard: false,
      worldInfoSource: 'none',
    });
    llmResponse = String(result?.assistantText ?? '');

    logger.debug('LLM response received');
    logger.trace('Raw LLM response:', llmResponse);
  } catch (error) {
    logger.error('LLM generation failed:', error);
    return []; // Return empty array instead of throwing
  }

  // Parse response
  const suggestions = parsePromptSuggestions(llmResponse);

  if (suggestions.length === 0) {
    logger.warn('LLM returned no valid suggestions');
    return [];
  }

  // Apply maxPromptsPerMessage limit
  const maxPrompts = settings.maxPromptsPerMessage || 5;
  if (suggestions.length > maxPrompts) {
    logger.info(
      `Limiting prompts from ${suggestions.length} to ${maxPrompts} (maxPromptsPerMessage)`
    );
    return suggestions.slice(0, maxPrompts);
  }

  logger.info(
    `Successfully generated ${suggestions.length} prompt suggestions`
  );

  // Log suggestions for debugging
  suggestions.forEach((s, i) => {
    logger.debug(`Suggestion ${i + 1}:`, {
      text: s.text.substring(0, 60) + (s.text.length > 60 ? '...' : ''),
      after: s.insertAfter.substring(0, 30),
      before: s.insertBefore.substring(0, 30),
    });
  });

  return suggestions;
}
