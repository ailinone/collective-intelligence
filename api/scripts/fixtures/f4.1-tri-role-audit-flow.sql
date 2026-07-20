-- Copyright (C) 2026 Ailin One, Inc.
--
-- This file is part of Collective Intelligence Engine (ci).
-- Licensed under the GNU Affero General Public License v3.0 or later.
-- See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Source: https://github.com/ailinone/collective-intelligence

-- F4.1 audit-flow fixture — one tri-role-collective run (3 turns: planner → solver → auditor-accept)
-- Verifies the F4.1 audit fields (schedulerName + decisionReason) reach the F3.3 export
-- via collective_signals.decision_value JSON.

INSERT INTO collective_runs (
  id, organization_id, request_id, strategy, config,
  rounds, stop_reason, convergence_score, decision_flip_rate, dissent,
  total_cost_usd, total_latency_ms, total_tokens,
  final_decision_type, final_confidence, metadata, created_at
) VALUES (
  'eeeeeeee-4444-5555-6666-eeeeeeeeeeee',
  '11111111-1111-1111-1111-111111111111',
  'smoke-f4.1-tri-role-001',
  'tri-role-collective',
  '{"maxTurns": 5, "maxCostUsd": 0.30, "maxLatencyMs": 60000, "ambiguityResolution": "accept"}'::jsonb,
  3,
  'accepted',
  1.000,
  0.000,
  0.000,
  0.07560,
  4500,
  1800,
  'auditor-accept',
  1.00,
  '{"participatingModels": [{"modelId": "openai/gpt-5", "modelName": "GPT-5", "providerId": "openai"}, {"modelId": "anthropic/claude-sonnet", "modelName": "Claude Sonnet", "providerId": "anthropic"}]}'::jsonb,
  NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO collective_signals (
  id, run_id, round, agent_id, model_id, provider_id, role,
  decision_type, decision_value, decision_confidence, decision_rationale,
  sensitivities, latency_ms, input_tokens, output_tokens, cost_usd, created_at
) VALUES
  -- Turn 1: planner
  (
    'ffffffff-1111-1111-1111-ffffffffffff',
    'eeeeeeee-4444-5555-6666-eeeeeeeeeeee',
    1,
    'planner-turn-1',
    'openai/gpt-5',
    'openai',
    'planner',
    'planner',
    '{"responseText": "GOAL: implement feature\nSTEPS:\n1. design\n2. test\nSUCCESS_CRITERIA: tests pass", "schedulerName": "fixed-state-machine", "decisionReason": "turn-1-fixed"}'::jsonb,
    1.00,
    NULL,
    '[]'::jsonb,
    1500,
    400,
    200,
    0.012,
    NOW()
  ),
  -- Turn 2: solver
  (
    'ffffffff-2222-2222-2222-ffffffffffff',
    'eeeeeeee-4444-5555-6666-eeeeeeeeeeee',
    2,
    'solver-turn-2',
    'anthropic/claude-sonnet',
    'anthropic',
    'solver',
    'solver',
    '{"responseText": "Final implementation answer goes here.", "schedulerName": "fixed-state-machine", "decisionReason": "turn-2-fixed"}'::jsonb,
    1.00,
    NULL,
    '[]'::jsonb,
    1800,
    600,
    400,
    0.034,
    NOW()
  ),
  -- Turn 3: auditor (accept)
  (
    'ffffffff-3333-3333-3333-ffffffffffff',
    'eeeeeeee-4444-5555-6666-eeeeeeeeeeee',
    3,
    'auditor-turn-3',
    'openai/gpt-5',
    'openai',
    'auditor',
    'verdict-accept',
    '{"responseText": "VERDICT: ACCEPT\nLooks good.", "verdict": {"status": "accept", "feedback": "Looks good.", "inferred": false}, "schedulerName": "fixed-state-machine", "decisionReason": "after-solver"}'::jsonb,
    1.00,
    'Looks good.',
    '[]'::jsonb,
    1200,
    800,
    200,
    0.0296,
    NOW()
  )
ON CONFLICT (id) DO NOTHING;
