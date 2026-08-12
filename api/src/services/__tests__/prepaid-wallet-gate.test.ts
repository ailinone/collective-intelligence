// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * prepaid-wallet-gate.test.ts — the billing DISCRIMINATION contract.
 *
 * The module under test decides, for every chat request, whether the prepaid wallet
 * is gated (a 402 hold) and debited. Getting that decision wrong charges real money,
 * so the cases below are exhaustive over the request shapes the server can produce.
 *
 * Two things make this module awkward to test, and both are handled by `loadGate()`:
 *  - `GATE_ENABLED` is a module-level const read at import time, so the flag can only
 *    be flipped by re-importing the module (`vi.resetModules()` + dynamic import);
 *  - the wallet is a module-private lazy singleton over `PrismaBalanceStore`, so the
 *    store module is mocked to hand back an `InMemoryBalanceStore` we control.
 *
 * IMPORTANT: the request shapes here are POST-normalization — the shape the gate
 * actually receives at chat-routes.ts:807, not the shape the client sent. Every
 * resolved alias arrives with `model: 'auto'` (chat-routes.ts:492); only genuine
 * `<strategy>:<tier>` composites additionally carry the server-set `ailin_tier` +
 * `ailin_tier_rate` carrier (chat-routes.ts:522-528). That carrier is the billing key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryBalanceStore, type BalanceStore } from '@/services/prepaid-wallet';
import { resolveAilinVirtualModelAlias } from '@/services/ailin-virtual-model-service';
import type { ChatRequest } from '@/types';

const FLAG = 'PREPAID_WALLET_GATE_ENABLED';
const ORG = 'org-under-test';

/** Holder the mocked Prisma store hands back — swapped per test. */
const hoisted = vi.hoisted(() => ({ store: null as BalanceStore | null }));

vi.mock('@/services/prepaid-wallet-prisma-store', () => ({
  // A constructor that returns our in-memory store instead of touching Postgres.
  PrismaBalanceStore: class {
    constructor() {
      return hoisted.store as never;
    }
  },
}));

type Gate = typeof import('@/services/prepaid-wallet-gate');

/**
 * Import a FRESH copy of the module with the flag in the requested state. Required
 * because `GATE_ENABLED` is captured once at module load (prepaid-wallet-gate.ts:31).
 */
async function loadGate(enabled: boolean): Promise<Gate> {
  vi.resetModules();
  vi.stubEnv(FLAG, enabled ? 'true' : '');
  return import('@/services/prepaid-wallet-gate');
}

function req(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    messages: [{ role: 'user', content: 'hello world '.repeat(20) }],
    max_tokens: 256,
    ...overrides,
  } as ChatRequest;
}

// ── The post-normalization shapes, named by what the client originally sent. ──

/** `ailin-best` etc: alias resolved, model rewritten to 'auto', NO tier carrier. */
const legacyAlias = (alias: string): ChatRequest => req({ model: 'auto', ailin_alias: alias });

/** `consensus:large`: composite cell — alias + the SERVER-SET tier carrier. */
const composite = (): ChatRequest =>
  req({
    model: 'auto',
    ailin_alias: 'consensus:large',
    ailin_tier: 'large',
    ailin_tier_rate: { inputPer1MUsd: 4, outputPer1MUsd: 20 },
  });

/** Every shape that must NOT be gated or debited, with the client input that produces it. */
const NEVER_BILLED: Array<[string, ChatRequest]> = [
  ["legacy preset alias 'ailin-best'", legacyAlias('ailin-best')],
  ["legacy preset alias 'ailin-economy'", legacyAlias('ailin-economy')],
  ["legacy preset alias 'ailin-auto' (the platform default)", legacyAlias('ailin-auto')],
  ["legacy non-tier alias 'ailin-voice'", legacyAlias('ailin-voice')],
  ["literal model:'auto' with no alias at all", req({ model: 'auto' })],
  ['raw provider model id', req({ model: 'gpt-4o-mini' })],
  ['no model and no alias', req({})],
  [
    "shadow-wired cell 'war-room:large' (never routed, must never be sold)",
    req({ model: 'war-room:large' }),
  ],
  [
    'client-injected ailin_alias with no server carrier (billing key must not be client-controlled)',
    req({ model: 'gpt-4o-mini', ailin_alias: 'expert-panel:extra' }),
  ],
];

