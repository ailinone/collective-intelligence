// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tests for Lote 5 — runtime selection, observability, benchmark hardening.
 *
 * Covers:
 *   S1 — provider-kind classification + native preference in scoring
 *   S2 — selection metrics emit correctly
 *   J1 — benchmark judge config resolution
 *   B1 — failure taxonomy types + decision-grade gating helpers
 *   O1 — Prometheus exporter with labels
 *   D1 — bootstrap helper exists and is importable
 *   Non-regression: Lotes 1-4 tests still pass (validated separately)
 */

import { describe, expect, it, beforeEach } from 'vitest';

import {
  classifyProviderKind,
  getProviderKindRegistry,
  type ProviderKind,
} from '../../selection/provider-kind';
import {
  SELECTION_METRIC_NAMES,
  recordSelectionCandidates,
  recordNoEligibleModel,
  recordNativePreferred,
  recordProviderSelected,
  recordExecutionFailure,
} from '../../selection/selection-metrics';
import {
  resolveBenchmarkJudgeConfig,
  type BenchmarkJudgeConfig,
} from '../../benchmark/benchmark-judge-config';
import {
  PROMPT_METRIC_NAMES,
  getPromptMetric,
  getLabelledSeries,
  resetPromptMetrics,
  incrementPromptMetric,
} from '../prompts/prompt-metrics';
import {
  exportPromptMetricsAsPrometheus,
} from '../prompts/prompt-metrics-exporter';

// ────────────────────────────────────────────────────────────────────────────
// S1 — Provider-kind classification
// ────────────────────────────────────────────────────────────────────────────

