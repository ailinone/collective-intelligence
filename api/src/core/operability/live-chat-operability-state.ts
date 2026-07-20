// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-F — Live Chat Operability State.
 *
 * In-memory + optional snapshot-on-disk record of which
 * `(providerId, routeId, modelId)` triples have a recent SUCCESSFUL
 * chat completion vs. a recent NON-RETRYABLE failure. This is the
 * source of truth the planner consults to exclude broken routes from
 * role selection.
 *
 * Why a separate state from `ProviderOperabilityHub`:
 *   - The legacy hub records flat provider-level health (`recordEvent`)
 *     and a coarse route-level key (`recordRouteExecution`). Neither
 *     captures `errorKind` from the body-aware `ProviderErrorClassifier`,
 *     nor enforces cooldowns per error kind.
 *   - This state is additive: it lives next to the hub and feeds the
 *     planner. No schema/db changes; pure in-process memory with an
 *     optional JSON snapshot for cold-start seeding.
 *
 * Source ranking (highest authority first):
 *   1. `direct_chat_probe` — explicit /chat/completions probe with a
 *      tiny prompt (script run-live-chat-operability-audit.ts)
 *   2. `execution_feedback` — real chat call result observed by the
 *      orchestration runtime
 *   3. `manual_override` — operator forced a route to a specific state
 *   4. `unknown` — initial state, no data yet
 */
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import type { ProviderErrorClassification, ProviderErrorKind } from '../orchestration/failures/provider-error-classifier';

export type LiveChatOperabilitySource =
  | 'direct_chat_probe'
  | 'execution_feedback'
  | 'manual_override'
  | 'unknown';

export interface LiveChatOperabilityState {
  readonly providerId: string;
  readonly routeId: string;
  readonly modelId: string;
  readonly canonicalModelId?: string;
  readonly providerKind?: string;

  /** True when most-recent direct-probe or execution-feedback indicates
   *  this route can handle a chat completion right now. */
  readonly chatReady: boolean;
  /** True when this route is eligible for synthesizer/judge selection.
   *  Currently aliased with `chatReady` (no extra hop), but reserved so
   *  future policies can demand stricter signals for critical roles. */
  readonly eligibleForCriticalRole: boolean;

  readonly lastChatSuccessAt?: string;
  readonly lastChatFailureAt?: string;

  readonly lastErrorKind?: ProviderErrorKind;
  readonly lastHttpStatus?: number;
  readonly lastSanitizedMessage?: string;

  /** When set and > now, this route should NOT be selected for any role
   *  until the cooldown expires. */
  readonly cooldownUntil?: string;

  readonly successCountRecent: number;
  readonly failureCountRecent: number;
  readonly latencyP50Ms?: number;
  readonly latencyP95Ms?: number;

  readonly source: LiveChatOperabilitySource;
  readonly updatedAt: string;
}

/** Cooldown durations per error kind. Conservative defaults; operators
 *  can tune via env vars in a future turn. */
const COOLDOWN_MS: Record<ProviderErrorKind, number> = {
  model_not_supported: 24 * 60 * 60 * 1000, // 24h — catalog gap
  insufficient_credits: 6 * 60 * 60 * 1000, // 6h
  consumer_suspended: 24 * 60 * 60 * 1000, // 24h
  invalid_auth: 24 * 60 * 60 * 1000, // 24h
  rate_limited: 5 * 60 * 1000, // 5m default if no retry-after
  timeout: 5 * 60 * 1000, // 5m
  network_error: 5 * 60 * 1000, // 5m
  server_error: 5 * 60 * 1000, // 5m
  bad_request: 6 * 60 * 60 * 1000, // 6h (signals body or schema mismatch)
  unknown: 5 * 60 * 1000, // 5m
};

/** Composite key: `providerId|routeId|modelId`. Stable across snapshot
 *  writes/reads so cold-start can seed without losing route granularity. */
export function buildLiveStateKey(input: {
  providerId: string;
  routeId: string;
  modelId: string;
}): string {
  return `${input.providerId.toLowerCase()}|${input.routeId.toLowerCase()}|${input.modelId.toLowerCase()}`;
}

