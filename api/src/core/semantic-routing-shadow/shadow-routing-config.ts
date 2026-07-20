// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-config.ts — MVP 8C.0
 *
 * Env-driven config for the shadow routing layer. All defaults are
 * CONSERVATIVE: feature flag off, sample rate 0, decision mode legacy.
 * Missing env vars resolve to OFF.
 *
 * The config is read ONCE at module-load via `loadShadowConfigFromEnv`.
 * Tests can inject their own config via `resolveShadowConfig`.
 *
 * Pure. No I/O beyond a single env read.
 */

export type ShadowDecisionMode = 'legacy' | 'shadow';
export type ShadowLogLevel = 'off' | 'debug' | 'info' | 'warn' | 'error';
export type ShadowWriteMode = 'log_only' | 'metrics_only' | 'log_and_metrics';

export interface ShadowRoutingConfig {
  readonly enabled: boolean;
  readonly sampleRate: number; // [0, 1]
  readonly logLevel: ShadowLogLevel;
  readonly maxLatencyMs: number;
  readonly taskTypes: readonly string[];
  readonly writeMode: ShadowWriteMode;
  readonly decisionMode: ShadowDecisionMode;
  readonly source: 'env' | 'override' | 'default';
}

export const DEFAULT_SHADOW_CONFIG: ShadowRoutingConfig = Object.freeze({
  enabled: false,
  sampleRate: 0,
  logLevel: 'off',
  maxLatencyMs: 25,
  taskTypes: Object.freeze(['code-generation']),
  writeMode: 'log_only',
  decisionMode: 'legacy',
  source: 'default',
});

/**
 * Resolves an override on top of the defaults. Conservative: any
 * out-of-range value clamps to the safe default.
 */
export function resolveShadowConfig(
  override?: Partial<ShadowRoutingConfig>,
): ShadowRoutingConfig {
  if (!override) return DEFAULT_SHADOW_CONFIG;
  return Object.freeze({
    enabled: override.enabled === true,
    sampleRate: clamp01(override.sampleRate ?? DEFAULT_SHADOW_CONFIG.sampleRate),
    logLevel: pickLogLevel(override.logLevel) ?? DEFAULT_SHADOW_CONFIG.logLevel,
    maxLatencyMs: clampLatency(
      override.maxLatencyMs ?? DEFAULT_SHADOW_CONFIG.maxLatencyMs,
    ),
    taskTypes: Object.freeze(
      override.taskTypes && override.taskTypes.length > 0
        ? [...override.taskTypes]
        : [...DEFAULT_SHADOW_CONFIG.taskTypes],
    ),
    writeMode: pickWriteMode(override.writeMode) ?? DEFAULT_SHADOW_CONFIG.writeMode,
    decisionMode:
      pickDecisionMode(override.decisionMode) ?? DEFAULT_SHADOW_CONFIG.decisionMode,
    source: override.source ?? 'override',
  });
}

// ─── Env loader ─────────────────────────────────────────────────────────

/**
 * Reads the env (process.env) ONCE and returns a frozen config.
 * Missing or malformed env vars resolve to safe defaults.
 *
 * The runtime SHOULD call this exactly once at boot and inject the
 * resulting config into the ShadowRoutingService. Tests should NOT
 * call this directly — they use `resolveShadowConfig` with explicit
 * overrides.
 */
export function loadShadowConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ShadowRoutingConfig {
  return Object.freeze({
    enabled: readBool(env.SEMANTIC_ROUTING_SHADOW_ENABLED) ?? false,
    sampleRate: clamp01(readNumber(env.SEMANTIC_ROUTING_SHADOW_SAMPLE_RATE) ?? 0),
    logLevel:
      pickLogLevel(env.SEMANTIC_ROUTING_SHADOW_LOG_LEVEL as ShadowLogLevel | undefined) ??
      'off',
    maxLatencyMs: clampLatency(
      readNumber(env.SEMANTIC_ROUTING_SHADOW_MAX_LATENCY_MS) ?? 25,
    ),
    taskTypes: Object.freeze(parseTaskTypes(env.SEMANTIC_ROUTING_SHADOW_TASKTYPES)),
    writeMode:
      pickWriteMode(env.SEMANTIC_ROUTING_SHADOW_WRITE_MODE as ShadowWriteMode | undefined) ??
      'log_only',
    decisionMode:
      pickDecisionMode(
        env.SEMANTIC_ROUTING_DECISION_MODE as ShadowDecisionMode | undefined,
      ) ?? 'legacy',
    source: 'env',
  });
}

// ─── Helpers (pure) ─────────────────────────────────────────────────────

function readBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
}

function readNumber(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function clampLatency(v: number): number {
  if (!Number.isFinite(v)) return 25;
  if (v < 1) return 1;
  if (v > 500) return 500;
  return Math.floor(v);
}

function pickLogLevel(v: ShadowLogLevel | undefined): ShadowLogLevel | undefined {
  if (v === 'off' || v === 'debug' || v === 'info' || v === 'warn' || v === 'error') {
    return v;
  }
  return undefined;
}

function pickWriteMode(v: ShadowWriteMode | undefined): ShadowWriteMode | undefined {
  if (v === 'log_only' || v === 'metrics_only' || v === 'log_and_metrics') {
    return v;
  }
  return undefined;
}

function pickDecisionMode(
  v: ShadowDecisionMode | undefined,
): ShadowDecisionMode | undefined {
  if (v === 'legacy' || v === 'shadow') return v;
  return undefined;
}

function parseTaskTypes(v: string | undefined): string[] {
  if (!v) return [...DEFAULT_SHADOW_CONFIG.taskTypes];
  return v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
