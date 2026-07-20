// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Expert Panel — catalog routing + coordinator system-message preservation.
 *
 * Pins the contract that expert-panel-strategy no longer uses an inline
 * per-domain prompt map (which drifted from the SOTA catalog AND evaded the
 * A-Final catalog-drift guardrail, since those strings started with "As a…"
 * rather than the guardrail's "You are…"/"Your …" pattern):
 *
 *   1. `expertRoleForDomain` derives (domain, role) for ANY domain slug.
 *   2. `createExpertRequest` produces a system prompt sourced from
 *      `PROMPTS.expertSpecialist` (collective framing + adaptive depth + slots),
 *      NOT the old "As a X Expert, analyze…" strings.
 *   3. `buildCoordinatorMessages` preserves the client's own system message
 *      instead of dropping it via `filter(m => m.role !== 'system')`.
 */
import { describe, it, expect } from 'vitest';
import { promises as fs } from 'fs';
import path from 'path';
import {
  ExpertPanelStrategy,
  expertRoleForDomain,
} from '@/core/orchestration/strategies/expert-panel-strategy';
import type { ChatRequest, ChatMessage } from '@/types';

// Private-method access surface used only by these unit tests.
type ExpertPanelInternals = {
  createExpertRequest: (
    request: ChatRequest,
    domain: string,
    opts?: { slots?: unknown; variant?: unknown },
  ) => ChatRequest;
  buildCoordinatorMessages: (request: ChatRequest, coordinatorSystem: string) => ChatMessage[];
};

function internals(): ExpertPanelInternals {
  return new ExpertPanelStrategy() as unknown as ExpertPanelInternals;
}

describe('expertRoleForDomain — dynamic domain → (domain, role) derivation', () => {
  it('normalizes hyphenated slugs and title-cases the role', () => {
    expect(expertRoleForDomain('code-quality')).toEqual({
      domain: 'code quality',
      expertRole: 'Code Quality Specialist',
    });
  });

  it('handles single-word and underscore slugs', () => {
    expect(expertRoleForDomain('security')).toEqual({
      domain: 'security',
      expertRole: 'Security Specialist',
    });
    expect(expertRoleForDomain('code_quality').domain).toBe('code quality');
  });

  it('falls back to "general" for empty input (no fixed allow-list required)', () => {
    expect(expertRoleForDomain('')).toEqual({
      domain: 'general',
      expertRole: 'General Specialist',
    });
  });
});

describe('createExpertRequest — routes through the SOTA catalog', () => {
  const baseRequest: ChatRequest = {
    messages: [{ role: 'user', content: 'Refactor my auth module' }],
    model: 'test-model',
  };

  it('sources the expert system prompt from PROMPTS.expertSpecialist', () => {
    const req = internals().createExpertRequest(baseRequest, 'code-quality');
    const system = req.messages[0];
    expect(system.role).toBe('system');
    const content = system.content as string;
    // Catalog signature + parameterized domain.
    expect(content).toContain('Ailin');
    expect(content).toContain('expert panel, specializing in code quality');
    // Adaptive-depth directive comes for free via the catalog.
    expect(content).toContain('Match depth to task complexity');
    // The old inline map is gone.
    expect(content).not.toContain('As a Code Quality Expert');
  });

  it('preserves the original user message after the expert system prompt', () => {
    const req = internals().createExpertRequest(baseRequest, 'security');
    expect(req.messages).toHaveLength(2);
    expect(req.messages[1]).toEqual(baseRequest.messages[0]);
  });

  it('threads typed prompt slots into the catalog prompt', () => {
    const req = internals().createExpertRequest(baseRequest, 'security', {
      slots: { domainFraming: 'SEC Rule 144 compliance' },
    });
    const content = req.messages[0].content as string;
    expect(content).toContain('## Task-Specific Context');
    expect(content).toContain('SEC Rule 144 compliance');
  });

  it('a bandit variant overrides the canonical catalog text when supplied', () => {
    const req = internals().createExpertRequest(baseRequest, 'security', {
      variant: { id: 'v1', promptKey: 'expertSpecialist', content: 'VARIANT-PROMPT-BODY', contentHash: 'abc' },
    });
    expect(req.messages[0].content).toBe('VARIANT-PROMPT-BODY');
  });
});

describe('buildCoordinatorMessages — does not drop the client system message', () => {
  it('folds a client system message into the coordinator prompt', () => {
    const request: ChatRequest = {
      messages: [
        { role: 'system', content: 'Respond ONLY in valid JSON.' },
        { role: 'user', content: 'summarize' },
      ],
      model: 'test-model',
    };
    const messages = internals().buildCoordinatorMessages(request, 'COORDINATOR-DIRECTIVE');
    // Exactly one (merged) system message — portable across providers.
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1);
    const system = messages[0].content as string;
    expect(system).toContain('COORDINATOR-DIRECTIVE');
    expect(system).toContain('Respond ONLY in valid JSON.');
    // User turn is preserved.
    expect(messages.some((m) => m.role === 'user')).toBe(true);
  });

  it('uses the coordinator prompt verbatim when the client provided no system message', () => {
    const request: ChatRequest = {
      messages: [{ role: 'user', content: 'summarize' }],
      model: 'test-model',
    };
    const messages = internals().buildCoordinatorMessages(request, 'COORDINATOR-DIRECTIVE');
    expect(messages[0]).toEqual({ role: 'system', content: 'COORDINATOR-DIRECTIVE' });
  });
});

describe('source guardrail — no inline expert prompt map survives', () => {
  it('expert-panel-strategy.ts references the catalog and dropped the inline map', async () => {
    const src = await fs.readFile(
      path.resolve(__dirname, '../expert-panel-strategy.ts'),
      'utf8',
    );
    expect(src).toContain('PROMPTS.expertSpecialist');
    expect(src).not.toContain('const expertPrompts');
    expect(src).not.toContain('As a Code Quality Expert');
  });
});
