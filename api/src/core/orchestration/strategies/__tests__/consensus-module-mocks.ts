// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Single source of truth for the consensus-strategy module mocks.
 *
 * Two kinds of consumers register these with vi.mock():
 *  - `consensus-validation.setup.ts`, the setup file of the dedicated
 *    vitest.consensus-validation.config.ts run (covers every file in
 *    this directory at once); and
 *  - individual test files that must stay green when executed under any
 *    other vitest config (e.g. a bare `vitest run <file>` uses the
 *    default config, which loads no setup file — without a file-local
 *    vi.mock the REAL aggregator runs and falls back to simple
 *    concatenation, breaking every assertion on synthesis content).
 *
 * Keeping both registration paths on these factories prevents the setup
 * file and the test files from drifting apart.
 *
 * This module must stay dependency-free: importing anything that
 * transitively reaches the mocked modules would create a cycle inside
 * the vi.mock factories.
 */

/** Structural stand-in for the wire `ToolCall` (keeps this module dependency-free). */
export interface MockToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ConsensusAggOverride {
  content: string;
  confidence: number;
  threwError: boolean;
  /**
   * When set, the mocked aggregate returns `finish_reason: 'tool_calls'` with
   * these calls on `choices[0].message` — mirroring the REAL aggregator's
   * Elo-3 quorum preservation, which only sets that shape on a strict
   * majority. Tests use it to drive the consensus quorum-tool execution path.
   */
  toolCalls?: MockToolCall[];
}

declare global {
  // eslint-disable-next-line no-var
  var __consensusAggOverride: ConsensusAggOverride;
}

export function defaultAggOverride(): ConsensusAggOverride {
  return {
    content:
      'Synthesis output: an integrated response that combines all participant perspectives into a coherent answer above the outlier threshold so the default path is exercised in tests.',
    confidence: 0.85,
    threwError: false,
  };
}

/** Module shape for vi.mock('@/core/aggregation/response-aggregator'). */
export function responseAggregatorModuleMock() {
  return {
    getResponseAggregator: () => ({
      aggregate: async (inputs: Array<{ modelName?: string }>, method: string) => {
        const override = globalThis.__consensusAggOverride ?? defaultAggOverride();
        if (override.threwError) {
          throw new Error('synthesis_failed_mock');
        }
        return {
          response: {
            id: 'synth-1',
            object: 'chat.completion',
            created: 0,
            model: 'mock-coordinator',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: override.content,
                  ...(override.toolCalls?.length ? { tool_calls: override.toolCalls } : {}),
                },
                finish_reason: override.toolCalls?.length ? 'tool_calls' : 'stop',
                logprobs: null,
              },
            ],
          },
          method,
          confidence: override.confidence,
          metadata: {
            sourcesUsed: inputs.map((i) => i.modelName ?? 'unknown'),
            totalSources: inputs.length,
            aggregationTime: 1,
          },
        };
      },
    }),
  };
}

/** Module shape for vi.mock('@/core/coordination/ensemble-coordinator-shadow'). */
export function ensembleShadowModuleMock() {
  return {
    runEnsembleInShadow: async () => null,
  };
}

/** Module shape for vi.mock('@/core/coordination/ensemble-coordinator-client'). */
export function ensembleClientModuleMock() {
  return {
    buildEnsembleRequest: (..._args: unknown[]) => ({}),
  };
}
