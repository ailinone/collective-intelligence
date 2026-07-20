// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { CapabilityTester } from '../capabilities';

// Valid 1x1 PNG fixture (base64). We use a real image payload to avoid fake probes.
const TEST_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Y3J8AAAAASUVORK5CYII=';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function getVisionFixture(): Buffer {
  const image = Buffer.from(TEST_PNG_BASE64, 'base64');
  if (image.length < 32 || !image.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Invalid PNG fixture for vision capability probe');
  }
  return image;
}

/**
 * Vision capability probe.
 * Success criteria focus on real transport/inference execution:
 * - valid image fixture sent
 * - provider returned textual output
 */
export const visionTest: CapabilityTester = async ({ client }) => {
  const testImage = getVisionFixture();

  const result = await client.vision({
    prompt:
      'Respond in up to 20 words describing the image content. If extremely small, say what you can detect.',
    image: testImage,
  });

  const content =
    typeof result.content === 'string' ? result.content.trim() : JSON.stringify(result.content);

  const success = content.length > 0;

  return {
    success,
    score: success ? 0.85 : 0,
    metadata: {
      bytes: testImage.length,
      mimeType: 'image/png',
      responsePreview: content.slice(0, 200),
      raw: result.raw,
    },
  };
};

/**
 * Image generation capability probe.
 */
export const imageGenerationTest: CapabilityTester = async ({ client }) => {
  const result = await client.imageGenerate({
    prompt: 'Draw a red circle centered on a white background.',
    size: '512x512',
  });

  const buffer = result.image;
  const minBytes = 10000;
  const success = Buffer.isBuffer(buffer) && buffer.length > minBytes;

  return {
    success,
    score: success ? 1 : 0,
    metadata: { bytes: buffer.length },
  };
};
