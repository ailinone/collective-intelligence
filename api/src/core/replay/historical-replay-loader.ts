// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-replay-loader.ts — MVP 8B.5
 *
 * Reads an exported JSONL stream and produces a sanitised list of
 * `HistoricalReplayExecution`. The loader NEVER opens a network socket
 * and NEVER touches the DB. It works on a string (so it stays trivially
 * testable) and on a file path via `readJsonl`.
 *
 * Sanitisation rules — applied to every parsed row:
 *   - strip any `prompt`, `response`, `messages`, `rawContext`,
 *     `judgeRubric`, `structuredMetadata` field
 *   - normalise numeric fields (judge_score, cost_usd, latency_ms)
 *   - normalise array fields (models_used, provider_routes)
 *   - drop rows missing `experimentId`, `executionId`, `taskType`,
 *     `strategyId` (these are required for the backtest to function)
 *
 * Pure. Deterministic. Never mutates input.
 */

import { readFileSync } from 'node:fs';
import type {
  HistoricalReplayExecution,
  ReplayComplexity,
  ReplayModality,
} from './historical-replay-types';

// ─── Forbidden fields — stripped from every row ─────────────────────────

const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  'prompt',
  'response',
  'response_summary',
  'messages',
  'rawContext',
  'context',
  'raw_context',
  'attachments',
  'judge_rubric',
  'judgeRubric',
  'structured_metadata',
  'structuredMetadata',
  'userMessage',
  'user_message',
  'rawPrompt',
  'raw_prompt',
]);

// ─── Public API ─────────────────────────────────────────────────────────

export interface ReplayLoaderResult {
  readonly executions: readonly HistoricalReplayExecution[];
  readonly skipped: readonly { readonly raw: string; readonly reason: string }[];
}

export function loadFromJsonl(jsonl: string): ReplayLoaderResult {
  const lines = jsonl.split('\n');
  const out: HistoricalReplayExecution[] = [];
  const skipped: { raw: string; reason: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push({ raw: line.slice(0, 80), reason: 'invalid_json' });
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      skipped.push({ raw: line.slice(0, 80), reason: 'not_an_object' });
      continue;
    }
    const sanitised = sanitiseRow(parsed as Record<string, unknown>);
    const ex = buildExecution(sanitised);
    if (!ex) {
      skipped.push({ raw: line.slice(0, 80), reason: 'missing_required_fields' });
      continue;
    }
    out.push(ex);
  }
  return Object.freeze({
    executions: Object.freeze(out),
    skipped: Object.freeze(skipped),
  });
}

export function readJsonlFile(path: string): ReplayLoaderResult {
  const text = readFileSync(path, 'utf-8');
  return loadFromJsonl(text);
}

// ─── Internals ──────────────────────────────────────────────────────────

function sanitiseRow(
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (FORBIDDEN_FIELDS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function buildExecution(
  raw: Record<string, unknown>,
): HistoricalReplayExecution | null {
  const executionId = pickString(raw, ['executionId', 'execution_id', 'id']);
  const experimentId = pickString(raw, ['experimentId', 'experiment_id']);
  const taskType = pickString(raw, ['taskType', 'task_type']);
  const strategyId = pickString(raw, ['strategyId', 'strategy', 'strategy_id']);
  if (!executionId || !experimentId || !taskType || !strategyId) return null;

  const taskId =
    pickString(raw, ['taskId', 'task_id']) ??
    buildTaskId(experimentId, raw);

  const modelsUsed = pickStringArray(raw, ['modelsUsed', 'models_used']);
  if (modelsUsed.length === 0) return null;

  const effectiveStrategyId =
    pickString(raw, ['effectiveStrategyId', 'effective_strategy_id']) ?? strategyId;

  return Object.freeze({
    executionId,
    experimentId,
    taskId,
    createdAt: pickString(raw, ['createdAt', 'created_at']) ?? undefined,
    taskType,
    complexity: pickComplexity(raw),
    strategyId,
    effectiveStrategyId,
    modelsUsed: Object.freeze(modelsUsed),
    providerRoutes: pickStringArrayOpt(raw, ['providerRoutes', 'provider_routes']),
    judgeScore: pickNumberOrNull(raw, ['judgeScore', 'judge_score']),
    costUsd: pickNumberOrNull(raw, ['costUsd', 'cost_usd']),
    latencyMs: pickNumberOrNullOpt(raw, ['latencyMs', 'latency_ms']),
    success: pickBoolean(raw, ['success']) ?? true,
    failureMode: pickString(raw, ['failureMode', 'failure_mode']) ?? null,
    degraded: pickBooleanOpt(raw, ['degraded']),
    degradationReason: pickString(raw, ['degradationReason', 'degradation_reason']) ?? null,
    modality: pickModality(raw),
  });
}

function buildTaskId(
  experimentId: string,
  raw: Record<string, unknown>,
): string {
  const idx = raw.task_index ?? raw.taskIndex ?? '';
  const rep = raw.repetition ?? 0;
  return `${experimentId}::${String(idx)}::${String(rep)}`;
}

function pickString(
  raw: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickStringArray(
  raw: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  for (const k of keys) {
    const v = raw[k];
    if (Array.isArray(v)) {
      const out: string[] = [];
      for (const item of v) {
        if (typeof item === 'string' && item.length > 0) out.push(item);
      }
      return out;
    }
    if (typeof v === 'string') {
      // Postgres array literal: {a,b,c}
      const trimmed = v.trim();
      if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        return parsePgArray(trimmed);
      }
    }
  }
  return [];
}

function pickStringArrayOpt(
  raw: Record<string, unknown>,
  keys: readonly string[],
): readonly string[] | undefined {
  const arr = pickStringArray(raw, keys);
  return arr.length > 0 ? Object.freeze(arr) : undefined;
}

function parsePgArray(literal: string): string[] {
  const inner = literal.slice(1, -1);
  if (inner.length === 0) return [];
  const parts = inner.split(',');
  const out: string[] = [];
  for (const p of parts) {
    let v = p.trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.length > 0) out.push(v);
  }
  return out;
}

function pickNumberOrNull(
  raw: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

function pickNumberOrNullOpt(
  raw: Record<string, unknown>,
  keys: readonly string[],
): number | null | undefined {
  const v = pickNumberOrNull(raw, keys);
  return v === null ? undefined : v;
}

function pickBoolean(
  raw: Record<string, unknown>,
  keys: readonly string[],
): boolean | null {
  for (const k of keys) {
    const v = raw[k];
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 't') return true;
    if (v === 'false' || v === 'f') return false;
  }
  return null;
}

function pickBooleanOpt(
  raw: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  const v = pickBoolean(raw, keys);
  return v === null ? undefined : v;
}

function pickComplexity(
  raw: Record<string, unknown>,
): ReplayComplexity | undefined {
  const v = pickString(raw, ['complexity']);
  if (v === 'low' || v === 'medium' || v === 'high' || v === 'extreme') return v;
  return undefined;
}

function pickModality(
  raw: Record<string, unknown>,
): ReplayModality | undefined {
  const v = pickString(raw, ['modality']);
  if (v === 'text' || v === 'image' || v === 'audio' || v === 'video' || v === 'mixed') {
    return v;
  }
  return undefined;
}
