// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cross-provider fallback execution primitive.
 *
 * The problem this solves: every capability route (embeddings, moderations,
 * audio, images, etc.) was independently re-implementing "find a model that
 * supports X, try it, on failure try the next one". The implementations
 * diverged in subtle ways — some bailed on the first error when the user
 * specified a model explicitly, some only considered a single catalog row per
 * model name, some swallowed errors instead of accumulating attempt
 * diagnostics. The result was that a single dead provider could 503 the entire
 * capability even though five other live rows were sitting in the catalog.
 *
 * `executeWithFallback` consolidates the contract:
 *   1. Discover ALL catalog rows that declare the requested capability.
 *   2. If the caller named a model explicitly, narrow to rows whose name/id
 *      matches it AND that still declare the capability.
 *   3. Resolve adapters via the registry; drop rows whose provider isn't
 *      reachable (missing key, circuit open, etc.).
 *   4. Optionally probe the adapter for actual implementation of the method
 *      we're about to call (catalog says "embeddings" but the adapter base
 *      class throws? Skip it.).
 *   5. Order via `rankRetryCandidates` (tier → bandit → sourcePriority).
 *   6. Execute up to `maxCandidates` rows in order, classifying each failure
 *      and accumulating a structured `attempts[]` record.
 *   7. Return the first success, or throw `FallbackExhaustedError` carrying
 *      the full attempt log so the route handler can surface it as a
 *      structured 503 envelope.
 *
 * What it deliberately doesn't do:
 *   - Bandit reward update. The route knows business semantics (cost, quality)
 *     better than we do; it should call `providerBandit.recordSuccess/failure`
 *     after the call site receives the response.
 *   - Per-attempt timeout. Adapter base class already wraps with bulkheads and
 *     adaptive timeouts; layering another timer would double-fire.
 *   - Streaming. The primitive returns a single Promise<TResponse>; streaming
 *     routes need their own contract because the failure point can be
 *     mid-stream rather than at request time.
 */
import type { Logger } from 'pino';
import { logger } from '@/utils/logger';
import { ApplicationError } from '@/utils/custom-errors';
import { rankRetryCandidates } from './retry-candidate-ranking';
import { getModelRepository } from '@/services/model-repository';
import type { ProviderRegistry } from '@/providers/provider-registry';
import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { Model, ModelCapability } from '@/types';

/** Heuristic taxonomy for why a candidate attempt failed. */
export type FallbackErrorClass =
  | 'quota_exhausted'
  | 'auth'
  | 'rate_limit'
  | 'capability_mismatch'
  | 'provider_unavailable'
  | 'timeout'
  | 'bad_request'
  | 'not_found'
  | 'other';

/** One row of the structured attempt log returned to callers. */
export interface CandidateAttempt {
  model: string;
  modelId: string;
  provider: string;
  status: 'success' | 'failed' | 'skipped';
  errorClass?: FallbackErrorClass;
  errorMessage?: string;
  statusCode?: number;
  durationMs: number;
}

/** Successful resolution returned from the primitive. */
export interface FallbackResult<TResponse> {
  response: TResponse;
  selectedModel: Model;
  selectedAdapter: ProviderAdapter;
  attempts: CandidateAttempt[];
}

