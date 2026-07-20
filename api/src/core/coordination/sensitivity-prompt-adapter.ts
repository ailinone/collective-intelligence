// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Ailin¹ Collective Coordination Layer — Sensitivity Prompt Adapter
 *
 * Generates structured prompts that elicit decisions + sensitivities
 * from LLM agents. Parses model responses into CoordinationSignal objects.
 *
 * Design:
 * - Prompts are concise to minimize token cost.
 * - Expected response format is JSON with a defined schema.
 * - Parser is robust to malformed responses (markdown wrapping, extra text).
 * - Falls back gracefully when parsing fails.
 */

import type {
  CoordinationSignal,
  CoordinationState,
} from './coordination-types';
import { validateCoordinationSignal } from './signal-validator';
import {
  sanitizeForPromptContext,
  sanitizeRiskDescription,
  sanitizeRiskSeverity,
  sanitizeVariableName,
  sanitizeVariableValue,
} from './collective-prompt-safety';
import { logger } from '@/utils/logger';
import { nanoid } from 'nanoid';

const log = logger.child({ component: 'sensitivity-prompt-adapter' });

// ============================================
// Prompt generation
// ============================================

/**
 * Optional flags that shape the system prompt for a coordination round.
 * Adding new flags here is backward-compatible: callers that pass no
 * options keep the original behavior.
 */
export interface CoordinationPromptOptions {
  /**
   * F1.1 — Anti-herding primitive (Ailin¹ EntropySeed). When `true`,
   * the prompt instructs the agent to first emit a 16-character random
   * string and use it as a diversity seed for its reasoning, before
   * outputting decision + sensitivities. The string itself is not part
   * of the structured response and is discarded after parsing.
   *
   * The instruction is purposely lightweight (~30 input tokens) and is
   * additive: agents that ignore it still produce valid signals; agents
   * that follow it are less prone to anchoring on the dominant prior
   * round position, which mitigates the herding pattern flagged by
   * `convergence-evaluator.ts:detectHerding`.
   */
  entropySeedEnabled?: boolean;
}

/**
 * Build the system prompt for a coordination round.
 * Instructs the model to respond with decision + sensitivities in JSON.
 */
export function buildCoordinationSystemPrompt(
  role?: string,
  roundNumber?: number,
  state?: CoordinationState,
  options?: CoordinationPromptOptions,
): string {
  const roleInstruction = role
    ? `You are participating as "${role}".`
    : 'You are participating as an independent expert.';

  const roundInfo = roundNumber && roundNumber > 1
    ? `\n\nThis is round ${roundNumber}. Previous rounds have established a collective state. Review the updated variables and reconsider your position.`
    : '';

  const stateContext = state && state.round > 0
    ? `\n\nCurrent collective state:\n${formatStateForPrompt(state)}`
    : '';

  // F1.1 — EntropySeed (anti-herding). Inserted as a leading instruction
  // when enabled. Kept short to bound token cost. The seed itself is
  // local to the agent's reasoning; it does not need to round-trip
  // through the parser (the parser only consumes the JSON tail).
  const entropySeedPreamble = options?.entropySeedEnabled
    ? '\n\nBefore reasoning about the task, first generate a 16-character random string composed of mixed letters, digits, and symbols. Use that string as a diversity seed: let it nudge you toward exploring hypotheses that differ from the dominant collective state below, rather than anchoring on it. Do not include the random string in your final JSON output.'
    : '';

  return `${roleInstruction} You are part of a collective intelligence process where multiple AI agents coordinate their decisions.${entropySeedPreamble}

Respond with a JSON object containing your analysis. You MUST respond with valid JSON only, no other text.

Schema:
{
  "decision": {
    "type": "<your decision category (e.g. approve, request_changes, reject, recommend, etc.)>",
    "value": <your actual recommendation or response>,
    "confidence": <0.0 to 1.0 — how confident you are>,
    "rationale": "<brief explanation>"
  },
  "sensitivities": [
    {
      "variable": "<name of a factor that could change your decision>",
      "direction": "<increase | decrease | hold | block | unlock>",
      "trigger": "<what specific change would cause you to reconsider>",
      "expectedDelta": <optional: expected magnitude of change>,
      "confidence": <0.0 to 1.0 — how certain this sensitivity is>,
      "rationale": "<why this matters>",
      "risk": "<low | medium | high | critical>"
    }
  ]
}

Rules:
1. Provide at least 1 sensitivity — a condition that would change your position.
2. Use "block" for factors that prevent approval regardless of other conditions.
3. Use "unlock" for factors that would resolve a blocking concern.
4. Be specific about triggers — avoid vague conditions.
5. Confidence must reflect your genuine certainty, not maximum by default.${roundInfo}${stateContext}`;
}

/**
 * Format current coordination state as human-readable context for the prompt.
 *
 * Every interpolated value flows through `collective-prompt-safety` before
 * concatenation. This guards against an attacker (or a hallucinating
 * agent in a previous round) embedding structural prompt-injection
 * markers — newlines, code-fence terminators, chat-template tokens — in
 * a sensitivity rationale or risk description that, once re-embedded
 * here, would surface as if they were part of the trusted system prompt.
 */
