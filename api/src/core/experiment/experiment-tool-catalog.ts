// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Experiment Tool Catalog — deterministic benchmark tools (capability #4).
 *
 * The c3 tool-calling tasks (166-169) grade whether a model can RECOGNISE it
 * must call a provided function and USE the result. To make that objective, the
 * correct FINAL answer must be UNKNOWABLE without calling the tool — so every
 * tool here returns FICTIONAL data from a fixed table (made-up currencies,
 * made-up SKUs). A model that answers "blind" cannot hit the checked number;
 * a model that calls the tool gets the real datum fed back by the server's
 * agentic tool loop (base-strategy.executeModelWithTools) and can compute it.
 *
 * These handlers are registered `safeForStrategies: true` so the loop is allowed
 * to execute them. They are PURE and side-effect-free, and — critically — a
 * registered tool is only ever OFFERED to a model when a caller puts it in the
 * request's `tools` array (no strategy injects the registry catalogue into a
 * prompt), so registering them cannot leak into production traffic. The runner
 * registers them lazily, only when a task actually carries `tools`.
 *
 * SINGLE SOURCE OF TRUTH: the data tables below drive BOTH the tool handlers and
 * the tasks' expected answers (TOOL_TASK_EXPECTED), so a task and its checker can
 * never silently drift from what the tool actually returns.
 */

import type { ToolResult } from '@/services/advanced-tool-execution-service';
import type { ToolHandler, ToolRegistration } from '@/core/tools/tool-registry';
import type { ExperimentTask } from './experiment-types';

// ─── Fictional data tables ───────────────────────────────────────────────────

/**
 * Made-up currencies priced in USD. `names` lists the aliases a model might
 * emit (code or full name) so the handler resolves them regardless of phrasing.
 * The values are deliberately non-round and non-guessable.
 */
const CURRENCIES: Record<string, { readonly usd: number; readonly names: readonly string[] }> = {
  ZRG: { usd: 3.75, names: ['zrg', 'zorgcoin', 'zorg'] },
  BLP: { usd: 0.42, names: ['blp', 'blipnar'] },
  QBT: { usd: 12.5, names: ['qbt', 'quibit'] },
  USD: { usd: 1, names: ['usd', 'dollar', 'dollars', 'us dollar', '$'] },
};

/** Made-up SKUs → units in stock. Non-guessable integers. */
const INVENTORY: Record<string, number> = {
  'QX-9': 4321,
  'ZP-7': 1580,
  'MK-3': 909,
};

/** Resolve a free-text currency argument ('ZRG', 'ZorgCoin', 'US Dollar') to a code. */
export function resolveCurrencyCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const lower = raw.trim().toLowerCase();
  if (lower.length === 0) return null;
  for (const [code, def] of Object.entries(CURRENCIES)) {
    if (lower === code.toLowerCase()) return code;
    if (def.names.some((n) => lower === n || lower.includes(n))) return code;
  }
  return null;
}

