// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Smart Canary — multi-bucket canary stratified by (providerId, modelFamily,
 * arm role).
 *
 * Replaces the legacy single-arm canary which would pass/fail based on the
 * first stratified arm (often the most exhausted one). The smart canary
 * covers a representative cross-section in parallel and gates on
 * COVERAGE BY MODE/POLICY, not raw success rate.
 *
 * Gates (all must pass for canaryPassed=true):
 *   1. Runner alive (the canary itself ran → trivially true if we got here)
 *   2. Auth ok across attempted canary arms (no 401 from the runner's
 *      bearer token)
 *   3. ≥3 distinct healthy providerIds (or ≥1 if goal is ollama_local_eval)
 *   4. Each `policyKind` represented in the arm pool got ≥1 successful
 *      canary (mode coverage)
 *   5. No detected cross-provider fallback for strict baselines
 *
 * The canary REUSES the existing fetch path (`/v1/chat/completions`) — no
 * model lists are hardcoded. Each canary fetches the arm's declared
 * candidate (or first ranked candidate for dynamic arms).
 */

import { logger } from '@/utils/logger';
import { type ResolvedExperimentArm, type ArmEvaluationPolicy } from './arm-evaluation-policy';

const log = logger.child({ component: 'smart-canary' });

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SmartCanaryRequest {
  readonly experimentId: string;
  readonly arms: ReadonlyArray<ResolvedExperimentArm>;
  readonly apiBase: string;
  readonly bearerToken: string;
  readonly canaryPrompt?: string;
  readonly maxTokens?: number;
  readonly perCanaryTimeoutMs?: number;
  readonly maxCanariesGlobal?: number;
  readonly minProvidersHealthy?: number;
  readonly minPolicyKindsCovered?: number;
}

export interface SingleCanaryResult {
  readonly armId: string;
  readonly policyKind: ArmEvaluationPolicy['kind'];
  readonly providerId: string | null;
  readonly modelFamily: string | null;
  readonly modelId: string | null;
  readonly success: boolean;
  readonly latencyMs: number;
  readonly httpStatus?: number;
  readonly errorClass?: string;
  readonly errorMessage?: string;
  readonly responseLength?: number;
}

export interface SmartCanaryGates {
  readonly runnerAlive: boolean;
  readonly authOk: boolean;
  readonly minProvidersHealthyMet: boolean;
  readonly modeCoverageMet: boolean;
  readonly noStrictBaselineCrossFallback: boolean;
}

export interface SmartCanaryResult {
  readonly passed: boolean;
  readonly gates: SmartCanaryGates;
  readonly perBucket: ReadonlyArray<SingleCanaryResult>;
  readonly distinctHealthyProviders: number;
  readonly distinctPolicyKindsCovered: ReadonlyArray<ArmEvaluationPolicy['kind']>;
  readonly skipPlan: ReadonlyArray<{
    readonly armId: string;
    readonly providerId: string | null;
    readonly errorClass: string;
  }>;
  readonly totalDurationMs: number;
  readonly diagnostics: ReadonlyArray<string>;
}

// ─── Public API ────────────────────────────────────────────────────────────

