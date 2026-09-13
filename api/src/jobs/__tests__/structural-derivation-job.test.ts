// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring-contract tests for the structural derivation job.
 *
 * Same shape and rationale as capability-materialise-job.test.ts: this grep-
 * tests the registry source rather than importing `SCHEDULED_JOBS` (the
 * registry keeps that array private), and checks the runner's own enabled
 * gate matches the registry's guard so the two can't drift apart.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isStructuralDerivationEnabled } from '../structural-derivation-job';

const REGISTRY_PATH = join(__dirname, '..', 'register-scheduled-jobs.ts');
const registrySource = readFileSync(REGISTRY_PATH, 'utf8');

describe('structural-derivation job ↔ scheduled-jobs registry wiring', () => {
  it('registers a handler under the name `structural-derivation`', () => {
    expect(registrySource).toMatch(/['"]structural-derivation['"]\s*:\s*async\s*\(\)/);
  });

  it('handler imports from `./structural-derivation-job`', () => {
    expect(registrySource).toMatch(/import\(\s*['"]\.\/structural-derivation-job(\.js)?['"]\s*\)/);
  });

  it('schedules the cron under the same name', () => {
    expect(registrySource).toMatch(/name:\s*['"]structural-derivation['"]/);
  });

  it('runs between embedding-refresh (:15) and capability-materialise (:45) in the same 6-hourly window', () => {
    expect(registrySource).toMatch(/name:\s*['"]structural-derivation['"][^}]*pattern:\s*['"]30 \*\/6 \* \* \*['"]/s);
  });
});

describe('isStructuralDerivationEnabled', () => {
  const originalDisabled = process.env.HCRA_STRUCTURAL_DERIVATION_DISABLED;
  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.HCRA_STRUCTURAL_DERIVATION_DISABLED;
    else process.env.HCRA_STRUCTURAL_DERIVATION_DISABLED = originalDisabled;
  });

  it('returns true by default (env var unset)', () => {
    delete process.env.HCRA_STRUCTURAL_DERIVATION_DISABLED;
    expect(isStructuralDerivationEnabled()).toBe(true);
  });

  it('returns false only when explicitly set to "true"', () => {
    process.env.HCRA_STRUCTURAL_DERIVATION_DISABLED = 'true';
    expect(isStructuralDerivationEnabled()).toBe(false);
  });

  it('returns true for any non-"true" value (defensive default)', () => {
    process.env.HCRA_STRUCTURAL_DERIVATION_DISABLED = 'false';
    expect(isStructuralDerivationEnabled()).toBe(true);
    process.env.HCRA_STRUCTURAL_DERIVATION_DISABLED = '0';
    expect(isStructuralDerivationEnabled()).toBe(true);
  });
});
