// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Wiring-contract tests for the pricing-integrity cron, mirroring the
 * metadata-backfill/capability-materialise wiring tests: registry-source grep
 * + env-gate behavior + the staleness threshold's value is pinned so a future
 * edit can't silently loosen it back toward "never" without a test failing.
 *
 * The staleness SQL sweep and cross-tier catalog read are exercised against a
 * real Prisma client only in integration/e2e suites (this file, like its
 * siblings, does not stand up Testcontainers); the pure classification logic
 * they both depend on (cross-tier-pricing-check.ts) has its own full unit
 * suite.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isPricingIntegrityCheckEnabled,
  PRICING_STALENESS_THRESHOLD_MS,
} from '../pricing-integrity-job';

const REGISTRY_PATH = join(__dirname, '..', 'register-scheduled-jobs.ts');
const registrySource = readFileSync(REGISTRY_PATH, 'utf8');

describe('pricing-integrity job ↔ scheduled-jobs registry wiring', () => {
  it('registers a handler under the name `pricing-integrity-check`', () => {
    expect(registrySource).toMatch(/['"]pricing-integrity-check['"]\s*:\s*async\s*\(\)/);
  });

  it('handler imports from `./pricing-integrity-job`', () => {
    expect(registrySource).toMatch(/import\(\s*['"]\.\/pricing-integrity-job(\.js)?['"]\s*\)/);
  });

  it('schedules the cron under the same name', () => {
    expect(registrySource).toMatch(/name:\s*['"]pricing-integrity-check['"]/);
  });
});

describe('isPricingIntegrityCheckEnabled', () => {
  const originalDisabled = process.env.PRICING_INTEGRITY_CHECK_DISABLED;
  afterEach(() => {
    if (originalDisabled === undefined) delete process.env.PRICING_INTEGRITY_CHECK_DISABLED;
    else process.env.PRICING_INTEGRITY_CHECK_DISABLED = originalDisabled;
  });

  it('returns true by default (env var unset)', () => {
    delete process.env.PRICING_INTEGRITY_CHECK_DISABLED;
    expect(isPricingIntegrityCheckEnabled()).toBe(true);
  });

  it('returns false only when explicitly set to "true"', () => {
    process.env.PRICING_INTEGRITY_CHECK_DISABLED = 'true';
    expect(isPricingIntegrityCheckEnabled()).toBe(false);
  });

  it('returns true for any non-"true" value (defensive default)', () => {
    process.env.PRICING_INTEGRITY_CHECK_DISABLED = 'false';
    expect(isPricingIntegrityCheckEnabled()).toBe(true);
    process.env.PRICING_INTEGRITY_CHECK_DISABLED = '';
    expect(isPricingIntegrityCheckEnabled()).toBe(true);
  });
});

describe('PRICING_STALENESS_THRESHOLD_MS', () => {
  it('is a real, justified multiple of the daily-full-discovery cadence (24h), not an arbitrary number', () => {
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    expect(PRICING_STALENESS_THRESHOLD_MS % ONE_DAY_MS).toBe(0);
    // Bounded: long enough to absorb a couple of missed daily runs from
    // transient provider outages, short enough that a genuinely delisted
    // model is caught in days, not the "NULL forever" status quo this job
    // replaces.
    expect(PRICING_STALENESS_THRESHOLD_MS).toBeGreaterThanOrEqual(ONE_DAY_MS * 2);
    expect(PRICING_STALENESS_THRESHOLD_MS).toBeLessThanOrEqual(ONE_DAY_MS * 7);
  });
});