function formatStateForPrompt(state: CoordinationState): string {
  const lines: string[] = [];

  if (Object.keys(state.variables).length > 0) {
    lines.push('Established variables:');
    for (const [name, varState] of Object.entries(state.variables)) {
      const safeName = sanitizeVariableName(name);
      const safeValue = sanitizeVariableValue(varState.value);
      // `confidence` and `stability` are guaranteed numeric by the
      // VariableState contract — toFixed is safe here without sanitization.
      lines.push(
        `  - ${safeName}: ${safeValue} (confidence: ${varState.confidence.toFixed(2)}, stability: ${varState.stability.toFixed(2)})`,
      );
    }
  }

  if (state.convergence.score > 0) {
    lines.push(`Convergence: ${state.convergence.score.toFixed(2)}`);
  }

  if (state.risks.length > 0) {
    lines.push('Active risks:');
    for (const risk of state.risks.slice(0, 5)) {
      const safeSeverity = sanitizeRiskSeverity(risk.severity);
      const safeDescription = sanitizeRiskDescription(risk.description);
      lines.push(`  - [${safeSeverity}] ${safeDescription}`);
    }
  }

  return lines.join('\n');
}

/**
 * Re-export of the safety helper for callers that build their own prompt
 * context fragments. Keeping a single canonical entry-point reduces the
 * risk that a future strategy interpolates raw text without sanitizing.
 */
export { sanitizeForPromptContext };

/**
 * Build the user message that wraps the original task with coordination context.
 */
export function buildCoordinationUserMessage(
  originalMessages: Array<{ role: string; content: string | unknown[] }>,
  taskContext?: string,
): string {
  // Extract the core task from original messages
  const userMessages = originalMessages
    .filter(m => m.role === 'user')
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));

  const lastUserMessage = userMessages[userMessages.length - 1] || '';

  if (taskContext) {
    return `${taskContext}\n\n---\n\nTask:\n${lastUserMessage}`;
  }

  return lastUserMessage;
}

// ============================================
// Response parsing
// ============================================

/**
 * Parse a raw LLM response string into a CoordinationSignal.
 *
 * Handles:
 * - Pure JSON response
 * - JSON wrapped in markdown code blocks
 * - JSON embedded in explanatory text
 * - Partially malformed JSON (best-effort extraction)
 *
 * Returns null if parsing fails completely.
 */
export function parseSignalResponse(
  rawResponse: string,
  runId: string,
  round: number,
  agentId: string,
  modelId: string,
  providerId: string,
  role?: string,
  metrics?: {
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCost: number;
  },
): { signal: CoordinationSignal | null; parseError?: string } {
  if (!rawResponse || rawResponse.trim().length === 0) {
    return { signal: null, parseError: 'Empty response from model' };
  }

  // Extract JSON from response
  const jsonStr = extractJSON(rawResponse);
  if (!jsonStr) {
    return { signal: null, parseError: 'No JSON found in response' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    return {
      signal: null,
      parseError: `JSON parse error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Wrap in signal structure
  const rawSignal = {
    id: `sig-${nanoid(12)}`,
    runId,
    round,
    agentId,
    modelId,
    providerId,
    role,
    decision: (parsed as Record<string, unknown>).decision,
    sensitivities: (parsed as Record<string, unknown>).sensitivities,
    metrics,
    createdAt: new Date().toISOString(),
  };

  // Validate
  const validation = validateCoordinationSignal(rawSignal);
  if (!validation.valid) {
    return {
      signal: null,
      parseError: `Validation failed: ${validation.errors.join('; ')}`,
    };
  }

  if (validation.warnings.length > 0) {
    log.debug(
      { warnings: validation.warnings, modelId, round },
      'Signal parsed with warnings',
    );
  }

  return { signal: validation.sanitized! };
}

/**
 * Extract JSON string from a raw LLM response.
 * Handles markdown wrapping and embedded JSON.
 */
function extractJSON(text: string): string | null {
  const trimmed = text.trim();

  // Case 1: Pure JSON
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return trimmed;
  }

  // Case 2: Markdown code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    if (inner.startsWith('{') && inner.endsWith('}')) {
      return inner;
    }
  }

  // Case 3: JSON embedded in text — find first { to last }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.substring(firstBrace, lastBrace + 1);
  }

  return null;
}

/**
 * Extract the text content from a model response, handling various response shapes.
 */
export function extractResponseText(response: unknown): string {
  if (!response || typeof response !== 'object') return '';

  const resp = response as Record<string, unknown>;

  // Standard ChatResponse format
  if (Array.isArray(resp.choices) && resp.choices.length > 0) {
    const choice = resp.choices[0] as Record<string, unknown>;
    const message = choice.message as Record<string, unknown> | undefined;
    if (message) {
      if (typeof message.content === 'string') return message.content;
      if (Array.isArray(message.content)) {
        const textParts = message.content
          .filter((p: unknown) => (p as Record<string, unknown>)?.type === 'text')
          .map((p: Record<string, unknown>) => (p as { text?: string }).text ?? '');
        return textParts.join('');
      }
    }
    // Delta format for streaming
    const delta = choice.delta as Record<string, unknown> | undefined;
    if (delta && typeof delta.content === 'string') {
      return delta.content;
    }
  }

  // Fallback: try to stringify
  if (typeof resp === 'string') return resp;
  return '';
}
