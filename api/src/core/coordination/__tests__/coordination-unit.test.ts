// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Unit tests for the Ailin¹ Collective Coordination Layer
 */

import { describe, it, expect } from 'vitest';
import {
  validateCoordinationSignal,
  validateSensitivity,
  validateDecision,
  looksLikeSignalResponse,
  redactPii,
} from '../signal-validator';
import {
  createInitialState,
  aggregateSignals,
  evaluateStopConditions,
} from '../sensitivity-aggregator';
import {
  parseSignalResponse,
  buildCoordinationSystemPrompt,
  buildCoordinationUserMessage,
} from '../sensitivity-prompt-adapter';
import { evaluateConvergence } from '../convergence-evaluator';
import { DEFAULT_COORDINATION_CONFIG } from '../coordination-types';

function makeSignal(overrides) {
  const base = {
    id: 'sig-test-1',
    runId: 'run-test',
    round: 1,
    agentId: 'agent-a',
    modelId: 'model-a',
    providerId: 'provider-a',
    decision: {
      type: 'approve',
      value: 'approved',
      confidence: 0.85,
      rationale: 'Looks good',
    },
    sensitivities: [
      {
        variable: 'test_coverage',
        direction: 'block',
        trigger: 'If test coverage drops below 80%',
        confidence: 0.9,
        rationale: 'Quality gate requires 80% coverage',
        risk: 'high',
      },
    ],
    createdAt: new Date().toISOString(),
  };
  return { ...base, ...overrides };
}

function defaultLimits() {
  return {
    maxRounds: 3,
    minConvergenceScore: 0.82,
    maxDecisionFlipRate: 0.15,
    maxDissent: 0.35,
    stopOnCriticalRisk: true,
    minValidSignalsPerRound: 2,
    detectStagnation: true,
  };
}

