-- Copyright (C) 2026 Ailin One, Inc.
--
-- This file is part of Collective Intelligence Engine (ci).
-- Licensed under the GNU Affero General Public License v3.0 or later.
-- See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Source: https://github.com/ailinone/collective-intelligence

-- F3.3 smoke fixture — one collective_run + 2 collective_signals
INSERT INTO collective_runs (
  id, organization_id, request_id, strategy, config,
  rounds, stop_reason, convergence_score, decision_flip_rate, dissent,
  total_cost_usd, total_latency_ms, total_tokens,
  final_decision_type, final_confidence, metadata, created_at
) VALUES (
  'cccccccc-3333-4444-5555-cccccccccccc',
  '11111111-1111-1111-1111-111111111111',
  'smoke-f3.3-export-001',
  'sensitivity-consensus',
  '{"maxRounds": 5, "aggregationMethod": "llm_synthesis"}'::jsonb,
  2,
  'converged',
  0.91,
  0.05,
  0.10,
  0.05432,
  3500,
  2400,
  'recommendation',
  0.88,
  '{"participatingModels": ["openai/gpt-5", "anthropic/claude-sonnet"], "criticalVariables": ["cost", "quality"]}'::jsonb,
  NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO collective_signals (
  id, run_id, round, agent_id, model_id, provider_id, role,
  decision_type, decision_value, decision_confidence, decision_rationale,
  sensitivities, latency_ms, input_tokens, output_tokens, cost_usd, created_at
) VALUES
  (
    'dddddddd-1111-1111-1111-dddddddddddd',
    'cccccccc-3333-4444-5555-cccccccccccc',
    0,
    'agent-A',
    'openai/gpt-5',
    'openai',
    'solver',
    'recommendation',
    '{"choice": "option-A"}'::jsonb,
    0.85,
    'Reasoning for option A.',
    '[{"variable": "cost", "direction": "minimize", "confidence": 0.8}]'::jsonb,
    1800,
    600,
    300,
    0.025,
    NOW()
  ),
  (
    'dddddddd-2222-2222-2222-dddddddddddd',
    'cccccccc-3333-4444-5555-cccccccccccc',
    1,
    'agent-A',
    'openai/gpt-5',
    'openai',
    'solver',
    'recommendation',
    '{"choice": "option-A"}'::jsonb,
    0.91,
    'Confirming option A after round 1 signals.',
    '[{"variable": "quality", "direction": "maximize", "confidence": 0.9}]'::jsonb,
    1700,
    700,
    400,
    0.029,
    NOW()
  )
ON CONFLICT (id) DO NOTHING;
