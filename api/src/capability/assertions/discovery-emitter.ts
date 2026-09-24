// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Discovery → Capability-Assertion Emitter (ADR-022 closure — GAP-A12)
 *
 * ## What this closes
 *
 * `writeAssertions()` (./writer.ts) was built in Sprint 2 to persist the
 * `CapabilitySignal[]` that discovery emits, and `capability-materialise-job.ts`
 * names "Discovery service (provider-declared, parameter-derived assertions)"
 * as its FIRST upstream. But nothing in the live discovery path ever called the
 * writer: the only call sites were five one-shot backfill/coverage scripts
 * (`hcra-close-coverage`, `hcra-test-writer`, `hcra-validate-e2e`,
 * `hcra-sprint1-bootstrap`, `hcra-reseed-ontology`).
 *
 * Net effect before this module: any provider onboarded — or any model set
 * refreshed — after the last manual backfill shipped with `capability_uris`
 * empty or stale. `CapabilitySearchService`'s `requireCaps` filter does
 * `capability_uris @> $n::text[]`, and array containment against an empty array
 * never matches, so those models were invisible to capability search. (The main
 * selector was NOT affected: `dynamic-model-selector.ts` falls back to the
 * legacy `capabilities` array when `capabilityUris` is empty.)
 *
 * This module is the missing link, called from the ONE funnel where discovery
 * persists models (`central-model-discovery-service.ts#bulkUpsertModels`), so
 * assertions are produced by the production pipeline rather than by a cron that
 * can silently drift out of sync with it.
 *
 * ## Source attribution by ablation, not by re-implementation
 *
 * The writer needs a `CapabilitySource` per claim, but discovery hands us a
 * FLAT `ModelCapability[]` — `inferModelCapabilities()` merges provider-declared
 * seeds, modality arrays, `supported_parameters` and name regexes into one list
 * and throws the provenance away.
 *
 * Rather than duplicate ~200 lines of inference rules here (which would rot the
 * moment someone edits the real engine), we recover provenance by ABLATION:
 * re-run the SAME engine with deliberately narrowed inputs and difference the
 * results.
 *
 *   declared  = inferModelCapabilities({ modelId: '', seedCapabilities })
 *   modality  = inferModelCapabilities({ modelId: '', metadata: <modality keys only> })
 *   parameter = inferModelCapabilities({ modelId: '', metadata: <supported_parameters only> })
 *
 * With `modelId: ''` and no `description`/`family`/`tier`/`endpoint` in the
 * ablated metadata, the engine's `combinedText` is empty, so every regex branch
 * is inert and only the branch under test can fire. Each capability in the final
 * list is then attributed to the STRONGEST bucket that explains it, and anything
 * no ablation explains is — correctly — `name-regex`.
 *
 * The upside over a hand-written table: when the inference rules change, this
 * attribution follows automatically. There is exactly one source of truth for
 * "what does an `input_modalities: ['image']` imply", and it is not this file.
 *
 * ## Fail-soft by construction
 *
 * `model_capability_assertions.capability_uri` is an FK onto
 * `capability_ontology(uri)` with ON DELETE RESTRICT, and `writeAssertions()`
 * inserts the whole batch in ONE statement. A single URI missing from the
 * ontology table (a deployment whose ontology seed is behind the code) would
 * therefore abort the entire batch. Since this runs INSIDE the discovery write
 * path, a failure here must never cost us a discovery cycle. Two guards:
 *
 *   1. Signals are pre-filtered against the ontology URIs actually present in
 *      the database (cached, refreshed on a TTL), so an unseeded URI is dropped
 *      and counted instead of poisoning its batch.
 *   2. The whole emit is wrapped so any residual error is logged + counted and
 *      swallowed. Discovery correctness never depends on assertions landing;
 *      the next cycle supersedes and reinserts anyway.
 *
 * Kill switch: `HCRA_DISCOVERY_ASSERTIONS_DISABLED=true` (mirrors
 * `HCRA_MATERIALISE_DISABLED` on the materialise job).
 */

import type { CapabilitySignal, CapabilitySource } from '@/services/model-capability-merger';
import type { ModelCapability } from '@/types';
import { inferModelCapabilities } from '@/services/model-capability-inference';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';
import { writeAssertions, type ModelAssertionBatch } from './writer';
import { prisma } from '@/database/client';
import type { PrismaClient } from '@/generated/prisma/index.js';
import { logger } from '@/utils/logger';
import { incrementCounter, observeHistogram, METRIC_NAMES } from '@/core/operability/metrics';