describe('Signal Validator', () => {
  it('accepts a valid CoordinationSignal', () => {
    const signal = makeSignal();
    const result = validateCoordinationSignal(signal);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.sanitized).toBeDefined();
  });

  it('rejects a signal with missing required fields', () => {
    const result = validateCoordinationSignal({
      round: 1,
      decision: { type: 'approve', value: true, confidence: 0.8 },
      sensitivities: [],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a signal with invalid round', () => {
    const result = validateCoordinationSignal(makeSignal({ round: 0 }));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('round'))).toBe(true);
  });

  it('rejects a signal with invalid confidence', () => {
    const result = validateCoordinationSignal(
      makeSignal({ decision: { type: 'approve', value: true, confidence: 1.5 } }),
    );
    expect(result.valid).toBe(false);
  });

  it('rejects a signal with no sensitivities', () => {
    const result = validateCoordinationSignal(makeSignal({ sensitivities: [] }));
    expect(result.valid).toBe(false);
  });

  it('sanitizes long rationale strings', () => {
    const longRationale = 'a'.repeat(3000);
    const result = validateSensitivity(
      { variable: 'x', direction: 'increase', trigger: 'test', confidence: 0.8, rationale: longRationale },
      0,
    );
    expect(result.sanitized).toBeDefined();
    if (result.sanitized) {
      expect(result.sanitized.rationale.length).toBeLessThan(longRationale.length);
    }
  });

  it('validates a valid decision', () => {
    const result = validateDecision({ type: 'approve', value: 'yes', confidence: 0.8, rationale: 'test' });
    expect(result.errors).toHaveLength(0);
    expect(result.sanitized).toBeDefined();
  });

  it('rejects decision with missing value', () => {
    const result = validateDecision({ type: 'approve', confidence: 0.8 });
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('detects signal-like responses', () => {
    expect(looksLikeSignalResponse('{"decision":{}, "sensitivities":[]}')).toBe(true);
    expect(looksLikeSignalResponse('```json\n{"decision":{}}\n```')).toBe(true);
    expect(looksLikeSignalResponse('')).toBe(false);
    expect(looksLikeSignalResponse('random text')).toBe(false);
  });
});

describe('SensitivityAggregator', () => {
  it('creates a valid initial state', () => {
    const state = createInitialState('run-1', 'sensitivity-consensus', defaultLimits());
    expect(state.runId).toBe('run-1');
    expect(state.round).toBe(0);
    expect(state.history).toHaveLength(0);
    expect(state.convergence.score).toBe(0);
    expect(state.totalCostUsd).toBe(0);
  });

  it('returns insufficient_valid_signals for empty signals', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    const result = aggregateSignals([], state);
    expect(result.stopReason).toBe('insufficient_valid_signals');
    expect(result.nextState).toBe(state);
  });

  it('aggregates signals and updates state', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    const signals = [
      makeSignal({ agentId: 'a', modelId: 'm1', providerId: 'p1' }),
      makeSignal({ agentId: 'b', modelId: 'm2', providerId: 'p2' }),
      makeSignal({ agentId: 'c', modelId: 'm3', providerId: 'p3' }),
    ];
    const result = aggregateSignals(signals, state);
    expect(result.nextState.round).toBe(1);
    expect(result.updatedVariables.length).toBeGreaterThan(0);
    expect(result.nextState.history.length).toBe(3);
  });

  it('detects conflicts when agents disagree on direction', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    const signals = [
      makeSignal({ agentId: 'a', sensitivities: [{ variable: 'risk', direction: 'increase', trigger: 't', confidence: 0.8, rationale: 'r' }] }),
      makeSignal({ agentId: 'b', sensitivities: [{ variable: 'risk', direction: 'decrease', trigger: 't', confidence: 0.7, rationale: 'r' }] }),
    ];
    const result = aggregateSignals(signals, state);
    expect(result.conflictingSignals).toContain('risk');
  });

  it('computes convergence with full agreement', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    const signals = [
      makeSignal({ agentId: 'a', decision: { type: 'approve', value: 'yes', confidence: 0.95 } }),
      makeSignal({ agentId: 'b', decision: { type: 'approve', value: 'yes', confidence: 0.93 } }),
      makeSignal({ agentId: 'c', decision: { type: 'approve', value: 'yes', confidence: 0.91 } }),
    ];
    const result = aggregateSignals(signals, state);
    expect(result.nextState.convergence.dissent).toBe(0);
    expect(result.nextState.convergence.score).toBeGreaterThan(0.8);
  });

  it('computes dissent when agents disagree', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    const signals = [
      makeSignal({ agentId: 'a', decision: { type: 'approve', value: 'yes', confidence: 0.9 } }),
      makeSignal({ agentId: 'b', decision: { type: 'reject', value: 'no', confidence: 0.8 } }),
      makeSignal({ agentId: 'c', decision: { type: 'approve', value: 'yes', confidence: 0.7 } }),
    ];
    const result = aggregateSignals(signals, state);
    expect(result.nextState.convergence.dissent).toBeGreaterThan(0);
  });
});

describe('Stop Conditions', () => {
  it('stops at max rounds', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    state.round = 3;
    expect(evaluateStopConditions(state)).toBe('max_rounds');
  });

  it('stops at max cost', () => {
    const limits = defaultLimits();
    limits.maxCostUsd = 0.1;
    const state = createInitialState('run-1', 'test', limits);
    state.totalCostUsd = 0.15;
    state.round = 1;
    expect(evaluateStopConditions(state)).toBe('max_cost');
  });

  it('stops at max latency', () => {
    const limits = defaultLimits();
    limits.maxLatencyMs = 1000;
    const state = createInitialState('run-1', 'test', limits);
    state.totalLatencyMs = 1500;
    state.round = 1;
    expect(evaluateStopConditions(state)).toBe('max_latency');
  });

  it('stops on critical risk when configured', () => {
    const limits = defaultLimits();
    limits.stopOnCriticalRisk = true;
    const state = createInitialState('run-1', 'test', limits);
    state.round = 1;
    state.risks = [{ type: 'test', severity: 'critical', description: 'critical issue', sourceSignalIds: [] }];
    expect(evaluateStopConditions(state)).toBe('critical_risk');
  });

  it('does not stop on critical risk when disabled', () => {
    const limits = defaultLimits();
    limits.stopOnCriticalRisk = false;
    const state = createInitialState('run-1', 'test', limits);
    state.round = 1;
    state.risks = [{ type: 'test', severity: 'critical', description: 'critical issue', sourceSignalIds: [] }];
    state.convergence.score = 0.5;
    state.convergence.decisionFlipRate = 0.5;
    expect(evaluateStopConditions(state)).toBeUndefined();
  });

  it('stops on convergence', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    state.round = 1;
    state.convergence.score = 0.9;
    state.convergence.decisionFlipRate = 0.05;
    state.convergence.dissent = 0.1;
    expect(evaluateStopConditions(state)).toBe('converged');
  });

  it('continues when not converged', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    state.round = 1;
    state.convergence.score = 0.5;
    state.convergence.decisionFlipRate = 0.5;
    expect(evaluateStopConditions(state)).toBeUndefined();
  });
});

