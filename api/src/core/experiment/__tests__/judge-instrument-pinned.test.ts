// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Judge instrument pinning — split-brain guard (review F1).
 *
 * A paid run must be scored by the SAME fixed, reproducible judge the
 * calibration phase certified. A floating `EXPERIMENT_JUDGE_MODEL=auto` resolves
 * to a (possibly different) model per request and per phase, so calibration
 * cannot certify the instrument the run actually used. The judge identity is
 * frozen at module load, so each scenario re-imports the module under a fresh
 * env to exercise the guard.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function importUnderEnv(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../experiment-runner');
}

describe('assertJudgeInstrumentPinned', () => {
  it('THROWS when pinned mode has a floating "auto" judge', async () => {
    const mod = await importUnderEnv({ JUDGE_MODE: undefined, EXPERIMENT_JUDGE_MODEL: 'auto' });
    expect(() => mod.assertJudgeInstrumentPinned()).toThrow(/not pinned/i);
  });

  it('THROWS when pinned mode has no judge model configured', async () => {
    const mod = await importUnderEnv({ JUDGE_MODE: undefined, EXPERIMENT_JUDGE_MODEL: undefined });
    expect(() => mod.assertJudgeInstrumentPinned()).toThrow(/not pinned/i);
  });

  it('passes when pinned to a concrete model id', async () => {
    const mod = await importUnderEnv({ JUDGE_MODE: undefined, EXPERIMENT_JUDGE_MODEL: 'openai/gpt-5.4-mini' });
    expect(() => mod.assertJudgeInstrumentPinned()).not.toThrow();
  });

  it('passes in dynamic mode regardless of judge model (the cascade is the instrument)', async () => {
    const mod = await importUnderEnv({ JUDGE_MODE: 'dynamic', EXPERIMENT_JUDGE_MODEL: undefined });
    expect(() => mod.assertJudgeInstrumentPinned()).not.toThrow();
  });
});
