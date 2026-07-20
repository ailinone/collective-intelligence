// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Arbitration System Tests
 * Uses REAL models from dynamic discovery - NO hardcoded models
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { arbitrationSystem, type CompetitiveSolution } from '@/core/arbitration/arbitration-system';
import { startTestEnvironment, stopTestEnvironment } from '../../utils/test-environment';
import { getTestModels, ensureModelsDiscovered } from '../../utils/dynamic-model-discovery';
import type { ChatResponse } from '@/types';

describe('Arbitration System - Real Tests (NO Hardcoded Models)', () => {
  beforeAll(async () => {
    await startTestEnvironment();
    await ensureModelsDiscovered();
  });

  afterAll(async () => {
    await stopTestEnvironment();
  });

  it('should arbitrate between solutions with real models', async () => {
    // Get real models from dynamic discovery - NO hardcoded models
    const realModels = await getTestModels(2);
    if (realModels.length < 2) {
      return; // Skip if not enough models
    }

    const model1 = realModels[0];
    const model2 = realModels[1];

    const mockSolutions: CompetitiveSolution[] = [
      {
        modelId: model1.id, // Use dynamically discovered model
        modelName: model1.name,
        provider: model1.provider,
        response: {
          id: 'resp-1',
          model: model1.id, // Use dynamically discovered model
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '# Solution A\n\nDetailed solution with code examples:\n\n```typescript\nconst example = "code";\n```\n\nThis is a comprehensive solution that addresses all requirements.',
              },
              finishReason: 'stop',
            },
          ],
          usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
        },
        cost: 0.015,
        durationMs: 2500,
      },
      {
        modelId: model2.id, // Use dynamically discovered model
        modelName: model2.name,
        provider: model2.provider,
        response: {
          id: 'resp-2',
          model: model2.id, // Use dynamically discovered model
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'Solution B: Basic response without much detail.',
              },
              finishReason: 'stop',
            },
          ],
          usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        },
        cost: 0.008,
        durationMs: 2000,
      },
    ];

    const result = await arbitrationSystem.arbitrate(
      mockSolutions,
      [
        { id: model1.id, name: model1.name, provider: model1.provider },
        { id: model2.id, name: model2.name, provider: model2.provider },
      ],
      0.7
    );

    expect(result).toBeDefined();
    expect(result.action).toBeDefined();
    expect(result.selectedSolution?.modelId).toBeDefined();
    expect(result.reasoning).toBeDefined();
  }, 60000);
});