describe('ConvergenceEvaluator', () => {
  it('detects herding when all models converge rapidly to same decision', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    state.round = 2;
    state.history = [
      makeSignal({ agentId: 'a', round: 1, decision: { type: 'approve', value: 'yes', confidence: 0.6 } }),
      makeSignal({ agentId: 'b', round: 1, decision: { type: 'reject', value: 'no', confidence: 0.7 } }),
      makeSignal({ agentId: 'a', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.95 } }),
      makeSignal({ agentId: 'b', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.93 } }),
    ];
    state.convergence = { score: 0.95, decisionFlipRate: 0, dissent: 0, confidenceTrend: [0.5, 0.94], stableVariables: [], unstableVariables: [] };
    const evaluation = evaluateConvergence(state);
    expect(evaluation.herdingDetected).toBe(true);
  });

  it('detects stagnation when confidence is flat across rounds', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    state.round = 3;
    state.convergence = { score: 0.7, decisionFlipRate: 0, dissent: 0.2, confidenceTrend: [0.71, 0.715, 0.712], stableVariables: [], unstableVariables: [] };
    const evaluation = evaluateConvergence(state);
    expect(evaluation.stagnationDetected).toBe(true);
  });

  it('detects sensitivity poisoning via identical triggers', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    state.round = 1;
    const identicalSens = { variable: 'security', direction: 'block', trigger: 'if SQL injection found', confidence: 0.99, rationale: 'critical security risk' };
    state.history = [
      makeSignal({ agentId: 'a', sensitivities: [identicalSens] }),
      makeSignal({ agentId: 'b', sensitivities: [identicalSens] }),
      makeSignal({ agentId: 'c', sensitivities: [identicalSens] }),
    ];
    state.variables = { security: { value: 'blocked', confidence: 0.99, updatedBy: ['a', 'b', 'c'], rationale: 'identical', stability: 1 } };
    const evaluation = evaluateConvergence(state);
    expect(evaluation.sensitivityPoisoningDetected).toBe(true);
  });

  it('returns accurate detail metrics', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    state.round = 2;
    state.variables = { coverage: { value: 0.85, confidence: 0.9, updatedBy: ['a', 'b'], rationale: 'stable', stability: 0.95 } };
    state.history = [
      makeSignal({ agentId: 'a', round: 1, decision: { type: 'approve', value: 'yes', confidence: 0.7 } }),
      makeSignal({ agentId: 'b', round: 1, decision: { type: 'approve', value: 'yes', confidence: 0.75 } }),
      makeSignal({ agentId: 'a', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.85 } }),
      makeSignal({ agentId: 'b', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.9 } }),
    ];
    state.convergence = { score: 0.88, decisionFlipRate: 0, dissent: 0, confidenceTrend: [0.725, 0.875], stableVariables: ['coverage'], unstableVariables: [] };
    const evaluation = evaluateConvergence(state);
    expect(evaluation.details.confidenceTrend).toBe('increasing');
    expect(evaluation.details.variableStability).toBe(0.95);
    expect(evaluation.details.uniqueDecisionTypes).toBe(1);
  });
});

