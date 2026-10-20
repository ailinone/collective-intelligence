// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * buildDocumentCritics — turns a resolved text-capable judge model id into
 * 3 role-differentiated `DocumentJudgeEvaluator` critics
 * (`factual_accuracy` / `required_clause_presence` / `tone`), ready to hand
 * to `DocumentReviewStrategy`'s `critics` constructor field. Section C of
 * the MediaPlanner completion design (2026-09-23) — wired 2026-09-27,
 * mirroring `media-critics-factory.ts`'s `buildMediaCritics` (Section A)
 * exactly, since document critics only differ from media critics in being
 * text-only (no vision dispatch — see document-judge-evaluator.types.ts's
 * module doc).
 *
 * Gated behind the SAME `config.mediaPlanner.judgeEnabled` master switch as
 * `buildMediaCritics` — one "is judging on" decision for both media and
 * document critics, not two independent flags — with its own rubric
 * version (`config.mediaPlanner.documentJudgeRubricVersion`) since it is a
 * distinct rubric domain.
 *
 * Non-silent-degradation: same contract as `buildMediaCritics` — when no
 * judge model resolves (empty result or a thrown resolution error), this
 * returns an EMPTY critics array (DocumentReviewStrategy's existing, tested
 * `no_document_critics_configured` degrade path) plus a labeled
 * `documentJudgingUnavailableReason`, never an uncaught exception.
 */
import { config } from '@/config';
import { logger } from '@/utils/logger';
import type { ProviderRegistry } from '@/providers/provider-registry';
import { DocumentJudgeEvaluator } from './evaluation/document-judge-evaluator';
import { ProviderDocumentJudgeClient } from './evaluation/provider-document-judge-client';
import { DOCUMENT_CRITIC_ROLES } from './evaluation/document-judge-evaluator.types';
import {
  resolveDocumentJudgeModelId as defaultResolveDocumentJudgeModelId,
  type MediaJudgeModelResolutionDeps,
} from './evaluation/media-judge-model-resolution';
import type { DocumentCriticConfig } from './document-review-strategy';

const log = logger.child({ component: 'document-critics-factory' });

export const DOCUMENT_JUDGING_UNAVAILABLE_REASON =
  'document judging unavailable: no text-capable judge model configured';

export interface DocumentCriticsFactoryDeps extends MediaJudgeModelResolutionDeps {
  readonly providerRegistry: ProviderRegistry;
  /** Injectable for tests; defaults to the real `resolveDocumentJudgeModelId`. */
  readonly resolveDocumentJudgeModelId?: (
    deps: MediaJudgeModelResolutionDeps
  ) => Promise<string | undefined>;
}

export interface DocumentCriticsFactoryResult {
  readonly critics: readonly DocumentCriticConfig[];
  readonly documentJudgingUnavailableReason?: string;
}

export async function buildDocumentCritics(
  deps: DocumentCriticsFactoryDeps
): Promise<DocumentCriticsFactoryResult> {
  const resolve = deps.resolveDocumentJudgeModelId ?? defaultResolveDocumentJudgeModelId;
  let judgeModelId: string | undefined;
  try {
    judgeModelId = await resolve({
      resolver: deps.resolver,
      listCatalogModels: deps.listCatalogModels,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ error: message }, 'resolveDocumentJudgeModelId threw; degrading without critics');
    return {
      critics: [],
      documentJudgingUnavailableReason: `${DOCUMENT_JUDGING_UNAVAILABLE_REASON} (resolution failed: ${message})`,
    };
  }

  if (!judgeModelId) {
    return { critics: [], documentJudgingUnavailableReason: DOCUMENT_JUDGING_UNAVAILABLE_REASON };
  }

  const documentClient = new ProviderDocumentJudgeClient({ registry: deps.providerRegistry });
  const critics: DocumentCriticConfig[] = DOCUMENT_CRITIC_ROLES.map((role) => ({
    role,
    evaluator: new DocumentJudgeEvaluator(
      {
        enabled: true,
        judgeModelId,
        maxCostUsd: config.mediaPlanner.judgeMaxCostUsd,
        timeoutMs: config.mediaPlanner.judgeTimeoutMs,
        rubricVersion: config.mediaPlanner.documentJudgeRubricVersion,
        criticRole: role,
      },
      documentClient
    ),
  }));

  return { critics };
}
