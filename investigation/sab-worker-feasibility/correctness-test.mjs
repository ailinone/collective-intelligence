// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

// Verifies the SharedArrayBuffer read path produces IDENTICAL results (same
// candidate id sets, same fairness stats) to the current in-process Map
// approach on the real 111,666-row fixture, across several criteria
// combinations — before trusting ANY benchmark number comparing the two.
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { buildRealisticCatalogRecords } from './fixture.mjs';
import { buildCatalogIndices, getFullCacheFairCandidateModels } from './current-map-approach.mjs';
import { computeLayout, wrapViews } from './schema.mjs';
import { buildGenLookup, getCandidatesFromSharedIndex } from './reader.mjs';

const workerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));

function waitForMessage(worker, type) {
  return new Promise((resolve) => {
    function onMsg(msg) {
      if (msg.type === type) {
        worker.off('message', onMsg);
        resolve(msg);
      }
    }
    worker.on('message', onMsg);
  });
}

async function main() {
  console.log('Building fixture (111,666 rows)...');
  const models = buildRealisticCatalogRecords();
  console.log(`  -> ${models.length} rows`);

  console.log('Building current-Map indices...');
  const mapIndices = buildCatalogIndices(models);

  console.log('Starting worker, requesting initial build...');
  const worker = new Worker(workerPath);
  const ready = await waitForMessage(worker, 'ready');
  const { layout } = computeLayout();
  const viewsA = wrapViews(ready.bufferA, layout);
  const viewsB = wrapViews(ready.bufferB, layout);
  const controlView = new Int32Array(ready.control);

  const rebuiltP = waitForMessage(worker, 'rebuilt');
  worker.postMessage({ type: 'rebuild', models });
  const rebuilt = await rebuiltP;
  console.log(`  -> worker encode took ${rebuilt.buildMs.toFixed(2)}ms, gen=${rebuilt.gen}`);
  console.log(
    `  -> rowCount=${rebuilt.meta.rowCount} curatedTotal=${rebuilt.meta.curatedTotal} aggregatedTotal=${rebuilt.meta.aggregatedTotal} curatedProviderCount=${rebuilt.meta.curatedProviderCount} capNames=${JSON.stringify(rebuilt.meta.capNames)}`
  );

  const activeGenNow = Atomics.load(controlView, 0);
  const activeViews = activeGenNow === 0 ? viewsA : viewsB;
  const gen = buildGenLookup(rebuilt.meta);

  const CASES = [
    { name: 'default (contextSize=1000, no caps, no provider filter)', criteria: { contextSize: 1000 } },
    { name: 'no filters at all', criteria: {} },
    { name: 'requiredCapabilities=[reasoning]', criteria: { contextSize: 1000, requiredCapabilities: ['reasoning'] } },
    { name: 'requiredCapabilities=[vision,reasoning]', criteria: { contextSize: 1000, requiredCapabilities: ['vision', 'reasoning'] } },
    { name: 'requiredCapabilities=[nonexistent-cap] (fail-open expected)', criteria: { contextSize: 1000, requiredCapabilities: ['nonexistent-cap'] } },
    { name: 'preferredProviders=[openai,anthropic]', criteria: { contextSize: 1000, preferredProviders: ['openai', 'anthropic'] } },
    { name: 'excludeProviders=[featherless-ai]', criteria: { contextSize: 1000, excludeProviders: ['featherless-ai'] } },
    { name: 'high contextSize=200000 (curated bucket rows are all 128k -> should empty curated)', criteria: { contextSize: 200_000 } },
  ];

  const CURATED_TAKE = 400;
  const AGGREGATED_TAKE = 300;
  const MAX_PROVIDER_SHARE = 0.15;

  let allPass = true;
  for (const { name, criteria } of CASES) {
    const mapResult = getFullCacheFairCandidateModels(mapIndices, criteria, CURATED_TAKE, AGGREGATED_TAKE, MAX_PROVIDER_SHARE);
    const sabResult = getCandidatesFromSharedIndex(activeViews, gen, criteria, CURATED_TAKE, AGGREGATED_TAKE, MAX_PROVIDER_SHARE);

    const mapIds = new Set(mapResult.models.map((m) => m.id));
    const sabIds = new Set(sabResult.models.map((m) => m.id));
    const idsMatch = mapIds.size === sabIds.size && [...mapIds].every((id) => sabIds.has(id));

    const statsMatch =
      mapResult.curatedCount === sabResult.curatedCount &&
      mapResult.aggregatedCount === sabResult.aggregatedCount &&
      mapResult.curatedDistinctProviders === sabResult.curatedDistinctProviders &&
      Math.abs(mapResult.curatedTopProviderShare - sabResult.curatedTopProviderShare) < 1e-9;

    const pass = idsMatch && statsMatch;
    allPass = allPass && pass;
    console.log(
      `${pass ? 'PASS' : 'FAIL'} — ${name}\n` +
        `  map: curated=${mapResult.curatedCount} aggregated=${mapResult.aggregatedCount} distinctProviders=${mapResult.curatedDistinctProviders} topShare=${mapResult.curatedTopProviderShare.toFixed(4)}\n` +
        `  sab: curated=${sabResult.curatedCount} aggregated=${sabResult.aggregatedCount} distinctProviders=${sabResult.curatedDistinctProviders} topShare=${sabResult.curatedTopProviderShare.toFixed(4)}\n` +
        `  idsMatch=${idsMatch} (map=${mapIds.size} sab=${sabIds.size})`
    );
    if (!pass && idsMatch === false) {
      const onlyInMap = [...mapIds].filter((id) => !sabIds.has(id)).slice(0, 5);
      const onlyInSab = [...sabIds].filter((id) => !mapIds.has(id)).slice(0, 5);
      console.log(`  sample onlyInMap=${JSON.stringify(onlyInMap)} onlyInSab=${JSON.stringify(onlyInSab)}`);
    }
  }

  console.log(allPass ? '\nALL CASES MATCH — SAB reader is a faithful port.' : '\nMISMATCH DETECTED — see FAIL lines above.');
  await worker.terminate();
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
