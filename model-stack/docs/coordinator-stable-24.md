<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Coordinator Stable 24 — Architecture

**Status**: Phase 1 (Foundations). Configs + cascade aggregator + CI client landed.
Training, serving, and live integration are Phase 2+.

## What this is

A **24-model ensemble** that replaces the heuristic role/scheduler decisions
made today by `triage-service.ts`, `decideRoleForTurn`, `assignModeratorRole`,
`selectPanel`, and friends in `api/src/core/orchestration/strategies/`.

The ensemble is structured as a **6-tier speculative cascade**:

```
                  │ Encoder │ Dense ≤1B │ Dense 1-3B │ Dense 3-9B │ MoE Light │ MoE Heavy │
   ──────────────┼─────────┼───────────┼────────────┼────────────┼───────────┼───────────┤
   Generalist    │   m01   │   m05     │   m09      │   m13      │   m17     │   m21     │
   Code          │   m02   │   m06     │   m10      │   m14      │   m18     │   m22     │
   Reasoning     │   m03   │   m07     │   m11      │   m15      │   m19     │   m23     │
   Routing/Safety│   m04   │   m08     │   m12      │   m16      │   m20     │   m24     │
```

Tier 1 (encoders, ~5ms) decides 70-80% of requests alone via confidence
threshold. Only ambiguous cases escalate through Tier 2-6.

Full per-model selection rationale, license, and serving profile lives in
[`registry/models/coordinator-stable.yaml`](../registry/models/coordinator-stable.yaml).

## Why 24 models instead of 1

The CI orchestration platform's core thesis is that *N models cooperating
beat 1 monolithic model*. Applying that recursively to the coordinator layer
is consistent with the philosophy. The 24-stable matrix gives us:

- **6 architectural classes** × **4 specialties** — broad coverage
- **13 distinct model families** — minimizes correlated errors
- **6 decision tiers** — speculative execution avoids paying for premium
  inference on easy decisions
- **22/24 fully open** (Apache 2.0 / MIT) — minimal license fragility
- **Robustness up to 11 simultaneous wrong votes** out of 24 (majority of 24 = 13)

## Why MoE models in the stable

Including OLMoE-1B-7B (m17), Qwen1.5-MoE (m18), JetMoE-8B (m19),
DeepSeek-V2-Lite (m20), Mixtral-8x7B (m21), DeepSeek-Coder-V2 (m22),
Phi-3.5-MoE (m23), and DBRX-base (m24) makes the architecture **fractal**:

- Outer ensemble: 24 coordinators voting (this stable)
- Inner ensemble (within each MoE coordinator): 8-64 experts routed by their
  internal router
- A single Tier 5/6 vote already incorporates a sub-ensemble decision

This matches the existing `sensitivity-consensus-strategy` and
`tri-role-collective-strategy` patterns at the execution layer — same idea,
applied one level above.

## Phase plan

| Phase | Scope | Status |
|-------|-------|--------|
| 1. Foundations | Catalog, configs, aggregator, client types | **DONE** |
| 2. Training pipeline | Distillation from F3.3, LoRA SFT, MoE LoRA | TODO |
| 3. Train 24 models | Parallel SFT runs ($10K-$25K) | TODO |
| 4. Wire into CI | Plug `ensemble-coordinator-client` into 5 strategies | TODO |
| 5. Champion-challenger continuous | Rotate poor performers via flywheel | TODO |

## Architecture: cascade execution

The cascade is implemented in
[`serving/aggregation/tiered_voter.py`](../serving/aggregation/tiered_voter.py).
Pseudocode of the production flow:

```
1. Strategy makes a decision request (e.g. "next role for tri-role turn 3")
2. Client posts EnsembleDecisionRequest to model-stack aggregator
3. Aggregator runs Tier 1 (encoders) — 4 votes back in ~5ms
4. If running confidence ≥ 0.85 AND dissent ≤ 2 → exit with Tier-1 result
5. Else escalate to Tier 2 (4 dense ≤1B votes, ~50ms more)
6. Repeat threshold check; escalate if needed
7. Tier 6 (MoE Heavy) is the floor — always runs to completion when reached
8. Final decision: weighted Bayesian majority across all activated tiers
```

### Vote weighting

Each vote contributes `tier_weight × confidence × accuracy_history` to its
chosen role. The "anchor" tier (Tier 4, dense 3-9B) carries the highest tier
weight (0.25); MoE Heavy (Tier 6) is bounded at 0.10 specifically so it
never single-handedly overrides the consensus of lower tiers.

### Dissent handling

When dissent (count of disagreeing votes) exceeds the threshold, the
aggregator can choose between:

- `weighted_bayesian_majority` (default): proceed with weighted vote
- `dissent_aware_synthesis`: escalate to Tier 6 LLM-synthesis for tie-breaking

Both produce an `AggregatedEnsembleDecision` with full audit substrate.

## Audit substrate (F4.1 alignment)

Every ensemble decision lands in `collective_signals.decision_value` JSONB
exactly as today, but with a richer payload:

```jsonc
{
  "responseText": "...",                          // strategy-specific
  "schedulerName": "ensemble-24-tiered-bayesian", // identifies the aggregator
  "decisionReason": "task-type-match",            // most common reason among winners
  "ensembleMetadata": {
    "role": "auditor",
    "confidence": 0.92,
    "aggregationMethod": "weighted_bayesian_majority",
    "tierResults": [
      { "tier": 1, "votes": [...4...], "majorityRole": "auditor", "dissentCount": 0 },
      { "tier": 2, "votes": [...4...], "majorityRole": "auditor", "dissentCount": 1 }
      // tiers 3-6 not activated (short-circuited)
    ],
    "voteDistribution": { "auditor": 7, "solver": 1 },
    "totalVotes": 8,
    "dissentCount": 1,
    "tiersActivated": [1, 2],
    "finalTier": 2,
    "shortCircuited": true
  }
}
```

This shape flows unchanged through:

1. `collective_signals.decision_value` (Postgres JSONB)
2. F3.3 export pipeline (JSONL via training-data-export-job)
3. Future learned coordinator training (`alignment/sft/train_sft_coord.py`)

The vote distribution becomes training signal: **when 24 models disagreed,
which one was right?** The `flywheel/replay/` infrastructure consumes this
to selectively retrain the worst performers.

## License posture

| License | Models | Notes |
|---------|--------|-------|
| Apache 2.0 | m01, m04, m05-m11, m13-m14, m17-m19, m21 | No restrictions for this use |
| MIT | m02-m03, m15, m16, m20, m22-m23 | Permissive |
| Llama-3 | m12 | Free <700M MAU; commercial review |
| Databricks Open | m24 | Restricts uses competing with Databricks; cold-fallback only |

22/24 models are fully open. The two with caveats (m12 Llama-3.2-1B, m24
DBRX-base) are positioned as cold-fallback or rotational — neither carries
the load on the hot path, so they're easy to swap out if licensing changes.

## File map

```
model-stack/
  registry/models/
    coordinator-stable.yaml               # 24-model registry (single source of truth)
  model/configs/coord-stable/
    _shared.yaml                          # shared defaults
    m01.yaml ... m24.yaml                 # per-model overrides
  serving/aggregation/
    __init__.py
    tiered_voter.py                       # cascade aggregator (Python)
  docs/
    coordinator-stable-24.md              # this file

api/src/core/coordination/
  ensemble-coordinator-types.ts           # TypeScript types (mirror Python shapes)
  ensemble-coordinator-client.ts          # HTTP client + result discriminated union
```

## Integration with the existing F4.1 substrate

The ensemble is designed to be a **drop-in replacement** for any of the
five strategy decision points already auditable today:

| Existing decision | Strategy | Ensemble call replaces |
|-------------------|----------|------------------------|
| `decideRoleForTurn(turn, transcript)` | tri-role-collective | `EnsembleDecisionRequest({decisionType: 'role-for-turn'})` |
| `assignModeratorRole(participants, ctx)` | debate | `decisionType: 'moderator-selection'` |
| `selectPanel(models, domains, ctx)` | expert-panel | `decisionType: 'panel-composition'` |
| Coordinator selection inline | consensus | `decisionType: 'synthesis-coordinator'` |
| Candidate selection | parallel-race | `decisionType: 'race-candidates'` |

The strategies' RoleDecision shape (role + scheduler + reason + confidence)
is preserved — `liftEnsembleDecisionToAuditShape()` extracts those four
fields, and the ensemble metadata lands in the existing JSONB `decisionValue`.

When `CI_ENSEMBLE_COORDINATOR_ENABLED=false` (default), strategies use the
heuristics they use today. When `true`, they call the ensemble first and
fall back to heuristics on error if `CI_ENSEMBLE_COORDINATOR_FALLBACK_ON_ERROR`
is true (default).

A `shadowMode` flag runs both paths simultaneously (heuristic drives
execution, ensemble decision is logged for offline comparison) so we can
validate the ensemble before flipping it on for real traffic.

## Operational targets (Phase 2+)

| Metric | Target |
|--------|--------|
| Median latency per decision | ≤80ms (Tier 1 short-circuits ~75% of requests) |
| P99 latency | ≤2s (Tier 6 worst case) |
| VRAM steady-state (Tiers 1-3) | ≤6GB int4 |
| VRAM peak (full Tier 6 active) | ≤190GB int4 |
| Total training cost (24 LoRA distill) | $10K-$25K |
| Decision accuracy vs triage-service shadow | ≥90% |
| Calibration Brier score | ≤0.10 |

## Risks

| Risk | Mitigation |
|------|------------|
| Vote correlation (models concord errado juntos) | 13 distinct architectural families |
| Drift between models | Weekly champion-challenger refresh |
| Inference cost grows with stable | Tiered cascade: Tier 1 alone for ~75% of requests |
| Bug replication across 24 jobs | LoRA pipeline tested on m01 first; replicated only after green |
| Storage of checkpoints | 24 × ~1GB LoRA adapters = 24GB. Trivial. |
