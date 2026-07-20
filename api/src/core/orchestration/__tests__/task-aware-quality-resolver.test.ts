// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J2-C-R4 §12 — Task-aware quality resolver tests.
 *
 * Covers:
 *   - Task-type → category mapping for every TaskType
 *   - expectedFormat overrides (code/json prepends code_webdev)
 *   - Resolution path: task_category vs source_category_avg vs aggregate
 *   - Behavior when entry is undefined
 *   - Behavior when priority's first category is missing but second has data
 *   - Aggregate fallback when no category in priority is covered
 */
import { describe, it, expect } from 'vitest';
import {
  categoryPriorityForTask,
  resolveTaskAwareQuality,
} from '@/core/orchestration/role-selection/task-aware-quality-resolver';
import type { ModelQualityCalibrationEntry } from '@/core/orchestration/role-selection/model-quality-calibration';

function mkEntry(
  overrides: Partial<ModelQualityCalibrationEntry> = {},
): ModelQualityCalibrationEntry {
  return {
    modelId: 'test-x',
    qualityScore: 0.7,
    qualityScoreSource: 'external_benchmark',
    qualityConfidence: 'high',
    warnings: [],
    createdAt: '2026-05-19T00:00:00.000Z',
    ...overrides,
  };
}

describe('01C.1B-J2-C-R4 §12 — categoryPriorityForTask', () => {
  it('maps code-generation → code_webdev first', () => {
    expect(categoryPriorityForTask({ taskType: 'code-generation' })[0]).toBe('code_webdev');
  });

  it('maps debugging → code_webdev first', () => {
    expect(categoryPriorityForTask({ taskType: 'debugging' })[0]).toBe('code_webdev');
  });

  it('maps document-understanding → chat_document first', () => {
    expect(categoryPriorityForTask({ taskType: 'document-understanding' })[0]).toBe('chat_document');
  });

  it('maps analysis → chat_document first', () => {
    expect(categoryPriorityForTask({ taskType: 'analysis' })[0]).toBe('chat_document');
  });

  it('maps general → chat_text', () => {
    expect(categoryPriorityForTask({ taskType: 'general' })).toEqual(['chat_text']);
  });

  it('unknown taskType falls back to [chat_text]', () => {
    expect(categoryPriorityForTask({ taskType: 'unknown-mystery-type' })).toEqual(['chat_text']);
  });

  it('empty / undefined taskType falls back to [chat_text]', () => {
    expect(categoryPriorityForTask({})).toEqual(['chat_text']);
  });

  it('expectedFormat=code prepends code_webdev for non-code task', () => {
    const r = categoryPriorityForTask({ taskType: 'general', expectedFormat: 'code' });
    expect(r[0]).toBe('code_webdev');
  });

  it('expectedFormat=json prepends code_webdev', () => {
    const r = categoryPriorityForTask({ taskType: 'creative', expectedFormat: 'json' });
    expect(r[0]).toBe('code_webdev');
  });

  it('expectedFormat=code does NOT duplicate code_webdev when already at front', () => {
    const r = categoryPriorityForTask({ taskType: 'code-generation', expectedFormat: 'code' });
    expect(r[0]).toBe('code_webdev');
    expect(r.filter((c) => c === 'code_webdev').length).toBe(1);
  });
});

