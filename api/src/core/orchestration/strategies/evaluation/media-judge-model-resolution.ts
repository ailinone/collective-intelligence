// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * resolveMediaJudgeModelId — resolves a real, vision-capable judge model
 * against the live catalog, via `ModelRoleResolver`'s `role: 'judge'`
 * resolution with `requireVision: true` (Section A of the MediaPlanner
 * completion design, 2026-09-23).
 *
 * Deliberately does NOT reuse `ConsensusExecutionPlanner` /
 * `ConsensusPlanDryRunService` — that stack additionally requires a live
 * `ChatRequest`, participant/synthesizer resolution, and the provider
 * operability hub, none of which a judge-only lookup needs. Instead this
 * reuses the SAME judge-pool builder
 * (`buildConsensusRoleSpecificCandidatePools`) already used in production
 * by `chat-request-processor.ts`'s `computeConsensusPlanAndFingerprint`,
 * then wraps each `Model` into the `ModelCandidate` shape the resolver
 * expects with unconditional "assume healthy" defaults, so this narrow
 * lookup doesn't pull in the operability hub as a dependency.
 *
 * IMPORTANT — this is NOT the same as the real stack's degraded-path
 * behavior. `consensus-plan-dry-run-service.ts`'s `wrapAsCandidate` FIRST
 * calls `getProviderOperabilityHub().getProviderState(model.provider)`
 * and only falls back to "assume healthy" when that call throws (hub
 * unreachable) — a fallback for an exceptional case. `wrapJudgeCandidate`
 * below never attempts to query the hub at all: "assume healthy" is its
 * permanent, sole behavior, not a fallback. Since `providerHealthy` /
 * `hasCredits` / `rateLimited` are hard filters inside
 * `ModelRoleResolver.resolve()`, this means `resolveMediaJudgeModelId`
 * can currently select a model whose provider is actually down,
 * rate-limited, or out of credits — the resolver has no real signal to
 * catch that here. This is a known, deliberate gap (accepted to keep
 * this helper free of the operability hub dependency), not a bug — but a
 * future maintainer should not assume this call site has the same
 * health-awareness as the production consensus flow. Wiring in the
 * operability hub (mirroring `wrapAsCandidate`'s primary path) is a
 * reasonable follow-up if this gap proves to matter in practice.
 *
 * NOTE on `requireJsonOutput`: this helper intentionally does NOT set
 * `constraints.requireJsonOutput`. `ModelRoleResolver.resolve()`'s legacy
 * (non-R4D) requireJsonOutput filter hard-rejects any candidate lacking
 * the narrow `json_mode` / `function_calling` / `tool_use` capability
 * tags (see `model-role-resolver.ts` stage 9) — a constraint orthogonal
 * to "can this model see the media it's judging". Catalog rows commonly
 * carry `vision` without also carrying those structured-output tags, so
 * combining both hard filters here would silently starve the judge pool
 * of otherwise-correct vision-capable candidates. JSON-output enforcement
 * for the judge's response format belongs to the prompting/parsing layer
 * (`MediaJudgeEvaluator`), not to model *selection*.
 */
import { getAllCatalogModels } from '@/services/model-catalog-service';
import { buildConsensusRoleSpecificCandidatePools } from '@/core/orchestration/model-selection/role-specific-candidate-pool-builder';
import {
  ModelRoleResolver,
  isLocalProvider,
} from '@/core/orchestration/model-selection/model-role-resolver';
import type { ModelCandidate } from '@/core/orchestration/model-selection/model-role-types';
import type { Model } from '@/types';

export interface MediaJudgeModelResolutionDeps {
  readonly resolver?: ModelRoleResolver;
  /** Defaults to the real `getAllCatalogModels()` singleton. Overridden
   *  in tests to avoid touching the DB/catalog cache. */
  readonly listCatalogModels?: () => Promise<readonly Model[]>;
}

function wrapJudgeCandidate(model: Model): ModelCandidate {
  return {
    model,
    providerId: model.provider,
    providerHealthy: true,
    hasCredits: true,
    rateLimited: false,
    isLocal: isLocalProvider(model.provider),
    estimatedCostPerCallUsd:
      Math.max(0, model.inputCostPer1k ?? 0) + Math.max(0, model.outputCostPer1k ?? 0),
  };
}

/**
 * Resolves one vision-capable judge model id from the live catalog, or
 * `undefined` when none satisfies the resolver's judge-role filters
 * (capability, health, credits, context window, requireVision). Never
 * fabricates a fallback model id.
 */
export async function resolveMediaJudgeModelId(
  deps: MediaJudgeModelResolutionDeps = {}
): Promise<string | undefined> {
  const resolver = deps.resolver ?? new ModelRoleResolver();
  const listCatalogModels = deps.listCatalogModels ?? getAllCatalogModels;

  const pools = await buildConsensusRoleSpecificCandidatePools({
    catalog: { listCatalogModels },
  });
  const candidatePool = (pools.judgePool ?? []).map(wrapJudgeCandidate);

  const result = await resolver.resolve({
    taskProfile: {},
    strategyName: 'media-consensus',
    role: 'judge',
    candidatePool,
    constraints: { requireVision: true, count: 1 },
  });

  return result.selected[0]?.model.id;
}
