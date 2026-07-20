// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1D-R3 §10 — Targeted provider spec tests.
 *
 * Asserts that nanogpt, novita and edenai each have a PROVIDER_SPECS
 * entry, that the entries match the adapter/config-layer URLs (no
 * divergence), that auth uses Bearer without printing the secret, and
 * that providers we deliberately did NOT add (alibaba, fireworks*) are
 * documented unsupported with reason.
 *
 * Tests are deterministic + offline — no fetch, no env reads beyond
 * shape checks.
 */
import { describe, it, expect } from 'vitest';
import { PROVIDER_SPECS } from '@/core/operability/scripts/run-live-chat-operability-audit';

const J1D_R3_ADDED = ['nanogpt', 'novita', 'edenai'] as const;
const J1D_R3_UNSUPPORTED = ['alibaba', 'fireworks'] as const; // distinct from 'fireworks-ai'

describe('01C.1B-J1D-R3 §10 — targeted provider specs', () => {
  for (const id of J1D_R3_ADDED) {
    describe(`provider: ${id}`, () => {
      it('is present in PROVIDER_SPECS', () => {
        expect(PROVIDER_SPECS[id]).toBeDefined();
      });

      it('has an https endpoint', () => {
        const ep = PROVIDER_SPECS[id]!.endpoint;
        expect(ep).toMatch(/^https:\/\//);
      });

      it('has an API key env var name (uppercase, no value embedded)', () => {
        const v = PROVIDER_SPECS[id]!.envVar;
        expect(v).toMatch(/^[A-Z_][A-Z0-9_]*$/);
      });

      it('builds Bearer auth without leaking the key in the headers map', () => {
        // Synthetic key value — must NOT appear anywhere except inside
        // the Authorization header value.
        const fakeKey = 'sk-FAKE-TEST-KEY-DO-NOT-LEAK';
        const headers = PROVIDER_SPECS[id]!.buildHeaders(fakeKey);
        expect(headers.Authorization).toBe(`Bearer ${fakeKey}`);
        expect(headers['Content-Type']).toBe('application/json');
        // Ensure no other header carries the key
        for (const [k, v] of Object.entries(headers)) {
          if (k === 'Authorization') continue;
          expect(String(v)).not.toContain(fakeKey);
        }
      });

      it('modelIdTransform (if present) is a function and does not duplicate provider prefix', () => {
        const t = PROVIDER_SPECS[id]!.normalizeModelId;
        if (t) {
          const out = t('some/model-id');
          expect(typeof out).toBe('string');
          // Should not contain the provider id twice
          const lower = String(out).toLowerCase();
          expect((lower.match(new RegExp(id, 'g')) || []).length).toBeLessThanOrEqual(1);
        }
      });
    });
  }

  it('expected J1D-R3 added providers have OpenAI-compatible /chat/completions endpoint', () => {
    for (const id of J1D_R3_ADDED) {
      expect(PROVIDER_SPECS[id]!.endpoint).toMatch(/\/chat\/completions$/);
    }
  });

  it('nanogpt endpoint matches existing config layer (https://nano-gpt.com/api/v1/...)', () => {
    expect(PROVIDER_SPECS.nanogpt!.endpoint).toBe(
      'https://nano-gpt.com/api/v1/chat/completions',
    );
  });

  it('novita endpoint matches NovitaAdapter.DEFAULT_BASE_URL (https://api.novita.ai/openai/v1/...)', () => {
    expect(PROVIDER_SPECS.novita!.endpoint).toBe(
      'https://api.novita.ai/openai/v1/chat/completions',
    );
  });

  it('edenai endpoint matches catalog baseUrl (https://api.edenai.run/v3/llm/...)', () => {
    expect(PROVIDER_SPECS.edenai!.endpoint).toBe(
      'https://api.edenai.run/v3/llm/chat/completions',
    );
  });

  describe('deliberately unsupported providers (no key / no spec safety)', () => {
    for (const id of J1D_R3_UNSUPPORTED) {
      it(`${id} is NOT in PROVIDER_SPECS — operator must add explicitly when key arrives`, () => {
        expect(PROVIDER_SPECS[id as keyof typeof PROVIDER_SPECS]).toBeUndefined();
      });
    }
  });

  it('all PROVIDER_SPECS entries use Bearer auth (uniform shape)', () => {
    const fake = 'sk-PROBE-KEY';
    for (const [id, spec] of Object.entries(PROVIDER_SPECS)) {
      const hdr = spec.buildHeaders(fake);
      const hasBearer = hdr.Authorization === `Bearer ${fake}`;
      const hasXApiKey = hdr['x-api-key'] === fake;
      // Anthropic uses x-api-key; everyone else Bearer.
      if (id === 'anthropic') {
        expect(hasXApiKey).toBe(true);
      } else {
        expect(hasBearer).toBe(true);
      }
    }
  });

  it('no PROVIDER_SPECS endpoint contains template literal placeholders or invalid URLs', () => {
    for (const [, spec] of Object.entries(PROVIDER_SPECS)) {
      expect(spec.endpoint).not.toMatch(/\$\{/);
      expect(() => new URL(spec.endpoint)).not.toThrow();
    }
  });
});