const log = logger.child({ component: 'discovery-assertion-emitter' });

type PrismaRunner = Pick<PrismaClient, '$executeRawUnsafe' | '$queryRawUnsafe'>;

/**
 * Metadata keys that `extractModelModalities()` reads. Kept in sync by the
 * ablation contract test — if the engine starts reading a new key, the test
 * that asserts a modality-declaring model is attributed `modality-derived`
 * (and not `name-regex`) fails.
 */
const MODALITY_METADATA_KEYS = [
  'architecture',
  'input_modalities',
  'inputModalities',
  'output_modalities',
  'outputModalities',
] as const;

/** Metadata keys that `readSupportedParameters()` reads. */
const PARAMETER_METADATA_KEYS = ['supported_parameters', 'supportedParameters'] as const;

/**
 * How long the ontology-URI allowlist is cached in-process. Discovery sweeps
 * run for minutes; re-reading ~200 rows once per sweep is free, and a stale
 * cache only costs us dropped assertions for a URI added mid-sweep (which the
 * next sweep picks up).
 */
const ONTOLOGY_CACHE_TTL_MS = 5 * 60 * 1000;

interface OntologyCache {
  uris: ReadonlySet<string>;
  loadedAt: number;
}

let ontologyCache: OntologyCache | null = null;

/** Test seam — drops the cached ontology allowlist. */
export function __resetOntologyUriCacheForTests(): void {
  ontologyCache = null;
}

/**
 * Whether discovery writes capability assertions. Default ON: the whole point
 * of GAP-A12 is that the canonical capability projection must not depend on
 * someone remembering to run a backfill script.
 */
export function isDiscoveryAssertionsEnabled(): boolean {
  return process.env.HCRA_DISCOVERY_ASSERTIONS_DISABLED !== 'true';
}

// ─── Provenance derivation ────────────────────────────────────────────────────

export interface DiscoverySignalInput {
  /** Model id as the provider reports it — used only for logging/detail. */
  modelId: string;
  /**
   * The capability list that is actually being persisted to `models`
   * (post-enrichment). Every entry here gets exactly one signal.
   */
  finalCapabilities: readonly string[];
  /**
   * The upstream fetcher's capability list, before enrichment ran. In
   * `bulkUpsertModels` this is the pre-`enrichModelMetadata` model.
   *
   * IMPORTANT — this is NOT by itself evidence of a provider declaration, and
   * is deliberately not treated as one. `OpenAICompatibleHubModelFetcher`
   * populates the same field from three different places: real declared vendor
   * fields, `inferCapabilitiesFromModelId()` name heuristics, and a bare
   * `['chat','text_generation']` default for anything that appeared in
   * `/v1/models`. Promoting all three to `provider-declared` would stamp
   * confidence 1.0 (weight 0.95 → fused P ≈ 0.95) on what is often a guess —
   * precisely the fabricated-confidence class of bug LOTE AM had to root-cause.
   * It is only trusted when {@link DiscoverySignalInput.metadata} corroborates
   * it; see `collectDeclaredEvidence`.
   */
  declaredCapabilities?: readonly string[];
  /** The model's metadata bag as persisted. */
  metadata?: Record<string, unknown>;
}

/**
 * The capabilities we can honestly call `provider-declared`, i.e. the ones the
 * pipeline can substantiate rather than infer.
 *
 * Two corroborating markers exist, both written by discovery itself:
 *
 *  - `metadata.capabilities` — set by the hub fetcher ONLY from genuinely
 *    declared response fields (`capabilities` / `features` /
 *    `supported_capabilities`) or a vendor extension's boolean flags. When the
 *    fetcher falls back to name inference or its chat default, it does not
 *    write this key.
 *  - `metadata.capabilitySource === 'operator-declared'` — set by the
 *    catalog-bridge pinned path when the catalog row carried hand-curated
 *    `{id, capabilities}` entries (as opposed to bare id strings, which that
 *    same path tags `'name-regex'`).
 *
 * Anything else falls through to the modality / parameter / name-regex
 * ablations. Under-attributing is the safe direction: the noisy-OR materialiser
 * lets a later, stronger source raise a capability's confidence, whereas a
 * fabricated `provider-declared` row poisons the evidence log until it ages out.
 */
