// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import type { CapabilityId, CapabilityTester } from './capabilities';

/**
 * Runtime registry for capability probes used by ModelValidationService.
 * This registry intentionally starts empty. Probes are registered in `tests/index.ts`
 * and no legacy placeholder probes are preloaded.
 */
export const capabilityTests: Partial<Record<CapabilityId, CapabilityTester>> = {};

export function registerCapabilityTest(capability: CapabilityId, tester: CapabilityTester) {
  capabilityTests[capability] = tester;
}

export function getCapabilityTest(capability: CapabilityId): CapabilityTester | undefined {
  return capabilityTests[capability];
}

export function getRegisteredCapabilities(): CapabilityId[] {
  return Object.keys(capabilityTests) as CapabilityId[];
}

export function hasCapabilityTest(capability: CapabilityId): boolean {
  return capability in capabilityTests;
}
