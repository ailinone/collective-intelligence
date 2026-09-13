// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tier-3 Multimodal Probe (Tiered Capability Fingerprint, "TCF").
 *
 * The most expensive tier in the design, so it is GATED: only models whose
 * Tier-0 metadata (`model-capability-inference.ts`'s modality-based
 * inference, already materialised into `models.capability_uris`) already
 * declares a multimodal input capability get probed here. A model with no
 * declared vision/audio/video/pdf input is never a Tier-3 candidate — this
 * tier PROVES a claim the catalog already makes, it does not go fishing for
 * undeclared multimodal support (that would defeat the whole point of a
 * tiered, cost-bounded design: per the feasibility investigation this
 * closes, Tier-3 averages ~0.15 calls/model across the full catalog
 * specifically BECAUSE it only fires for the minority already gated in).
 *
 * `isTier3EligibleByDeclaredModality` is the gate: pure, and driven by the
 * ontology's OWN slug→URI mapping (`LEGACY_CAPABILITY_TO_URI`) rather than a
 * hardcoded URI string list, so a future ontology change to those slugs
 * cannot silently desync the gate from what Tier-0 actually writes.
 *
 * Probe shape mirrors `function-calling-probe.ts` / `tier1-diagnostic-probe.ts`:
 * one real call carrying a minimal test payload for the declared modality,
 * `probe-liveness-classifier.ts` for provider-unreachable vs capability
 * verdict, and `recordProbeAssertions` for persistence (source
 * `runtime-probe`) — this is a genuine empirical UPGRADE of an existing
 * `modality-derived` assertion to the stronger `runtime-probe` source, not a
 * new claim from nothing.
 */

import type { ProviderAdapter } from '@/providers/base/provider-adapter';
import type { ChatRequest, ModelCapability } from '@/types';
import { logger } from '@/utils/logger';
import { incrementCounter, observeHistogram, METRIC_NAMES } from '@/core/operability/metrics';
import { isProviderLivenessError } from './probe-liveness-classifier';
import { LEGACY_CAPABILITY_TO_URI } from '@/capability/ontology/seed';

const log = logger.child({ component: 'tier3-multimodal-probe' });

export const TIER3_ORIGIN = 'tier3-multimodal-probe@v1';

const PROBE_TIMEOUT_MS = Number(process.env.TIER3_PROBE_TIMEOUT_MS ?? 20_000);
const MAX_PROBES_PER_PROCESS = Number(process.env.TIER3_PROBE_MAX_PROBES ?? 5_000);

let probesStarted = 0;

export function resetTier3ProbeForTesting(): void {
  probesStarted = 0;
}

export function getTier3ProbeStats(): { started: number } {
  return { started: probesStarted };
}

/**
 * Modality capabilities Tier-0 can declare that Tier-3 knows how to probe.
 * Ordered by how commonly they're declared (vision first) — irrelevant to
 * correctness, only affects which ONE capability a model with several
 * declared modalities gets probed for first when the caller probes one at a
 * time (see `jobs/capability-fingerprint-job.ts`).
 */
const TIER3_PROBEABLE_CAPABILITIES: readonly ModelCapability[] = [
  'vision',
  'audio_input',
  'video_understanding',
  'pdf_understanding',
];

export interface Tier3EligibilityResult {
  readonly eligible: boolean;
  /** The first declared, probeable modality capability, when eligible. */
  readonly declaredCapability?: ModelCapability;
}

/**
 * Real, dynamic gate: eligible only when the model's OWN materialised
 * `capability_uris` already contains one of the modality URIs. Never
 * hardcodes a catalog size or provider list — this is evaluated per-model
 * against whatever `capability_uris` actually contains right now.
 */
export function isTier3EligibleByDeclaredModality(
  capabilityUris: readonly string[] | null | undefined
): Tier3EligibilityResult {
  if (!capabilityUris || capabilityUris.length === 0) return { eligible: false };
  const uriSet = new Set(capabilityUris);

  for (const capability of TIER3_PROBEABLE_CAPABILITIES) {
    const uri = LEGACY_CAPABILITY_TO_URI[capability];
    if (uri && uriSet.has(uri)) {
      return { eligible: true, declaredCapability: capability };
    }
  }
  return { eligible: false };
}

/** Minimal 1x1 transparent PNG — enough for the provider to accept or reject an image part. */
const TEST_IMAGE_DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** Explicit "cannot process this modality" rejection shapes — conservative,
 *  only unambiguous rejections count as a negative (mirrors the FC probe's
 *  `TOOLS_UNSUPPORTED_PATTERNS`). No negative assertion is written even when
 *  matched (see module doc on this tier only ever upgrading an existing
 *  positive) — matching here just means "don't misread this as a pass". */