/** Resolve a free-text SKU argument to a known key ('qx-9', ' "QX-9" ' → 'QX-9'). */
export function resolveSku(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.trim().replace(/^["']|["']$/g, '').toUpperCase();
  if (INVENTORY[cleaned] !== undefined) return cleaned;
  const compact = cleaned.replace(/\s+/g, '');
  return INVENTORY[compact] !== undefined ? compact : null;
}

function ok(toolCallId: string, output: Record<string, unknown>): ToolResult {
  return { tool_call_id: toolCallId, success: true, output: JSON.stringify(output), metadata: output };
}
function err(toolCallId: string, message: string): ToolResult {
  return { tool_call_id: toolCallId, success: false, error: message };
}

// ─── Handlers ────────────────────────────────────────────────────────────────

const getExchangeRateHandler: ToolHandler = async (args, toolCallId): Promise<ToolResult> => {
  const from = resolveCurrencyCode(args.from);
  const to = resolveCurrencyCode(args.to);
  if (!from) return err(toolCallId, `Unknown currency: ${JSON.stringify(args.from)}. Known: ZRG, BLP, QBT, USD.`);
  if (!to) return err(toolCallId, `Unknown currency: ${JSON.stringify(args.to)}. Known: ZRG, BLP, QBT, USD.`);
  // Rate = how many units of `to` per 1 unit of `from`.
  const rate = CURRENCIES[from].usd / CURRENCIES[to].usd;
  return ok(toolCallId, { from, to, rate });
};

const lookupInventoryHandler: ToolHandler = async (args, toolCallId): Promise<ToolResult> => {
  const sku = resolveSku(args.sku);
  if (!sku) return err(toolCallId, `Unknown SKU: ${JSON.stringify(args.sku)}. Known: QX-9, ZP-7, MK-3.`);
  return ok(toolCallId, { sku, in_stock: INVENTORY[sku] });
};

const multiplyHandler: ToolHandler = async (args, toolCallId): Promise<ToolResult> => {
  const a = Number(args.a);
  const b = Number(args.b);
  if (!Number.isFinite(a) || !Number.isFinite(b)) {
    return err(toolCallId, `multiply requires numeric a and b; got a=${JSON.stringify(args.a)}, b=${JSON.stringify(args.b)}.`);
  }
  return ok(toolCallId, { product: a * b });
};

// ─── Registry wiring ─────────────────────────────────────────────────────────

/** ToolRegistration entries for the three benchmark tools. */
export const EXPERIMENT_BENCHMARK_TOOL_REGISTRATIONS: readonly ToolRegistration[] = [
  {
    name: 'getExchangeRate',
    description: 'Return the exchange rate (units of `to` per 1 unit of `from`) between two currencies.',
    category: 'general',
    safeForStrategies: true,
    handler: getExchangeRateHandler,
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source currency code, e.g. ZRG, BLP, QBT, USD.' },
        to: { type: 'string', description: 'Target currency code, e.g. USD.' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'lookupInventory',
    description: 'Return the number of units currently in stock for a product SKU.',
    category: 'general',
    safeForStrategies: true,
    handler: lookupInventoryHandler,
    parameters: {
      type: 'object',
      properties: { sku: { type: 'string', description: 'Product SKU, e.g. QX-9.' } },
      required: ['sku'],
    },
  },
  {
    name: 'multiply',
    description: 'Return the product a × b of two numbers.',
    category: 'general',
    safeForStrategies: true,
    handler: multiplyHandler,
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
] as const;

let registered = false;
/**
 * Idempotently register the benchmark tools into the shared tool registry so the
 * server-side agentic loop can execute them. Called lazily by the runner when a
 * task carries `tools`. Safe to call repeatedly (register() overwrites by name).
 */
export async function registerExperimentBenchmarkTools(): Promise<void> {
  if (registered) return;
  const { toolRegistry } = await import('@/core/tools/tool-registry');
  toolRegistry.registerAll([...EXPERIMENT_BENCHMARK_TOOL_REGISTRATIONS]);
  registered = true;
}

/** Reset the memoisation guard — test-only. */
export function __resetExperimentToolRegistrationForTest(): void {
  registered = false;
}

// ─── Tool specs offered to the model (OpenAI `tools` shape) ──────────────────

type TaskTool = NonNullable<ExperimentTask['tools']>[number];

/** Build the `tools` array for a task from a subset of registered tools. */
function toolSpecs(...names: string[]): TaskTool[] {
  return names.map((name) => {
    const r = EXPERIMENT_BENCHMARK_TOOL_REGISTRATIONS.find((t) => t.name === name);
    if (!r) throw new Error(`experiment-tool-catalog: unknown benchmark tool "${name}"`);
    return { type: 'function', function: { name: r.name, description: r.description, parameters: r.parameters } };
  });
}

// ─── Expected answers (derived from the tables — single source of truth) ─────

export const TOOL_TASK_EXPECTED: Record<number, number> = {
  166: 100 * CURRENCIES.ZRG.usd,           // 375  — 100 ZRG at 3.75 USD/ZRG
  167: INVENTORY['QX-9'],                   // 4321 — stock lookup
  168: 8 * 12 * CURRENCIES.QBT.usd,         // 1200 — 96 QBT at 12.5 USD/QBT
  169: INVENTORY['ZP-7'] * 3,               // 4740 — 1580 units × 3 kg
};

// ─── The tool-calling benchmark tasks (indices 166-169) ──────────────────────
//
// 166+ continues the suite after the earlier capability batches (hard-verifiable
// 126-135, canvas-physics 136-145, H-A tier 146-155, code-verified 156-160,
// long-generation 161-165), keeping EXPERIMENT_SUITE contiguous 0..169.

export const EXPERIMENT_TOOL_CALLING_TASKS: ExperimentTask[] = [
  {
    index: 166,
    taskType: 'tool-calling',
    complexity: 'low',
    domain: 'tech',
    prompt:
      'You hold 100 ZorgCoins (currency code ZRG). Convert them to US Dollars (USD). ' +
      'You do NOT know the ZRG→USD rate — you MUST call the getExchangeRate tool to obtain it, then multiply. ' +
      'End with exactly one line: `FINAL: <number>` (the USD amount, digits and an optional dot only).',
    judgeRubric:
      'CHECKLIST: [1] Calls getExchangeRate(from=ZRG,to=USD) [2] Uses the returned rate 3.75 [3] 100×3.75=375 [4] FINAL: 375. Score = fraction met.',
    expectedDifficulty: 0.35,
    tools: toolSpecs('getExchangeRate', 'multiply'),
    toolChoice: 'auto',
    expectTool: { name: 'getExchangeRate', argsMatch: { from: 'ZRG', to: 'USD' } },
    answerCheck: { kind: 'numeric_equals', expected: TOOL_TASK_EXPECTED[166] },
  },
  {
    index: 167,
    taskType: 'tool-calling',
    complexity: 'low',
    domain: 'business',
    prompt:
      "How many units of the product with SKU 'QX-9' are currently in stock? " +
      'This is private inventory data you cannot know — you MUST call the lookupInventory tool. ' +
      'End with exactly one line: `FINAL: <number>` (the unit count, digits only).',
    judgeRubric:
      "CHECKLIST: [1] Calls lookupInventory(sku=QX-9) [2] Reports the returned count 4321 [3] FINAL: 4321. Score = fraction met.",
    expectedDifficulty: 0.3,
    tools: toolSpecs('lookupInventory'),
    toolChoice: 'auto',
    expectTool: { name: 'lookupInventory', argsMatch: { sku: 'QX-9' } },
    answerCheck: { kind: 'numeric_equals', expected: TOOL_TASK_EXPECTED[167] },
  },
  {
    index: 168,
    taskType: 'tool-calling',
    complexity: 'medium',
    domain: 'business',
    prompt:
      'A customer buys 8 items priced at 12 Quibit (currency code QBT) each. What is the total cost in US Dollars (USD)? ' +
      'You do NOT know the QBT→USD rate — call the getExchangeRate tool for it (the multiply tool is available for the arithmetic). ' +
      'Compute total QBT = 8×12, then convert to USD. End with exactly one line: `FINAL: <number>` (USD, digits and an optional dot only).',
    judgeRubric:
      'CHECKLIST: [1] Calls getExchangeRate(from=QBT,to=USD) [2] Rate 12.5 [3] 8×12=96 QBT [4] 96×12.5=1200 USD [5] FINAL: 1200. Score = fraction met.',
    expectedDifficulty: 0.5,
    tools: toolSpecs('getExchangeRate', 'multiply'),
    toolChoice: 'auto',
    expectTool: { name: 'getExchangeRate', argsMatch: { from: 'QBT', to: 'USD' } },
    answerCheck: { kind: 'numeric_equals', expected: TOOL_TASK_EXPECTED[168] },
  },
  {
    index: 169,
    taskType: 'tool-calling',
    complexity: 'medium',
    domain: 'tech',
    prompt:
      "Each unit of the product with SKU 'ZP-7' weighs 3 kg. What is the total weight, in kilograms, of ALL units currently in stock? " +
      'The stock count is private data — call the lookupInventory tool to get it (the multiply tool is available). ' +
      'End with exactly one line: `FINAL: <number>` (total kg, digits only).',
    judgeRubric:
      "CHECKLIST: [1] Calls lookupInventory(sku=ZP-7) [2] Count 1580 [3] 1580×3=4740 [4] FINAL: 4740. Score = fraction met.",
    expectedDifficulty: 0.5,
    tools: toolSpecs('lookupInventory', 'multiply'),
    toolChoice: 'auto',
    expectTool: { name: 'lookupInventory', argsMatch: { sku: 'ZP-7' } },
    answerCheck: { kind: 'numeric_equals', expected: TOOL_TASK_EXPECTED[169] },
  },
];