describe('Prompt Adapter', () => {
  it('builds a coordination system prompt', () => {
    const prompt = buildCoordinationSystemPrompt('security-expert', 2, undefined);
    expect(prompt).toContain('security-expert');
    expect(prompt).toContain('round 2');
    expect(prompt).toContain('JSON');
  });

  it('builds user message from messages', () => {
    const messages = [{ role: 'system', content: 'system msg' }, { role: 'user', content: 'review this code' }];
    const userMsg = buildCoordinationUserMessage(messages);
    expect(userMsg).toContain('review this code');
    expect(userMsg).not.toContain('system msg');
  });

  it('parses a valid JSON signal response', () => {
    const response = JSON.stringify({
      decision: { type: 'approve', value: 'approved', confidence: 0.9, rationale: 'looks good' },
      sensitivities: [{ variable: 'test_coverage', direction: 'block', trigger: 'below 80%', confidence: 0.85, rationale: 'quality gate', risk: 'high' }],
    });
    const result = parseSignalResponse(response, 'run-1', 1, 'agent-a', 'model-a', 'provider-a');
    expect(result.signal).not.toBeNull();
    expect(result.signal.decision.type).toBe('approve');
    expect(result.signal.sensitivities).toHaveLength(1);
  });

  it('parses signal from markdown code block', () => {
    const response = '```json\n' + JSON.stringify({
      decision: { type: 'reject', value: 'rejected', confidence: 0.7 },
      sensitivities: [{ variable: 'x', direction: 'increase', trigger: 't', confidence: 0.6, rationale: 'r' }],
    }) + '\n```';
    const result = parseSignalResponse(response, 'run-1', 1, 'agent-a', 'model-a', 'provider-a');
    expect(result.signal).not.toBeNull();
  });

  it('returns null for completely invalid response', () => {
    const result = parseSignalResponse('not json at all', 'run-1', 1, 'a', 'm', 'p');
    expect(result.signal).toBeNull();
    expect(result.parseError).toBeDefined();
  });

  it('returns null for empty response', () => {
    const result = parseSignalResponse('', 'run-1', 1, 'a', 'm', 'p');
    expect(result.signal).toBeNull();
  });
});

describe('Decision Flip Rate', () => {
  it('computes flip rate across rounds', () => {
    const state = createInitialState('run-1', 'test', defaultLimits());
    state.round = 1;
    state.history = [
      makeSignal({ agentId: 'a', round: 1, decision: { type: 'approve', value: 'yes', confidence: 0.9 } }),
      makeSignal({ agentId: 'b', round: 1, decision: { type: 'approve', value: 'yes', confidence: 0.8 } }),
    ];
    const round2Signals = [
      makeSignal({ agentId: 'a', round: 2, decision: { type: 'reject', value: 'no', confidence: 0.7 } }),
      makeSignal({ agentId: 'b', round: 2, decision: { type: 'approve', value: 'yes', confidence: 0.85 } }),
    ];
    const result = aggregateSignals(round2Signals, state);
    expect(result.nextState.convergence.decisionFlipRate).toBeGreaterThan(0);
  });
});

describe('Configuration', () => {
  it('default config has coordination disabled', () => {
    expect(DEFAULT_COORDINATION_CONFIG.enabled).toBe(false);
  });

  it('default config has safe limits', () => {
    expect(DEFAULT_COORDINATION_CONFIG.maxRounds).toBeLessThanOrEqual(5);
    expect(DEFAULT_COORDINATION_CONFIG.minConvergenceScore).toBeGreaterThanOrEqual(0.5);
    expect(DEFAULT_COORDINATION_CONFIG.maxCostUsd).toBeGreaterThan(0);
  });
});

