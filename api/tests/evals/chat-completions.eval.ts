// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Chat Completions Evaluation Tests
 *
 * Tests the quality and correctness of chat completion responses
 * from the Ailin orchestration gateway.
 */

import { describeEval } from 'vitest-evals';
import {
    mockLLMResponse,
    mockChatCompletionResponse,
    isLiveMode,
    getEvalApiBaseUrl,
    getEvalAuthToken,
} from './setup';

const CHAT_COMPLETIONS_URL = `${getEvalApiBaseUrl()}/v1/chat/completions`;

// ─── Task: Answer a factual question about the LLM ──────────────────────────
async function chatCompletionTask(input: string): Promise<string> {
    if (isLiveMode()) {
        // In live mode, call the actual Ailin API
        const response = await fetch(CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${getEvalAuthToken()}`,
            },
            body: JSON.stringify({
                model: 'auto',
                messages: [{ role: 'user', content: input }],
                temperature: 0,
            }),
        });
        const data = await response.json();
        return data.choices?.[0]?.message?.content || '';
    }

    // Mock mode: deterministic responses
    return mockLLMResponse(input);
}

// ─── Eval 1: Factual Correctness ────────────────────────────────────────────
describeEval('Chat Completions - Factual Correctness', {
    data: async () => [
        {
            input: 'What is the capital of France?',
            expected: 'Paris',
        },
        {
            input: 'What is the capital of Japan?',
            expected: 'Tokyo',
        },
        {
            input: 'Translate "hello, how are you?" to Spanish',
            expected: 'Hola',
        },
    ],
    task: chatCompletionTask,
    scorers: [
        // Simple containment scorer: does the output contain the expected answer?
        async ({ output, expected }) => ({
            score: output.toLowerCase().includes((expected as string).toLowerCase()) ? 1.0 : 0.0,
            metadata: {
                rationale: output.toLowerCase().includes((expected as string).toLowerCase())
                    ? `Output correctly contains "${expected}"`
                    : `Output does not contain "${expected}". Got: "${output.substring(0, 100)}"`,
            },
        }),
    ],
    threshold: 0.8,
});

// ─── Eval 2: Response Format Compliance ─────────────────────────────────────
describeEval('Chat Completions - Response Format (OpenAPI Schema)', {
    data: async () => [
        { input: 'Tell me a joke' },
        { input: 'Explain quantum computing in one sentence' },
        { input: 'What is 2 + 2?' },
    ],
    task: async (input: string) => {
        if (isLiveMode()) {
            const response = await fetch(CHAT_COMPLETIONS_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${getEvalAuthToken()}`,
                },
                body: JSON.stringify({
                    model: 'auto',
                    messages: [{ role: 'user', content: input }],
                }),
            });
            return JSON.stringify(await response.json());
        }
        return JSON.stringify(mockChatCompletionResponse(mockLLMResponse(input)));
    },
    scorers: [
        // OpenAPI schema compliance scorer
        async ({ output }) => {
            try {
                const parsed = JSON.parse(output);

                const checks = {
                    hasId: typeof parsed.id === 'string',
                    hasObject: parsed.object === 'chat.completion',
                    hasCreated: typeof parsed.created === 'number',
                    hasModel: typeof parsed.model === 'string',
                    hasChoices: Array.isArray(parsed.choices) && parsed.choices.length > 0,
                    hasUsage: parsed.usage !== undefined,
                    choiceHasMessage:
                        parsed.choices?.[0]?.message?.role === 'assistant' &&
                        typeof parsed.choices?.[0]?.message?.content === 'string',
                    choiceHasFinishReason: typeof parsed.choices?.[0]?.finish_reason === 'string',
                };

                const passed = Object.values(checks).filter(Boolean).length;
                const total = Object.values(checks).length;

                return {
                    score: passed / total,
                    metadata: {
                        checks,
                        rationale: `${passed}/${total} schema checks passed`,
                    },
                };
            } catch {
                return {
                    score: 0,
                    metadata: { rationale: 'Failed to parse JSON response' },
                };
            }
        },
    ],
    threshold: 1.0, // All schema checks must pass
});

// ─── Eval 3: Instruction Following ──────────────────────────────────────────
describeEval('Chat Completions - Instruction Following', {
    data: async () => [
        {
            input: 'Respond with ONLY the word "yes" and nothing else',
            expected: 'yes',
        },
        {
            input: 'Give me a JSON object with keys "name" and "age"',
            expected: '{"',
        },
        {
            input: 'Write a haiku about programming (exactly 3 lines)',
            expected: '\n',
        },
    ],
    task: chatCompletionTask,
    scorers: [
        async ({ output, expected }) => {
            if (!expected) return { score: 1.0 };

            // For "only yes" – check exactness
            if ((expected as string) === 'yes') {
                const isExact = output.trim().toLowerCase() === 'yes';
                return {
                    score: isExact ? 1.0 : 0.3,
                    metadata: { rationale: isExact ? 'Exact match' : `Got "${output.substring(0, 50)}" instead of "yes"` },
                };
            }

            // General containment
            const contains = output.includes(expected as string);
            return {
                score: contains ? 1.0 : 0.0,
                metadata: { rationale: contains ? 'Output follows instruction format' : 'Output does not match expected format' },
            };
        },
    ],
    threshold: 0.5, // More lenient — instruction following is hard
});

// ─── Eval 4: Response Quality & Helpfulness ─────────────────────────────────
describeEval('Chat Completions - Response Quality', {
    data: async () => [
        {
            input: 'Explain what an API is in simple terms',
            expected: 'interface',
        },
        {
            input: 'What are the benefits of TypeScript over JavaScript?',
            expected: 'type',
        },
        {
            input: 'How does a database index work?',
            expected: 'search',
        },
    ],
    task: chatCompletionTask,
    scorers: [
        // Quality scorer: checks length, relevance, and keyword coverage
        async ({ output, expected, input }) => {
            let score = 0;

            // 1. Non-empty response (0.2)
            if (output.length > 10) score += 0.2;

            // 2. Sufficient length for an explanation (0.2)
            if (output.length > 50) score += 0.2;

            // 3. Contains relevant keyword (0.3)
            if (expected && output.toLowerCase().includes((expected as string).toLowerCase())) {
                score += 0.3;
            }

            // 4. Contains words from the input (relevance) (0.3)
            const inputWords = (input as string).toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
            const relevantWords = inputWords.filter((w: string) => output.toLowerCase().includes(w));
            if (relevantWords.length > 0) {
                score += 0.3 * (relevantWords.length / inputWords.length);
            }

            return {
                score: Math.min(score, 1.0),
                metadata: {
                    outputLength: output.length,
                    containsKeyword: expected ? output.toLowerCase().includes((expected as string).toLowerCase()) : 'N/A',
                    relevantWordRatio: `${relevantWords.length}/${inputWords.length}`,
                },
            };
        },
    ],
    threshold: 0.6,
});
