// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-DESIGN §4+5 — Task set and quality rubric contract.
 *
 * Locks in the 8-task set (T1–T8) and 7-dimension quality rubric.
 * Any change to task categories or rubric dimensions/weights must update
 * these tests explicitly.
 *
 * ABSOLUTE PROHIBITIONS:
 *   - This test does NOT execute C3
 *   - This test does NOT execute dryRun=false
 *   - This test does NOT call any LLM provider
 */

import { describe, it, expect } from 'vitest';
import {
  C3_TASK_IDS,
  C3_TASK_CATEGORIES,
  C3_RUBRIC_DIMENSIONS,
  C3_RUBRIC_WEIGHTS,
  C3_SCOPE_POLICY_VERSION,
} from '@/core/experiment/c3-scope-design-contract';

describe('01C.1B-C3-SCOPE-DESIGN §4+5 — task set and quality rubric contract', () => {

  describe('task set: count and IDs', () => {
    it('C3_TASK_IDS has exactly 8 entries', () => {
      expect(C3_TASK_IDS.length).toBe(8);
    });

    it('contains T1 through T8 in order', () => {
      expect([...C3_TASK_IDS]).toEqual(['T1','T2','T3','T4','T5','T6','T7','T8']);
    });
  });

  describe('task categories', () => {
    it('T1 is mathematical_reasoning', () => {
      expect(C3_TASK_CATEGORIES['T1']).toBe('mathematical_reasoning');
    });

    it('T2 is code_generation', () => {
      expect(C3_TASK_CATEGORIES['T2']).toBe('code_generation');
    });

    it('T3 is factual_retrieval', () => {
      expect(C3_TASK_CATEGORIES['T3']).toBe('factual_retrieval');
    });

    it('T4 is logical_deduction', () => {
      expect(C3_TASK_CATEGORIES['T4']).toBe('logical_deduction');
    });

    it('T5 is creative_writing', () => {
      expect(C3_TASK_CATEGORIES['T5']).toBe('creative_writing');
    });

    it('T6 is document_summarization', () => {
      expect(C3_TASK_CATEGORIES['T6']).toBe('document_summarization');
    });

    it('T7 is instruction_following', () => {
      expect(C3_TASK_CATEGORIES['T7']).toBe('instruction_following');
    });

    it('T8 is scientific_explanation', () => {
      expect(C3_TASK_CATEGORIES['T8']).toBe('scientific_explanation');
    });

    it('all tasks have non-empty category', () => {
      for (const taskId of C3_TASK_IDS) {
        expect(C3_TASK_CATEGORIES[taskId]).toBeTruthy();
        expect(C3_TASK_CATEGORIES[taskId].length).toBeGreaterThan(0);
      }
    });

    it('all task categories are unique (no duplicate categories)', () => {
      const categories = C3_TASK_IDS.map(id => C3_TASK_CATEGORIES[id]);
      const unique = new Set(categories);
      expect(unique.size).toBe(C3_TASK_IDS.length);
    });
  });

  describe('quality rubric: dimensions', () => {
    it('C3_RUBRIC_DIMENSIONS has exactly 7 dimensions', () => {
      expect(C3_RUBRIC_DIMENSIONS.length).toBe(7);
    });

    it('contains correctness', () => expect(C3_RUBRIC_DIMENSIONS).toContain('correctness'));
    it('contains completeness', () => expect(C3_RUBRIC_DIMENSIONS).toContain('completeness'));
    it('contains coherence', () => expect(C3_RUBRIC_DIMENSIONS).toContain('coherence'));
    it('contains conciseness', () => expect(C3_RUBRIC_DIMENSIONS).toContain('conciseness'));
    it('contains relevance', () => expect(C3_RUBRIC_DIMENSIONS).toContain('relevance'));
    it('contains factuality', () => expect(C3_RUBRIC_DIMENSIONS).toContain('factuality'));
    it('contains helpfulness', () => expect(C3_RUBRIC_DIMENSIONS).toContain('helpfulness'));
  });

  describe('quality rubric: weights', () => {
    it('all 7 dimensions have a weight entry', () => {
      for (const dim of C3_RUBRIC_DIMENSIONS) {
        expect(C3_RUBRIC_WEIGHTS[dim]).toBeDefined();
        expect(typeof C3_RUBRIC_WEIGHTS[dim]).toBe('number');
      }
    });

    it('all weights are in (0, 1]', () => {
      for (const dim of C3_RUBRIC_DIMENSIONS) {
        const w = C3_RUBRIC_WEIGHTS[dim];
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    });

    it('weights sum to exactly 1.00 (within floating-point tolerance)', () => {
      const total = C3_RUBRIC_DIMENSIONS.reduce((sum, d) => sum + C3_RUBRIC_WEIGHTS[d], 0);
      expect(Math.abs(total - 1.0)).toBeLessThan(0.0001);
    });

    it('correctness has the highest weight (0.25)', () => {
      expect(C3_RUBRIC_WEIGHTS['correctness']).toBe(0.25);
      for (const dim of C3_RUBRIC_DIMENSIONS) {
        if (dim !== 'correctness') {
          expect(C3_RUBRIC_WEIGHTS[dim]).toBeLessThanOrEqual(C3_RUBRIC_WEIGHTS['correctness']);
        }
      }
    });

    it('helpfulness has the lowest weight (0.05)', () => {
      expect(C3_RUBRIC_WEIGHTS['helpfulness']).toBe(0.05);
      for (const dim of C3_RUBRIC_DIMENSIONS) {
        if (dim !== 'helpfulness') {
          expect(C3_RUBRIC_WEIGHTS[dim]).toBeGreaterThanOrEqual(C3_RUBRIC_WEIGHTS['helpfulness']);
        }
      }
    });
  });

  describe('policy version', () => {
    it('C3_SCOPE_POLICY_VERSION is R4 (integrity lock + 23 providers)', () => {
      expect(C3_SCOPE_POLICY_VERSION).toBe('01C.1B-C3-SCOPE-DESIGN-R4-v1');
    });
  });
});
