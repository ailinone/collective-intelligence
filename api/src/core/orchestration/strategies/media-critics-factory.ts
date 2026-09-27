// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * buildMediaCritics — turns a resolved vision-capable judge model id into
 * 3 role-differentiated `MediaJudgeEvaluator` critics
 * (`spec_compliance` / `artifact_quality` / `tone`), ready to hand to
 * `MediaConsensusStrategy`'s `critics` constructor field. Section A of the
 * MediaPlanner completion design (2026-09-23) — this is the single piece
 * both production call sites (capabilities-routes.ts,
 * chat-request-processor.ts) import so the wiring logic exists in exactly
 * one place.
 *
 * Non-silent-degradation: when no vision-capable judge model resolves —
 * whether because resolution legitimately came back empty OR because the
 * resolve call itself threw (e.g. a transient catalog/DB error) — this
 * returns an EMPTY critics array (MediaConsensusStrategy's existing,
 * tested degrade path) plus a labeled `qualityJudgingUnavailableReason` —
 * callers thread that reason into the persisted plan audit trail (see
 * media-planner-strategy.ts's `qualityJudgingUnavailableReason` handling)
 * instead of letting the degrade happen invisibly. Neither production call
 * site wraps this factory in its own try/catch, so an uncaught exception
 * here would hard-fail an entire `media-plan/execute` or `generate_media`
 * request instead of gracefully proceeding without judging — the try/catch
 * below is what keeps that promise for the "resolution threw" case, the
 * same way `llm-judge-evaluator.ts` / `media-judge-evaluator.ts` degrade
 * instead of throwing on a failed provider call.
 */
import { config } from '@/config';
import { logger } from '@/utils/logger';
import type { ProviderRegistry } from '@/providers/provider-registry';
import { MediaJudgeEvaluator } from './evaluation/media-judge-evaluator';
import { ProviderMediaJudgeClient } from './evaluation/provider-media-judge-client';
import { MEDIA_CRITIC_ROLES } from './evaluation/media-judge-evaluator.types';
import {
  resolveMediaJudgeModelId as defaultResolveMediaJudgeModelId,
  type MediaJudgeModelResolutionDeps,
} from './evaluation/media-judge-model-resolution';
import type { MediaCriticConfig } from './media-consensus-strategy';

const log = logger.child({ component: 'media-critics-factory' });

export const QUALITY_JUDGING_UNAVAILABLE_REASON =
  'quality judging unavailable: no vision-capable judge model configured';

export interface MediaCriticsFactoryDeps extends MediaJudgeModelResolutionDeps {
  readonly providerRegistry: ProviderRegistry;
  /** Injectable for tests; defaults to the real `resolveMediaJudgeModelId`. */
  readonly resolveMediaJudgeModelId?: (
    deps: MediaJudgeModelResolutionDeps
  ) => Promise<string | undefined>;
}

export interface MediaCriticsFactoryResult {
  readonly critics: readonly MediaCriticConfig[];
  readonly qualityJudgingUnavailableReason?: string;
}

export async function buildMediaCritics(
  deps: MediaCriticsFactoryDeps
): Promise<MediaCriticsFactoryResult> {
  const resolve = deps.resolveMediaJudgeModelId ?? defaultResolveMediaJudgeModelId;
  let judgeModelId: string | undefined;
  try {
    judgeModelId = await resolve({
      resolver: deps.resolver,
      listCatalogModels: deps.listCatalogModels,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, 'resolveMediaJudgeModelId threw; degrading without critics');
    return {
      critics: [],
      qualityJudgingUnavailableReason: `${QUALITY_JUDGING_UNAVAILABLE_REASON} (resolution failed: ${message})`,
    };
  }

  if (!judgeModelId) {
    return { critics: [], qualityJudgingUnavailableReason: QUALITY_JUDGING_UNAVAILABLE_REASON };
  }

  const mediaClient = new ProviderMediaJudgeClient({ registry: deps.providerRegistry });
  const critics: MediaCriticConfig[] = MEDIA_CRITIC_ROLES.map((role) => ({
    role,
    evaluator: new MediaJudgeEvaluator(
      {
        enabled: true,
        judgeModelId,
        maxCostUsd: config.mediaPlanner.judgeMaxCostUsd,
        timeoutMs: config.mediaPlanner.judgeTimeoutMs,
        rubricVersion: config.mediaPlanner.judgeRubricVersion,
        criticRole: role,
      },
      mediaClient
    ),
  }));

  return { critics };
}