export interface RecordRouteExecutionInput {
  providerId: string;
  routeId: string;
  modelId: string;
  canonicalModelId?: string;
  providerKind?: string;
  ok: boolean;
  httpStatus?: number;
  errorClassification?: ProviderErrorClassification;
  latencyMs?: number;
  costUsd?: number;
  cooldownMs?: number;
  source: LiveChatOperabilitySource;
  observedAt?: string;
}

/**
 * In-memory store. Singleton-per-process. Snapshot to disk is OPT-IN
 * via `writeSnapshot()`; cold-start hydration is OPT-IN via
 * `loadSnapshot()`.
 */
export class LiveChatOperabilityStore {
  private readonly states = new Map<string, LiveChatOperabilityState>();

  /** Update one route's live state from a recorded execution result. */
  record(input: RecordRouteExecutionInput): LiveChatOperabilityState {
    const key = buildLiveStateKey(input);
    const now = input.observedAt ?? new Date().toISOString();
    const prev = this.states.get(key);
    const cls = input.errorClassification;

    let chatReady: boolean;
    let eligibleForCriticalRole: boolean;
    let cooldownUntil: string | undefined;
    let lastErrorKind: ProviderErrorKind | undefined;

    if (input.ok) {
      // Successful execution clears prior failure state.
      chatReady = true;
      eligibleForCriticalRole = true;
      cooldownUntil = undefined;
      lastErrorKind = undefined;
    } else if (cls) {
      // Body-aware classification controls retryability + cooldown.
      const explicitCooldown = input.cooldownMs;
      const kindCooldown = COOLDOWN_MS[cls.kind] ?? COOLDOWN_MS.unknown;
      const cooldownDuration = explicitCooldown ?? kindCooldown;
      cooldownUntil = new Date(Date.now() + cooldownDuration).toISOString();
      lastErrorKind = cls.kind;
      chatReady = false;
      eligibleForCriticalRole = false;
    } else {
      // No classification — conservative: mark not ready, short cooldown.
      cooldownUntil = new Date(Date.now() + COOLDOWN_MS.unknown).toISOString();
      lastErrorKind = 'unknown';
      chatReady = false;
      eligibleForCriticalRole = false;
    }

    const successCountRecent = (prev?.successCountRecent ?? 0) + (input.ok ? 1 : 0);
    const failureCountRecent = (prev?.failureCountRecent ?? 0) + (input.ok ? 0 : 1);

    const next: LiveChatOperabilityState = {
      providerId: input.providerId.toLowerCase(),
      routeId: input.routeId.toLowerCase(),
      modelId: input.modelId,
      canonicalModelId: input.canonicalModelId,
      providerKind: input.providerKind ?? prev?.providerKind,
      chatReady,
      eligibleForCriticalRole,
      lastChatSuccessAt: input.ok ? now : prev?.lastChatSuccessAt,
      lastChatFailureAt: input.ok ? prev?.lastChatFailureAt : now,
      lastErrorKind,
      lastHttpStatus: input.ok ? prev?.lastHttpStatus : input.httpStatus,
      lastSanitizedMessage: input.ok
        ? prev?.lastSanitizedMessage
        : cls?.sanitizedMessage,
      cooldownUntil,
      successCountRecent,
      failureCountRecent,
      latencyP50Ms: prev?.latencyP50Ms,
      latencyP95Ms: prev?.latencyP95Ms,
      source: input.source,
      updatedAt: now,
    };
    this.states.set(key, next);
    return next;
  }

  /** Lookup live state for a route. Returns undefined when unseen. */
  get(input: { providerId: string; routeId: string; modelId: string }): LiveChatOperabilityState | undefined {
    return this.states.get(buildLiveStateKey(input));
  }

  /** Lookup all states for a (providerId, modelId) regardless of routeId. */
  getByModel(providerId: string, modelId: string): readonly LiveChatOperabilityState[] {
    const p = providerId.toLowerCase();
    const m = modelId.toLowerCase();
    const out: LiveChatOperabilityState[] = [];
    for (const s of this.states.values()) {
      if (s.providerId === p && s.modelId.toLowerCase() === m) out.push(s);
    }
    return out;
  }