/** Caller-controlled inputs to the primitive. */
export interface FallbackOptions<TResponse> {
  /** One or more capabilities the candidate must declare. Any-match. */
  capability: ModelCapability | ModelCapability[];
  /** Optional model name/id the user requested explicitly. */
  explicit?: string | null;
  /**
   * Absolute safety backstop on attempts (defaults to the FULL ranked
   * candidate pool — no artificial truncation). This is deliberately NOT the
   * primary governor of "how many candidates to try" — see `deadlineMs`.
   * Only set this if you need a hard structural ceiling for a reason
   * unrelated to search depth (e.g. a test asserting exact attempt count).
   */
  maxCandidates?: number;
  /**
   * Wall-clock budget (ms) for the WHOLE search, checked before each
   * sequential attempt — NOT a per-attempt timeout (per-attempt bounding is
   * the adapter's job, see class doc). Replaces candidate-COUNT ceilings:
   * a count tied to "how many providers exist today" needs bumping every
   * time the catalog grows; this doesn't. Omit (or pass `Infinity`) to try
   * every ranked candidate with no time bound — only do that for callers
   * that already impose their own outer deadline.
   */
  deadlineMs?: number;
  /** Registry used for adapter resolution. */
  registry: ProviderRegistry;
  /** The capability call to attempt against each (model, adapter). */
  execute: (model: Model, adapter: ProviderAdapter) => Promise<TResponse>;
  /**
   * Optional adapter-level capability probe. Catalog metadata can lie (we've
   * seen it); when the route knows how to detect "this adapter doesn't
   * actually implement the method we're calling", pass that predicate here.
   */
  supportsCapability?: (adapter: ProviderAdapter) => boolean;
  /**
   * Optional bandit scores (provider name → Beta sample). Used by
   * `rankRetryCandidates` to break ties within a tier. Pass an empty map for
   * deterministic ordering.
   */
  banditScores?: ReadonlyMap<string, number>;
  /** Human-readable label used in error messages and logs. */
  capabilityLabel?: string;
  /** Optional logger child for attempt-level visibility. */
  log?: Pick<Logger, 'info' | 'warn'>;
  /**
   * Optional pre-fetched catalog. When supplied, the primitive skips the
   * default `getModelRepository().searchModels()` call. Useful for callers
   * that already filtered by tenant/quality/etc., and for unit tests that
   * want to drive the inner loop deterministically without standing up
   * Prisma.
   */
  catalog?: Model[];
  /**
   * Race the first N viable candidates in parallel before falling through to
   * sequential. First success wins (Promise.any semantics); failures populate
   * `attempts[]`. If all N race participants fail, sequential fallback
   * resumes from candidate (N+1).
   *
   * Default: 1 (pure sequential, current behavior). Capped at `maxCandidates`
   * and at the actual queue length.
   *
   * Use this for capabilities where cold-start latency dominates (audio,
   * speech, real-time generation) — racing 2-3 candidates amortizes the
   * cold-start across providers so the fastest one wins. Don't use for
   * cost-sensitive routes (embeddings, moderation) where the extra
   * invocations cost more than the latency saving — racing here means N×
   * provider charges per request.
   *
   * Trade-off you accept by setting > 1: when one racer wins, slower
   * in-flight calls keep running on the provider side (we don't have a
   * cancellation hook). Their attempt records still land in `attempts[]`
   * eventually, but after the function has returned. For diagnostics this
   * is fine; for billing it isn't free.
   */
  parallelDegree?: number;
}

/**
 * Thrown when every viable candidate fails. Carries the full attempt log so
 * the route handler can surface it to the client.
 */
export class FallbackExhaustedError extends ApplicationError {
  public readonly attempts: CandidateAttempt[];
  public readonly capabilityLabel: string;

  constructor(capabilityLabel: string, attempts: CandidateAttempt[]) {
    const summary = attempts
      .map((a) => `${a.provider}/${a.model}=${a.errorClass ?? a.status}`)
      .join('; ');
    super(
      `All ${capabilityLabel} candidates failed: ${summary || 'no attempts'}`,
      503,
      'capability_dependency_unavailable',
      { capability: capabilityLabel, attempts },
    );
    this.name = 'FallbackExhaustedError';
    this.attempts = attempts;
    this.capabilityLabel = capabilityLabel;
  }
}

/**
 * Thrown when no rows match before any execution attempt was made:
 * - explicit model name resolves to nothing in catalog, or
 * - no catalog row declares the capability at all.
 *
 * Distinct from `FallbackExhaustedError` because the remediation differs:
 * exhausted = "all providers we tried are broken", no-candidates = "the model
 * you asked for doesn't exist or has no provider that can serve it".
 */
export class NoFallbackCandidateError extends ApplicationError {
  public readonly capabilityLabel: string;
  public readonly requestedModel: string | null;

  constructor(capabilityLabel: string, explicit?: string | null) {
    const msg = explicit
      ? `Model "${explicit}" not found or does not support ${capabilityLabel}`
      : `No models with ${capabilityLabel} capability are currently available`;
    super(msg, 404, 'no_capability_candidates', {
      capability: capabilityLabel,
      requestedModel: explicit ?? null,
    });
    this.name = 'NoFallbackCandidateError';
    this.capabilityLabel = capabilityLabel;
    this.requestedModel = explicit ?? null;
  }
}

/**
 * Heuristic error → FallbackErrorClass classifier.
 *
 * The provider zoo doesn't agree on error envelopes, so we triangulate on
 * three signals:
 *   - HTTP status code (when the error carries one — `ApplicationError`,
 *     fetch errors, axios errors, custom adapter errors)
 *   - Error name (AbortError → timeout, certain adapter-specific names)
 *   - Message regex (last resort; survives even when the upstream returns
 *     200-with-error-body and we wrapped it ourselves)
 *
 * This is exported so the route layer can re-classify when post-processing
 * the attempts log if needed.
 */
