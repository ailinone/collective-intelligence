// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Faithful JS port of the CURRENT (SELECTION_USE_FULL_CACHE_INDEX) approach:
// api/src/services/model-catalog-service.ts's buildCatalogIndices() +
// api/src/core/selection/dynamic-model-selector.ts's
// getFullCacheFairCandidateModels() / selectCuratedFairUids(). Logic copied
// 1:1 (control flow, comments on tie-break rules preserved) — this is the
// baseline the SharedArrayBuffer prototype is measured against.

export function buildCatalogIndices(models) {
  const byCapability = new Map();
  const byProvider = new Map();
  const byId = new Map();
  for (const model of models) {
    byId.set(model.id, model);
    const providerList = byProvider.get(model.provider);
    if (providerList) providerList.push(model.id);
    else byProvider.set(model.provider, [model.id]);
    const caps = Array.isArray(model.capabilities) ? model.capabilities : [];
    for (const cap of caps) {
      let set = byCapability.get(cap);
      if (!set) {
        set = new Set();
        byCapability.set(cap, set);
      }
      set.add(model.id);
    }
  }
  return { byCapability, byProvider, byId, builtAt: Date.now() };
}

function sortByUsageThenUid(a, b) {
  if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
  return a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0;
}

export function selectCuratedFairUids(rows, filters, curatedTake, maxProviderShare) {
  if (rows.length === 0 || curatedTake <= 0) {
    return { uids: [], distinctProviders: 0, topProviderShare: 0 };
  }
  const includeSet =
    filters.includeProviderNames && filters.includeProviderNames.length > 0
      ? new Set(filters.includeProviderNames)
      : null;
  const excludeSet =
    filters.excludeProviderNames && filters.excludeProviderNames.length > 0
      ? new Set(filters.excludeProviderNames)
      : null;
  const minContext = filters.contextSize ?? 0;

  const byProvider = new Map();
  for (const row of rows) {
    if (minContext > 0 && row.contextWindow < minContext) continue;
    if (includeSet && !includeSet.has(row.providerName)) continue;
    if (excludeSet && excludeSet.has(row.providerName)) continue;
    let list = byProvider.get(row.providerId);
    if (!list) {
      list = [];
      byProvider.set(row.providerId, list);
    }
    list.push(row);
  }
  if (byProvider.size === 0) return { uids: [], distinctProviders: 0, topProviderShare: 0 };

  for (const list of byProvider.values()) list.sort(sortByUsageThenUid);

  const perProviderCap = Math.max(1, Math.ceil(curatedTake * maxProviderShare));
  const providerLists = [...byProvider.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const uids = [];
  const takenPerProvider = new Map();

  for (let rank = 0; rank < perProviderCap && uids.length < curatedTake; rank++) {
    let addedThisRound = false;
    for (const [providerId, list] of providerLists) {
      if (uids.length >= curatedTake) break;
      if (rank >= list.length) continue;
      uids.push(list[rank].uid);
      takenPerProvider.set(providerId, (takenPerProvider.get(providerId) ?? 0) + 1);
      addedThisRound = true;
    }
    if (!addedThisRound) break;
  }

  const topProviderCount = takenPerProvider.size > 0 ? Math.max(...takenPerProvider.values()) : 0;
  return {
    uids,
    distinctProviders: takenPerProvider.size,
    topProviderShare: uids.length > 0 ? topProviderCount / uids.length : 0,
  };
}

export function getFullCacheFairCandidateModels(indices, criteria, curatedTake, aggregatedTake, curatedMaxProviderShare) {
  const empty = {
    models: [],
    uids: [],
    curatedCount: 0,
    aggregatedCount: 0,
    curatedDistinctProviders: 0,
    curatedTopProviderShare: 0,
  };
  if (!indices || indices.byId.size === 0) return empty;

  let candidateIds = null;
  const hardRequiredCaps = (criteria.requiredCapabilities ?? []).filter((c) => c !== 'function_calling');
  if (hardRequiredCaps.length > 0) {
    for (const cap of hardRequiredCaps) {
      const matchesCap = indices.byCapability.get(cap) ?? new Set();
      if (candidateIds === null) {
        candidateIds = new Set(matchesCap);
      } else {
        for (const id of candidateIds) {
          if (!matchesCap.has(id)) candidateIds.delete(id);
        }
      }
    }
    if (candidateIds && candidateIds.size === 0) candidateIds = null;
  }

  const includeSet =
    criteria.preferredProviders && criteria.preferredProviders.length > 0 ? new Set(criteria.preferredProviders) : null;
  const excludeSet =
    criteria.excludeProviders && criteria.excludeProviders.length > 0 ? new Set(criteria.excludeProviders) : null;
  const minContext = criteria.contextSize ?? 0;

  const curatedRows = [];
  const aggregatedCandidates = [];

  for (const model of indices.byId.values()) {
    if (model.status === 'disabled') continue;
    if (candidateIds && !candidateIds.has(model.id)) continue;
    if (minContext > 0 && model.contextWindow < minContext) continue;
    if (includeSet && !includeSet.has(model.provider)) continue;
    if (excludeSet && excludeSet.has(model.provider)) continue;

    const metadata = model.metadata ?? {};
    const hubInventoryClass = typeof metadata.hubInventoryClass === 'string' ? metadata.hubInventoryClass : undefined;
    const serverlessCallable = metadata.serverless_callable === true;

    if (hubInventoryClass !== 'aggregated_index') {
      curatedRows.push({
        uid: model.id,
        providerId: model.providerId,
        providerName: model.provider,
        contextWindow: model.contextWindow,
        usageCount: 0,
      });
    } else if (serverlessCallable) {
      aggregatedCandidates.push(model);
    }
  }

  const {
    uids: curatedUids,
    distinctProviders: curatedDistinctProviders,
    topProviderShare: curatedTopProviderShare,
  } = selectCuratedFairUids(curatedRows, {}, curatedTake, curatedMaxProviderShare);

  aggregatedCandidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const aggregatedSelected = aggregatedCandidates.slice(0, aggregatedTake);

  const curatedModels = curatedUids.map((id) => indices.byId.get(id)).filter(Boolean);

  return {
    models: [...curatedModels, ...aggregatedSelected],
    uids: [...curatedUids, ...aggregatedSelected.map((m) => m.id)],
    curatedCount: curatedModels.length,
    aggregatedCount: aggregatedSelected.length,
    curatedDistinctProviders,
    curatedTopProviderShare,
  };
}
