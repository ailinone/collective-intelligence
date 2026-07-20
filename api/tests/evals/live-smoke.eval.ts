// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Live smoke evals for fast, low-cost validation against a real endpoint.
 */

import { describeEval } from 'vitest-evals';
import {
    getEvalApiBaseUrl,
    getEvalAuthToken,
    isLiveMode,
    mockChatCompletionResponse,
    mockLLMResponse,
} from './setup';

const CHAT_COMPLETIONS_URL = `${getEvalApiBaseUrl()}/v1/chat/completions`;

async function liveSmokeTask(input: string): Promise<string> {
    if (!isLiveMode()) {
        return JSON.stringify(mockChatCompletionResponse(mockLLMResponse(input)));
    }

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
    return JSON.stringify(data);
}

describeEval('Live Smoke - Chat Completion Contract', {
    data: async () => [
        { input: 'Reply with one short greeting.' },
        { input: 'What is 2 + 2?' },
    ],
    task: liveSmokeTask,
    scorers: [
        async ({ output }) => {
            try {
                const parsed = JSON.parse(output as string);
                const checks = {
                    hasId: typeof parsed.id === 'string',
                    hasObject: parsed.object === 'chat.completion',
                    hasModel: typeof parsed.model === 'string' && parsed.model.length > 0,
                    hasChoices: Array.isArray(parsed.choices) && parsed.choices.length > 0,
                    hasAssistantMessage:
                        parsed.choices?.[0]?.message?.role === 'assistant' &&
                        typeof parsed.choices?.[0]?.message?.content === 'string' &&
                        parsed.choices?.[0]?.message?.content?.length > 0,
                };

                const passed = Object.values(checks).filter(Boolean).length;
                const total = Object.keys(checks).length;

                return {
                    score: passed / total,
                    metadata: {
                        checks,
                        rationale: `${passed}/${total} smoke checks passed`,
                    },
                };
            } catch {
                return {
                    score: 0,
                    metadata: { rationale: 'Response was not valid JSON' },
                };
            }
        },
    ],
    threshold: 0.8,
});
