// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { canSatisfyDocumentAttributes } from '../document-capability-matcher';

describe('canSatisfyDocumentAttributes', () => {
  it('fails open when attrs is undefined', () => {
    expect(canSatisfyDocumentAttributes(undefined, { pageCount: 500 })).toBe(true);
  });

  it('fails open when maxPages is undeclared', () => {
    expect(canSatisfyDocumentAttributes({ source: 'human' }, { pageCount: 500 })).toBe(true);
  });

  it('rejects a request exceeding the declared maxPages', () => {
    expect(canSatisfyDocumentAttributes({ maxPages: 100 }, { pageCount: 200 })).toBe(false);
  });

  it('accepts a request within the declared maxPages', () => {
    expect(canSatisfyDocumentAttributes({ maxPages: 200 }, { pageCount: 100 })).toBe(true);
  });
});
