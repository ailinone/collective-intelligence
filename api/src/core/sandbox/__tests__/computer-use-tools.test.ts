// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * `computer_use` registration gating (ADR-024, LOTE AQ, 2026-09-05).
 *
 * The property under test is that a disabled capability is ABSENT, not merely
 * inert: with the flag off the tools must not exist in the registry at all, so
 * the model never sees them in a tool catalogue and triage cannot attach them.
 * A "registered but refuses when called" design would still leak the tool
 * names into prompts and invite the model to try.
 *
 * Container behaviour is proven separately against real Docker in
 * `container-sandbox-adversarial.integration.test.ts` and
 * `computer-use-tools.integration.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isAutoRecommendable, toolRegistry } from '@/core/tools/tool-registry';
import {
  __resetComputerUseRegistrationForTest,
  buildComputerUseRegistrations,
  registerComputerUseTools,
} from '../computer-use-tools';

const TOOL_NAMES = [
  'computer_shell',
  'computer_write_file',
  'computer_read_file',
  'computer_list_files',
];

let savedFlag: string | undefined;

beforeEach(() => {
  savedFlag = process.env.AGENTIC_COMPUTER_USE_ENABLED;
  delete process.env.AGENTIC_COMPUTER_USE_ENABLED;
  __resetComputerUseRegistrationForTest();
});

afterEach(() => {
  if (savedFlag === undefined) delete process.env.AGENTIC_COMPUTER_USE_ENABLED;
  else process.env.AGENTIC_COMPUTER_USE_ENABLED = savedFlag;
});

describe('computer_use — the capability is absent, not just inert, while disabled', () => {
  it('registers nothing when the flag is unset', () => {
    registerComputerUseTools();
    for (const name of TOOL_NAMES) {
      expect(toolRegistry.has(name), `${name} must not exist while the flag is off`).toBe(false);
    }
  });

  it('registers nothing on a near-miss flag value', () => {
    for (const value of ['1', 'TRUE', 'yes', 'on']) {
      __resetComputerUseRegistrationForTest();
      process.env.AGENTIC_COMPUTER_USE_ENABLED = value;
      registerComputerUseTools();
      expect(toolRegistry.has('computer_shell'), `'${value}' must not enable the tools`).toBe(
        false
      );
    }
  });
});

describe('computer_use — registration shape', () => {
  it('declares every tool as strategy-safe but never triage-auto-attachable', () => {
    for (const registration of buildComputerUseRegistrations()) {
      expect(registration.safeForStrategies, `${registration.name} runs sandboxed`).toBe(true);
      expect(
        registration.autoRecommendable,
        `${registration.name} must never be auto-attached to a request that did not ask for it`
      ).toBe(false);
      expect(
        isAutoRecommendable(registration),
        `${registration.name} must not pass the auto-recommend predicate`
      ).toBe(false);
    }
  });

  it('exposes the four tools with parameter schemas', () => {
    const registrations = buildComputerUseRegistrations();
    expect(registrations.map((entry) => entry.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const registration of registrations) {
      expect(registration.description.length).toBeGreaterThan(20);
      if (registration.name !== 'computer_list_files') {
        expect(registration.parameters, `${registration.name} needs a schema`).toBeDefined();
      }
    }
  });

  it('does not advertise a shell or a network client in the computer_shell schema', () => {
    const shell = buildComputerUseRegistrations().find((r) => r.name === 'computer_shell');
    const described = JSON.stringify(shell?.parameters ?? {});
    for (const forbidden of ['curl', 'wget', 'bash', 'python']) {
      expect(described, `the advertised allowlist must not include ${forbidden}`).not.toContain(
        `${forbidden},`
      );
    }
  });
});
