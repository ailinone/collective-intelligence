// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-J1E §14.1 — Provider API Model ID resolver unit tests.
 *
 * Pins the resolution priority + structural rules of the J1E central
 * resolver, including:
 *   - explicit alias overrides
 *   - duplicate-prefix detection and conservative derivation
 *   - native identity (no transformation)
 *   - router peering forms
 *   - preservation of `:free` suffix and `accounts/.../models/...` shape
 *   - strict mode behavior (unresolved instead of legacy_low fallback)
 *
 * NO HARDCODED model identity in production code — these tests verify
 * the BEHAVIOR using anthropic/claude/etc. as fixtures, not as
 * model-name overrides.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveApiModelId,
  detectsDuplicateProviderPrefix,
  stripDuplicateProviderPrefix,
} from '@/core/orchestration/model-routing/provider-api-model-id-resolver';

describe('01C.1B-J1E §14.1 — provider-api-model-id-resolver', () => {
  describe('duplicate-prefix detection', () => {
    it('detects nativeProviderId-LOGICAL', () => {
      expect(detectsDuplicateProviderPrefix('anthropic', 'anthropic-claude-3.7-sonnet')).toBe(true);
      expect(detectsDuplicateProviderPrefix('openai', 'openai-gpt-4o')).toBe(true);
      expect(detectsDuplicateProviderPrefix('google', 'google-gemini-2.5-pro')).toBe(true);
    });

    it('detects nativeProviderId/LOGICAL', () => {
      expect(detectsDuplicateProviderPrefix('anthropic', 'anthropic/claude')).toBe(true);
    });

    it('does NOT detect clean ids', () => {
      expect(detectsDuplicateProviderPrefix('anthropic', 'claude-3.7-sonnet')).toBe(false);
      expect(detectsDuplicateProviderPrefix('openai', 'gpt-4o')).toBe(false);
      expect(detectsDuplicateProviderPrefix('google', 'gemini-2.5-pro')).toBe(false);
    });

    it('handles undefined native', () => {
      expect(detectsDuplicateProviderPrefix(undefined, 'anything')).toBe(false);
    });
  });

  describe('strip-duplicate-prefix', () => {
    it('strips hyphen form', () => {
      expect(stripDuplicateProviderPrefix('anthropic', 'anthropic-claude-3.7-sonnet')).toBe('claude-3.7-sonnet');
    });
    it('strips slash form', () => {
      expect(stripDuplicateProviderPrefix('anthropic', 'anthropic/claude-3.7-sonnet')).toBe('claude-3.7-sonnet');
    });
    it('preserves clean id', () => {
      expect(stripDuplicateProviderPrefix('anthropic', 'claude-3.7-sonnet')).toBe('claude-3.7-sonnet');
    });
  });

  describe('anthropic family (the core J1D bug)', () => {
    it('native anthropic-claude-3.7-sonnet resolves to canonical via alias map', () => {
      const r = resolveApiModelId({
        providerId: 'anthropic',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        nativeProviderId: 'anthropic',
      });
      // The alias map has 'anthropic-claude-3.7-sonnet' → 'claude-3-7-sonnet-latest'
      expect(r.apiModelId).toBe('claude-3-7-sonnet-latest');
      expect(r.source).toBe('provider_explicit_alias');
      expect(r.aliasApplied).toBe(true);
    });

    it('openrouter + anthropic-claude-3.7-sonnet resolves to anthropic/claude-3.7-sonnet via alias map', () => {
      const r = resolveApiModelId({
        providerId: 'openrouter',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        nativeProviderId: 'anthropic',
      });
      expect(r.apiModelId).toBe('anthropic/claude-3.7-sonnet');
      expect(r.source).toBe('provider_explicit_alias');
      expect(r.aliasApplied).toBe(true);
    });

    it('aiml + anthropic-claude-3.7-sonnet resolves to versioned API id via alias map', () => {
      const r = resolveApiModelId({
        providerId: 'aiml',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        nativeProviderId: 'anthropic',
      });
      expect(r.apiModelId).toBe('claude-3-7-sonnet-20250219');
      expect(r.source).toBe('provider_explicit_alias');
    });

    it('routeway + anthropic-claude-3.7-sonnet does NOT produce anthropic/anthropic-claude-3.7-sonnet', () => {
      const r = resolveApiModelId({
        providerId: 'routeway',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        nativeProviderId: 'anthropic',
      });
      expect(r.apiModelId).not.toBe('anthropic/anthropic-claude-3.7-sonnet');
      // The alias map has routeway → 'anthropic/claude-3-7-sonnet'
      expect(r.apiModelId).toBe('anthropic/claude-3-7-sonnet');
    });

    it('vercel-ai-gateway + anthropic-claude-3.7-sonnet uses alias map', () => {
      const r = resolveApiModelId({
        providerId: 'vercel-ai-gateway',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        nativeProviderId: 'anthropic',
      });
      expect(r.apiModelId).toBe('anthropic/claude-3.7-sonnet');
      expect(r.aliasApplied).toBe(true);
    });

    it('UNMAPPED router for anthropic uses conservative_derivation, NOT naive concat', () => {
      // 'newrouter' has no alias map entry — must use conservative derivation
      // (strip prefix + namespace) instead of producing anthropic/anthropic-claude-3.7-sonnet.
      const r = resolveApiModelId({
        providerId: 'newrouter',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        nativeProviderId: 'anthropic',
      });
      expect(r.apiModelId).not.toBe('anthropic/anthropic-claude-3.7-sonnet');
      expect(r.apiModelId).toBe('anthropic/claude-3.7-sonnet');
      expect(r.source).toBe('conservative_derivation');
      expect(r.confidence).toBe('derived');
      expect(r.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('OpenAI family', () => {
    it('native openai + gpt-4o resolves to gpt-4o (legacy_native_identity)', () => {
      const r = resolveApiModelId({
        providerId: 'openai',
        logicalModelId: 'gpt-4o',
        nativeProviderId: 'openai',
      });
      expect(r.apiModelId).toBe('gpt-4o');
      expect(r.source).toBe('legacy_native_identity');
    });

    it('alias map handles openai/openai-gpt-X (double-prefix from hub)', () => {
      const r = resolveApiModelId({
        providerId: 'openai',
        logicalModelId: 'openai/openai-gpt-4o',
        nativeProviderId: 'openai',
      });
      // The alias map has 'openai/openai-gpt-4o' → 'gpt-4o'
      expect(r.apiModelId).toBe('gpt-4o');
      expect(r.source).toBe('provider_explicit_alias');
    });

    it('router + gpt-4o uses legacy_native_prefix (no duplicate, no alias)', () => {
      const r = resolveApiModelId({
        providerId: 'aiml',
        logicalModelId: 'gpt-4o',
        nativeProviderId: 'openai',
      });
      // No duplicate prefix in logical id, no aiml alias for gpt-4o yet
      // → falls through to legacy_native_prefix = `openai/gpt-4o`
      expect(r.apiModelId).toBe('openai/gpt-4o');
      expect(r.source).toBe('legacy_native_prefix');
      expect(r.confidence).toBe('legacy_low');
    });
  });

  describe('preservation of special id shapes', () => {
    it(':free suffix is preserved', () => {
      const r = resolveApiModelId({
        providerId: 'openrouter',
        logicalModelId: 'qwen/qwen3-next-80b-a3b-instruct:free',
        nativeProviderId: 'qwen',
      });
      // No alias for this; should fall to legacy_native_prefix or similar
      // but the `:free` MUST be preserved verbatim.
      expect(r.apiModelId).toContain(':free');
    });

    it('accounts/.../models/... shape is preserved', () => {
      const r = resolveApiModelId({
        providerId: 'fireworks-ai',
        logicalModelId: 'accounts/fireworks/models/qwen3-235b',
        nativeProviderId: 'fireworks-ai',
      });
      expect(r.apiModelId).toContain('accounts/');
      expect(r.apiModelId).toContain('/models/');
    });
  });

  describe('strict mode', () => {
    it('strict + no alias + no duplicate prefix → unresolved (NOT legacy_low)', () => {
      const r = resolveApiModelId({
        providerId: 'aiml',
        logicalModelId: 'gpt-4o',
        nativeProviderId: 'openai',
        strict: true,
      });
      expect(r.source).toBe('unresolved');
      expect(r.confidence).toBe('unresolved');
      expect(r.warnings.some((w) => w.includes('unresolved'))).toBe(true);
    });

    it('strict + alias entry → resolves normally', () => {
      const r = resolveApiModelId({
        providerId: 'openrouter',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        nativeProviderId: 'anthropic',
        strict: true,
      });
      expect(r.source).toBe('provider_explicit_alias');
      expect(r.apiModelId).toBe('anthropic/claude-3.7-sonnet');
    });
  });

  describe('catalog/discovery sources take priority over derivation', () => {
    it('catalog providerModelId takes priority', () => {
      const r = resolveApiModelId({
        providerId: 'newrouter',
        logicalModelId: 'anthropic-claude-3.7-sonnet',
        nativeProviderId: 'anthropic',
        providerModelId: 'custom-id-from-catalog',
      });
      expect(r.apiModelId).toBe('custom-id-from-catalog');
      expect(r.source).toBe('catalog_provider_model_id');
    });

    it('discoveredApiModelId takes priority over derivation but not over alias', () => {
      const r = resolveApiModelId({
        providerId: 'newrouter',
        logicalModelId: 'something-else',
        nativeProviderId: 'somewhere',
        discoveredApiModelId: 'discovered-name',
      });
      expect(r.apiModelId).toBe('discovered-name');
      expect(r.source).toBe('discovery_provider_model_id');
    });
  });

  describe('anti-regression: no naive concat for duplicate-prefix cases', () => {
    it('never returns anthropic/anthropic-claude-3.7-sonnet', () => {
      const routers = ['openrouter', 'aiml', 'routeway', 'vercel-ai-gateway', 'cometapi', 'aihubmix', 'ai302', 'nanogpt', 'requesty', 'poe', 'orqai', 'edenai', 'heliconeai', 'synthetic', 'newrouter-not-in-alias-map'];
      for (const router of routers) {
        const r = resolveApiModelId({
          providerId: router,
          logicalModelId: 'anthropic-claude-3.7-sonnet',
          nativeProviderId: 'anthropic',
        });
        expect(r.apiModelId).not.toBe('anthropic/anthropic-claude-3.7-sonnet');
      }
    });
  });
});
