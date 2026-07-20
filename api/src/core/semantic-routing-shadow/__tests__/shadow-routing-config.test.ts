// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * shadow-routing-config.test.ts — MVP 8C.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SHADOW_CONFIG,
  loadShadowConfigFromEnv,
  resolveShadowConfig,
} from '../shadow-routing-config';

describe('DEFAULT_SHADOW_CONFIG — conservative defaults', () => {
  it('enabled = false', () => {
    expect(DEFAULT_SHADOW_CONFIG.enabled).toBe(false);
  });

  it('sampleRate = 0', () => {
    expect(DEFAULT_SHADOW_CONFIG.sampleRate).toBe(0);
  });

  it('logLevel = off', () => {
    expect(DEFAULT_SHADOW_CONFIG.logLevel).toBe('off');
  });

  it('decisionMode = legacy', () => {
    expect(DEFAULT_SHADOW_CONFIG.decisionMode).toBe('legacy');
  });

  it('maxLatencyMs = 25', () => {
    expect(DEFAULT_SHADOW_CONFIG.maxLatencyMs).toBe(25);
  });

  it('writeMode = log_only', () => {
    expect(DEFAULT_SHADOW_CONFIG.writeMode).toBe('log_only');
  });

  it('taskTypes default to code-generation only', () => {
    expect(DEFAULT_SHADOW_CONFIG.taskTypes).toEqual(['code-generation']);
  });

  it('frozen', () => {
    expect(Object.isFrozen(DEFAULT_SHADOW_CONFIG)).toBe(true);
  });
});

describe('loadShadowConfigFromEnv — env absent', () => {
  it('empty env resolves to defaults', () => {
    const c = loadShadowConfigFromEnv({});
    expect(c.enabled).toBe(false);
    expect(c.sampleRate).toBe(0);
    expect(c.decisionMode).toBe('legacy');
    expect(c.source).toBe('env');
  });

  it('SEMANTIC_ROUTING_SHADOW_ENABLED=invalid → false', () => {
    const c = loadShadowConfigFromEnv({ SEMANTIC_ROUTING_SHADOW_ENABLED: 'maybe' });
    expect(c.enabled).toBe(false);
  });

  it('SEMANTIC_ROUTING_SHADOW_ENABLED=true → enabled', () => {
    const c = loadShadowConfigFromEnv({ SEMANTIC_ROUTING_SHADOW_ENABLED: 'true' });
    expect(c.enabled).toBe(true);
  });

  it('parses sample rate within [0, 1]', () => {
    const a = loadShadowConfigFromEnv({ SEMANTIC_ROUTING_SHADOW_SAMPLE_RATE: '0.05' });
    expect(a.sampleRate).toBe(0.05);
    const b = loadShadowConfigFromEnv({ SEMANTIC_ROUTING_SHADOW_SAMPLE_RATE: '1.5' });
    expect(b.sampleRate).toBe(1);
    const c = loadShadowConfigFromEnv({ SEMANTIC_ROUTING_SHADOW_SAMPLE_RATE: '-0.5' });
    expect(c.sampleRate).toBe(0);
  });

  it('parses maxLatency with clamping to [1, 500]', () => {
    const a = loadShadowConfigFromEnv({ SEMANTIC_ROUTING_SHADOW_MAX_LATENCY_MS: '50' });
    expect(a.maxLatencyMs).toBe(50);
    const b = loadShadowConfigFromEnv({ SEMANTIC_ROUTING_SHADOW_MAX_LATENCY_MS: '9999' });
    expect(b.maxLatencyMs).toBe(500);
  });

  it('parses CSV taskTypes', () => {
    const c = loadShadowConfigFromEnv({
      SEMANTIC_ROUTING_SHADOW_TASKTYPES: 'code-generation,analysis',
    });
    expect(c.taskTypes).toEqual(['code-generation', 'analysis']);
  });

  it('decisionMode invalid → legacy', () => {
    const c = loadShadowConfigFromEnv({ SEMANTIC_ROUTING_DECISION_MODE: 'invalid' });
    expect(c.decisionMode).toBe('legacy');
  });
});

describe('resolveShadowConfig — override merge', () => {
  it('no override → defaults', () => {
    expect(resolveShadowConfig()).toBe(DEFAULT_SHADOW_CONFIG);
  });

  it('partial override merges with defaults', () => {
    const c = resolveShadowConfig({ enabled: true, sampleRate: 0.1 });
    expect(c.enabled).toBe(true);
    expect(c.sampleRate).toBe(0.1);
    expect(c.decisionMode).toBe('legacy');
    expect(c.maxLatencyMs).toBe(25);
  });

  it('clamps invalid sampleRate', () => {
    const c = resolveShadowConfig({ sampleRate: 2 });
    expect(c.sampleRate).toBe(1);
  });

  it('output is frozen', () => {
    const c = resolveShadowConfig({ enabled: true });
    expect(Object.isFrozen(c)).toBe(true);
  });
});