const MODALITY_UNSUPPORTED_PATTERNS: readonly RegExp[] = [
  /(cannot|can't|unable to)\s+(process|view|see|analyze|read)\s+(images?|audio|video|pdf|documents?)/i,
  /does\s+not\s+support\s+(image|audio|video|pdf|vision|multimodal)/i,
  /(image|audio|video|pdf)\s+input\s+is\s+not\s+supported/i,
  /no\s+(vision|image|audio|video)\s+support/i,
  /i\s+(don'?t|do\s+not)\s+have\s+the\s+ability\s+to\s+(see|view|process)\s+images?/i,
];

function buildProbeRequestFor(modelId: string, capability: ModelCapability): ChatRequest | null {
  if (capability === 'vision') {
    return {
      model: modelId,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What color is this image? Answer in one short sentence.' },
            { type: 'image_url', image_url: { url: TEST_IMAGE_DATA_URI } },
          ],
        },
      ],
      max_tokens: 60,
      stream: false,
    };
  }
  // audio_input / video_understanding / pdf_understanding: this codebase's
  // `MessageContent` union (types/index.ts) does not yet carry a generic
  // audio/video/document input part — only `image_url` (plus judge-only
  // `video_frame`/`audio_transcript` variants MediaJudgeEvaluator normalizes
  // away before sending). Probing those modalities for real would need a
  // provider-specific request shape this module has no safe generic way to
  // build, so Tier-3 only ever ACTUALLY probes `vision` today; the other
  // three stay in `TIER3_PROBEABLE_CAPABILITIES` (real gate, real
  // eligibility signal, observable in stats) but `null` here means the
  // caller skips executing a probe call for them rather than guessing a
  // request shape that might not mean what it looks like on the wire.
  return null;
}

export type Tier3ProbeStatus =
  | 'confirmed'
  | 'rejected'
  | 'provider-dead'
  | 'inconclusive'
  | 'not-probeable'
  | 'budget-exhausted';

export interface Tier3ProbeOutcome {
  readonly status: Tier3ProbeStatus;
  readonly capability?: ModelCapability;
}

/**
 * Probe ONE model's declared modality capability. Never throws.
 * `declaredCapability` should come from `isTier3EligibleByDeclaredModality` —
 * calling this on an ineligible model is a caller error, not something this
 * function re-validates against the DB (it has no DB access).
 */
export async function runTier3MultimodalProbe(
  adapter: ProviderAdapter,
  provider: string,
  modelId: string,
  declaredCapability: ModelCapability
): Promise<Tier3ProbeOutcome> {
  const request = buildProbeRequestFor(modelId, declaredCapability);
  if (!request) {
    return { status: 'not-probeable', capability: declaredCapability };
  }

  if (probesStarted >= MAX_PROBES_PER_PROCESS) {
    log.warn({ probesStarted }, 'Tier-3 probe budget exhausted — skipping');
    incrementCounter(METRIC_NAMES.CAPABILITY_PROBE_TOTAL, {
      capability: declaredCapability,
      providerId: provider,
      outcome: 'budget-exhausted',
    });
    return { status: 'budget-exhausted', capability: declaredCapability };
  }
  probesStarted++;

  const probeStartedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  let responseText = '';
  try {
    const response = await adapter.chatCompletion(request, { signal: controller.signal });
    const content = response.choices?.[0]?.message?.content;
    responseText = typeof content === 'string' ? content : '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A provider can reject the modality outright (HTTP-level "unsupported
    // content type") rather than accepting the request and having the MODEL
    // say it can't see — same three-way split as the FC probe's
    // classifyProbeError: an explicit rejection message beats the liveness
    // check, which beats "inconclusive, learned nothing".
    const outcome = MODALITY_UNSUPPORTED_PATTERNS.some((p) => p.test(message))
      ? 'rejected'
      : isProviderLivenessError(message)
        ? 'provider-dead'
        : 'inconclusive';
    log.debug({ provider, modelId, error: message, outcome }, 'Tier-3 probe call failed');
    incrementCounter(METRIC_NAMES.CAPABILITY_PROBE_TOTAL, {
      capability: declaredCapability,
      providerId: provider,
      outcome,
    });
    return { status: outcome, capability: declaredCapability };
  } finally {
    clearTimeout(timer);
  }

  const trimmed = responseText.trim();
  const rejected =
    trimmed.length === 0 || MODALITY_UNSUPPORTED_PATTERNS.some((p) => p.test(trimmed));

  if (!rejected) {
    try {
      const { recordProbeAssertions } = await import('@/capability/assertions/probe-emitter');
      await recordProbeAssertions({
        providerId: provider,
        modelId,
        origin: TIER3_ORIGIN,
        signals: [{ capability: declaredCapability }],
      });
    } catch {
      /* best-effort */
    }
  }

  const outcome = rejected ? 'rejected' : 'confirmed';
  log.info({ provider, modelId, capability: declaredCapability, outcome }, 'Tier-3 probe completed');
  incrementCounter(METRIC_NAMES.CAPABILITY_PROBE_TOTAL, {
    capability: declaredCapability,
    providerId: provider,
    outcome,
  });
  observeHistogram(METRIC_NAMES.CAPABILITY_PROBE_LATENCY_MS, Date.now() - probeStartedAt, {
    capability: declaredCapability,
    outcome,
  });

  return { status: outcome, capability: declaredCapability };
}
