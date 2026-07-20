// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Model Selection Evaluation Tests
 *
 * Tests the intelligent model selection system of Ailin —
 * verifying that the "auto" model routing picks appropriate
 * models based on task complexity, cost constraints, and quality targets.
 */

import { describeEval } from 'vitest-evals';
import { isLiveMode, getEvalApiBaseUrl, getEvalAuthToken } from './setup';

const CHAT_COMPLETIONS_URL = `${getEvalApiBaseUrl()}/v1/chat/completions`;

// Model tiers for scoring
const CHEAP_MODELS = [
    'gpt-4o-mini', 'gpt-3.5-turbo', 'claude-3-haiku', 'claude-3.5-haiku',
    'gemini-1.5-flash', 'gemini-2.0-flash', 'mistral-small',
    'deepseek-chat', 'deepseek-v3',
];

const PREMIUM_MODELS = [
    'gpt-4o', 'gpt-4-turbo', 'gpt-4', 'claude-3-opus', 'claude-3.5-sonnet',
    'claude-sonnet-4', 'gemini-1.5-pro', 'gemini-2.0-pro',
    'mistral-large', 'o1', 'o1-pro', 'o3',
];

// Simulate model selection
async function modelSelectionTask(input: string): Promise<string> {
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
        const data = await response.json();
        return data.model || 'unknown';
    }

    // Mock: simulate intelligent model selection
    const lower = input.toLowerCase();

    // Simple tasks → cheap model
    if (
        lower.includes('hello') ||
        lower.includes('what is 2+2') ||
        lower.includes('translate') ||
        lower.includes('simple') ||
        lower.length < 30
    ) {
        return 'gpt-4o-mini';
    }

    // Complex reasoning → premium model
    if (
        lower.includes('analyze') ||
        lower.includes('complex') ||
        lower.includes('reasoning') ||
        lower.includes('prove') ||
        lower.includes('multi-step') ||
        lower.includes('architecture')
    ) {
        return 'gpt-4o';
    }

    // Code tasks → code-optimized model
    if (
        lower.includes('code') ||
        lower.includes('function') ||
        lower.includes('debug') ||
        lower.includes('implement') ||
        lower.includes('refactor')
    ) {
        return 'claude-3.5-sonnet';
    }

    // Long-form content → balanced model
    if (
        lower.includes('write') ||
        lower.includes('essay') ||
        lower.includes('article') ||
        lower.includes('story')
    ) {
        return 'gpt-4o';
    }

    return 'gpt-4o-mini';
}

// ─── Eval 1: Cost Optimization — Simple Tasks → Cheap Models ────────────────
describeEval('Model Selection - Cost Optimization (Simple Tasks)', {
    data: async () => [
        { input: 'Hello!', expected: 'cheap' },
        { input: 'What is 2+2?', expected: 'cheap' },
        { input: 'Translate "hi" to French', expected: 'cheap' },
        { input: 'Yes or no: is the sky blue?', expected: 'cheap' },
    ],
    task: modelSelectionTask,
    scorers: [
        async ({ output, expected }) => {
            const tier = expected as string;
            const model = output.toLowerCase();

            if (tier === 'cheap') {
                const isCheap = CHEAP_MODELS.some((m) => model.includes(m.toLowerCase()));
                return {
                    score: isCheap ? 1.0 : 0.0,
                    metadata: {
                        selectedModel: output,
                        expectedTier: 'cheap',
                        rationale: isCheap
                            ? `Correctly selected cost-effective model: ${output}`
                            : `Selected premium model "${output}" for a simple task (wastes budget)`,
                    },
                };
            }
            return { score: 1.0 };
        },
    ],
    threshold: 0.75,
});

// ─── Eval 2: Quality Routing — Complex Tasks → Premium Models ───────────────
describeEval('Model Selection - Quality Routing (Complex Tasks)', {
    data: async () => [
        {
            input: 'Analyze the time complexity of the following algorithm and prove its optimality with a formal proof...',
            expected: 'premium',
        },
        {
            input: 'Design a multi-step reasoning chain to solve this complex logical puzzle involving 5 constraints...',
            expected: 'premium',
        },
        {
            input: 'Provide a detailed architecture review of this microservices system considering scalability, fault tolerance, and data consistency...',
            expected: 'premium',
        },
    ],
    task: modelSelectionTask,
    scorers: [
        async ({ output, expected }) => {
            const tier = expected as string;
            const model = output.toLowerCase();

            if (tier === 'premium') {
                const isPremium = PREMIUM_MODELS.some((m) => model.includes(m.toLowerCase()));
                return {
                    score: isPremium ? 1.0 : 0.0,
                    metadata: {
                        selectedModel: output,
                        expectedTier: 'premium',
                        rationale: isPremium
                            ? `Correctly selected premium model: ${output}`
                            : `Selected cheap model "${output}" for a complex task (quality risk)`,
                    },
                };
            }
            return { score: 1.0 };
        },
    ],
    threshold: 0.75,
});

// ─── Eval 3: Code Tasks → Code-Optimized Models ────────────────────────────
describeEval('Model Selection - Code Task Routing', {
    data: async () => [
        {
            input: 'Write a TypeScript function that implements a binary search tree with insert, delete, and search operations',
            expected: 'code-capable',
        },
        {
            input: 'Debug this recursive function: it enters an infinite loop when passed an empty array',
            expected: 'code-capable',
        },
        {
            input: 'Refactor this class to use the Strategy pattern instead of if-else chains',
            expected: 'code-capable',
        },
    ],
    task: modelSelectionTask,
    scorers: [
        async ({ output }) => {
            const model = output.toLowerCase();
            // Any premium or code-capable model should be selected for code tasks
            const codeCapable = [...PREMIUM_MODELS, ...CHEAP_MODELS.filter(m =>
                m.includes('deepseek') || m.includes('flash'),
            )].some((m) => model.includes(m.toLowerCase()));

            return {
                score: codeCapable ? 1.0 : 0.3,
                metadata: {
                    selectedModel: output,
                    rationale: codeCapable
                        ? `Selected code-capable model: ${output}`
                        : `Model "${output}" may not be optimized for code tasks`,
                },
            };
        },
    ],
    threshold: 0.7,
});

// ─── Eval 4: Model Selection Consistency ────────────────────────────────────
describeEval('Model Selection - Consistency', {
    data: async () => [
        { input: 'What is the capital of Brazil?', expected: 'consistent' },
        { input: 'What is the capital of Brazil?', expected: 'consistent' },
        { input: 'What is the capital of Brazil?', expected: 'consistent' },
    ],
    task: modelSelectionTask,
    scorers: [
        // Track all results and check consistency at the end
        (() => {
            const results: string[] = [];
            return async ({ output }: { output: string }) => {
                results.push(output);
                // Only score on the last item
                if (results.length >= 3) {
                    const allSame = results.every((r) => r === results[0]);
                    const score = allSame ? 1.0 : 0.5;
                    const finalResults = [...results];
                    results.length = 0; // reset
                    return {
                        score,
                        metadata: {
                            models: finalResults,
                            rationale: allSame
                                ? `Consistent model selection: always "${finalResults[0]}"`
                                : `Inconsistent: selected ${[...new Set(finalResults)].join(', ')}`,
                        },
                    };
                }
                return { score: 1.0, metadata: { rationale: 'Accumulating results...' } };
            };
        })(),
    ],
    threshold: 0.8,
});
