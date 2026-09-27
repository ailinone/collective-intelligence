// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { describe, expect, it } from 'vitest';
import { attachRunwaymlTier1Metadata } from '../central-model-discovery-service-runwayml-helper';

describe('attachRunwaymlTier1Metadata', () => {
  it('attaches capabilityAttributes.video_generation with source: schema for runwayml', () => {
    const model = {
      id: 'gen3a_turbo',
      name: 'gen3a_turbo',
      displayName: 'gen3a_turbo',
      contextWindow: 0,
      maxOutputTokens: 0,
      capabilities: ['video_generation'],
      metadata: { originalProvider: 'runwayml' },
    };
    const result = attachRunwaymlTier1Metadata('runwayml', model);
    expect(result.metadata).toMatchObject({
      originalProvider: 'runwayml',
      capabilityAttributes: {
        video_generation: { maxDurationSeconds: 10, source: 'schema' },
      },
    });
  });

  it('is a no-op for any provider other than runwayml', () => {
    const model = { id: 'x', metadata: { foo: 'bar' } };
    const result = attachRunwaymlTier1Metadata('some-other-provider', model);
    expect(result).toBe(model);
  });
});
