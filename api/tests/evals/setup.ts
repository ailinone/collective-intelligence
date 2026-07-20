// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Eval Test Setup
 *
 * Configures the environment for LLM evaluation tests.
 * Supports two modes:
 *   - EVAL_MODE=live  → Real LLM API calls (requires API keys, incurs costs)
 *   - EVAL_MODE=mock  → Deterministic mock responses (default, free, for CI)
 */

import dotenv from 'dotenv';
import path from 'path';

// Load env vars from .env file
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Default to mock mode if not specified
if (!process.env.EVAL_MODE) {
    process.env.EVAL_MODE = 'mock';
}

/**
 * Check if we're in live eval mode (real API calls)
 */
export function isLiveMode(): boolean {
    return process.env.EVAL_MODE === 'live';
}

/**
 * Base URL used by eval tests in live mode.
 */
export function getEvalApiBaseUrl(): string {
    const baseUrl = process.env.EVAL_API_BASE_URL || 'http://localhost:3000';
    return baseUrl.replace(/\/+$/, '');
}

/**
 * Bearer token used by eval tests in live mode.
 */
export function getEvalAuthToken(): string {
    return process.env.EVAL_BEARER_TOKEN || process.env.JWT_SECRET || 'test-token';
}

/**
 * Get the OpenAI API key for eval purposes (autoevals uses this)
 */
export function getOpenAIKey(): string | undefined {
    return process.env.OPENAI_API_KEY;
}

/**
 * Mock LLM response generator for deterministic testing
 */
export function mockLLMResponse(input: string, taskType?: string): string {
    const lower = input.toLowerCase();

    // Exact instruction-following special cases used in evals.
    if (lower.includes('respond with only the word "yes" and nothing else')) {
        return 'yes';
    }

    // Chat completion mock responses
    if (lower.includes('capital') && lower.includes('france')) {
        return 'The capital of France is Paris.';
    }
    if (lower.includes('capital') && lower.includes('japan')) {
        return 'The capital of Japan is Tokyo.';
    }
    if (lower.includes('translate') && lower.includes('spanish')) {
        return 'Hola, ¿cómo estás?';
    }
    if (lower.includes('summarize') || lower.includes('summary')) {
        return 'This text discusses the main points of the given topic, highlighting key findings and conclusions.';
    }
    if (lower.includes('code') || lower.includes('function') || lower.includes('program')) {
        return '```typescript\nfunction example(): string {\n  return "Hello, World!";\n}\n```';
    }
    if (lower.includes('json') || lower.includes('structured')) {
        return '{"result": "success", "data": {"key": "value"}}';
    }

    // Model selection mock
    if (taskType === 'simple') {
        return 'gpt-4o-mini'; // cheap model for simple tasks
    }
    if (taskType === 'complex') {
        return 'gpt-4o'; // premium model for complex tasks
    }

    // Default response
    return `I understand your question: "${input}". Here is a helpful response based on the available information.`;
}

/**
 * Mock tool call response
 */
export function mockToolCall(
    toolName: string,
    args: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown>; result: unknown } {
    return {
        name: toolName,
        arguments: args,
        result: { success: true, output: `Tool ${toolName} executed with args: ${JSON.stringify(args)}` },
    };
}

/**
 * Simulates the chat completions API response format
 */
export function mockChatCompletionResponse(content: string, model = 'gpt-4o-mock') {
    return {
        id: `chatcmpl-mock-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                message: {
                    role: 'assistant',
                    content,
                },
                finish_reason: 'stop',
            },
        ],
        usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
        },
    };
}

console.log(`[Eval Setup] Mode: ${process.env.EVAL_MODE}`);
