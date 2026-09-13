// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Inbound Admission Control — SHADOW MODE FIRST.
 *
 * Track 1 §2.1 of `api/docs/CAPACITY-SCALING-PLAN-10K-USERS.md` — "the single
 * missing safety mechanism". Read that section before changing anything here;
 * this file implements it literally, including its safety requirement that
 * this ships observe-only until real thresholds exist.
 *
 * THE GAP THIS CLOSES: three real rate limiters already exist in this
 * codebase (`middleware/api-key-rate-limit-middleware.ts`, the
 * `@fastify/rate-limit` registration in `server.ts`, the token-bucket
 * middleware in `index.ts`) — all of them cap REQUESTS PER TIME WINDOW. None
 * of them cap how many requests are being processed AT ONCE. The one real
 * concurrency gate in this codebase, `core/resilience/distributed-bulkhead.ts`,
 * is scoped to OUTBOUND provider calls, not inbound admission. So a burst of
 * concurrent inbound requests toward the plan's 10k-user target has no code
 * path today that says "we are at capacity, shed load with a controlled
 * response" — this module is that code path.
 *
 * TWO MECHANISMS, NOT ONE (plan §2.1's own conclusion, restated here because
 * it is easy to "simplify" this file into just one and quietly lose the
 * axis that actually protects against this app's dominant failure mode):
 *
 *   1. `@fastify/under-pressure` for the RESOURCE-PRESSURE axis (event-loop
 *      lag, heap, RSS, event-loop utilization). Good fit for CPU/memory-bound
 *      failure (both API service replicas already peg a full core at baseline
 *      per the plan's live investigation), poor fit for a pile-up of
 *      I/O-bound requests parked on an `await` that never spikes the event
 *      loop.
 *   2. A custom in-flight-request counter (onRequest/onResponse hook pair)
 *      for the RAW-CONCURRENCY axis, scoped to the expensive routes (chat
 *      completions, responses, and their equivalents — see
 *      EXPENSIVE_ROUTE_PATTERNS below), since that is what actually protects
 *      the DB pool and memory from an I/O-bound pile-up that event-loop
 *      metrics would miss.
 *
 * WHY SHADOW MODE FIRST (plan §2.1, Appendix B): the resource-pressure
 * thresholds below are REASONED FROM CONTAINER LIMITS, NOT FROM A LOAD TEST —
 * no load test has ever produced a committed result in this repo (plan §3.7).
 * `maxEventLoopDelay`/`maxEventLoopUtilization` and the in-flight cap have NO
 * suggested numbers at all; the plan is explicit that guessing them risks
 * shedding legitimate traffic (this app's own CPU-bound bursts — catalog
 * refresh, triage heuristics — can spike event-loop lag legitimately). So:
 *
 *   - `ADMISSION_CONTROL_ENABLED` (default true): the master switch. Default
 *     true is zero-risk because shadow mode never rejects anything — it only
 *     logs and increments metrics.
 *   - `ADMISSION_CONTROL_ENFORCE` (default FALSE): flips the pressureHandler
 *     and the in-flight cap from log-only to actually sending 503 +
 *     Retry-After. Turning this on is a config flip (punch-list item 8 in
 *     the plan), not a new deploy — but it must not happen before at least
 *     one real traffic cycle has been observed in shadow mode.
 *
 * WHY LONG TIMEOUTS ARE UNTOUCHED: `server.ts` sets 5-10 minute connection/
 * request timeouts deliberately, because collective/debate/expert-panel
 * orchestration strategies genuinely take that long. Nothing in this module
 * imposes a per-request duration limit — it only gates ADMISSION (whether a
 * new request is accepted at all) at the moment it arrives. An
 * already-admitted long-running request is never touched by this module
 * again.
 *
 * STRUCTURAL CAVEAT — PER-PROCESS STATE (plan §2.1, verbatim reasoning):
 * both `@fastify/under-pressure` and the in-flight counter below are
 * PER-PROCESS. With 2 API service replicas, a per-replica threshold effectively
 * multiplies fleet-wide capacity by 2 — the *exact same* footgun
 * `docs/audit/16` documented for the old in-memory provider bulkhead (fixed
 * via `distributed-bulkhead.ts`'s Redis-backed fleet-wide semaphore). At a
 * FIXED 2-replica count this is a known, currently-tolerable limitation, not
 * something this task needs to solve — if/when replica count becomes
 * dynamic, a per-process cap stops being sound and would need the same
 * Redis-leased-semaphore treatment `distributed-bulkhead.ts` already uses as
 * a pattern. Do not "fix" this by reaching for Redis here without that being
 * a deliberate, separately-reviewed follow-up.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '@/utils/logger';
import {
  admissionControlInFlightRequests,
  admissionControlPressureEventsTotal,
  admissionControlRejectedTotal,
} from '@/observability/ci-metrics';

const log = logger.child({ component: 'admission-control' });

// ──────────────────────────────────────────────────────────────────────────
// Config (env-driven, mirrors this codebase's existing `process.env.X ||
// default` idiom used throughout server.ts/index.ts rather than the
// config/index.ts getEnv* helpers, which are private to that module).
// ──────────────────────────────────────────────────────────────────────────

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return defaultValue;
  return normalized === 'true' || normalized === '1';
}

/** Returns `undefined` (not a default) when unset/invalid — several of this
 *  module's thresholds are deliberately unset until a load test exists, and
 *  "unset" must stay distinguishable from "set to some fallback number". */
function parsePositiveNumberEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function parsePositiveNumberEnvWithDefault(raw: string | undefined, defaultValue: number): number {
  return parsePositiveNumberEnv(raw) ?? defaultValue;
}

/**
 * Master switch. Default true — shadow mode is zero-risk (log-only). Read
 * live (not snapshotted at module load) so tests can toggle it per case via
 * `vi.stubEnv` without needing `vi.resetModules()`, and so a future operator
 * change is visible without relying on import order.
 */
export function isAdmissionControlEnabled(): boolean {
  return parseBooleanEnv(process.env.ADMISSION_CONTROL_ENABLED, true);
}

/**
 * Flips the pressureHandler and the in-flight cap from log-only to actually
 * rejecting with 503 + Retry-After. MUST default false — see module comment.
 * Read live for the same reason as isAdmissionControlEnabled() above.
 */
export function isAdmissionControlEnforcing(): boolean {
  return parseBooleanEnv(process.env.ADMISSION_CONTROL_ENFORCE, false);
}

const GB = 1024 * 1024 * 1024;

/**
 * ~2.8GB — REVISED FROM REAL SHADOW-MODE DATA (2026-09-10), no longer a pure
 * container-limit guess. This module has been running in shadow mode in
 * production since 2026-09-07 (`ADMISSION_CONTROL_ENFORCE` still false the
 * whole time); pulling the periodic resource-pressure sample logs from both
 * API service replicas over a full, uninterrupted ~24h window (2,868 + 2,863
 * samples at the default 30s cadence — see `startPressureMetricsLogger`)
 * gives real percentiles instead of a guess:
 *
 *   heapUsedBytes (MB): p50 ~973-1013, p95 ~1713-1715, p99 ~1924-1928,
 *   p99.9 ~2250-2282, max 2457.46 (combined-replica max).
 *
 * The PREVIOUS default (2.5GB / 2560MB) left only ~103MB (~4%) of margin
 * above that real 24h max — under completely normal, non-adversarial
 * traffic (this window included zero actual pressure-handler firings; see
 * below). That thin a margin means enabling `ADMISSION_CONTROL_ENFORCE`
 * with the old number would likely start rejecting healthy requests soon
 * after real traffic grows even slightly, not just during genuine
 * overload — exactly the false-positive risk this module's own module doc
 * warns about. 2.8GB (2,936,012,800 bytes) restores a ~14% margin above the
 * real observed max (matching `DEFAULT_MAX_RSS_BYTES`'s own real-vs-limit
 * margin below) while staying a further ~272MB under the 3GB V8
 * `--max-old-space-size` ceiling (`docker/docker-compose.production.yml`)
 * — enforcement should trip BEFORE V8 itself starts GC-thrashing near its
 * own ceiling, not at the same moment. Override via
 * ADMISSION_CONTROL_MAX_HEAP_USED_BYTES if a later observation window
 * shows a different real ceiling.
 *
 * IMPORTANT CAVEAT carried forward from the same real data: production
 * traffic during this measurement window was genuinely low (~315-360
 * inbound requests/24h per replica — see the in-flight caveat on
 * `DEFAULT_MAX_IN_FLIGHT_REQUESTS`... except no such default exists, see
 * that section below). This heap number reflects real GC/background-job
 * behavior (catalog refresh, discovery, scheduled jobs) at TODAY's traffic
 * level, not a stress test — it is a real, evidence-based number, but not
 * a capacity-planning ceiling for 10k-user load. Re-derive once traffic
 * grows materially or a deliberate load test exists.
 */
const DEFAULT_MAX_HEAP_USED_BYTES = 2.8 * GB;

/**
 * ~3.6GB — now CROSS-CHECKED against the same real 24h shadow-mode window
 * (see `DEFAULT_MAX_HEAP_USED_BYTES` above for the full methodology):
 * rssBytes (MB) p50 ~1800-1849, p95 ~2451-2479, p99 ~2632-2643, p99.9
 * ~2866-2896, max 3185.52 (combined-replica max). The existing 3.6GB
 * (3686.4MB) default already sits ~500MB (~16%) above that real max —
 * independently landing almost exactly on the same "~max x 1.15" margin
 * ratio `DEFAULT_MAX_HEAP_USED_BYTES` was just revised to hit — so this
 * number is being LEFT AS-IS, now validated by real data rather than pure
 * container-limit reasoning. It also still leaves ~410MB before the 4G
 * container hard limit (`docker/docker-compose.production.yml`) for the
 * Swarm/cgroup OOM-killer margin the original reasoning called for.
 * Override via ADMISSION_CONTROL_MAX_RSS_BYTES.
 */
const DEFAULT_MAX_RSS_BYTES = 3.6 * GB;

/**
 * NO DEFAULT EXISTS for `maxEventLoopDelayMs`/`maxEventLoopUtilization`
 * (see `AdmissionControlThresholds` below — both stay `undefined` unless an
 * operator explicitly sets them) and there still isn't enough SAFE real
 * signal to add one. The same 24h shadow-mode pull that justified the two
 * revisions above also measured:
 *
 *   eventLoopUtilized: p50 ~0.38-0.47, p95 ~0.85-0.88, p99 ~0.95-0.96,
 *   max ~0.97 — i.e. ALREADY pegged near-saturated at the tail under
 *   completely normal operation, not overload.
 *   eventLoopDelayMs: p50 ~0.2, p95 ~5, p99 ~13-95 (the two replicas
 *   disagreed by ~7x here), p99.9 ~422-507, max 899-3247ms (one replica hit
 *   a 3.2-SECOND event-loop stall with zero user-visible incident).
 *
 * This heavy-tailed, replica-inconsistent shape is exactly what this
 * module's own module doc predicted ("this app's own CPU-bound bursts —
 * catalog refresh, triage heuristics — can spike event-loop lag
 * legitimately") — it is corroborated by real, independent evidence from
 * the same measurement window: `SLOW QUERY DETECTED` fired 3,127 times and
 * `candidate.trace` logged 104,193 times on ONE replica in 24h. Any single
 * static threshold in the practically-useful range (roughly 100-1000ms)
 * would already fire on routine background bursts, not genuine inbound
 * overload — enabling enforcement on this axis today would reject healthy
 * requests during normal catalog-refresh/discovery/slow-query windows.
 * Left unset deliberately; `under-pressure` still samples and logs both
 * metrics regardless (`startPressureMetricsLogger`) so the signal keeps
 * accumulating. The `SLOW QUERY DETECTED` / `candidate.trace` volume is a
 * separate, real performance follow-up, not an admission-control problem.
 *
 * Similarly, `maxInFlightRequests` (see `AdmissionControlThresholds`) has
 * NO safe real number to derive either, for the opposite reason: the same
 * window's `inFlightRequests` field read exactly 0 at every single one of
 * the 5,731 combined 30s samples. Real inbound traffic during this window
 * was genuinely low (~315-360 "Request received" log lines per replica per
 * 24h, i.e. roughly one request every 4-7 minutes) — a 30s point-in-time
 * sample essentially never catches two requests overlapping at that volume,
 * so "always 0" is a low-traffic artifact, not evidence that real
 * concurrency has a ceiling anywhere near 0. Setting a number here from
 * this data would be inventing it, not observing it. Leave unset until
 * traffic grows enough to produce real non-zero samples, or a deliberate,
 * separately-approved load test exists (out of scope for this change).
 */

/** Plan's suggested range is 10-15s; only governs the Retry-After header on
 *  newly REJECTED requests, never the 5-10 minute timeouts of already
 *  admitted ones. */
const DEFAULT_RETRY_AFTER_SECONDS = 12;

/** under-pressure's own internal default is 1000ms; kept explicit + tunable
 *  rather than silently inherited. */
const DEFAULT_SAMPLE_INTERVAL_MS = 1000;

/** How often the shadow-mode resource sampler logs a structured snapshot of
 *  all four `under-pressure` metrics (including the two with no enforcing
 *  threshold set — this is the "measure before guessing" instrumentation
 *  the plan asks for). */
const DEFAULT_METRICS_LOG_INTERVAL_MS = 30_000;

/** Every Nth expensive-route request, log the current in-flight count. Doing
 *  this on every single request would spam logs at real traffic volume;
 *  the Prometheus gauge (`admissionControlInFlightRequests`) already carries
 *  the full-resolution series for anyone scraping /metrics. */
const DEFAULT_IN_FLIGHT_LOG_EVERY_N = 50;

export interface AdmissionControlThresholds {
  maxHeapUsedBytes: number;
  maxRssBytes: number;
  /** `undefined` = under-pressure still samples/exposes this metric, but
   *  never triggers pressureHandler for it. Deliberately unset by default —
   *  plan §2.1: "must be measured, not guessed". */
  maxEventLoopDelayMs: number | undefined;
  /** Same reasoning as maxEventLoopDelayMs. */
  maxEventLoopUtilization: number | undefined;
  /** `undefined` = the in-flight cap never rejects, regardless of
   *  ADMISSION_CONTROL_ENFORCE — plan §2.1: "derive from the load test in
   *  §3.7, do not hardcode a guess". */
  maxInFlightRequests: number | undefined;
  retryAfterSeconds: number;
  sampleIntervalMs: number;
  metricsLogIntervalMs: number;
  inFlightLogEveryN: number;
}

export function resolveAdmissionControlThresholds(): AdmissionControlThresholds {
  return {
    maxHeapUsedBytes: parsePositiveNumberEnvWithDefault(
      process.env.ADMISSION_CONTROL_MAX_HEAP_USED_BYTES,
      DEFAULT_MAX_HEAP_USED_BYTES
    ),
    maxRssBytes: parsePositiveNumberEnvWithDefault(
      process.env.ADMISSION_CONTROL_MAX_RSS_BYTES,
      DEFAULT_MAX_RSS_BYTES
    ),
    maxEventLoopDelayMs: parsePositiveNumberEnv(
      process.env.ADMISSION_CONTROL_MAX_EVENT_LOOP_DELAY_MS
    ),
    maxEventLoopUtilization: parsePositiveNumberEnv(
      process.env.ADMISSION_CONTROL_MAX_EVENT_LOOP_UTILIZATION
    ),
    maxInFlightRequests: parsePositiveNumberEnv(process.env.ADMISSION_CONTROL_MAX_IN_FLIGHT),
    retryAfterSeconds: parsePositiveNumberEnvWithDefault(
      process.env.ADMISSION_CONTROL_RETRY_AFTER_SECONDS,
      DEFAULT_RETRY_AFTER_SECONDS
    ),
    sampleIntervalMs: parsePositiveNumberEnvWithDefault(
      process.env.ADMISSION_CONTROL_SAMPLE_INTERVAL_MS,
      DEFAULT_SAMPLE_INTERVAL_MS
    ),
    metricsLogIntervalMs: parsePositiveNumberEnvWithDefault(
      process.env.ADMISSION_CONTROL_METRICS_LOG_INTERVAL_MS,
      DEFAULT_METRICS_LOG_INTERVAL_MS
    ),
    inFlightLogEveryN: Math.max(
      1,
      Math.trunc(
        parsePositiveNumberEnvWithDefault(
          process.env.ADMISSION_CONTROL_IN_FLIGHT_LOG_EVERY_N,
          DEFAULT_IN_FLIGHT_LOG_EVERY_N
        )
      )
    ),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Expensive-route scope (mechanism 2: the in-flight counter)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Routes that actually invoke a model/provider (the I/O-bound work this
 * counter exists to protect against) — NOT health/auth/admin/CRUD routes.
 * Enumerated from the real route registrations under `src/routes/*` rather
 * than guessed: chat completions and Responses are the plan's named
 * examples; the rest are their direct equivalents (other endpoints that
 * call out to a model/provider synchronously on the request path).
 *
 * Deliberately excluded: health/status/metrics/auth (plan's explicit "not
 * health/auth"), and CRUD-only routes that don't themselves invoke a model
 * (e.g. creating a thread, listing assistants, batch/file management) —
 * only a thread RUN executes a model, so only `.../runs` is in scope, not
 * `/v1/threads` itself.
 */
const EXPENSIVE_ROUTE_PATTERNS: readonly RegExp[] = [
  /^\/v1\/chat\/completions(?:\/|$)/, // includes /extended-thinking, /ultra-thinking sub-paths
  /^\/v1\/responses(?:\/|$)/,
  /^\/v1\/collective\/runs(?:\/|$)/, // collective/debate/expert-panel orchestration
  /^\/v1\/embeddings(?:\/|$)/,
  /^\/v1\/rerank(?:\/|$)/,
  /^\/v1\/audio\//, // speech, transcriptions, translations
  /^\/v1\/images\//, // generations, edits, variations
  /^\/v1\/videos\/generations(?:\/|$)/,
  /^\/v1\/capabilities\/[^/]+\/(?:execute|stream)$/, // capability-first universal execution
  /^\/v1\/threads\/[^/]+\/runs(?:\/|$)/, // Assistants API: only runs invoke a model
  /^\/v1\/workflows\/execute$/,
];

export function isExpensiveRoute(pathname: string): boolean {
  return EXPENSIVE_ROUTE_PATTERNS.some((pattern) => pattern.test(pathname));
}

/** Coarser label for the Prometheus `route` label so cardinality stays
 *  bounded (path params like thread/run ids must never become label
 *  values). Falls back to the first two path segments for anything not in
 *  the explicit map, which for this allowlisted set is always a fixed
 *  prefix, never a param. */
function routeLabel(pathname: string): string {
  const segments = pathname.split('/').filter(Boolean);
  return `/${segments.slice(0, 3).join('/')}`;
}

function extractPathname(request: FastifyRequest): string {
  const url = request.url || '';
  const queryIndex = url.indexOf('?');
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

// ──────────────────────────────────────────────────────────────────────────
// In-flight counter state
// ──────────────────────────────────────────────────────────────────────────

/** Per-process in-flight count across all expensive routes. Exported read
 *  accessor for tests and (in enforce mode) the cap check. */
let inFlightCount = 0;

/** Request-scoped marker so onResponse/onError/'close' can each safely
 *  decrement exactly once regardless of which fires first or whether more
 *  than one fires for the same request (error paths can trigger several). */
const trackedRequests = new WeakSet<FastifyRequest>();

export function getInFlightRequestCount(): number {
  return inFlightCount;
}

/** Test-only: reset module-level state between test files/cases. Never
 *  called from production code paths. */
export function __resetAdmissionControlStateForTests(): void {
  inFlightCount = 0;
}

function decrementInFlight(request: FastifyRequest, pathname: string): void {
  if (!trackedRequests.has(request)) return;
  trackedRequests.delete(request);
  inFlightCount = Math.max(0, inFlightCount - 1);
  admissionControlInFlightRequests.dec({ route: routeLabel(pathname) });
}

/**
 * Registers the in-flight counter's onRequest/onResponse/onError hooks, plus
 * a raw-socket 'close' fallback so a client disconnect that never reaches
 * Fastify's own onResponse/onError (e.g. the connection is destroyed before
 * a reply is ever produced) still decrements. All four decrement call sites
 * funnel through `decrementInFlight`, which is idempotent per request via
 * `trackedRequests` — a leaked counter that never decrements on failure
 * would be worse than no counter at all, so every exit path is covered
 * rather than relying on the happy-path hook alone.
 */
function registerInFlightCounter(
  server: FastifyInstance,
  thresholds: AdmissionControlThresholds
): void {
  // Async (request, reply) signature — matches this codebase's own hook
  // convention (see api/middleware/request-context.ts, gateway_middleware.ts's
  // quotaValidationHook): sending a reply and returning ends the chain,
  // Fastify checks `reply.sent` itself, no explicit `done()` bookkeeping.
  server.addHook('onRequest', async (request, reply) => {
    const pathname = extractPathname(request);
    if (!isExpensiveRoute(pathname)) return;

    if (
      isAdmissionControlEnforcing() &&
      thresholds.maxInFlightRequests !== undefined &&
      inFlightCount >= thresholds.maxInFlightRequests
    ) {
      admissionControlRejectedTotal.inc({ route: routeLabel(pathname), reason: 'in_flight_cap' });
      log.warn(
        {
          route: pathname,
          inFlight: inFlightCount,
          cap: thresholds.maxInFlightRequests,
          requestId: request.id,
        },
        'Admission control: in-flight request cap exceeded — rejecting (enforce mode)'
      );
      reply.header('Retry-After', String(thresholds.retryAfterSeconds));
      reply.code(503).send({
        error: {
          code: 'service_unavailable',
          message: 'Server is at maximum concurrent-request capacity; please retry shortly.',
          type: 'admission_control_error',
          retryAfter: thresholds.retryAfterSeconds,
        },
      });
      return;
    }

    trackedRequests.add(request);
    inFlightCount += 1;
    admissionControlInFlightRequests.inc({ route: routeLabel(pathname) });

    if (inFlightCount % thresholds.inFlightLogEveryN === 0) {
      log.info(
        { inFlight: inFlightCount, route: pathname, requestId: request.id },
        'Admission control: in-flight request count (shadow instrumentation)'
      );
    }

    // Safety net: a client that disconnects before Fastify ever produces a
    // response (socket destroyed mid-flight) may not always reach
    // onResponse/onError. `decrementInFlight` is idempotent per request
    // (guarded by `trackedRequests`), so this never double-decrements
    // alongside the hooks below.
    request.raw.once('close', () => decrementInFlight(request, pathname));
  });

  server.addHook('onResponse', async (request) => {
    decrementInFlight(request, extractPathname(request));
  });

  server.addHook('onError', async (request) => {
    decrementInFlight(request, extractPathname(request));
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Resource-pressure axis (mechanism 1: @fastify/under-pressure)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Custom pressureHandler: ALWAYS logs + increments the pressure-events
 * counter; only sends a 503 when ADMISSION_CONTROL_ENFORCE is true. Per
 * @fastify/under-pressure's documented contract, a pressureHandler that
 * returns nullish without calling `reply.send()` lets the request proceed
 * normally — that is exactly shadow mode's required behavior, not a
 * workaround.
 */
function buildPressureHandler(
  thresholds: AdmissionControlThresholds
): (request: FastifyRequest, reply: FastifyReply, type: string, value: number | undefined) => void {
  return (request, reply, type, value) => {
    admissionControlPressureEventsTotal.inc({ metric: type });
    const enforceMode = isAdmissionControlEnforcing();

    log.warn(
      {
        metric: type,
        value,
        route: extractPathname(request),
        method: request.method,
        requestId: request.id,
        enforceMode,
      },
      enforceMode
        ? `Admission control: resource pressure (${type}) — rejecting (enforce mode)`
        : `Admission control: resource pressure (${type}) — shadow mode, request proceeds`
    );

    if (!enforceMode) {
      return; // shadow mode: log + metric only, do NOT call reply.send()
    }

    admissionControlRejectedTotal.inc({
      route: routeLabel(extractPathname(request)),
      reason: `pressure_${type}`,
    });
    reply.header('Retry-After', String(thresholds.retryAfterSeconds));
    reply.code(503).send({
      error: {
        code: 'service_unavailable',
        message: 'Server is under resource pressure; please retry shortly.',
        type: 'admission_control_error',
        retryAfter: thresholds.retryAfterSeconds,
      },
    });
  };
}

let metricsLogTimer: NodeJS.Timeout | null = null;

/**
 * Periodic structured log of ALL FOUR under-pressure metrics — including
 * eventLoopDelay/eventLoopUtilization, which have no enforcing threshold set
 * by default. `under-pressure` computes and exposes these regardless of
 * whether a `max*` option is configured for them (see
 * `fastify.memoryUsage()`); this is the "measure before guessing" step the
 * plan asks for so a real number can eventually replace the "ship in shadow
 * mode" placeholder in Appendix B.
 */
function startPressureMetricsLogger(
  server: FastifyInstance,
  thresholds: AdmissionControlThresholds
): void {
  if (process.env.NODE_ENV === 'test') return;
  if (metricsLogTimer) return; // idempotent — already running

  metricsLogTimer = setInterval(() => {
    try {
      const usage = server.memoryUsage();
      log.info(
        {
          eventLoopDelayMs: usage.eventLoopDelay,
          eventLoopUtilized: usage.eventLoopUtilized,
          heapUsedBytes: usage.heapUsed,
          rssBytes: usage.rssBytes,
          inFlightRequests: inFlightCount,
          enforceMode: isAdmissionControlEnforcing(),
        },
        'Admission control: periodic resource-pressure sample'
      );
    } catch (error) {
      log.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Admission control: failed to sample resource pressure'
      );
    }
  }, thresholds.metricsLogIntervalMs);
  metricsLogTimer.unref();
}

/** Exported for graceful-shutdown symmetry with cache-refresh-ahead.ts's
 *  stopCacheRefreshAhead() pattern, and for tests. */
export function stopPressureMetricsLogger(): void {
  if (metricsLogTimer) {
    clearInterval(metricsLogTimer);
    metricsLogTimer = null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Public entry point
// ──────────────────────────────────────────────────────────────────────────

export async function registerAdmissionControl(server: FastifyInstance): Promise<void> {
  if (!isAdmissionControlEnabled()) {
    log.warn(
      'Admission control DISABLED via ADMISSION_CONTROL_ENABLED=false — no resource-pressure or in-flight-concurrency protection is active'
    );
    return;
  }

  const thresholds = resolveAdmissionControlThresholds();

  const underPressure = (await import('@fastify/under-pressure')).default;
  await server.register(underPressure, {
    maxHeapUsedBytes: thresholds.maxHeapUsedBytes,
    maxRssBytes: thresholds.maxRssBytes,
    // Deliberately undefined by default (plan §2.1: "must be measured, not
    // guessed"). under-pressure still samples + exposes these via
    // `server.memoryUsage()` regardless — see startPressureMetricsLogger.
    maxEventLoopDelay: thresholds.maxEventLoopDelayMs,
    maxEventLoopUtilization: thresholds.maxEventLoopUtilization,
    retryAfter: thresholds.retryAfterSeconds * 1000,
    sampleInterval: thresholds.sampleIntervalMs,
    pressureHandler: buildPressureHandler(thresholds),
    // No exposeStatusRoute: this codebase already has /v1/status and
    // /metrics; a third status surface would be redundant and risks path
    // collision. The Prometheus gauges/counters above + the periodic log
    // are this rollout's observability surface.
    exposeStatusRoute: false,
  });

  registerInFlightCounter(server, thresholds);
  startPressureMetricsLogger(server, thresholds);

  const enforceMode = isAdmissionControlEnforcing();
  log.info(
    {
      enforceMode,
      maxHeapUsedBytes: thresholds.maxHeapUsedBytes,
      maxRssBytes: thresholds.maxRssBytes,
      maxEventLoopDelayMs: thresholds.maxEventLoopDelayMs ?? 'unset (measure first)',
      maxEventLoopUtilization: thresholds.maxEventLoopUtilization ?? 'unset (measure first)',
      maxInFlightRequests: thresholds.maxInFlightRequests ?? 'unset (measure first)',
      retryAfterSeconds: thresholds.retryAfterSeconds,
    },
    enforceMode
      ? '⚠️ Admission control ENFORCING — pressure/in-flight-cap breaches will be rejected with 503'
      : '✅ Admission control registered in SHADOW MODE (log-only — no request is ever rejected by this layer yet). ' +
          'Per-process only: with 2 API service replicas this multiplies fleet-wide capacity by 2 (see module comment).'
  );
}
