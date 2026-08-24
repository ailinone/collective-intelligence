// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * The `ailin-*` aliases are the product's public model names.
 *
 * `id` is the wire contract — clients send it back as `model`, and it is
 * hardcoded in chat (`ANONYMOUS_DEFAULT_MODEL_ID`, the default-model resolver,
 * and the seeded agent's `base_model_id`). It must never change.
 * `displayName` is the label, and is free to change.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(join(__dirname, '..', 'ailin-virtual-model-service.ts'), 'utf8');

const EXPECTED: Array<[string, string]> = [
  ['ailin-auto', 'Ailin¹ Auto'],
  ['ailin-best', 'Ailin¹ High'],
  ['ailin-fast', 'Ailin¹ Fast'],
  ['ailin-economy', 'Ailin¹ Budget'],
  ['ailin-consensus', 'Ailin¹ Consensus'],
];

describe('ailin-* alias labels', () => {
  it.each(EXPECTED)('%s keeps its id', (id) => {
    expect(SOURCE).toContain(`id: '${id}'`);
  });

  it.each(EXPECTED)('%s is labelled %s', (_id, displayName) => {
    expect(SOURCE).toContain(`displayName: '${displayName}'`);
  });

  it('never renames an id to the display name', () => {
    for (const [, displayName] of EXPECTED) {
      expect(SOURCE).not.toContain(`id: '${displayName}'`);
    }
  });
});