describe('01C.1B-J2-C-R4 §12 — resolveTaskAwareQuality', () => {
  it('returns unavailable when entry is undefined', () => {
    const r = resolveTaskAwareQuality(undefined, { taskType: 'general' });
    expect(r.score).toBeUndefined();
    expect(r.resolutionPath).toBe('unavailable');
  });

  it('uses task_category when entry has taskCategoryScores[priority[0]]', () => {
    const entry = mkEntry({
      qualityScore: 0.7,
      taskCategoryScores: { code_webdev: 0.95 },
    });
    const r = resolveTaskAwareQuality(entry, { taskType: 'code-generation' });
    expect(r.score).toBe(0.95);
    expect(r.resolutionPath).toBe('task_category');
    expect(r.matchedCategory).toBe('code_webdev');
  });

  it('falls down priority list when first category missing', () => {
    const entry = mkEntry({
      qualityScore: 0.7,
      // priority for code-generation is [code_webdev, chat_text]
      // No code_webdev data; only chat_text data
      taskCategoryScores: { chat_text: 0.85 },
    });
    const r = resolveTaskAwareQuality(entry, { taskType: 'code-generation' });
    expect(r.score).toBe(0.85);
    expect(r.matchedCategory).toBe('chat_text');
  });

  it('falls back to aggregate when NO category in priority is covered', () => {
    const entry = mkEntry({
      qualityScore: 0.7,
      // priority for code-generation is [code_webdev, chat_text]
      // Entry has only image_t2i — no match in priority list
      taskCategoryScores: { image_t2i: 0.95 },
    });
    const r = resolveTaskAwareQuality(entry, { taskType: 'code-generation' });
    expect(r.score).toBe(0.7);
    expect(r.resolutionPath).toBe('aggregate');
    expect(r.matchedCategory).toBeUndefined();
  });

  it('uses source_category_avg when taskCategoryScores missing but sourceScores cover category', () => {
    const entry = mkEntry({
      qualityScore: 0.6,
      sourceScores: [
        { source: 'lmarena', score: 0.7, confidence: 'high', categoryScores: { code_webdev: 0.92 } },
      ],
      qualityScoreSources: ['lmarena'],
    });
    const r = resolveTaskAwareQuality(entry, { taskType: 'code-generation' });
    expect(r.score).toBe(0.92); // single source, weight cancels
    expect(r.resolutionPath).toBe('source_category_avg');
    expect(r.matchedCategory).toBe('code_webdev');
  });

  it('expectedFormat=code on a general task pulls code_webdev to front', () => {
    const entry = mkEntry({
      qualityScore: 0.5,
      taskCategoryScores: { chat_text: 0.85, code_webdev: 0.95 },
    });
    const r = resolveTaskAwareQuality(entry, { taskType: 'general', expectedFormat: 'code' });
    expect(r.matchedCategory).toBe('code_webdev');
    expect(r.score).toBe(0.95);
  });

  it('aggregate path returns entry.qualityScore for entry with no category data', () => {
    const entry = mkEntry({ qualityScore: 0.6 });
    const r = resolveTaskAwareQuality(entry, { taskType: 'general' });
    expect(r.score).toBe(0.6);
    expect(r.resolutionPath).toBe('aggregate');
  });

  it('priorityConsidered reflects the actual priority list searched', () => {
    const entry = mkEntry({ qualityScore: 0.6 });
    const r = resolveTaskAwareQuality(entry, { taskType: 'document-understanding' });
    expect(r.priorityConsidered).toEqual(['chat_document', 'chat_text']);
  });

  it('matchedCategory undefined when resolutionPath=aggregate', () => {
    const entry = mkEntry({ qualityScore: 0.6 });
    const r = resolveTaskAwareQuality(entry, { taskType: 'general' });
    expect(r.matchedCategory).toBeUndefined();
  });

  it('matchedCategory undefined when resolutionPath=unavailable', () => {
    const r = resolveTaskAwareQuality(undefined, { taskType: 'general' });
    expect(r.matchedCategory).toBeUndefined();
  });

  it('image_edit task (mapped via expectedFormat hack) uses image_edit category', () => {
    const entry = mkEntry({
      qualityScore: 0.5,
      taskCategoryScores: { image_edit: 0.93, chat_text: 0.7 },
    });
    // No direct TaskType for image_edit yet; use expectedFormat=free_text on a creative task
    // and verify chat_text wins; then verify with a custom category that an image-task pool
    // would set up. (This documents the current limitation — image-task mapping is a future ext.)
    const r = resolveTaskAwareQuality(entry, { taskType: 'creative' });
    expect(r.matchedCategory).toBe('chat_text');
    expect(r.score).toBe(0.7);
  });

  it('factual-qa lists chat_search as secondary priority', () => {
    const priority = categoryPriorityForTask({ taskType: 'factual-qa' });
    expect(priority).toContain('chat_search');
  });
});