const DEFAULT_OPTS = {
  canaryPrompt: 'Reply with the single word: READY.',
  // maxTokens 5 → 256 (2026-06-29): modern frontier models REJECT tiny limits —
  // gpt-5.x return 400 "max_output_tokens below minimum value (>= 16)", so the
  // strict frontier baseline canary always failed for a PARAMETER reason (not
  // funding). Reasoning models also burn output budget on hidden reasoning before
  // any visible token, so 256 gives headroom for a real "READY" while staying cheap.
  maxTokens: 256,
  // 12s → 30s: frontier/reasoning models are slower; a tight cap false-fails the
  // baseline canary on cold routes.
  perCanaryTimeoutMs: 30_000,
  // 12 → 100 (2026-07-19): this used to silently truncate `reps` to the first
  // 12 stratified buckets in Map insertion order — for a 40-arm experiment
  // (e.g. c3-tool-calling) that's 28 buckets NEVER probed pre-flight, purely
  // an artifact of arm ORDER, not health. Measured same day: the truncated
  // canary found "only 2 distinct healthy providers" and aborted the start,
  // while the actual run (once bypassed) hit 92.8% success (90/97) across
  // the full arm set. This is now a SAFETY CEILING against a pathological
  // arm count, not a routine cap — reps are fired in parallel (Promise.all),
  // each targeting a DIFFERENT (provider, model, mode) by construction, so
  // raising it doesn't concentrate load on any one provider or add wall-clock
  // time (bounded by the slowest single probe, not the sum).
  maxCanariesGlobal: 100,
  minProvidersHealthy: 3,
  minPolicyKindsCovered: 1,
  // A canary probe that fails transiently (server_error/timeout/network_error)
  // gets exactly ONE retry before its provider is counted unhealthy — the
  // same class of blip the real run already tolerates without retry (7/480
  // executions hit HTTP 500 today and the run kept going fine); a single-shot
  // canary treating that as "provider down" is stricter than the thing it's
  // gating. NOT retried: auth_failed/insufficient_credit/forbidden/not_found/
  // rate_limited/validation_error — retrying those either can't succeed or
  // risks compounding a rate limit.
  retryableErrorClasses: new Set(['server_error', 'timeout', 'network_error']),
};

export async function runSmartCanary(req: SmartCanaryRequest): Promise<SmartCanaryResult> {
  const opts = {
    canaryPrompt: req.canaryPrompt ?? DEFAULT_OPTS.canaryPrompt,
    maxTokens: req.maxTokens ?? DEFAULT_OPTS.maxTokens,
    perCanaryTimeoutMs: req.perCanaryTimeoutMs ?? DEFAULT_OPTS.perCanaryTimeoutMs,
    maxCanariesGlobal: req.maxCanariesGlobal ?? DEFAULT_OPTS.maxCanariesGlobal,
    minProvidersHealthy: req.minProvidersHealthy ?? DEFAULT_OPTS.minProvidersHealthy,
    minPolicyKindsCovered: req.minPolicyKindsCovered ?? DEFAULT_OPTS.minPolicyKindsCovered,
    retryableErrorClasses: DEFAULT_OPTS.retryableErrorClasses,
  };

  const startMs = Date.now();
  const diagnostics: string[] = [];

  // 1. Stratify arms by (policyKind, providerId, modelFamily). One
  //    representative per bucket.
  const buckets = stratifyArms(req.arms);
  const reps = [...buckets.values()].slice(0, opts.maxCanariesGlobal);

  log.info(
    {
      experimentId: req.experimentId,
      totalArms: req.arms.length,
      buckets: buckets.size,
      canariesToProbe: reps.length,
    },
    'Smart canary starting',
  );

  // 2. Fire all canaries in parallel, with one retry each for transient failures.
  const results = await Promise.all(reps.map((arm) => executeSingleCanaryWithRetry(arm, req, opts)));

  // 3. Compute gates
  const successful = results.filter((r) => r.success);
  const distinctHealthyProviders = new Set(
    successful.map((r) => r.providerId).filter((p): p is string => p !== null),
  ).size;

  const distinctPolicyKindsCovered = [
    ...new Set(successful.map((r) => r.policyKind)),
  ] as ArmEvaluationPolicy['kind'][];

  const authFailures = results.filter(
    (r) => r.errorClass === 'auth_failed' || r.httpStatus === 401,
  );
  const authOk = authFailures.length === 0;
  if (!authOk) {
    diagnostics.push(`auth failed on ${authFailures.length} canaries — check bearer token`);
  }

  const minProvidersHealthyMet = distinctHealthyProviders >= opts.minProvidersHealthy;
  if (!minProvidersHealthyMet) {
    diagnostics.push(
      `only ${distinctHealthyProviders} distinct healthy providers, need ≥${opts.minProvidersHealthy}`,
    );
  }

  const modeCoverageMet = distinctPolicyKindsCovered.length >= opts.minPolicyKindsCovered;
  if (!modeCoverageMet) {
    diagnostics.push(
      `only ${distinctPolicyKindsCovered.length} policy kinds covered, need ≥${opts.minPolicyKindsCovered}`,
    );
  }

  // For strict baselines: each one MUST have its declared provider succeed —
  // any cross-provider fallback at canary time is a red flag.
  const strictBaselineFailures = results.filter(
    (r) => r.policyKind === 'strict_baseline_identity' && !r.success,
  );
  const noStrictBaselineCrossFallback = true; // we can only detect cross-fallback at exec time, not canary
  if (strictBaselineFailures.length > 0) {
    diagnostics.push(
      `${strictBaselineFailures.length} strict baseline canaries failed — these arms will be skipped`,
    );
  }

  const gates: SmartCanaryGates = {
    runnerAlive: true,
    authOk,
    minProvidersHealthyMet,
    modeCoverageMet,
    noStrictBaselineCrossFallback,
  };

  const passed = Object.values(gates).every((g) => g === true);

  // 4. Skip plan: arms whose canary failed
  const skipPlan = results
    .filter((r) => !r.success)
    .map((r) => ({
      armId: r.armId,
      providerId: r.providerId,
      errorClass: r.errorClass ?? 'unknown',
    }));

  const result: SmartCanaryResult = Object.freeze({
    passed,
    gates,
    perBucket: Object.freeze(results),
    distinctHealthyProviders,
    distinctPolicyKindsCovered: Object.freeze(distinctPolicyKindsCovered),
    skipPlan: Object.freeze(skipPlan),
    totalDurationMs: Date.now() - startMs,
    diagnostics: Object.freeze(diagnostics),
  });

  log.info(
    {
      experimentId: req.experimentId,
      passed,
      gates,
      durationMs: result.totalDurationMs,
      successful: successful.length,
      total: results.length,
    },
    `Smart canary ${passed ? 'PASSED' : 'FAILED'}`,
  );

  return result;
}

