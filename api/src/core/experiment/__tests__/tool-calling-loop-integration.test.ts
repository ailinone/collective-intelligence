// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Capability #4 — server-side tool-execution LOOP wiring (integration).
 *
 * The operator's prerequisite was "a robust tool-calling test needs the
 * server-side tool-execution LOOP confirmed". base-strategy.executeModelWithTools
 * runs that loop and executes each returned tool_call via
 * strategy-tool-executor.executeToolForStrategy → toolRegistry.executeForStrategy
 * (safeForStrategies tools only), then feeds the result back. This test drives
 * that EXACT executor against the registered benchmark tools and proves it
 * returns the fictional datum the tasks' answerCheck expects — so a looped model
 * that calls the tool gets a grounded FINAL answer that scores 1, while a model
 * that never calls it can only fail closed (scores 0).
 *
 * Note: the registry singleton is per-test-file (vitest module isolation), so
 * marking it initialized here does not leak to other suites.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { narrowAs } from '@/utils/type-guards';
import type { Logger } from 'pino';
import type { ToolCall } from '@/types';
import { toolRegistry } from '@/core/tools/tool-registry';
import { executeToolForStrategy } from '@/services/strategy-tool-executor';
import {
  registerExperimentBenchmarkTools,
  __resetExperimentToolRegistrationForTest,
  TOOL_TASK_EXPECTED,
} from '../experiment-tool-catalog';

const log = narrowAs<Logger>({
  info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {}, child() { return log; },
});

const call = (name: string, args: Record<string, unknown>): ToolCall => ({
  id: 'call_x',
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

describe('server-side tool loop executes the registered benchmark tools', () => {
  beforeAll(async () => {
    __resetExperimentToolRegistrationForTest();
    await registerExperimentBenchmarkTools();
    // The loop calls executeToolForStrategy, which refuses to run until the
    // registry is marked initialized (as it is at API boot).
    toolRegistry.markInitialized();
  });

  it('executeForStrategy runs getExchangeRate and returns the fictional rate (→ 100 ZRG = 375 USD)', async () => {
    const res = await executeToolForStrategy(call('getExchangeRate', { from: 'ZRG', to: 'USD' }), log);
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output ?? '{}') as { rate: number };
    expect(parsed.rate).toBe(3.75);
    expect(100 * parsed.rate).toBe(TOOL_TASK_EXPECTED[166]); // the number answerCheck verifies
  });

  it('executeForStrategy runs lookupInventory and returns the fictional stock (task 167 = 4321)', async () => {
    const res = await executeToolForStrategy(call('lookupInventory', { sku: 'QX-9' }), log);
    expect(res.success).toBe(true);
    const parsed = JSON.parse(res.output ?? '{}') as { in_stock: number };
    expect(parsed.in_stock).toBe(TOOL_TASK_EXPECTED[167]);
  });

  it('the benchmark tools are permitted inside strategy execution (safeForStrategies)', () => {
    for (const name of ['getExchangeRate', 'lookupInventory', 'multiply']) {
      expect(toolRegistry.get(name)?.safeForStrategies, name).toBe(true);
    }
  });

  it('an unknown SKU fails closed inside the loop (model then cannot produce the checked number)', async () => {
    const res = await executeToolForStrategy(call('lookupInventory', { sku: 'ZZ-0' }), log);
    expect(res.success).toBe(false);
  });
});
