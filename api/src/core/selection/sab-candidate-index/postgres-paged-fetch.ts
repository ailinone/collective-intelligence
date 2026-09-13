// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Keyset-paginated Postgres fetch for the SAB candidate-index worker's
 * fallback path. Pure (the querier is injected) so the paging contract can
 * be unit-tested without a database; `worker.ts` supplies the real Prisma
 * querier with a per-page `SET LOCAL statement_timeout`.
 *
 * Why pages instead of one `findMany` over the whole table: the previous
 * single query made one Postgres backend sequentially scan and de-TOAST
 * the entire `models` relation (2.1 GB with indexes and TOAST at 112k
 * rows) and buffer a ~120 MB result set, inside the production database container with a
 * 1 GiB memory limit that the OOM killer was already hitting on 2026-09-11
 * (ADR-027, "Canary 2"). Keyset pages on the primary key (`uid > last`,
 * ordered by `uid`) bound both the per-statement work on the backend and
 * the worker's own transient heap (one page of raw records at a time
 * instead of all 112k co-resident with their mapped `Model`s).
 *
 * Why `uid > last` and not Prisma's `cursor:`: `cursor:` requires the
 * cursor row to still exist; a discovery run deleting it between pages
 * would make the next page come back empty and this loop would publish a
 * silently partial generation. A strict-greater-than predicate on the PK
 * has no such dependency.
 */
import type { Model } from '@/types';
import { mapPrismaModel, type CatalogHotPathRecord } from '@/services/catalog-hot-path';

export type CatalogHotPathRecordWithUid = CatalogHotPathRecord & { uid: string };

export interface CatalogPageQuerier {
  /** Returns up to `take` non-disabled rows with `uid > afterUid` (all rows
   *  when `afterUid` is null), ordered by `uid` ascending. */
  fetchPage(afterUid: string | null, take: number): Promise<CatalogHotPathRecordWithUid[]>;
}

export const DEFAULT_POSTGRES_FETCH_PAGE_SIZE = 5_000;

export async function fetchCatalogModelsPaged(
  querier: CatalogPageQuerier,
  pageSize: number = DEFAULT_POSTGRES_FETCH_PAGE_SIZE
): Promise<{ models: Model[]; pages: number }> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`sab-candidate-index paged fetch: invalid page size ${pageSize}`);
  }
  const models: Model[] = [];
  let afterUid: string | null = null;
  let pages = 0;
  for (;;) {
    const page = await querier.fetchPage(afterUid, pageSize);
    pages += 1;
    for (const record of page) models.push(mapPrismaModel(record));
    if (page.length < pageSize) break;
    const lastUid = page[page.length - 1].uid;
    if (afterUid !== null && lastUid <= afterUid) {
      // A querier that does not honor the keyset predicate would loop
      // forever re-fetching the same page; fail instead.
      throw new Error(
        `sab-candidate-index paged fetch: cursor did not advance (page ended at uid ${lastUid}, previous ${afterUid})`
      );
    }
    afterUid = lastUid;
  }
  return { models, pages };
}
