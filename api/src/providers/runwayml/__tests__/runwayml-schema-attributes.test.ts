// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { getRunwaymlSchemaCapabilityAttributes } from '../runwayml-schema-attributes';

describe('getRunwaymlSchemaCapabilityAttributes', () => {
  it('returns the documented 2024-11-06 parameter contract with source: schema', () => {
    const attrs = getRunwaymlSchemaCapabilityAttributes('2024-11-06');
    expect(attrs).toMatchObject({
      maxDurationSeconds: 10,
      minDurationSeconds: 2,
      nativeAudioSupport: false,
      source: 'schema',
    });
    expect(attrs?.supportedAspectRatios).toContain('1280:720');
  });

  it('returns undefined for an unrecognized API version rather than guessing', () => {
    expect(getRunwaymlSchemaCapabilityAttributes('1999-01-01')).toBeUndefined();
  });
});
