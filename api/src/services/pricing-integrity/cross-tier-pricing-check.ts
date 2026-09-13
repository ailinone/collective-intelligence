// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Cross-tier pricing sanity check.
 *
 * Catches the shape of bug seen in openai-model-fetcher.ts (2026-09): a
 * cheap/fast-tier-named model (`o3-mini`, `gpt-5-nano`, `gemini-2.5-flash-lite`,
 * ...) priced at or above its own family's flagship-tier price. That specific
 * fetcher bug is fixed at the source (the missing `&& !isFast` guard), but
 * fixing one fetcher does not stop the NEXT one from shipping the same class
 * of mistake — this module is the catalog-wide, provider-agnostic detector
 * that would have caught it regardless of which fetcher introduced it.
 *
 * Deliberately NOT a hardcoded per-model table: family membership and
 * cheap/flagship classification are both derived from generic tier-naming
 * TOKENS that are conventions used across many providers' own model names
 * (openai's mini/nano, google's flash/flash-lite, anthropic's haiku, ...),
 * not specific model ids. A brand-new model with one of these tokens in its
 * id is classified automatically — zero code change required.
 */

/** A minimal, provider-agnostic view of a priced catalog row. */
export interface PricedModel {
  id: string;
  providerId: string;
  inputCostPer1M: number;
  outputCostPer1M: number;
}

export interface CrossTierViolation {
  providerId: string;
  family: string;
  cheapModelId: string;
  cheapInputCostPer1M: number;
  cheapOutputCostPer1M: number;
  flagshipModelId: string;
  flagshipInputCostPer1M: number;
  flagshipOutputCostPer1M: number;
  /** Which metric(s) triggered the violation. */
  violatedOn: Array<'input' | 'output'>;
}

/**
 * Naming-convention tokens that mark a model as the cheaper/faster tier of
 * its family, used across many real provider catalogs (not specific to any
 * one provider). Order does not matter — tokenization below matches whole
 * hyphen/underscore-delimited segments, not substrings, so this never
 * mis-fires on an unrelated word that merely contains one of these as a
 * substring (e.g. "flashcard").
 */
const CHEAP_TIER_TOKENS = new Set([
  'nano',
  'mini',
  'lite',
  'tiny',
  'small',
  'flash',
  'haiku',
  'fast',
]);

/**
 * Tokens stripped when deriving a model's "family" root, so that e.g.
 * `gemini-2.5-flash-lite`, `gemini-2.5-flash`, and `gemini-2.5-pro` all
 * collapse to the same family (`gemini-2.5`) despite differing tiers. This
 * union includes both the cheap tokens above and generic flagship-side
 * tokens (`pro`, `max`, `ultra`, `opus`, `turbo`) — none of these are
 * specific model names, only generic tier qualifiers.
 */
const TIER_STRIP_TOKENS = new Set([...CHEAP_TIER_TOKENS, 'pro', 'max', 'ultra', 'opus', 'turbo']);

function tokenize(modelId: string): string[] {
  return modelId
    .toLowerCase()
    .split(/[-_/\s]+/)
    .filter((t) => t.length > 0);
}

/** Whether any tier-qualifier token in the id marks it as the cheap tier. */
export function isCheapTierModelId(modelId: string): boolean {
  return tokenize(modelId).some((t) => CHEAP_TIER_TOKENS.has(t));
}

/**
 * Derive a family key by stripping generic tier-qualifier tokens from the
 * model id. Two models differing only by tier (mini/pro/flash/lite/...)
 * collapse to the same family; two genuinely different model lines do not.
 */
export function deriveModelFamily(modelId: string): string {
  const kept = tokenize(modelId).filter((t) => !TIER_STRIP_TOKENS.has(t));
  // A model id that is ENTIRELY tier tokens (pathological/synthetic input)
  // falls back to the untouched id so it never collapses into an empty,
  // maximally-overloaded family bucket shared by unrelated models.
  return kept.length > 0 ? kept.join('-') : modelId.toLowerCase();
}

/**
 * Find every (provider, family) group where a cheap-tier-tagged model's price
 * is >= a same-family, non-cheap-tagged ("flagship") model's price on either
 * input or output cost. Models with a non-positive cost on both axes are
 * excluded from comparison — a 0 typically signals "pricing unknown" (see
 * the `pricingSource: 'unknown'` convention across the fetchers), not a
 * confirmed free tier, and comparing against it would produce false
 * positives/negatives either way.
 */
export function findCrossTierPricingViolations(models: PricedModel[]): CrossTierViolation[] {
  const priced = models.filter((m) => m.inputCostPer1M > 0 || m.outputCostPer1M > 0);

  const groups = new Map<string, PricedModel[]>();
  for (const model of priced) {
    const key = `${model.providerId}::${deriveModelFamily(model.id)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(model);
    else groups.set(key, [model]);
  }

  const violations: CrossTierViolation[] = [];

  for (const [key, bucket] of groups) {
    if (bucket.length < 2) continue; // Nothing to compare within a singleton family.

    const family = key.slice(key.indexOf('::') + 2);
    const cheap = bucket.filter((m) => isCheapTierModelId(m.id));
    const flagship = bucket.filter((m) => !isCheapTierModelId(m.id));
    if (cheap.length === 0 || flagship.length === 0) continue;

    for (const cheapModel of cheap) {
      for (const flagshipModel of flagship) {
        const violatedOn: Array<'input' | 'output'> = [];
        if (
          cheapModel.inputCostPer1M > 0 &&
          flagshipModel.inputCostPer1M > 0 &&
          cheapModel.inputCostPer1M >= flagshipModel.inputCostPer1M
        ) {
          violatedOn.push('input');
        }
        if (
          cheapModel.outputCostPer1M > 0 &&
          flagshipModel.outputCostPer1M > 0 &&
          cheapModel.outputCostPer1M >= flagshipModel.outputCostPer1M
        ) {
          violatedOn.push('output');
        }
        if (violatedOn.length > 0) {
          violations.push({
            providerId: cheapModel.providerId,
            family,
            cheapModelId: cheapModel.id,
            cheapInputCostPer1M: cheapModel.inputCostPer1M,
            cheapOutputCostPer1M: cheapModel.outputCostPer1M,
            flagshipModelId: flagshipModel.id,
            flagshipInputCostPer1M: flagshipModel.inputCostPer1M,
            flagshipOutputCostPer1M: flagshipModel.outputCostPer1M,
            violatedOn,
          });
        }
      }
    }
  }

  return violations;
}