export function classifyFallbackError(err: unknown): {
  errorClass: FallbackErrorClass;
  statusCode?: number;
  message: string;
} {
  if (err === null || err === undefined) {
    return { errorClass: 'other', message: 'unknown error' };
  }

  const errObj = (typeof err === 'object' ? err : null) as Record<string, unknown> | null;
  const message =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : errObj && typeof errObj.message === 'string'
          ? errObj.message
          : String(err);

  const name =
    err instanceof Error
      ? err.name
      : errObj && typeof errObj.name === 'string'
        ? errObj.name
        : '';

  const statusCode =
    errObj && typeof errObj.statusCode === 'number'
      ? errObj.statusCode
      : errObj && typeof errObj.status === 'number'
        ? errObj.status
        : undefined;

  if (name === 'AbortError' || /timeout|timed out|deadline/i.test(message)) {
    return { errorClass: 'timeout', statusCode, message };
  }

  if (statusCode === 401 || /unauthor|invalid api key|invalid bearer|forbidden api key/i.test(message)) {
    return { errorClass: 'auth', statusCode, message };
  }

  if (
    statusCode === 402 ||
    /quota|insufficient.*(credit|balance|fund)|out of credit|payment required|exceed.*usage/i.test(
      message,
    )
  ) {
    return { errorClass: 'quota_exhausted', statusCode, message };
  }

  if (statusCode === 429 || /rate.?limit|too many requests|tpm|rpm/i.test(message)) {
    return { errorClass: 'rate_limit', statusCode, message };
  }

  if (
    statusCode === 503 ||
    /service unavailable|temporarily unavailable|circuit.*open|provider.*unavailable/i.test(message)
  ) {
    return { errorClass: 'provider_unavailable', statusCode, message };
  }

  if (
    /not[\s-_]?support|capability.*mismatch|operation.*not.*allowed|invalid.*endpoint/i.test(
      message,
    )
  ) {
    return { errorClass: 'capability_mismatch', statusCode, message };
  }

  if (statusCode === 404 || /model.*not[\s-_]?found|no such model/i.test(message)) {
    return { errorClass: 'not_found', statusCode, message };
  }

  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return { errorClass: 'bad_request', statusCode, message };
  }

  return { errorClass: 'other', statusCode, message };
}

/**
 * Build the candidate list for a capability. Pure function; takes pre-fetched
 * catalog rows so it's easy to unit-test without standing up Prisma.
 */
export function selectCandidates(params: {
  catalog: Model[];
  capabilities: ModelCapability[];
  explicit?: string | null;
}): Model[] {
  const wanted = new Set(params.capabilities);
  const declares = (m: Model): boolean =>
    Array.isArray(m.capabilities) && m.capabilities.some((c) => wanted.has(c));

  if (params.explicit && params.explicit !== 'auto') {
    const target = params.explicit.toLowerCase();
    return params.catalog.filter(
      (m) =>
        declares(m) &&
        (m.name.toLowerCase() === target ||
          m.id.toLowerCase() === target ||
          (typeof m.displayName === 'string' && m.displayName.toLowerCase() === target)),
    );
  }

  return params.catalog.filter(declares);
}

/**
 * Attempt the requested operation across ranked candidates, returning the
 * first success or an exhausted-error that lists every attempt.
 */