  /** Quick check: should this route be allowed for a critical role
   *  right now? Returns false when chatReady is false OR cooldown is
   *  still active. Returns true when chatReady AND (no cooldown OR
   *  cooldown expired). */
  isEligibleForCriticalRole(input: { providerId: string; routeId: string; modelId: string }): boolean {
    const s = this.get(input);
    if (!s) return false;
    if (!s.eligibleForCriticalRole) return false;
    if (s.cooldownUntil && new Date(s.cooldownUntil).getTime() > Date.now()) return false;
    return true;
  }

  /** Materialize all known states for snapshot / inspection. */
  snapshot(): readonly LiveChatOperabilityState[] {
    return Array.from(this.states.values());
  }

  /** Write the current state to a JSON file. Sanitized — no secrets.
   *  Throws on filesystem errors so the caller can decide whether to
   *  log + continue or abort. */
  async writeSnapshot(path: string): Promise<void> {
    const body = JSON.stringify(
      {
        version: 1,
        observedAt: new Date().toISOString(),
        states: this.snapshot(),
      },
      null,
      2,
    );
    await fs.writeFile(path, body, 'utf-8');
  }

  /** Hydrate from a snapshot file written by `writeSnapshot()`. Silently
   *  no-ops if the file is missing or malformed (this is a cold-start
   *  seed, not a strict requirement). */
  async loadSnapshot(path: string): Promise<{ loaded: number }> {
    try {
      const raw = await fs.readFile(path, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: number; states?: LiveChatOperabilityState[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.states)) return { loaded: 0 };
      let loaded = 0;
      for (const s of parsed.states) {
        if (!s.providerId || !s.routeId || !s.modelId) continue;
        this.states.set(buildLiveStateKey(s), s);
        loaded++;
      }
      return { loaded };
    } catch {
      return { loaded: 0 };
    }
  }

  /** Synchronous variant used at singleton-bootstrap time so the first
   *  caller doesn't race with an unresolved promise. The file is
   *  expected to be small (a few KB), so blocking I/O on first access
   *  is acceptable. */
  loadSnapshotSync(path: string): { loaded: number } {
    try {
      if (!existsSync(path)) return { loaded: 0 };
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as { version?: number; states?: LiveChatOperabilityState[] };
      if (parsed.version !== 1 || !Array.isArray(parsed.states)) return { loaded: 0 };
      let loaded = 0;
      for (const s of parsed.states) {
        if (!s.providerId || !s.routeId || !s.modelId) continue;
        this.states.set(buildLiveStateKey(s), s);
        loaded++;
      }
      return { loaded };
    } catch {
      return { loaded: 0 };
    }
  }

  /** Test helper. */
  clear(): void {
    this.states.clear();
  }
}

let singleton: LiveChatOperabilityStore | undefined;
let hydrationAttempted = false;

/** Default snapshot path the audit script writes to. Hydration is
 *  best-effort: missing file is silently ignored so tests + boot work
 *  even when no audit has been run. Operators can override via
 *  `LIVE_CHAT_OPERABILITY_SNAPSHOT_PATH`. */
function snapshotPath(): string {
  return (
    process.env.LIVE_CHAT_OPERABILITY_SNAPSHOT_PATH ??
    '/tmp/ci-live-chat-operability-snapshot.json'
  );
}

export function getLiveChatOperabilityStore(): LiveChatOperabilityStore {
  if (!singleton) {
    singleton = new LiveChatOperabilityStore();
    // 01C.1B-F — synchronous hydration on first access so the first
    // caller sees the snapshot data. Snapshot is small; blocking I/O
    // here is acceptable. Missing/malformed files are silently ignored
    // so tests + boot work even when no audit has been run.
    if (!hydrationAttempted) {
      hydrationAttempted = true;
      singleton.loadSnapshotSync(snapshotPath());
    }
  }
  return singleton;
}

/** Test-only reset (the singleton survives across imports otherwise). */
export function _resetLiveChatOperabilityStoreForTests(): void {
  singleton = undefined;
  hydrationAttempted = false;
}
