// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * 01C.1B-G4 §7 — Tests for the prompt runtime trace.
 *
 * Pins the contract:
 *   - Trace is sanitized (no raw prompt body in surface).
 *   - Fingerprint is deterministic (same inputs → same hash).
 *   - Changing the template, the variables, the messages shape, or the
 *     adapter payload format changes the fingerprint.
 *   - missingVariables is correctly populated.
 *   - Multi-role aggregator produces a stable aggregate hash.
 *   - Unselected roles emit a `role_not_selected_due_to_plan_blocker` issue.
 */
import { describe, it, expect } from 'vitest';
import {
  buildPromptRuntimeTrace,
  buildMultiRolePromptTrace,
  sanitizeTraceForSurface,
  type PromptTemplateRegistryEntry,
  type PromptTemplateRegistry,
  type PromptRuntimeTraceRole,
} from '../prompt-runtime-trace';

function makeEntry(over: Partial<PromptTemplateRegistryEntry> = {}): PromptTemplateRegistryEntry {
  return {
    id: 'testTemplate',
    path: 'src/test/template.ts',
    version: 'test@v1',
    variablesRequired: ['userName'],
    adapterPayloadFormat: 'openai_chat_messages',
    getBody: (vars) => `Hello ${String(vars.userName ?? '<missing>')}!`,
    ...over,
  };
}

describe('buildPromptRuntimeTrace — sanitization invariants', () => {
  it('never includes the raw system body in the trace surface', () => {
    const trace = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: makeEntry(),
      variables: { userName: 'Alice' },
      userMessages: [{ role: 'user', content: 'Compute 2+2' }],
    });
    const surface = JSON.stringify(sanitizeTraceForSurface(trace));
    expect(surface).not.toContain('Hello Alice!');
    expect(surface).not.toContain('Compute 2+2');
    // Hash IS surfaced — confirm by length (64 hex chars).
    for (const m of trace.messagesShape) {
      expect(m.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(m.chars).toBeGreaterThan(0);
    }
  });

  it('sets sanitized=true on every produced trace', () => {
    const trace = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'synthesizer',
      registryEntry: makeEntry({ variablesRequired: [] }),
      variables: {},
      userMessages: [{ role: 'user', content: 'X' }],
    });
    expect(trace.sanitized).toBe(true);
  });
});

describe('buildPromptRuntimeTrace — determinism', () => {
  it('same inputs produce same fingerprint', () => {
    const args = {
      strategy: 'consensus' as const,
      role: 'participant' as const,
      registryEntry: makeEntry(),
      variables: { userName: 'Bob' },
      userMessages: [{ role: 'user' as const, content: 'task X' }],
    };
    const t1 = buildPromptRuntimeTrace(args);
    const t2 = buildPromptRuntimeTrace(args);
    expect(t1.promptFingerprint).toBe(t2.promptFingerprint);
  });

  it('different template body changes the fingerprint', () => {
    const e1 = makeEntry({ getBody: () => 'body A' });
    const e2 = makeEntry({ getBody: () => 'body B' });
    const t1 = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: e1,
      variables: { userName: 'X' },
      userMessages: [{ role: 'user', content: 'task' }],
    });
    const t2 = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: e2,
      variables: { userName: 'X' },
      userMessages: [{ role: 'user', content: 'task' }],
    });
    expect(t1.promptFingerprint).not.toBe(t2.promptFingerprint);
  });

  it('different user message content changes the fingerprint', () => {
    const entry = makeEntry();
    const t1 = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: entry,
      variables: { userName: 'X' },
      userMessages: [{ role: 'user', content: 'task A' }],
    });
    const t2 = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: entry,
      variables: { userName: 'X' },
      userMessages: [{ role: 'user', content: 'task B' }],
    });
    expect(t1.promptFingerprint).not.toBe(t2.promptFingerprint);
  });

  it('different adapterPayloadFormat changes the fingerprint', () => {
    const e1 = makeEntry({ adapterPayloadFormat: 'openai_chat_messages' });
    const e2 = makeEntry({ adapterPayloadFormat: 'anthropic_messages' });
    const t1 = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: e1,
      variables: { userName: 'X' },
      userMessages: [{ role: 'user', content: 'task' }],
    });
    const t2 = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: e2,
      variables: { userName: 'X' },
      userMessages: [{ role: 'user', content: 'task' }],
    });
    expect(t1.promptFingerprint).not.toBe(t2.promptFingerprint);
  });

  it('different promptVersion changes the fingerprint', () => {
    const e1 = makeEntry({ version: 'v1' });
    const e2 = makeEntry({ version: 'v2' });
    const t1 = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: e1,
      variables: { userName: 'X' },
      userMessages: [{ role: 'user', content: 'task' }],
    });
    const t2 = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: e2,
      variables: { userName: 'X' },
      userMessages: [{ role: 'user', content: 'task' }],
    });
    expect(t1.promptFingerprint).not.toBe(t2.promptFingerprint);
  });
});

