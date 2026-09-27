// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * image-deterministic-gate — tests.
 *
 * Mocks `image-size`'s `imageSize()` (same mocking style as
 * `media-deterministic-gate.test.ts` mocks `probeMedia`) so this suite
 * never reads a real file. Property that matters most: an out-of-spec
 * fixture is REJECTED (`status: 'fail'`) with the concrete violation
 * reported, and every missing-input case degrades to a `skipped_*` status
 * rather than fabricating a pass — same fail-open/fail-closed philosophy as
 * the media gate this file mirrors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const imageSize = vi.fn();

vi.mock('image-size', () => ({
  imageSize: (...args: unknown[]) => imageSize(...args),
}));

import {
  runImageDeterministicGate,
  evaluateImageConstraints,
  type ImageEditConstraintSet,
} from './image-deterministic-gate';
import type { AilinArtifact } from '@/types';

beforeEach(() => {
  vi.clearAllMocks();
  imageSize.mockReturnValue({ width: 1024, height: 1024, type: 'png' });
});

function imageArtifact(overrides: Partial<AilinArtifact> = {}): AilinArtifact {
  return {
    modality: 'image',
    stage_name: 'edit-turn',
    stage_index: 0,
    b64_json: Buffer.from('fake image bytes').toString('base64'),
    mime_type: 'image/png',
    ...overrides,
  };
}

describe('runImageDeterministicGate — skip cases (never fabricates a verdict)', () => {
  it('no artifact → skipped_no_bytes', async () => {
    const r = await runImageDeterministicGate(undefined, { format: 'png' });
    expect(r.status).toBe('skipped_no_bytes');
    expect(imageSize).not.toHaveBeenCalled();
  });

  it('artifact with .error (edit call failed) → skipped_no_bytes', async () => {
    const r = await runImageDeterministicGate(
      imageArtifact({ error: 'provider 500', b64_json: undefined }),
      { format: 'png' }
    );
    expect(r.status).toBe('skipped_no_bytes');
    expect(imageSize).not.toHaveBeenCalled();
  });

  it('no constraints supplied → skipped_no_constraints', async () => {
    const r = await runImageDeterministicGate(imageArtifact(), undefined);
    expect(r.status).toBe('skipped_no_constraints');
    expect(imageSize).not.toHaveBeenCalled();
  });

  it('artifact has a url but no inline bytes → skipped_no_bytes (never fetches remote)', async () => {
    const r = await runImageDeterministicGate(
      imageArtifact({ b64_json: undefined, url: 'https://example.test/out.png' }),
      { format: 'png' }
    );
    expect(r.status).toBe('skipped_no_bytes');
    expect(imageSize).not.toHaveBeenCalled();
  });

  it('imageSize throws (unrecognized/corrupt format) → skipped_unavailable, never throws', async () => {
    imageSize.mockImplementation(() => {
      throw new Error('unsupported file type');
    });
    const r = await runImageDeterministicGate(imageArtifact(), { format: 'png' });
    expect(r.status).toBe('skipped_unavailable');
  });
});

describe('runImageDeterministicGate — pass/fail', () => {
  it('matching dimensions and format → pass', async () => {
    imageSize.mockReturnValue({ width: 1024, height: 1024, type: 'png' });
    const r = await runImageDeterministicGate(imageArtifact(), {
      dimensions: { width: 1024, height: 1024 },
      format: 'png',
    });
    expect(r.status).toBe('pass');
    expect(r.violations).toHaveLength(0);
  });

  it('wrong format → fail with a "format" violation', async () => {
    imageSize.mockReturnValue({ width: 1024, height: 1024, type: 'jpg' });
    const r = await runImageDeterministicGate(imageArtifact(), { format: 'png' });
    expect(r.status).toBe('fail');
    expect(r.violations).toEqual([{ constraint: 'format', expected: 'png', actual: 'jpg' }]);
  });

  it('undersized dimensions beyond tolerance → fail with a "dimensions" violation', async () => {
    imageSize.mockReturnValue({ width: 800, height: 800, type: 'png' });
    const r = await runImageDeterministicGate(imageArtifact(), {
      dimensions: { width: 1024, height: 1024, tolerancePct: 0.1 },
    });
    expect(r.status).toBe('fail');
    expect(r.violations[0]?.constraint).toBe('dimensions');
  });

  it('undersized dimensions WITHIN tolerance → pass', async () => {
    imageSize.mockReturnValue({ width: 950, height: 950, type: 'png' });
    const r = await runImageDeterministicGate(imageArtifact(), {
      dimensions: { width: 1024, height: 1024, tolerancePct: 0.1 },
    });
    expect(r.status).toBe('pass');
  });
});

describe('evaluateImageConstraints — pure helper', () => {
  it('reports no violations for an empty constraint set', () => {
    const violations = evaluateImageConstraints(
      { width: 1, height: 1, type: 'png' },
      {} as ImageEditConstraintSet
    );
    expect(violations).toHaveLength(0);
  });
});