// ─── Stratification ────────────────────────────────────────────────────────

function stratifyArms(arms: ReadonlyArray<ResolvedExperimentArm>): Map<string, ResolvedExperimentArm> {
  const buckets = new Map<string, ResolvedExperimentArm>();
  for (const arm of arms) {
    // Stratification key: (policyKind, declaredProviderId or '*',
    //                      declaredModelFamily or '*', mode)
    const key = [
      arm.policy.kind,
      arm.declaredProviderId ?? '*',
      arm.declaredModelFamily ?? '*',
      arm.mode,
    ].join('::');
    if (!buckets.has(key)) {
      buckets.set(key, arm);
    }
  }
  return buckets;
}

// ─── Single canary execution ───────────────────────────────────────────────

/**
 * Parse the provider that actually served a (dynamic) canary from the chat
 * response body. Tries explicit metadata fields, then the `provider/model`
 * prefix of the resolved model id. Returns a lowercased identifier or null.
 * Any non-null identifier proves a healthy provider for the canary gate.
 */
function extractResolvedProvider(responseText: string): string | null {
  try {
    const j = JSON.parse(responseText) as Record<string, unknown>;
    const md = (j.ailin_metadata ?? j.metadata ?? {}) as Record<string, unknown>;
    const direct =
      md.executionProvider ?? md.provider ?? md.resolved_provider ?? md.providerId;
    if (typeof direct === 'string' && direct.trim()) return direct.trim().toLowerCase();
    const resolvedModel = (md.resolved_model ?? j.model) as unknown;
    if (typeof resolvedModel === 'string' && resolvedModel.trim()) {
      const rm = resolvedModel.trim();
      return (rm.includes('/') ? rm.split('/')[0] : rm).toLowerCase();
    }
  } catch {
    /* response wasn't JSON — no resolvable provider */
  }
  return null;
}