describe('PII Redaction', () => {
  it('redacts email addresses', () => {
    const result = redactPii('Contact user@example.com for details');
    expect(result.redacted).not.toContain('user@example.com');
    expect(result.redacted).toContain('[REDACTED_EMAIL]');
    expect(result.patterns).toContain('email');
  });

  it('redacts multiple emails in one string', () => {
    const result = redactPii('admin@corp.com and john.doe+tag@sub.domain.org both sent alerts');
    expect(result.redacted).not.toContain('admin@corp.com');
    expect(result.redacted).not.toContain('john.doe+tag@sub.domain.org');
    expect((result.redacted.match(/\[REDACTED_EMAIL\]/g) || []).length).toBe(2);
  });

  it('redacts Brazilian phone numbers', () => {
    const result = redactPii('Call +55 11 91234-5678 or (21) 93333-4444');
    expect(result.patterns).toContain('phone_br');
    expect(result.redacted).not.toContain('91234-5678');
    expect(result.redacted).not.toContain('93333-4444');
  });

  it('redacts CPF numbers', () => {
    const result = redactPii('CPF: 123.456.789-00');
    expect(result.redacted).not.toContain('123.456.789-00');
    expect(result.patterns).toContain('cpf');
  });

  it('redacts CNPJ numbers', () => {
    const result = redactPii('CNPJ: 12.345.678/0001-90');
    expect(result.redacted).not.toContain('12.345.678/0001-90');
    expect(result.patterns).toContain('cnpj');
  });

  it('redacts OpenAI-style API keys', () => {
    const result = redactPii('Key: sk-proj-abcdefghijklmnopqrstuvwxyz1234567890');
    expect(result.redacted).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz1234567890');
    expect(result.patterns).toContain('api_key_generic');
  });

  it('redacts GitHub PAT tokens', () => {
    const result = redactPii('Token: github_pat_AAAAAAA1234567890abcdefghijklmnop');
    expect(result.redacted).not.toContain('github_pat_AAAAAAA');
    expect(result.patterns).toContain('api_key_generic');
  });

  it('redacts Bearer tokens', () => {
    const result = redactPii('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def');
    expect(result.redacted).toContain('Bearer [REDACTED_TOKEN]');
    expect(result.patterns).toContain('bearer_token');
  });

  it('redacts Basic auth', () => {
    const result = redactPii('Authorization: Basic dXNlcjpwYXNz');
    expect(result.redacted).toContain('Basic [REDACTED_CREDENTIAL]');
    expect(result.patterns).toContain('basic_auth');
  });

  it('redacts URLs with query strings', () => {
    const result = redactPii('Visit https://api.example.com/users?token=secret&key=abc123');
    expect(result.redacted).not.toContain('token=secret');
    expect(result.redacted).toContain('[REDACTED_QUERY]');
    expect(result.redacted).toContain('https://api.example.com/users');
    expect(result.patterns).toContain('url_with_query');
  });

  it('preserves URLs without query strings', () => {
    const result = redactPii('Visit https://example.com/page for more info');
    expect(result.redacted).toBe('Visit https://example.com/page for more info');
  });

  it('redacts private IP addresses', () => {
    const result = redactPii('Server at 192.168.1.100 or 10.0.0.1');
    expect(result.redacted).not.toContain('192.168.1.100');
    expect(result.redacted).not.toContain('10.0.0.1');
    expect(result.patterns).toContain('private_ip');
  });

  it('redacts password-like patterns', () => {
    const result = redactPii('db.password=SuperSecret123! and api_key: "ghp_longkeyvaluehere"');
    expect(result.patterns.length).toBeGreaterThan(0);
    expect(result.redacted).not.toContain('SuperSecret123!');
  });

  it('redacts AWS access keys', () => {
    const result = redactPii('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    expect(result.redacted).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(result.patterns).toContain('aws_access_key');
  });

  it('handles empty string', () => {
    const result = redactPii('');
    expect(result.redacted).toBe('');
    expect(result.patterns).toHaveLength(0);
  });

  it('handles string without PII', () => {
    const result = redactPii('The test coverage is at 85 percent and quality looks good');
    expect(result.redacted).toBe('The test coverage is at 85 percent and quality looks good');
    expect(result.patterns).toHaveLength(0);
  });

  it('PII is redacted in validated signals', () => {
    const signal = makeSignal({
      decision: {
        type: 'approve',
        value: 'approved',
        confidence: 0.85,
        rationale: 'User admin@corp.com approved via 192.168.1.1',
      },
      sensitivities: [{
        variable: 'auth',
        direction: 'block',
        trigger: 'If admin@secret.com credentials expire',
        confidence: 0.9,
        rationale: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig must be valid',
        risk: 'high',
      }],
    });
    const result = validateCoordinationSignal(signal);
    expect(result.valid).toBe(true);
    expect(result.sanitized!.decision.rationale).not.toContain('admin@corp.com');
    expect(result.sanitized!.decision.rationale).toContain('[REDACTED_EMAIL]');
    expect(result.sanitized!.decision.rationale).toContain('[REDACTED_IP]');
    expect(result.sanitized!.sensitivities[0].trigger).not.toContain('admin@secret.com');
    expect(result.sanitized!.sensitivities[0].rationale).toContain('[REDACTED_TOKEN]');
  });
});