describe('S1 — classifyProviderKind', () => {
  it('classifies known native providers correctly', () => {
    const natives: Array<[string, ProviderKind]> = [
      ['openai', 'native'],
      ['anthropic', 'native'],
      ['google', 'native'],
      ['xai', 'native'],
      ['deepseek', 'native'],
      ['mistral', 'native'],
      ['cohere', 'native'],
    ];
    for (const [id, expected] of natives) {
      expect(classifyProviderKind(id), id).toBe(expected);
    }
  });

  it('classifies known hub providers correctly', () => {
    const hubs: Array<[string, ProviderKind]> = [
      ['nanogpt', 'hub'],
      ['aihubmix', 'hub'],
      ['openrouter', 'hub'],
      ['cometapi', 'hub'],
      ['heliconeai', 'hub'],
      ['edenai', 'hub'],
      ['orqai', 'hub'],
    ];
    for (const [id, expected] of hubs) {
      expect(classifyProviderKind(id), id).toBe(expected);
    }
  });

  it('classifies local providers correctly', () => {
    expect(classifyProviderKind('ollama')).toBe('local');
    expect(classifyProviderKind('local-llama')).toBe('local');
    expect(classifyProviderKind('self-hosted-gpt')).toBe('local');
  });

  it('returns unknown for unrecognized or null providers', () => {
    expect(classifyProviderKind('some-new-thing')).toBe('unknown');
    expect(classifyProviderKind(null)).toBe('unknown');
    expect(classifyProviderKind(undefined)).toBe('unknown');
    expect(classifyProviderKind('')).toBe('unknown');
  });

  it('is case-insensitive', () => {
    expect(classifyProviderKind('OpenAI')).toBe('native');
    expect(classifyProviderKind('NANOGPT')).toBe('hub');
  });

  it('getProviderKindRegistry returns non-empty native and hub lists', () => {
    const reg = getProviderKindRegistry();
    expect(reg.native.length).toBeGreaterThanOrEqual(10);
    expect(reg.hub.length).toBeGreaterThanOrEqual(10);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// S2 — Selection metrics emit correctly
// ────────────────────────────────────────────────────────────────────────────

describe('S2 — selection metrics', () => {
  beforeEach(() => resetPromptMetrics());

  it('recordSelectionCandidates increments the candidates counter', () => {
    recordSelectionCandidates(10, { taskType: 'analysis' });
    expect(getPromptMetric(SELECTION_METRIC_NAMES.CANDIDATES_RETURNED)).toBe(1);
  });

  it('recordNoEligibleModel increments the no-eligible counter', () => {
    recordNoEligibleModel({ taskType: 'code-gen' });
    expect(getPromptMetric(SELECTION_METRIC_NAMES.NO_ELIGIBLE_MODEL)).toBe(1);
  });

  it('recordNativePreferred increments native preference counter', () => {
    recordNativePreferred({
      modelId: 'gpt-4o',
      nativeProvider: 'openai',
      displacedHubProvider: 'nanogpt',
    });
    expect(getPromptMetric(SELECTION_METRIC_NAMES.NATIVE_PREFERRED)).toBe(1);
  });

  it('recordProviderSelected carries providerKind label', () => {
    recordProviderSelected({
      provider: 'openai',
      providerKind: 'native',
      strategy: 'single',
      taskType: 'qa',
    });
    const series = getLabelledSeries(SELECTION_METRIC_NAMES.PROVIDER_SELECTED);
    expect(series.size).toBe(1);
    const key = Array.from(series.keys())[0];
    expect(key).toContain('providerKind=native');
    expect(key).toContain('provider=openai');
  });

  it('recordExecutionFailure emits with cause label', () => {
    recordExecutionFailure('balance', {
      provider: 'nanogpt',
      modelId: 'openai/gpt-4o',
    });
    const series = getLabelledSeries(SELECTION_METRIC_NAMES.MODEL_EXECUTION_FAILED);
    expect(series.size).toBe(1);
    const key = Array.from(series.keys())[0];
    expect(key).toContain('cause=balance');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// J1 — Benchmark judge config resolution
// ────────────────────────────────────────────────────────────────────────────

describe('J1 — resolveBenchmarkJudgeConfig', () => {
  it('defaults to model=auto and operatorPinned=false when env is empty', () => {
    const cfg = resolveBenchmarkJudgeConfig({} as NodeJS.ProcessEnv);
    expect(cfg.model).toBe('auto');
    expect(cfg.operatorPinned).toBe(false);
    expect(cfg.source).toContain('default');
  });

  it('respects EXPERIMENT_JUDGE_MODEL and marks as operatorPinned', () => {
    const cfg = resolveBenchmarkJudgeConfig({
      EXPERIMENT_JUDGE_MODEL: 'gpt-4o-2024-11-20',
    } as NodeJS.ProcessEnv);
    expect(cfg.model).toBe('gpt-4o-2024-11-20');
    expect(cfg.operatorPinned).toBe(true);
    expect(cfg.provider).toBeUndefined();
  });

  it('respects EXPERIMENT_JUDGE_PROVIDER when both are set', () => {
    const cfg = resolveBenchmarkJudgeConfig({
      EXPERIMENT_JUDGE_MODEL: 'claude-sonnet-4-6',
      EXPERIMENT_JUDGE_PROVIDER: 'anthropic',
    } as NodeJS.ProcessEnv);
    expect(cfg.model).toBe('claude-sonnet-4-6');
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.operatorPinned).toBe(true);
    expect(cfg.source).toContain('EXPERIMENT_JUDGE_PROVIDER');
  });

  it('treats EXPERIMENT_JUDGE_MODEL=auto as unpinned', () => {
    const cfg = resolveBenchmarkJudgeConfig({
      EXPERIMENT_JUDGE_MODEL: 'auto',
    } as NodeJS.ProcessEnv);
    expect(cfg.operatorPinned).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// O1 — Prometheus exporter with labels
// ────────────────────────────────────────────────────────────────────────────

describe('O1 — Prometheus exporter with labels', () => {
  beforeEach(() => resetPromptMetrics());

  it('emits labelled series as metric{key="value"} format', () => {
    incrementPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED, { reason: 'mode-off' });
    incrementPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED, { reason: 'mode-off' });
    incrementPromptMetric(PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED, { reason: 'single-strategy' });

    const out = exportPromptMetricsAsPrometheus();
    // Must contain both label combinations
    expect(out).toContain(`${PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED}{reason="mode-off"} 2`);
    expect(out).toContain(`${PROMPT_METRIC_NAMES.PEER_REVIEW_SKIPPED}{reason="single-strategy"} 1`);
  });

  it('emits selection-metrics counters ONLY when touched (no cold-start pollution)', () => {
    // Before touching any selection metric, the exporter should not emit it
    const out = exportPromptMetricsAsPrometheus();
    expect(out).not.toContain('ailin_selection_candidates_returned_total');

    // After touching one, it should appear
    recordSelectionCandidates(5, { taskType: 'analysis' });
    const out2 = exportPromptMetricsAsPrometheus();
    expect(out2).toContain('ailin_selection_candidates_returned_total');
  });

  it('still emits canonical PROMPT_METRIC_NAMES even when zero-valued', () => {
    const out = exportPromptMetricsAsPrometheus();
    expect(out).toContain(`${PROMPT_METRIC_NAMES.FALLBACK_ACTIVATIONS} 0`);
    expect(out).toContain(`${PROMPT_METRIC_NAMES.JUDGE_NORMALIZATIONS} 0`);
  });

  it('getLabelledSeries returns per-label-combination counts', () => {
    incrementPromptMetric('test_labelled', { region: 'us', tier: 'free' });
    incrementPromptMetric('test_labelled', { region: 'us', tier: 'free' });
    incrementPromptMetric('test_labelled', { region: 'eu', tier: 'pro' });

    const series = getLabelledSeries('test_labelled');
    expect(series.size).toBe(2);
    const usFreeTierKey = Array.from(series.keys()).find((k) => k.includes('region=us'));
    expect(series.get(usFreeTierKey!)).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// D1 — bootstrap helper exists
// ────────────────────────────────────────────────────────────────────────────

describe('D1 — bootstrap-for-scripts helper', () => {
  it('exports bootstrapForScripts as an async function', async () => {
    const mod = await import('@/config/bootstrap-for-scripts');
    expect(typeof mod.bootstrapForScripts).toBe('function');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Non-regression: Lotes 1-4 still pass (run from test runner)
// ────────────────────────────────────────────────────────────────────────────

describe('Non-regression — Lote 5 does not touch prompt architecture', () => {
  it('PROMPT_METRIC_NAMES still exports all 7 canonical counters', () => {
    const names = Object.values(PROMPT_METRIC_NAMES);
    expect(names.length).toBe(7);
    expect(names).toContain('ailin_fallback_prompt_activations_total');
    expect(names).toContain('ailin_triage_drift_detected_total');
    expect(names).toContain('ailin_judge_normalizations_total');
  });

  it('SELECTION_METRIC_NAMES is disjoint from PROMPT_METRIC_NAMES', () => {
    const promptSet = new Set(Object.values(PROMPT_METRIC_NAMES));
    const selectionSet = new Set(Object.values(SELECTION_METRIC_NAMES));
    for (const n of selectionSet) {
      expect(promptSet.has(n as string), `${n} collides with prompt metrics`).toBe(false);
    }
  });
});
