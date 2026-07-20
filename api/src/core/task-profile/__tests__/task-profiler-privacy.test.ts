// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * task-profiler-privacy.test.ts — MVP 6A
 *
 * Privacy mode inference + explicit override priority.
 */

import { describe, expect, it } from 'vitest';
import { profileTask } from '../task-profiler';

describe('profileTask — explicit privacy mode wins', () => {
  it('explicitPrivacyMode=local_required wins over text signals', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'just a creative poem',
      explicitPrivacyMode: 'local_required',
    });
    expect(profile.privacyMode).toBe('local_required');
  });

  it('explicitPrivacyMode=standard wins over confidential text', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'this is confidential information',
      explicitPrivacyMode: 'standard',
    });
    expect(profile.privacyMode).toBe('standard');
  });

  it('explicitPrivacyMode=local_preferred is respected', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      explicitPrivacyMode: 'local_preferred',
    });
    expect(profile.privacyMode).toBe('local_preferred');
  });
});

describe('profileTask — text-inferred privacy', () => {
  it('text mentioning "confidential" → local_preferred (no explicit)', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'analyze this confidential document',
    });
    expect(profile.privacyMode).toBe('local_preferred');
  });

  it('text mentioning "internal" → local_preferred', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'review this internal report',
    });
    expect(profile.privacyMode).toBe('local_preferred');
  });

  it('text mentioning "sensitive" → local_preferred', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'this contains sensitive customer data',
    });
    expect(profile.privacyMode).toBe('local_preferred');
  });

  it('text mentioning "PII" → local_preferred', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'redact PII from this document',
    });
    expect(profile.privacyMode).toBe('local_preferred');
  });

  it('text mentioning "GDPR" → local_preferred', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'check GDPR compliance for this clause',
    });
    expect(profile.privacyMode).toBe('local_preferred');
  });
});

describe('profileTask — default privacy', () => {
  it('no explicit + no privacy text → standard', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'tell me a joke',
    });
    expect(profile.privacyMode).toBe('standard');
  });

  it('empty input → standard', () => {
    const { profile } = profileTask({ requestId: 'r-empty' });
    expect(profile.privacyMode).toBe('standard');
  });
});

describe('profileTask — strategyHints react to privacy mode', () => {
  it('local_required → strategyHints includes local_first', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      explicitPrivacyMode: 'local_required',
    });
    expect(profile.strategyHints).toContain('local_first');
  });

  it('local_preferred → strategyHints includes local_first', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      explicitPrivacyMode: 'local_preferred',
    });
    expect(profile.strategyHints).toContain('local_first');
  });

  it('standard → strategyHints does NOT include local_first', () => {
    const { profile } = profileTask({
      requestId: 'r-1',
      text: 'hello',
    });
    expect(profile.strategyHints).not.toContain('local_first');
  });
});