describe('buildPromptRuntimeTrace — missingVariables detection', () => {
  it('reports empty missingVariables when all required vars resolved', () => {
    const entry = makeEntry({ variablesRequired: ['a', 'b'] });
    const trace = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: entry,
      variables: { a: 1, b: 2 },
      userMessages: [{ role: 'user', content: 'X' }],
    });
    expect(trace.missingVariables).toEqual([]);
  });

  it('reports missing variables when some are unfilled', () => {
    const entry = makeEntry({ variablesRequired: ['a', 'b', 'c'] });
    const trace = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: entry,
      variables: { a: 1 },  // b and c missing
      userMessages: [{ role: 'user', content: 'X' }],
    });
    expect(trace.missingVariables).toEqual(['b', 'c']);
  });

  it('treats undefined/null values as missing', () => {
    const entry = makeEntry({ variablesRequired: ['a', 'b'] });
    const trace = buildPromptRuntimeTrace({
      strategy: 'consensus',
      role: 'participant',
      registryEntry: entry,
      variables: { a: 1, b: undefined as unknown as string },
      userMessages: [{ role: 'user', content: 'X' }],
    });
    expect(trace.missingVariables).toEqual(['b']);
  });
});

describe('buildMultiRolePromptTrace — aggregate fingerprint stability', () => {
  function makeRegistry(): PromptTemplateRegistry {
    const m = new Map<PromptRuntimeTraceRole, PromptTemplateRegistryEntry>();
    m.set('participant', makeEntry({ id: 'p', version: 'p@v1', getBody: () => 'P-body' }));
    m.set('synthesizer', makeEntry({ id: 's', version: 's@v1', variablesRequired: [], getBody: () => 'S-body' }));
    m.set('judge', makeEntry({ id: 'j', version: 'j@v1', variablesRequired: [], getBody: () => 'J-body' }));
    m.set('fallback', makeEntry({ id: 'f', version: 'f@v1', variablesRequired: [], getBody: () => 'F-body' }));
    return m;
  }

  it('produces stable aggregate across runs', () => {
    const reg = makeRegistry();
    const selected = new Map<PromptRuntimeTraceRole, {
      modelId?: string; providerId?: string; routeId?: string; variables: Record<string, unknown>;
    }>();
    selected.set('participant', { modelId: 'm1', providerId: 'p1', variables: { userName: 'A' } });
    selected.set('synthesizer', { modelId: 'm2', providerId: 'p2', variables: {} });

    const r1 = buildMultiRolePromptTrace({
      strategy: 'consensus',
      registry: reg,
      selectedRoles: selected,
      userMessages: [{ role: 'user', content: 'hello' }],
    });
    const r2 = buildMultiRolePromptTrace({
      strategy: 'consensus',
      registry: reg,
      selectedRoles: selected,
      userMessages: [{ role: 'user', content: 'hello' }],
    });
    expect(r1.aggregatePromptFingerprint).toBe(r2.aggregatePromptFingerprint);
  });

  it('emits role_not_selected_due_to_plan_blocker for unselected roles', () => {
    const reg = makeRegistry();
    const selected = new Map<PromptRuntimeTraceRole, {
      modelId?: string; providerId?: string; routeId?: string; variables: Record<string, unknown>;
    }>();
    selected.set('participant', { variables: { userName: 'A' } });

    const r = buildMultiRolePromptTrace({
      strategy: 'consensus',
      registry: reg,
      selectedRoles: selected,
      userMessages: [{ role: 'user', content: 'hello' }],
      unselectedRoles: ['judge', 'synthesizer', 'fallback'],
    });
    expect(r.issues.filter((i) => i.reason === 'role_not_selected_due_to_plan_blocker'))
      .toHaveLength(3);
  });

  it('emits template_not_found when role has no registry entry', () => {
    const emptyReg = new Map<PromptRuntimeTraceRole, PromptTemplateRegistryEntry>();
    const selected = new Map<PromptRuntimeTraceRole, {
      modelId?: string; providerId?: string; routeId?: string; variables: Record<string, unknown>;
    }>();
    selected.set('participant', { variables: {} });

    const r = buildMultiRolePromptTrace({
      strategy: 'consensus',
      registry: emptyReg,
      selectedRoles: selected,
      userMessages: [{ role: 'user', content: 'X' }],
    });
    expect(r.issues.some((i) => i.reason === 'template_not_found')).toBe(true);
    expect(r.traces).toHaveLength(0);
  });

  it('changing any role prompt changes the aggregate', () => {
    const reg1 = makeRegistry();
    const reg2 = new Map(reg1);
    reg2.set('judge', makeEntry({ id: 'j', version: 'j@v2', variablesRequired: [], getBody: () => 'J-body-NEW' }));

    const selected = new Map<PromptRuntimeTraceRole, {
      modelId?: string; providerId?: string; routeId?: string; variables: Record<string, unknown>;
    }>();
    selected.set('participant', { variables: { userName: 'A' } });
    selected.set('judge', { variables: {} });

    const r1 = buildMultiRolePromptTrace({
      strategy: 'consensus',
      registry: reg1,
      selectedRoles: selected,
      userMessages: [{ role: 'user', content: 'X' }],
    });
    const r2 = buildMultiRolePromptTrace({
      strategy: 'consensus',
      registry: reg2,
      selectedRoles: selected,
      userMessages: [{ role: 'user', content: 'X' }],
    });
    expect(r1.aggregatePromptFingerprint).not.toBe(r2.aggregatePromptFingerprint);
  });
});

