// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tool Calling Evaluation Tests
 *
 * Tests the accuracy of tool selection, argument extraction,
 * and multi-tool chain execution.
 */

import { describeEval } from 'vitest-evals';
import { isLiveMode, mockToolCall, getEvalApiBaseUrl, getEvalAuthToken } from './setup';

const CHAT_COMPLETIONS_URL = `${getEvalApiBaseUrl()}/v1/chat/completions`;

// Simulated task that returns tool calls based on input
async function toolCallingTask(input: string): Promise<{
    result: string;
    toolCalls: Array<{ name: string; arguments: Record<string, unknown>; result?: unknown }>;
}> {
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
                tools: [
                    {
                        type: 'function',
                        function: {
                            name: 'read_file',
                            description: 'Read the contents of a file',
                            parameters: {
                                type: 'object',
                                properties: {
                                    file_path: { type: 'string', description: 'Path to the file to read' },
                                },
                                required: ['file_path'],
                            },
                        },
                    },
                    {
                        type: 'function',
                        function: {
                            name: 'write_file',
                            description: 'Write content to a file',
                            parameters: {
                                type: 'object',
                                properties: {
                                    file_path: { type: 'string', description: 'Path to the file' },
                                    content: { type: 'string', description: 'Content to write' },
                                },
                                required: ['file_path', 'content'],
                            },
                        },
                    },
                    {
                        type: 'function',
                        function: {
                            name: 'run_command',
                            description: 'Execute a shell command',
                            parameters: {
                                type: 'object',
                                properties: {
                                    command: { type: 'string', description: 'The command to execute' },
                                },
                                required: ['command'],
                            },
                        },
                    },
                    {
                        type: 'function',
                        function: {
                            name: 'web_search',
                            description: 'Search the web for information',
                            parameters: {
                                type: 'object',
                                properties: {
                                    query: { type: 'string', description: 'Search query' },
                                },
                                required: ['query'],
                            },
                        },
                    },
                ],
                tool_choice: 'auto',
            }),
        });
        const data = await response.json();
        const message = data.choices?.[0]?.message;
        return {
            result: message?.content || '',
            toolCalls: (message?.tool_calls || []).map((tc: {
                function: { name: string; arguments: string };
            }) => ({
                name: tc.function.name,
                arguments: JSON.parse(tc.function.arguments || '{}'),
            })),
        };
    }

    // Mock mode: deterministic tool selection
    const lower = input.toLowerCase();

    if (lower.includes('read') && lower.includes('file')) {
        const fileMatch = input.match(/['"]([\w/.]+)['"]/);
        return {
            result: '',
            toolCalls: [
                mockToolCall('read_file', {
                    file_path: fileMatch?.[1] || 'src/index.ts',
                }),
            ],
        };
    }

    if (lower.includes('write') && lower.includes('file')) {
        return {
            result: '',
            toolCalls: [
                mockToolCall('write_file', {
                    file_path: 'output.txt',
                    content: 'Hello, World!',
                }),
            ],
        };
    }

    if (lower.includes('run') && (lower.includes('command') || lower.includes('test'))) {
        return {
            result: '',
            toolCalls: [
                mockToolCall('run_command', {
                    command: 'npm test',
                }),
            ],
        };
    }

    if (lower.includes('search') || lower.includes('look up') || lower.includes('find information')) {
        return {
            result: '',
            toolCalls: [
                mockToolCall('web_search', {
                    query: input.replace(/search|look up|find information about/gi, '').trim(),
                }),
            ],
        };
    }

    // No tool needed
    return {
        result: 'I can answer this directly without tools.',
        toolCalls: [],
    };
}

// ─── Eval 1: Correct Tool Selection ─────────────────────────────────────────
describeEval('Tool Calling - Correct Tool Selection', {
    data: async () => [
        {
            input: "Read the file 'src/config/index.ts'",
            expectedTools: [{ name: 'read_file' }],
        },
        {
            input: "Write 'Hello World' to file 'output.txt'",
            expectedTools: [{ name: 'write_file' }],
        },
        {
            input: 'Run the command to execute tests',
            expectedTools: [{ name: 'run_command' }],
        },
        {
            input: 'Search the web for TypeScript best practices',
            expectedTools: [{ name: 'web_search' }],
        },
    ],
    task: toolCallingTask,
    scorers: [
        // Custom tool selection scorer (compatible with our data format)
        async ({ output, expected }) => {
            const response = output as unknown as {
                result: string;
                toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
            };
            const expectedTools = (expected as unknown as { name: string }[]) || [];

            if (!response.toolCalls || response.toolCalls.length === 0) {
                return {
                    score: expectedTools.length === 0 ? 1.0 : 0.0,
                    metadata: { rationale: 'No tool calls made' },
                };
            }

            const actualToolNames = response.toolCalls.map((tc) => tc.name);
            const expectedNames = expectedTools.map((et) => et.name);

            const correctCalls = expectedNames.filter((name) => actualToolNames.includes(name)).length;
            const score = expectedNames.length > 0 ? correctCalls / expectedNames.length : 1.0;

            return {
                score,
                metadata: {
                    expected: expectedNames,
                    actual: actualToolNames,
                    rationale:
                        score === 1.0
                            ? 'All expected tools were called'
                            : `Missing tools: ${expectedNames.filter((n) => !actualToolNames.includes(n)).join(', ')}`,
                },
            };
        },
    ],
    threshold: 0.8,
});

// ─── Eval 2: Argument Extraction Accuracy ───────────────────────────────────
describeEval('Tool Calling - Argument Extraction', {
    data: async () => [
        {
            input: "Read the file 'src/config/index.ts'",
            expected: JSON.stringify({ file_path: 'src/config/index.ts' }),
        },
        {
            input: 'Run the npm test command',
            expected: JSON.stringify({ command: 'npm test' }),
        },
    ],
    task: async (input: string) => {
        const result = await toolCallingTask(input);
        if (result.toolCalls.length > 0) {
            return JSON.stringify(result.toolCalls[0].arguments);
        }
        return '{}';
    },
    scorers: [
        async ({ output, expected }) => {
            try {
                const actual = JSON.parse(output);
                const exp = JSON.parse(expected as string);

                const expectedKeys = Object.keys(exp);
                const matchingKeys = expectedKeys.filter((key) => {
                    const actualVal = String(actual[key] || '').toLowerCase();
                    const expectedVal = String(exp[key]).toLowerCase();
                    return actualVal.includes(expectedVal) || expectedVal.includes(actualVal);
                });

                const score = expectedKeys.length > 0 ? matchingKeys.length / expectedKeys.length : 1.0;

                return {
                    score,
                    metadata: {
                        expected: exp,
                        actual,
                        matchingKeys,
                        rationale: score === 1.0 ? 'All arguments correctly extracted' : `Partial match: ${matchingKeys.length}/${expectedKeys.length}`,
                    },
                };
            } catch {
                return { score: 0, metadata: { rationale: 'Failed to parse arguments' } };
            }
        },
    ],
    threshold: 0.7,
});

// ─── Eval 3: No-Tool Detection ──────────────────────────────────────────────
describeEval('Tool Calling - Knows When NOT to Use Tools', {
    data: async () => [
        {
            input: 'What is 2 + 2?',
            expected: 'no-tools',
        },
        {
            input: 'Explain what TypeScript is',
            expected: 'no-tools',
        },
        {
            input: 'Tell me a joke about programming',
            expected: 'no-tools',
        },
    ],
    task: async (input: string) => {
        const result = await toolCallingTask(input);
        return result.toolCalls.length === 0 ? 'no-tools' : `used-tools: ${result.toolCalls.map((t) => t.name).join(', ')}`;
    },
    scorers: [
        async ({ output, expected }) => ({
            score: output === expected ? 1.0 : 0.0,
            metadata: {
                rationale:
                    output === expected
                        ? 'Correctly decided not to use tools for a knowledge question'
                        : `Incorrectly used tools: ${output}`,
            },
        }),
    ],
    threshold: 0.8,
});
