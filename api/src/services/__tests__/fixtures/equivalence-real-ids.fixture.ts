// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Loader for equivalence-real-ids.tsv: real model ids of the active production
 * catalog (export of 2026-09-24), a deterministic leaf-closed sample (see the
 * header of the .tsv). Rows come back shaped like the equivalence build input;
 * the export's uids are not committed, so the uid is md5(providerId:modelId),
 * the scheme most production uids follow (it only orders members of a tier).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FixtureRow } from './equivalence-catalog.fixture';

export const REAL_IDS_FIXTURE_PATH = join(__dirname, 'equivalence-real-ids.tsv');

/** Providers whose catalog lists repositories by owner (HuggingFace hub and a host of it). */
export const REPOSITORY_HOST_PROVIDERS: ReadonlySet<string> = new Set([
  'huggingface',
  'featherless-ai',
]);

export function realIdUid(providerId: string, modelId: string): string {
  return createHash('md5').update(`${providerId}:${modelId}`).digest('hex').slice(0, 25);
}

export function loadRealIdCatalog(): FixtureRow[] {
  const rows: FixtureRow[] = [];
  let sawHeader = false;
  for (const line of readFileSync(REAL_IDS_FIXTURE_PATH, 'utf8').split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue;
    if (!sawHeader) {
      sawHeader = true; // column names
      continue;
    }
    const [modelId, providerId, sourceType] = line.split('\t');
    rows.push({
      uid: realIdUid(providerId, modelId),
      modelId,
      providerId,
      provider: providerId,
      sourceType,
    });
  }
  return rows;
}
