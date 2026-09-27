// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Tier 2 — empirical capability-attribute probing (LOTE AZ, 2026-09-23).
 *
 * DELIBERATELY NOT part of the hourly/startup discovery cycle
 * (model-discovery-runner.ts) and NOT registered in
 * jobs/register-scheduled-jobs.ts. Every call here can make a REAL, PAID
 * request against a real provider. The only entrypoint is the manual CLI
 * script `api/scripts/probe-capability-attributes.ts` — see that file's
 * usage comment. Each (provider, model) pair is probed AT MOST ONCE ever;
 * the result is cached forever in `provider_capability_attribute_records`
 * (re-probing requires a manual re-run, e.g. after a provider changelog).
 *
 * Probing strategy: request a value just above each candidate ceiling (from
 * highest to lowest, most conservative first) and read the provider's
 * STRUCTURED validation error (an error code/field, never free text
 * pattern-matching) to confirm the real limit. `callProvider` is injected so
 * this module never imports a live provider adapter directly — the caller
 * (the CLI script) wires the real adapter; tests wire a mock.
 */
import { writeCapabilityAttributeRecord } from './capability-attribute-store';
import { findUnpromotedDraft, autoPromoteIfAgrees } from './capability-attribute-draft-service';
import { projectCapabilityAttributesToModels } from './capability-attribute-projection';

export interface ProviderValidationError {
  readonly code: string;
  readonly field: string;
  readonly message: string;
}

function isProviderValidationError(error: unknown): error is ProviderValidationError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'field' in error &&
    (error as { field: unknown }).field === 'duration'
  );
}

export interface ProbeVideoDurationCeilingInput {
  readonly providerId: string;
  readonly modelId: string;
  /** Candidate ceilings to test, ordered HIGHEST first — the first one the
   *  provider ACCEPTS (or the highest that produces the expected structured
   *  validation error, whichever confirms a real boundary first) wins. */
  readonly candidateCeilings: readonly number[];
  /** Injected so this module never talks to a real adapter directly. */
  readonly callProvider: (durationSeconds: number) => Promise<unknown>;
}

export async function probeVideoDurationCeiling(
  input: ProbeVideoDurationCeilingInput
): Promise<{ maxDurationSeconds: number }> {
  const { providerId, modelId, candidateCeilings, callProvider } = input;

  let confirmedCeiling: number | undefined;
  for (const candidate of candidateCeilings) {
    try {
      await callProvider(candidate);
      confirmedCeiling = candidate;
      break;
    } catch (error) {
      if (isProviderValidationError(error)) {
        // The provider rejected this candidate with a structured
        // duration-field error — try the next, lower candidate.
        continue;
      }
      // Anything else (network error, auth error, ...) is NOT a confirmed
      // boundary — surface it rather than silently writing a wrong number.
      throw error;
    }
  }

  if (confirmedCeiling === undefined) {
    throw new Error(
      `probeVideoDurationCeiling(${providerId}/${modelId}): no candidate ceiling was accepted`
    );
  }

  await writeCapabilityAttributeRecord({
    providerId,
    capability: 'video_generation',
    source: 'probed',
    attributes: { maxDurationSeconds: confirmedCeiling },
    attributesVerifiedAt: new Date().toISOString().slice(0, 10),
  });

  await projectCapabilityAttributesToModels(providerId, 'video_generation', {
    maxDurationSeconds: confirmedCeiling,
    source: 'probed',
  });

  const draft = await findUnpromotedDraft(providerId, 'video_generation');
  if (draft) {
    await autoPromoteIfAgrees({
      draftId: draft.id,
      providerId,
      capability: 'video_generation',
      draftAttributes: draft.attributes,
      probedValue: confirmedCeiling,
      probedField: 'maxDurationSeconds',
    });
  }

  return { maxDurationSeconds: confirmedCeiling };
}