function collectDeclaredEvidence(input: DiscoverySignalInput): string[] {
  const metadata = input.metadata;
  const declared: string[] = [];

  if (Array.isArray(metadata?.capabilities)) {
    for (const c of metadata.capabilities as unknown[]) {
      if (typeof c === 'string') declared.push(c);
    }
  }

  if (metadata?.capabilitySource === 'operator-declared') {
    declared.push(...(input.declaredCapabilities ?? []));
  }

  return declared;
}

function pickKeys(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[]
): Record<string, unknown> {
  if (!metadata) return {};
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (metadata[key] !== undefined) picked[key] = metadata[key];
  }
  return picked;
}

/**
 * Run the real inference engine over a deliberately narrowed input so only one
 * evidence class can fire. `modelId: ''` neutralises every name/text regex.
 */
function ablate(metadata: Record<string, unknown>, seed?: readonly string[]): Set<string> {
  if (Object.keys(metadata).length === 0 && (!seed || seed.length === 0)) {
    return new Set<string>();
  }
  return new Set<string>(
    inferModelCapabilities({
      modelId: '',
      metadata,
      seedCapabilities: seed as ModelCapability[] | undefined,
    })
  );
}

/**
 * Attribute each persisted capability to the strongest evidence class that
 * explains it. See the module header for why this is an ablation rather than a
 * lookup table.
 */