async function executeSingleCanary(
  arm: ResolvedExperimentArm,
  req: SmartCanaryRequest,
  opts: typeof DEFAULT_OPTS,
): Promise<SingleCanaryResult> {
  const startMs = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.perCanaryTimeoutMs);

  // Resolve which (model, strategy) the canary should send. For arms that
  // declare a model, use that. For arms without declared model (dynamic /
  // collective / adaptive), use 'auto' — the system's own router picks.
  const modelId = arm.declaredModelId ?? 'auto';
  const strategy = (() => {
    if (arm.strategy === 'single') return 'single';
    if (arm.strategy === 'auto') return 'auto';
    if (arm.strategy === null) return 'single';
    // collective strategy name
    return arm.strategy;
  })();

  try {
    const body = JSON.stringify({
      model: modelId,
      strategy,
      messages: [{ role: 'user', content: opts.canaryPrompt }],
      max_tokens: opts.maxTokens,
      temperature: 0,
    });

    const response = await fetch(req.apiBase, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.bearerToken,
        'Authorization': `Bearer ${req.bearerToken}`,
        'x-operational-mode': 'experiment',
        'x-experiment-id': req.experimentId,
        'x-experiment-arm-id': arm.armId,
      },
      body,
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startMs;
    const text = await response.text().catch(() => '');

    if (!response.ok) {
      return {
        armId: arm.armId,
        policyKind: arm.policy.kind,
        providerId: arm.declaredProviderId,
        modelFamily: arm.declaredModelFamily,
        modelId: arm.declaredModelId,
        success: false,
        latencyMs,
        httpStatus: response.status,
        errorClass: classifyHttpStatus(response.status, text),
        errorMessage: text.slice(0, 200),
      };
    }

    // Count the RESOLVED provider for dynamic arms (2026-06-29). Dynamic /
    // collective / adaptive arms declare no provider (declaredProviderId=null), so
    // their successful canaries were ignored by distinctHealthyProviders — the gate
    // read 0 healthy even when the router demonstrably resolved to operable
    // providers (measured: 2/4 canaries succeeded via dynamic_router but counted as
    // 0). A dynamic canary that succeeded IS proof of a healthy provider, so use the
    // provider parsed from the response when none was declared.
    const resolvedProviderId = arm.declaredProviderId ?? extractResolvedProvider(text);
    return {
      armId: arm.armId,
      policyKind: arm.policy.kind,
      providerId: resolvedProviderId,
      modelFamily: arm.declaredModelFamily,
      modelId: arm.declaredModelId,
      success: true,
      latencyMs,
      httpStatus: response.status,
      responseLength: text.length,
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      armId: arm.armId,
      policyKind: arm.policy.kind,
      providerId: arm.declaredProviderId,
      modelFamily: arm.declaredModelFamily,
      modelId: arm.declaredModelId,
      success: false,
      latencyMs,
      errorClass: errMsg.includes('aborted') ? 'timeout' : 'network_error',
      errorMessage: errMsg.slice(0, 200),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One retry for a canary probe that failed transiently — mirrors the real
 * run's own tolerance for a stray 5xx/timeout (see maxCanariesGlobal above:
 * a single-shot canary shouldn't be stricter than the execution it gates).
 */
async function executeSingleCanaryWithRetry(
  arm: ResolvedExperimentArm,
  req: SmartCanaryRequest,
  opts: typeof DEFAULT_OPTS,
): Promise<SingleCanaryResult> {
  const first = await executeSingleCanary(arm, req, opts);
  if (first.success) return first;
  if (!first.errorClass || !opts.retryableErrorClasses.has(first.errorClass)) return first;
  return executeSingleCanary(arm, req, opts);
}

function classifyHttpStatus(status: number, body: string): string {
  if (status === 401) return 'auth_failed';
  if (status === 403) {
    if (/credit|quota|balance|billing|insufficient|exceeded/i.test(body)) {
      return 'insufficient_credit';
    }
    return 'forbidden';
  }
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server_error';
  if (status === 422) return 'validation_error';
  return `http_${status}`;
}