afterEach(() => {
  hoisted.store = null;
});

describe('prepaid-wallet-gate', () => {
  describe('flag OFF (the shipped default)', () => {
    let gate: Gate;
    let store: InMemoryBalanceStore;

    beforeEach(async () => {
      gate = await loadGate(false);
      store = new InMemoryBalanceStore({ [ORG]: 100 });
      hoisted.store = store;
    });

    it('reports itself disabled', () => {
      expect(gate.isWalletGateEnabled()).toBe(false);
    });

    // The executable form of the no-op proof: with the flag off NOTHING is gated,
    // held or debited — for any request shape, tiered or not.
    it.each([...NEVER_BILLED, ['a genuine <strategy>:<tier> composite', composite()]] as Array<
      [string, ChatRequest]
    >)('is a strict no-op for %s', async (_label, request) => {
      expect(await gate.gateChatRequest(ORG, request)).toEqual({ allowed: true });
      await gate.debitChatRequest({
        organizationId: ORG,
        request,
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        requestId: 'req-off',
      });
      expect(await store.getBalanceUsd(ORG)).toBe(100);
      expect(await store.getAvailableUsd(ORG)).toBe(100); // no lingering hold either
      expect(store.failedDebits).toHaveLength(0);
    });
  });

  describe('flag ON — only genuine <strategy>:<tier> cells are billable', () => {
    let gate: Gate;
    let store: InMemoryBalanceStore;

    beforeEach(async () => {
      gate = await loadGate(true);
      store = new InMemoryBalanceStore({ [ORG]: 100 });
      hoisted.store = store;
    });

    it('reports itself enabled', () => {
      expect(gate.isWalletGateEnabled()).toBe(true);
    });

    /**
     * THE REGRESSION TEST for the alias->'auto' pricing-cell collision.
     *
     * normalizeChatRequest rewrites every resolved alias to `model: 'auto'`, and
     * 'auto' is itself a key in STRATEGY_POLICY, so probing `req.model` resolved a
     * REAL chargeable cell ($1/$4 at tier `base`) for legacy aliases — i.e. for
     * essentially all default platform traffic. It must resolve to nothing.
     */
    it.each(NEVER_BILLED)('does not gate or debit %s', async (_label, request) => {
      const gated = await gate.gateChatRequest(ORG, request);
      expect(gated).toEqual({ allowed: true }); // allowed AND no hold reserved
      expect(gated.holdId).toBeUndefined();

      await gate.debitChatRequest({
        organizationId: ORG,
        request,
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        requestId: 'req-on',
      });
      expect(await store.getBalanceUsd(ORG)).toBe(100);
      expect(await store.getAvailableUsd(ORG)).toBe(100);
    });

    // The operational failure mode this whole fix exists to prevent: wallets hold $0
    // and there is no top-up path, so charging default traffic 402s the platform.
    it('allows legacy-alias traffic at a $0 balance instead of 402-ing it', async () => {
      hoisted.store = new InMemoryBalanceStore({ [ORG]: 0 });
      expect(await gate.gateChatRequest(ORG, legacyAlias('ailin-auto'))).toEqual({ allowed: true });
    });

    it('gates a composite cell and reserves a hold', async () => {
      const gated = await gate.gateChatRequest(ORG, composite());
      expect(gated.allowed).toBe(true);
      expect(gated.holdId).toMatch(/^hold_/);
      // The hold is a real reservation: spendable balance drops, ledger balance does not.
      expect(await store.getBalanceUsd(ORG)).toBe(100);
      expect(await store.getAvailableUsd(ORG)).toBeLessThan(100);
    });

    it('debits a composite cell at the tier rate on the user tokens', async () => {
      // 100k in @ $4/1M = $0.40, 100k out @ $20/1M = $2.00 → $2.40
      await gate.debitChatRequest({
        organizationId: ORG,
        request: composite(),
        promptTokens: 100_000,
        completionTokens: 100_000,
        requestId: 'req-composite',
      });
      expect(await store.getBalanceUsd(ORG)).toBeCloseTo(97.6, 6);
    });

    // Billing at the rate the resolver QUOTED, not at whatever the static card says
    // today, is what keeps the gate honest once the calibrator publishes a measured
    // card. `large` is $4/$20 on the static card; this request was quoted $1/$2.
    it('bills the rate carried on the request, not the static rate card', async () => {
      await gate.debitChatRequest({
        organizationId: ORG,
        request: req({
          model: 'auto',
          ailin_alias: 'consensus:large',
          ailin_tier: 'large',
          ailin_tier_rate: { inputPer1MUsd: 1, outputPer1MUsd: 2 },
        }),
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        requestId: 'req-quoted-rate',
      });
      expect(await store.getBalanceUsd(ORG)).toBeCloseTo(97, 6); // $1 + $2, not $4 + $20
    });

    it('settles the gate hold when the debit threads the holdId', async () => {
      const gated = await gate.gateChatRequest(ORG, composite());
      await gate.debitChatRequest({
        organizationId: ORG,
        request: composite(),
        promptTokens: 100_000,
        completionTokens: 100_000,
        requestId: 'req-settled',
        holdId: gated.holdId,
      });
      expect(await store.getBalanceUsd(ORG)).toBeCloseTo(97.6, 6);
      expect(await store.getAvailableUsd(ORG)).toBeCloseTo(97.6, 6); // remainder released
    });

    it('rejects a composite cell with 402 when the balance cannot cover the hold', async () => {
      hoisted.store = new InMemoryBalanceStore({ [ORG]: 0 });
      const gated = await gate.gateChatRequest(ORG, composite());
      expect(gated.allowed).toBe(false);
      expect(gated.status).toBe(402);
      const body = gated.body as { error: { code: string; message: string } };
      expect(body.error.code).toBe('insufficient_funds');
      // Names the product the user actually asked for — never the 'auto' sentinel
      // that normalization left in `model`.
      expect(body.error.message).toContain('consensus:large');
      expect(body.error.message).not.toContain('"auto"');
    });

    /**
     * The HOLD used to sum only `part.text`, so an image/audio prompt reserved barely
     * more than `max_tokens` while the debit charges the provider's REAL prompt tokens
     * — and `debit` does not floor at zero, so a near-empty wallet could go
     * arbitrarily negative. $0.008 covers the text-only hold (~$0.0054) but not the
     * same request with one image attached (~$0.0102).
     */
    it('counts non-text content parts in the hold (no free pass for image prompts)', async () => {
      const withImage = req({
        model: 'auto',
        ailin_alias: 'consensus:large',
        ailin_tier: 'large',
        ailin_tier_rate: { inputPer1MUsd: 4, outputPer1MUsd: 20 },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'hello world '.repeat(20) },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            ],
          },
        ],
      } as Partial<ChatRequest>);

      hoisted.store = new InMemoryBalanceStore({ [ORG]: 0.008 });
      expect((await gate.gateChatRequest(ORG, composite())).allowed).toBe(true);

      hoisted.store = new InMemoryBalanceStore({ [ORG]: 0.008 });
      const denied = await gate.gateChatRequest(ORG, withImage);
      expect(denied.allowed).toBe(false);
      expect(denied.status).toBe(402);
    });

    it('ignores a malformed tier rate rather than computing a bogus charge', async () => {
      const bad = req({
        model: 'auto',
        ailin_alias: 'consensus:large',
        ailin_tier: 'large',
        ailin_tier_rate: { inputPer1MUsd: Number.NaN, outputPer1MUsd: -5 },
      });
      expect(await gate.gateChatRequest(ORG, bad)).toEqual({ allowed: true });
      await gate.debitChatRequest({
        organizationId: ORG,
        request: bad,
        promptTokens: 1_000_000,
        completionTokens: 1_000_000,
        requestId: 'req-bad-rate',
      });
      expect(await store.getBalanceUsd(ORG)).toBe(100);
    });

    it('FAILS OPEN when the wallet store errors (never blocks traffic on infra)', async () => {
      hoisted.store = {
        getBalanceUsd: async () => {
          throw new Error('relation "organization_balance" does not exist');
        },
        getAvailableUsd: async () => {
          throw new Error('relation "organization_balance" does not exist');
        },
        adjustBalanceUsd: async () => 0,
        applyDebit: async () => {
          throw new Error('store down');
        },
        reserveHold: async () => {
          throw new Error('store down');
        },
        settleHold: async () => {
          throw new Error('store down');
        },
        releaseHold: async () => undefined,
        recordFailedDebit: async () => undefined,
      } satisfies BalanceStore;
      expect(await gate.gateChatRequest(ORG, composite())).toEqual({ allowed: true });
    });
  });

  /**
   * Pins the upstream invariant the fix depends on: which model strings acquire the
   * tier carrier. `normalizeChatRequest` is module-private, so we assert on the
   * resolver whose output it copies verbatim (chat-routes.ts:522-528 sets
   * `ailin_tier` / `ailin_tier_rate` from these fields and DELETES them elsewhere).
   *
   * The split is NOT "composite vs `ailin-*`" — an earlier version of this suite
   * enumerated only the five `ailin-*` names that happen to be DEFAULT_PROFILES and
   * so "proved" a generalization that is false. The real rule is PROFILE-FIRST:
   * `resolveAilinVirtualModelAlias` looks the name up in the configured virtual-model
   * profiles first, and only names that miss fall through to `resolveStrategyTier`,
   * which strips a leading `ailin-` (pricing-tiers.ts) and therefore prices
   * `ailin-expert-panel` exactly like `expert-panel`. Both directions are asserted.
   */
  describe('alias resolution invariant (the carrier the gate keys off)', () => {
    // Configured virtual-model profiles → no carrier → never touched by the wallet.
    it.each(['ailin-best', 'ailin-economy', 'ailin-auto', 'ailin-fast', 'ailin-consensus'])(
      'configured profile %s resolves with NO tier carrier',
      (alias) => {
        const resolved = resolveAilinVirtualModelAlias(alias);
        expect(resolved).not.toBeNull();
        expect(resolved?.model).toBe('auto'); // the rewrite that caused the defect
        expect(resolved?.tier).toBeUndefined();
        expect(resolved?.tierRate).toBeUndefined();
      }
    );

    // The counter-case the old enumeration hid: an `ailin-` prefix is NOT a billing
    // exemption. These names are not profiles, so they price as their bare strategy.
    it.each([
      ['ailin-parallel', 'parallel:base', 'base', 1, 4],
      ['ailin-single', 'single:base', 'base', 1, 4],
      ['ailin-expert-panel', 'expert-panel:large', 'large', 4, 20],
      ['ailin-best:large', 'best:large', 'large', 4, 20],
      ['ailin-consensus:extra', 'consensus:extra', 'extra', 8, 42],
    ] as Array<[string, string, string, number, number]>)(
      '%s is NOT a profile and DOES carry a tier (prices as %s)',
      (input, alias, tier, inputPer1MUsd, outputPer1MUsd) => {
        const resolved = resolveAilinVirtualModelAlias(input);
        expect(resolved?.alias).toBe(alias);
        expect(resolved?.tier).toBe(tier);
        expect(resolved?.tierRate).toEqual({ inputPer1MUsd, outputPer1MUsd });
      }
    );

    it('a <strategy>:<tier> composite resolves WITH the tier carrier', () => {
      const resolved = resolveAilinVirtualModelAlias('consensus:large');
      expect(resolved?.model).toBe('auto');
      expect(resolved?.alias).toBe('consensus:large');
      expect(resolved?.tier).toBe('large');
      expect(resolved?.tierRate).toEqual({ inputPer1MUsd: 4, outputPer1MUsd: 20 });
    });

    // The PR body claimed bare `auto` is charged. It is not: the resolver bails on
    // 'auto' before any tier lookup, so no carrier is ever attached.
    it("a bare model:'auto' does not resolve, so it can never carry a tier", () => {
      expect(resolveAilinVirtualModelAlias('auto')).toBeNull();
    });

    it('a shadow-wired cell does not resolve at all (never routed, never sold)', () => {
      expect(resolveAilinVirtualModelAlias('war-room:large')).toBeNull();
    });
  });
});
