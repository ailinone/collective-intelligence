// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * historical-results-deduper.ts — MVP 8B.6
 *
 * Deduplicates normalised rows by `executionId`. When two rows share an
 * id, the FIRST one (in input order) wins and a deduplication record
 * is emitted for the audit log.
 *
 * Pure function.
 */

import type { NormalisedRow } from './historical-results-schema';

export interface DedupeResult {
  readonly unique: readonly NormalisedRow[];
  readonly duplicates: readonly {
    readonly executionId: string;
    readonly occurrence: number;
  }[];
}

export function dedupeRows(rows: readonly NormalisedRow[]): DedupeResult {
  const seen = new Set<string>();
  const unique: NormalisedRow[] = [];
  const duplicates: { executionId: string; occurrence: number }[] = [];
  const occurrenceCount: Record<string, number> = {};
  for (const r of rows) {
    if (seen.has(r.executionId)) {
      occurrenceCount[r.executionId] = (occurrenceCount[r.executionId] ?? 1) + 1;
      duplicates.push({
        executionId: r.executionId,
        occurrence: occurrenceCount[r.executionId],
      });
      continue;
    }
    seen.add(r.executionId);
    occurrenceCount[r.executionId] = 1;
    unique.push(r);
  }
  return Object.freeze({
    unique: Object.freeze(unique),
    duplicates: Object.freeze(duplicates),
  });
}
