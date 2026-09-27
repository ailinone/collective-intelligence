// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { canSatisfyImageAttributes, parseDimensions } from '../image-capability-matcher';

describe('parseDimensions', () => {
  it('parses "2048x2048" into width/height', () => {
    expect(parseDimensions('2048x2048')).toEqual({ width: 2048, height: 2048 });
  });
  it('returns null for an unparseable string', () => {
    expect(parseDimensions('huge')).toBeNull();
  });
});

describe('canSatisfyImageAttributes', () => {
  it('fails open when attrs is undefined', () => {
    expect(canSatisfyImageAttributes(undefined, { width: 4096, height: 4096 })).toBe(true);
  });

  it('fails open when the declared maxDimensions is unparseable', () => {
    expect(
      canSatisfyImageAttributes({ maxDimensions: 'huge' }, { width: 4096, height: 4096 })
    ).toBe(true);
  });

  it('rejects a request exceeding the declared maxDimensions', () => {
    expect(
      canSatisfyImageAttributes({ maxDimensions: '1024x1024' }, { width: 2048, height: 2048 })
    ).toBe(false);
  });

  it('accepts a request within the declared maxDimensions', () => {
    expect(
      canSatisfyImageAttributes({ maxDimensions: '2048x2048' }, { width: 1024, height: 1024 })
    ).toBe(true);
  });

  it('rejects a requested format absent from a declared, non-empty supportedFormats list', () => {
    expect(
      canSatisfyImageAttributes({ supportedFormats: ['png', 'jpeg'] }, { format: 'webp' })
    ).toBe(false);
  });

  it('accepts when no format was requested even if supportedFormats is declared', () => {
    expect(canSatisfyImageAttributes({ supportedFormats: ['png'] }, {})).toBe(true);
  });
});