export function deriveDiscoverySignals(input: DiscoverySignalInput): CapabilitySignal[] {
  const final = Array.from(new Set(input.finalCapabilities)).filter(
    (c): c is string => typeof c === 'string' && c.length > 0
  );
  if (final.length === 0) return [];

  const declared = ablate({}, collectDeclaredEvidence(input));
  const modality = ablate(pickKeys(input.metadata, MODALITY_METADATA_KEYS));
  const parameter = ablate(pickKeys(input.metadata, PARAMETER_METADATA_KEYS));

  const signals: CapabilitySignal[] = [];
  for (const capability of final) {
    let source: CapabilitySource;
    let sourceField: string;
    if (declared.has(capability)) {
      source = 'provider-declared';
      sourceField = 'discovery:declared-capabilities';
    } else if (modality.has(capability)) {
      source = 'modality-derived';
      sourceField = 'discovery:modalities';
    } else if (parameter.has(capability)) {
      source = 'parameter-derived';
      sourceField = 'discovery:supported_parameters';
    } else {
      source = 'name-regex';
      sourceField = 'discovery:name-inference';
    }

    signals.push({
      capability: capability as ModelCapability,
      source,
      // No explicit `confidence`: the writer's per-source defaults
      // (declared 1.0 … name-regex 0.4) are the calibrated values and we do
      // not want a second copy of them here.
      detail: { source_field: sourceField, modelId: input.modelId },
    });
  }

  return signals;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export interface DiscoveryAssertionModel {
  /** Deterministic surrogate PK already computed by the discovery write path. */
  modelUid: string;
  signal: DiscoverySignalInput;
}

export interface EmitDiscoveryAssertionsOptions {
  /**
   * Discovery source name (e.g. `catalog-openai`, `openrouter-hub`). Becomes
   * the supersedence key, so re-running the SAME source replaces its own prior
   * rows while leaving other sources' independent evidence intact.
   */
  sourceName: string;
  /** Provider the batch belongs to — metrics label only. */
  providerId: string;
  runner?: PrismaRunner;
}

export interface DiscoveryAssertionStats {
  modelsTouched: number;
  rowsInserted: number;
  rowsSuperseded: number;
  /** Signals dropped because their URI is absent from `capability_ontology`. */
  signalsDroppedUnknownUri: number;
  /** Signals dropped by the writer because no legacy→URI mapping exists. */
  signalsDroppedUnmapped: number;
  skipped: 'disabled' | 'empty' | null;
}

const EMPTY_STATS: DiscoveryAssertionStats = Object.freeze({
  modelsTouched: 0,
  rowsInserted: 0,
  rowsSuperseded: 0,
  signalsDroppedUnknownUri: 0,
  signalsDroppedUnmapped: 0,
  skipped: null,
});

/**
 * URIs that actually exist in `capability_ontology`. See the module header:
 * the assertions table FKs onto this, and one bad URI aborts a whole batch.
 */
async function loadKnownOntologyUris(runner: PrismaRunner): Promise<ReadonlySet<string>> {
  const now = Date.now();
  if (ontologyCache && now - ontologyCache.loadedAt < ONTOLOGY_CACHE_TTL_MS) {
    return ontologyCache.uris;
  }
  const rows = await runner.$queryRawUnsafe<Array<{ uri: string }>>(
    `SELECT uri FROM capability_ontology WHERE status <> 'deprecated'`
  );
  const uris = new Set<string>(rows.map((r) => r.uri));
  ontologyCache = { uris, loadedAt: now };
  if (uris.size === 0) {
    log.warn(
      'capability_ontology is empty — discovery assertions will be dropped until the ontology is seeded (npx tsx scripts/hcra-reseed-ontology.ts)'
    );
  }
  return uris;
}

/**
 * Derive and persist capability assertions for a batch of freshly-upserted
 * models. NEVER throws: discovery correctness does not depend on this.
 */
export async function emitDiscoveryAssertions(
  models: readonly DiscoveryAssertionModel[],
  opts: EmitDiscoveryAssertionsOptions
): Promise<DiscoveryAssertionStats> {
  if (!isDiscoveryAssertionsEnabled()) {
    return { ...EMPTY_STATS, skipped: 'disabled' };
  }
  if (models.length === 0) {
    return { ...EMPTY_STATS, skipped: 'empty' };
  }

  const runner = opts.runner ?? prisma;
  const origin = `discovery:${opts.sourceName}@v1`;
  const startedAt = Date.now();

  try {
    const knownUris = await loadKnownOntologyUris(runner);

    let droppedUnknownUri = 0;
    const batch: ModelAssertionBatch[] = [];

    for (const { modelUid, signal } of models) {
      const derived = deriveDiscoverySignals(signal);
      const kept: CapabilitySignal[] = [];
      for (const s of derived) {
        const uri = LEGACY_CAPABILITY_TO_URI[s.capability];
        // An unmapped slug is the writer's business (it warns + counts); an
        // URI the DB has never heard of is ours, because it would abort the
        // whole INSERT.
        if (uri !== undefined && !knownUris.has(uri)) {
          droppedUnknownUri += 1;
          continue;
        }
        kept.push(s);
      }
      if (kept.length > 0) batch.push({ modelUid, signals: kept });
    }

    if (batch.length === 0) {
      recordOutcome(opts.providerId, 'empty', Date.now() - startedAt);
      return { ...EMPTY_STATS, signalsDroppedUnknownUri: droppedUnknownUri, skipped: 'empty' };
    }

    const stats = await writeAssertions(batch, { origin }, runner);

    recordOutcome(opts.providerId, 'written', Date.now() - startedAt);
    incrementCounter(
      METRIC_NAMES.CAPABILITY_ASSERTION_ROWS_TOTAL,
      { providerId: opts.providerId },
      { by: stats.rowsInserted, log: false }
    );

    log.debug(
      {
        sourceName: opts.sourceName,
        providerId: opts.providerId,
        modelsTouched: stats.modelsTouched,
        rowsInserted: stats.rowsInserted,
        rowsSuperseded: stats.rowsSuperseded,
        rowsTouched: stats.rowsTouched,
        droppedUnknownUri,
        droppedUnmapped: stats.signalsDropped,
      },
      'Discovery capability assertions written'
    );

    return {
      modelsTouched: stats.modelsTouched,
      rowsInserted: stats.rowsInserted,
      rowsSuperseded: stats.rowsSuperseded,
      signalsDroppedUnknownUri: droppedUnknownUri,
      signalsDroppedUnmapped: stats.signalsDropped,
      skipped: null,
    };
  } catch (error) {
    // Deliberately swallowed — see module header. A failed assertion write must
    // not fail the discovery cycle that produced the models.
    recordOutcome(opts.providerId, 'failed', Date.now() - startedAt);
    log.warn(
      {
        sourceName: opts.sourceName,
        providerId: opts.providerId,
        modelCount: models.length,
        error: error instanceof Error ? error.message : String(error),
      },
      'Discovery capability assertion write failed — discovery continues, next cycle retries'
    );
    return { ...EMPTY_STATS };
  }
}

function recordOutcome(providerId: string, outcome: string, elapsedMs: number): void {
  incrementCounter(METRIC_NAMES.CAPABILITY_ASSERTION_WRITE_TOTAL, { providerId, outcome });
  observeHistogram(METRIC_NAMES.CAPABILITY_ASSERTION_WRITE_LATENCY_MS, elapsedMs, { outcome });
}