describe('CONSENSUS_PROMPT_REGISTRY — covers all consensus roles', () => {
  it('has entries for participant/synthesizer/judge/fallback/fallbackSingle', async () => {
    const { CONSENSUS_PROMPT_REGISTRY } = await import('../consensus-prompt-registry');
    expect(CONSENSUS_PROMPT_REGISTRY.has('participant')).toBe(true);
    expect(CONSENSUS_PROMPT_REGISTRY.has('synthesizer')).toBe(true);
    expect(CONSENSUS_PROMPT_REGISTRY.has('judge')).toBe(true);
    expect(CONSENSUS_PROMPT_REGISTRY.has('fallback')).toBe(true);
    expect(CONSENSUS_PROMPT_REGISTRY.has('fallbackSingle')).toBe(true);
  });

  it('participant entry resolves to consensusVoter with declared slot variable', async () => {
    const { CONSENSUS_PROMPT_REGISTRY } = await import('../consensus-prompt-registry');
    const entry = CONSENSUS_PROMPT_REGISTRY.get('participant');
    expect(entry).toBeDefined();
    expect(entry!.id).toBe('consensusVoter');
    expect(entry!.variablesRequired).toContain('promptSlots');
    // Body must render (we don't assert content — just non-empty + sanitized handling).
    const body = entry!.getBody({ promptSlots: undefined });
    expect(typeof body).toBe('string');
    expect(body.length).toBeGreaterThan(50);
  });

  it('judge entry resolves with stable header when rubricVersion provided', async () => {
    const { CONSENSUS_PROMPT_REGISTRY } = await import('../consensus-prompt-registry');
    const entry = CONSENSUS_PROMPT_REGISTRY.get('judge');
    expect(entry).toBeDefined();
    const body = entry!.getBody({ rubricVersion: 'v3', judgeModelId: 'gpt-4o-mini' });
    expect(body).toContain('rubricVersion=v3');
    expect(body).toContain('judgeModelId=gpt-4o-mini');
  });

  it('fallback entry resolves to a non-empty Ailin¹ fallback prompt', async () => {
    const { CONSENSUS_PROMPT_REGISTRY } = await import('../consensus-prompt-registry');
    const entry = CONSENSUS_PROMPT_REGISTRY.get('fallback');
    expect(entry).toBeDefined();
    const body = entry!.getBody({ where: 'test' });
    expect(body).toContain('Ailin');
    expect(body).toContain('[fallback');
  });
});
