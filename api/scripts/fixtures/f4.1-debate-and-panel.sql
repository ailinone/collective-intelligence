-- Copyright (C) 2026 Ailin One, Inc.
--
-- This file is part of Collective Intelligence Engine (ci).
-- Licensed under the GNU Affero General Public License v3.0 or later.
-- See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
--
-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Source: https://github.com/ailinone/collective-intelligence

-- F4.1 audit-flow fixture for debate + expert-panel persistence
--
-- Mirrors the shape that persistDebateRun and persistExpertPanelRun produce
-- live. Used by smoke-collective-export.cjs to verify the audit fields
-- (moderatorScheduler/Reason, panelScheduler/Reason) survive the round-trip
-- through JSONB → API → JSONL.

-- ─── Debate run ─────────────────────────────────────────────────────────
INSERT INTO collective_runs (
  id, organization_id, request_id, strategy, config,
  rounds, stop_reason, convergence_score, decision_flip_rate, dissent,
  total_cost_usd, total_latency_ms, total_tokens,
  final_decision_type, final_confidence, metadata, created_at
) VALUES (
  '11111111-aaaa-bbbb-cccc-111111111111',
  '11111111-1111-1111-1111-111111111111',
  'smoke-f4.1-debate-001',
  'debate',
  '{"maxParticipants": 3, "numDebateRounds": 1}'::jsonb,
  1,
  'completed',
  1.000,
  0.000,
  0.000,
  0.0876,
  6500,
  3400,
  'synthesis',
  1.00,
  $${"participatingModels":[{"modelId":"openai/gpt-5","modelName":"GPT-5","providerId":"openai"},{"modelId":"anthropic/claude-sonnet","modelName":"Claude Sonnet","providerId":"anthropic"},{"modelId":"google/gemini-pro","modelName":"Gemini Pro","providerId":"google"}],"moderatorScheduler":"pin-or-quality","moderatorReason":"quality-fallback"}$$::jsonb,
  NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO collective_signals (
  id, run_id, round, agent_id, model_id, provider_id, role,
  decision_type, decision_value, decision_confidence, decision_rationale,
  sensitivities, latency_ms, input_tokens, output_tokens, cost_usd, created_at
) VALUES
  -- Debater 1: opening (round 1)
  (
    '22222222-aaaa-aaaa-aaaa-222222222222',
    '11111111-aaaa-bbbb-cccc-111111111111',
    1, 'debater-Claude Sonnet-round-1', 'anthropic/claude-sonnet', 'anthropic', 'debater',
    'opening',
    '{"text":"Position: option A is preferable because it has lower coupling and a clearer separation of concerns."}'::jsonb,
    1.00, NULL, '[]'::jsonb,
    1500, 600, 280, 0.025, NOW()
  ),
  -- Debater 2: opening (round 1)
  (
    '22222222-bbbb-bbbb-bbbb-222222222222',
    '11111111-aaaa-bbbb-cccc-111111111111',
    1, 'debater-Gemini Pro-round-1', 'google/gemini-pro', 'google', 'debater',
    'opening',
    '{"text":"Counter-position: option B reduces operational complexity and is easier to monitor in production."}'::jsonb,
    1.00, NULL, '[]'::jsonb,
    1700, 650, 320, 0.029, NOW()
  ),
  -- Moderator: synthesis (round 2)
  (
    '22222222-cccc-cccc-cccc-222222222222',
    '11111111-aaaa-bbbb-cccc-111111111111',
    2, 'moderator-GPT-5-round-2', 'openai/gpt-5', 'openai', 'moderator',
    'synthesis',
    '{"text":"Synthesis: option A is preferable on architecture grounds. The operational concerns raised for option B can be addressed via better observability without changing the architectural choice.","schedulerName":"pin-or-quality","decisionReason":"quality-fallback"}'::jsonb,
    1.00, NULL, '[]'::jsonb,
    3300, 1200, 600, 0.0336, NOW()
  )
ON CONFLICT (id) DO NOTHING;

-- ─── Expert-panel run ───────────────────────────────────────────────────
INSERT INTO collective_runs (
  id, organization_id, request_id, strategy, config,
  rounds, stop_reason, convergence_score, decision_flip_rate, dissent,
  total_cost_usd, total_latency_ms, total_tokens,
  final_decision_type, final_confidence, metadata, created_at
) VALUES (
  '11111111-dddd-eeee-ffff-111111111111',
  '11111111-1111-1111-1111-111111111111',
  'smoke-f4.1-panel-001',
  'expert-panel',
  '{"expertCount":3,"domains":["coding","security","testing"],"crossReviewEnabled":true}'::jsonb,
  3,
  'completed',
  1.000,
  0.000,
  0.000,
  0.1240,
  9800,
  5100,
  'synthesis',
  1.00,
  $${"participatingModels":[{"modelId":"openai/gpt-5","modelName":"GPT-5","providerId":"openai"},{"modelId":"anthropic/claude-sonnet","modelName":"Claude Sonnet","providerId":"anthropic"},{"modelId":"google/gemini-pro","modelName":"Gemini Pro","providerId":"google"}],"domains":["coding","security","testing"],"panelScheduler":"pin-or-quality","panelReason":"quality-fallback"}$$::jsonb,
  NOW()
) ON CONFLICT (id) DO NOTHING;

INSERT INTO collective_signals (
  id, run_id, round, agent_id, model_id, provider_id, role,
  decision_type, decision_value, decision_confidence, decision_rationale,
  sensitivities, latency_ms, input_tokens, output_tokens, cost_usd, created_at
) VALUES
  -- Expert 1: coding (round 1)
  (
    '33333333-aaaa-aaaa-aaaa-333333333333',
    '11111111-dddd-eeee-ffff-111111111111',
    1, 'expert-GPT-5-round-1', 'openai/gpt-5', 'openai', 'expert',
    'expert-opinion',
    '{"text":"From a coding perspective, the implementation should favor immutable data flows.","domain":"coding"}'::jsonb,
    1.00, NULL, '[]'::jsonb,
    1800, 700, 350, 0.034, NOW()
  ),
  -- Expert 2: security
  (
    '33333333-bbbb-bbbb-bbbb-333333333333',
    '11111111-dddd-eeee-ffff-111111111111',
    1, 'expert-Claude Sonnet-round-1', 'anthropic/claude-sonnet', 'anthropic', 'expert',
    'expert-opinion',
    '{"text":"Security review: tenant isolation must be enforced at the query layer, not just the route layer.","domain":"security"}'::jsonb,
    1.00, NULL, '[]'::jsonb,
    2000, 800, 400, 0.038, NOW()
  ),
  -- Cross-review (round 2)
  (
    '33333333-cccc-cccc-cccc-333333333333',
    '11111111-dddd-eeee-ffff-111111111111',
    2, 'reviewer-GPT-5-round-2', 'openai/gpt-5', 'openai', 'reviewer',
    'cross-review',
    '{"text":"Coding perspective on the security analysis: the immutable-data approach naturally enforces query-layer isolation.","domain":"coding","reviewedExpert":"Claude Sonnet"}'::jsonb,
    1.00, NULL, '[]'::jsonb,
    1100, 400, 220, 0.018, NOW()
  ),
  -- Coordinator synthesis (round 3)
  (
    '33333333-dddd-dddd-dddd-333333333333',
    '11111111-dddd-eeee-ffff-111111111111',
    3, 'coordinator-Gemini Pro-round-3', 'google/gemini-pro', 'google', 'coordinator',
    'synthesis',
    '{"text":"Final synthesis: implement the feature with immutable data flows and enforce tenant isolation at the query layer. Cross-review confirms these are mutually reinforcing.","schedulerName":"pin-or-quality","decisionReason":"quality-fallback"}'::jsonb,
    1.00, NULL, '[]'::jsonb,
    4900, 2800, 1300, 0.0340, NOW()
  )
ON CONFLICT (id) DO NOTHING;