export async function executeWithFallback<TResponse>(
  options: FallbackOptions<TResponse>,
): Promise<FallbackResult<TResponse>> {
  const capabilities = Array.isArray(options.capability)
    ? options.capability
    : [options.capability];
  const capabilityLabel = options.capabilityLabel ?? capabilities.join('|');
  // No default truncation — see FallbackOptions.maxCandidates doc. The real
  // governor of search depth is `deadlineMs` below, checked in the
  // sequential loop.
  const maxCandidates = options.maxCandidates ?? Infinity;
  const deadlineMs = options.deadlineMs ?? Infinity;
  const searchStartedAt = Date.now();
  const log = options.log ?? logger.child({ component: 'execute-with-fallback', capabilityLabel });

  const catalog =
    options.catalog ??
    (await getModelRepository().searchModels({ capabilities, status: 'active' }));

  const matched = selectCandidates({
    catalog,
    capabilities,
    explicit: options.explicit ?? null,
  });

  if (matched.length === 0) {
    throw new NoFallbackCandidateError(capabilityLabel, options.explicit ?? null);
  }

  const resolvable: Model[] = [];
  for (const model of matched) {
    const resolution = options.registry.resolveAdapterForModel(model);
    if (!resolution.adapter) continue;
    if (options.supportsCapability && !options.supportsCapability(resolution.adapter)) continue;
    resolvable.push(model);
  }

  if (resolvable.length === 0) {
    throw new NoFallbackCandidateError(capabilityLabel, options.explicit ?? null);
  }

  rankRetryCandidates(resolvable, options.banditScores ?? new Map());

  const queue = resolvable.slice(0, maxCandidates);
  const attempts: CandidateAttempt[] = [];

  /**
   * Try a single (model, adapter) pair. Always pushes one row to `attempts`
   * (success/failed/skipped). Never throws; the outcome variant tells the
   * caller what to do next.
   *
   * Factored out so both sequential and parallel paths share the same
   * per-candidate accounting + classification logic.
   */
  type Outcome =
    | {
        ok: true;
        response: TResponse;
        selectedModel: Model;
        selectedAdapter: ProviderAdapter;
      }
    | { ok: false };
  const tryCandidate = async (model: Model): Promise<Outcome> => {
    const startedAt = Date.now();
    const resolution = options.registry.resolveAdapterForModel(model);
    const adapter = resolution.adapter;

    if (!adapter) {
      attempts.push({
        model: model.name,
        modelId: model.id,
        provider: model.provider,
        status: 'skipped',
        errorClass: 'provider_unavailable',
        errorMessage: 'adapter no longer resolvable',
        durationMs: Date.now() - startedAt,
      });
      return { ok: false };
    }

    log.info(
      { provider: model.provider, model: model.name, capability: capabilityLabel },
      'fallback: attempting candidate',
    );

    try {
      const response = await options.execute(model, adapter);
      attempts.push({
        model: model.name,
        modelId: model.id,
        provider: model.provider,
        status: 'success',
        durationMs: Date.now() - startedAt,
      });
      return { ok: true, response, selectedModel: model, selectedAdapter: adapter };
    } catch (err) {
      const classified = classifyFallbackError(err);
      attempts.push({
        model: model.name,
        modelId: model.id,
        provider: model.provider,
        status: 'failed',
        errorClass: classified.errorClass,
        errorMessage: classified.message,
        statusCode: classified.statusCode,
        durationMs: Date.now() - startedAt,
      });
      log.warn(
        {
          provider: model.provider,
          model: model.name,
          errorClass: classified.errorClass,
          statusCode: classified.statusCode,
          message: classified.message,
        },
        'fallback: candidate failed, advancing to next',
      );
      return { ok: false };
    }
  };

  // Phase 1: optional parallel race. Skipped entirely when parallelDegree<=1.
  // Promise.any returns on first success; if all racers fail, the catch lets
  // the sequential phase resume from the next index. Slower racers continue
  // on the provider side without us awaiting them.
  const parallelDegree = Math.max(1, Math.min(options.parallelDegree ?? 1, queue.length));
  let cursor = 0;
  if (parallelDegree > 1) {
    const racers = queue.slice(0, parallelDegree);
    cursor = parallelDegree;
    try {
      const winner = await Promise.any(
        racers.map(async (model) => {
          const outcome = await tryCandidate(model);
          if (!outcome.ok) {
            // Reject the inner promise so Promise.any treats this racer as
            // failed and waits for another. The attempt is already recorded.
            throw new Error('racer_failed');
          }
          return outcome;
        }),
      );
      return {
        response: winner.response,
        selectedModel: winner.selectedModel,
        selectedAdapter: winner.selectedAdapter,
        attempts,
      };
    } catch {
      // AggregateError: every racer rejected. attempts[] already has each
      // failure. Fall through to sequential phase from `cursor`.
    }
  }

  // Phase 2: sequential fallback. When parallelDegree<=1 this is the entire
  // loop. When > 1 this picks up after the failed race. Checked BEFORE each
  // attempt (not a per-attempt timeout — see class doc) so a catalog that
  // grows to thousands of candidates per capability never needs a code
  // change: the search simply tries as many as fit in `deadlineMs`.
  for (const model of queue.slice(cursor)) {
    // The deadline never blocks the FIRST attempt of the whole search (across
    // both phases) — deadlineMs:0 means "try exactly one candidate, no
    // further search", not "try zero candidates". Without this guard,
    // `Date.now() - searchStartedAt >= 0` is true immediately, so
    // allow_fallback:false requests exhausted with zero attempts even when
    // the top candidate was healthy (found live, 2026-07-16).
    if (attempts.length > 0 && Date.now() - searchStartedAt >= deadlineMs) {
      log.warn(
        {
          capabilityLabel,
          attemptsTried: attempts.length,
          candidatesRemaining: queue.length - attempts.length,
          deadlineMs,
        },
        'fallback: search deadline exceeded, stopping before exhausting the full candidate pool',
      );
      break;
    }
    const outcome = await tryCandidate(model);
    if (outcome.ok) {
      return {
        response: outcome.response,
        selectedModel: outcome.selectedModel,
        selectedAdapter: outcome.selectedAdapter,
        attempts,
      };
    }
  }

  throw new FallbackExhaustedError(capabilityLabel, attempts);
}
