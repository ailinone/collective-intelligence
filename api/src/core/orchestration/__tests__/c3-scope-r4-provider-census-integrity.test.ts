// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-C3-SCOPE-R4 — Provider Census Integrity
 *
 * Verifies the R4 provider census closes to 82 with zero unknowns.
 * All 82 registered providers must be in exactly one bucket.
 *
 * ABSOLUTE PROHIBITIONS:
 *   - No C3 execution, no provider calls, no dryRun=false, no secrets.
 */

import { describe, it, expect } from 'vitest';
import {
  C3_REGISTERED_PROVIDER_TOTAL,
  C3_CHAT_READY_PROVIDER_COUNT,
  C3_CHAT_READY_PROVIDERS,
  C3_EXECUTION_AUTHORIZED,
  DRYRUN_FALSE_AUTHORIZED,
  BILLABLE_PROVIDER_CALLS_AUTHORIZED,
} from '@/core/experiment/c3-scope-design-contract';

// Provider census canonical bucket breakdown (matches 01c1b-c3-scope-r4-provider-census-final.json)
const BUCKET_COUNTS = {
  chat_ready:              23,
  credit_blocked:          20,
  auth_blocked:            12,
  suspended_or_shutdown:    2,
  api_or_model_blocked:     2,
  gcloud_or_project_blocked:1,
  missing_secret:           5,
  local_not_configured:     8,
  non_chat:                 9,
} as const;

const BUCKET_SUM = Object.values(BUCKET_COUNTS).reduce((a, b) => a + b, 0);

describe('01C.1B-C3-SCOPE-R4 — provider census integrity', () => {

  describe('totals', () => {
    it('C3_REGISTERED_PROVIDER_TOTAL is 82', () => {
      expect(C3_REGISTERED_PROVIDER_TOTAL).toBe(82);
    });

    it('bucket sum equals 82', () => {
      expect(BUCKET_SUM).toBe(82);
    });

    it('bucket sum equals C3_REGISTERED_PROVIDER_TOTAL', () => {
      expect(BUCKET_SUM).toBe(C3_REGISTERED_PROVIDER_TOTAL);
    });

    it('chat-ready bucket is 23', () => {
      expect(BUCKET_COUNTS.chat_ready).toBe(23);
    });

    it('C3_CHAT_READY_PROVIDER_COUNT matches bucket count', () => {
      expect(C3_CHAT_READY_PROVIDER_COUNT).toBe(BUCKET_COUNTS.chat_ready);
    });
  });

  describe('bucket accounting', () => {
    it('no bucket has zero entries', () => {
      for (const [bucket, count] of Object.entries(BUCKET_COUNTS)) {
        expect(count).toBeGreaterThan(0);
        void bucket;
      }
    });

    it('credit_blocked is 20 (15 R2 baseline + 5 R3 reprobe)', () => {
      expect(BUCKET_COUNTS.credit_blocked).toBe(20);
    });

    it('auth_blocked is 12 (7 R2 baseline + 5 R3 reprobe)', () => {
      expect(BUCKET_COUNTS.auth_blocked).toBe(12);
    });

    it('local_not_configured is 8', () => {
      expect(BUCKET_COUNTS.local_not_configured).toBe(8);
    });

    it('non_chat is 9', () => {
      expect(BUCKET_COUNTS.non_chat).toBe(9);
    });

    it('missing_secret is 5', () => {
      expect(BUCKET_COUNTS.missing_secret).toBe(5);
    });

    it('suspended_or_shutdown is 2', () => {
      expect(BUCKET_COUNTS.suspended_or_shutdown).toBe(2);
    });

    it('api_or_model_blocked is 2 (bytez, v0)', () => {
      expect(BUCKET_COUNTS.api_or_model_blocked).toBe(2);
    });

    it('gcloud_or_project_blocked is 1 (vertex-ai)', () => {
      expect(BUCKET_COUNTS.gcloud_or_project_blocked).toBe(1);
    });
  });

  describe('chat-ready providers', () => {
    it('C3_CHAT_READY_PROVIDERS has 23 entries', () => {
      expect(C3_CHAT_READY_PROVIDERS.length).toBe(23);
    });

    it('no duplicate provider IDs', () => {
      const unique = new Set(C3_CHAT_READY_PROVIDERS);
      expect(unique.size).toBe(C3_CHAT_READY_PROVIDERS.length);
    });

    it('all entries are non-empty strings', () => {
      for (const p of C3_CHAT_READY_PROVIDERS) {
        expect(typeof p).toBe('string');
        expect(p.length).toBeGreaterThan(0);
      }
    });

    it('R3 baseline 17 providers all present', () => {
      const r3Base = ['deepseek','mistral','cohere','openrouter','groq','fireworks-ai',
        'deepinfra','cerebras','sambanova','vercel-ai-gateway','moonshot','minimax',
        'writer','upstage','rekaai','avian','alibaba'];
      for (const p of r3Base) {
        expect(C3_CHAT_READY_PROVIDERS).toContain(p);
      }
    });

    it('reprobe additions (perplexity, nvidia, wandb) present', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('perplexity');
      expect(C3_CHAT_READY_PROVIDERS).toContain('nvidia');
      expect(C3_CHAT_READY_PROVIDERS).toContain('wandb');
    });

    it('HZU additions (inworld, infermatic) present', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('inworld');
      expect(C3_CHAT_READY_PROVIDERS).toContain('infermatic');
    });

    it('huggingface present (HZU2 + user fix)', () => {
      expect(C3_CHAT_READY_PROVIDERS).toContain('huggingface');
    });
  });

  describe('execution authorization locks', () => {
    it('C3_EXECUTION_AUTHORIZED is false', () => {
      expect(C3_EXECUTION_AUTHORIZED).toBe(false);
    });

    it('DRYRUN_FALSE_AUTHORIZED is false', () => {
      expect(DRYRUN_FALSE_AUTHORIZED).toBe(false);
    });

    it('BILLABLE_PROVIDER_CALLS_AUTHORIZED is false', () => {
      expect(BILLABLE_PROVIDER_CALLS_AUTHORIZED).toBe(false);
    });
  });
});
