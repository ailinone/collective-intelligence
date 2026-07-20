<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Training Data Export — JSONL Schema Contract

**Audience:** model-stack consumers (ailin-1b training pipeline, evaluation jobs, anyone reading the daily JSONL output).

**Producer:** [`api/src/jobs/training-data-export-job.ts`](../src/jobs/training-data-export-job.ts), scheduled at `02:00 UTC` via `node-cron` (override: `FEEDBACK_EXPORT_CRON` env).

**Output directory:** `${FEEDBACK_EXPORT_DIR}` (default `./data/feedback-export`).

---

## Files produced per day

For date `YYYY-MM-DD` (the run date in UTC), the job emits **five** files:

| File | Source table | Granularity | Watermark column |
|------|--------------|-------------|------------------|
| `feedback-outcomes-YYYY-MM-DD.jsonl` | `execution_outcomes` ⨝ `decision_audit` | one record per orchestration outcome | `execution_outcomes.created_at` |
| `feedback-shadow-YYYY-MM-DD.jsonl` | `shadow_evaluations` | one record per shadow-eval pair | `shadow_evaluations.created_at` |
| `feedback-collective-runs-YYYY-MM-DD.jsonl` | `collective_runs` | one record per coordination run | `collective_runs.created_at` |
| `feedback-collective-signals-YYYY-MM-DD.jsonl` | `collective_signals` | one record per per-agent signal | (joined to runs in the same batch) |
| `extraction-manifest-YYYY-MM-DD.json` | — | run summary + checksums | — |

The manifest is a single JSON object (not JSONL) and carries SHA-256 checksums of every JSONL file plus the watermark window covered.

---

## PII contract

The exporter NEVER writes:

- `organization_id` (tenant identifier)
- `user_id` (end-user identifier)
- raw `decision_trace_id` / `request_id` / `run_id` — these are SHA-256+pepper hashed and truncated to 16 hex chars before export

The `decision_rationale` field on collective signals IS exported as-is. PII redaction for that field happens upstream at [`signal-validator.ts`](../src/core/coordination/signal-validator.ts) before the row is persisted, so the rationale on disk is already redacted (12-pattern PII scrubber covering emails, SSNs, credit cards, phone numbers, IPs, tokens, etc.).

The hash pepper is set via `FEEDBACK_HASH_PEPPER` env. There is no default: the export refuses to run when the variable is unset (fail-closed), because a publicly known pepper would make the hashes reversible by dictionary attack. Production should rotate the pepper out of band.

---

## Record schemas

### `feedback-outcomes-*.jsonl`

```jsonc
{
  "trace_id_hash":      "string (16 hex chars)",
  "strategy":           "string (e.g. 'sensitivity-consensus', 'tri-role-collective')",
  "task_type":          "string (defaults to 'general' when null)",
  "complexity":         "low | medium | high",
  "quality_score":      0.0 - 1.0 | null,
  "quality_dimensions": { "<dim>": 0.0 - 1.0 } | null,
  "latency_ms":         "integer",
  "cost_usd":           "number",
  "total_tokens":       "integer",
  "success":            "boolean",
  "feedback_iterations": "integer",
  "models_used":        ["string"],
  "decision_source":    "string | null",
  "input_hash":         "string | null",
  "created_at":         "ISO 8601 timestamp"
}
```

### `feedback-shadow-*.jsonl`

```jsonc
{
  "trace_id_hash":     "string (16 hex chars)",
  "task_type":         "string",
  "complexity":        "low | medium | high",
  "chosen_strategy":   "string",
  "chosen_quality":    "number",
  "shadow_strategy":   "string",
  "shadow_quality":    "number",
  "quality_regret":    "number",
  "winner_strategy":   "string",
  "created_at":        "ISO 8601 timestamp"
}
```

### `feedback-collective-runs-*.jsonl` (F1.5 + F3.3)

```jsonc
{
  "run_id_hash":          "string (16 hex chars) — primary key for joining signals",
  "request_id_hash":      "string (16 hex chars) | null",
  "strategy":             "sensitivity-consensus | tri-role-collective",
  "rounds":               "integer (number of rounds executed)",
  "stop_reason":          "string (converged | max_rounds | accepted | max_turns | no_solver | …)",
  "convergence_score":    0.0 - 1.0,
  "decision_flip_rate":   0.0 - 1.0,
  "dissent":              0.0 - 1.0,
  "total_cost_usd":       "number",
  "total_latency_ms":     "integer",
  "total_tokens":         "integer",
  "final_decision_type":  "string | null",
  "final_confidence":     0.0 - 1.0 | null,
  "config":               { /* CoordinationConfig snapshot at run start */ },
  "metadata":             { /* see below */ },
  "created_at":           "ISO 8601 timestamp"
}
```

`metadata` carries strategy-specific fields:

- **sensitivity-consensus**: `participatingModels`, `criticalVariables`, `dominantSensitivities`, `dissentCount`, `stableVariables`, `unstableVariables`
- **tri-role-collective**: `participatingModels`
- both (when audit trail is on): `collectiveTraceSpans` — full F2.10 trace span array, bounded by `CollectiveTrace.maxSpans` (default 256)

### `feedback-collective-signals-*.jsonl` (F1.5 + F3.3)

One record per agent emission within a run. Join to runs via `run_id_hash`.

```jsonc
{
  "run_id_hash":          "string (16 hex chars) — joins to runs file",
  "round":                "integer (1-indexed)",
  "agent_id":             "string (e.g. 'agent-A' or 'planner-turn-1')",
  "model_id":             "string (e.g. 'openai/gpt-5')",
  "provider_id":          "string (e.g. 'openai')",
  "role":                 "string | null (e.g. 'solver', 'auditor', 'planner', 'expert')",
  "decision_type":        "string (strategy-specific; tri-role uses 'verdict-accept' / 'verdict-revise')",
  "decision_value":       "any JSON (strategy-specific payload)",
  "decision_confidence":  0.0 - 1.0,
  "decision_rationale":   "string | null (PII-redacted upstream)",
  "sensitivities":        [ /* Sensitivity[] — empty for tri-role */ ],
  "latency_ms":           "integer | null",
  "input_tokens":         "integer | null",
  "output_tokens":        "integer | null",
  "cost_usd":             "number | null",
  "created_at":           "ISO 8601 timestamp"
}
```

#### F4.1 audit fields embedded in `decision_value`

For tri-role-collective signals, `decision_value` carries:

```jsonc
{
  "responseText":     "string",
  "verdict":          { "status": "accept|revise", "feedback": "...", "inferred": false } | undefined,
  "schedulerName":    "string (e.g. 'fixed-state-machine')",
  "decisionReason":   "string (e.g. 'turn-1-fixed', 'after-revise', 'after-solver')"
}
```

`schedulerName` and `decisionReason` are the audit substrate for future role-coordinator training: when `ailin-coordinator-1b` (F4.1) replaces the fixed state machine, it emits its own `schedulerName` and the trainer can stratify by which scheduler made the decision.

### `extraction-manifest-*.json`

```jsonc
{
  "extraction_id":  "string (e.g. 'extract-2026-05-04-1714771200000')",
  "extracted_at":   "ISO 8601 timestamp",
  "outcomes":   { "file": "string", "row_count": "integer", "sha256": "string (64 hex)" },
  "shadow":     { "file": "string", "row_count": "integer", "sha256": "string (64 hex)" },
  "collective": {
    "runs":    { "file": "string", "row_count": "integer", "sha256": "string (64 hex)" },
    "signals": { "file": "string", "row_count": "integer", "sha256": "string (64 hex)" }
  },
  "watermarks": {
    "outcomes":   { "start": "ISO 8601", "end": "ISO 8601" },
    "shadow":     { "start": "ISO 8601", "end": "ISO 8601" },
    "collective": { "start": "ISO 8601", "end": "ISO 8601" }
  }
}
```

---

## Watermark semantics

Each stream has a watermark row in `feedback_extraction_state` keyed by `extraction_type` (`outcomes` | `shadow` | `collective`). Each export run extracts rows where `created_at > last_watermark AND created_at <= cutoff`, with `cutoff = now - 1 hour` (the safety margin avoids inflight data).

The watermark advances **only when rows are extracted** (the `if (rows.length > 0)` guard). Empty days do NOT advance the watermark — a quiet Saturday will still be reachable on Monday's run if a row eventually lands with that timestamp.

The `collective` watermark covers BOTH the runs file and the signals file. Signals are pulled by `run_id IN (...)` from the runs page, so a signal can never appear without its parent run in the same batch.

---

## Operations

### Trigger an ad-hoc export

```sh
curl -X POST https://<host>/v1/admin/training-data/export \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

Returns the manifest synchronously (the export is in-process). For large windows the request can take seconds — set a generous client timeout.

### Inspect watermark state

```sh
curl https://<host>/v1/admin/training-data/state \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

### Prometheus metrics

| Metric | Type | Labels |
|--------|------|--------|
| `ailin_dev_training_data_export_duration_seconds` | Histogram | `stream` |
| `ailin_dev_training_data_export_rows_total` | Counter | `stream` ∈ {outcomes, shadow, collective_runs, collective_signals} |
| `ailin_dev_training_data_export_errors_total` | Counter | `stream`, `stage` |

### Disable the cron

Set `FEEDBACK_EXPORT_ENABLED=false` and restart the API container. The job's `runTrainingDataExport()` function remains callable (e.g., via the admin route).

### Enable collective audit trail

Persistence to `collective_runs` + `collective_signals` is gated. Both sensitivity-consensus and tri-role-collective check `CI_COORDINATION_PERSIST_AUDIT === 'true'` at run time. With this flag off, the export will produce empty collective files — coordination still runs, just without DB persistence.

---

## Versioning

This schema is **v1**. Breaking changes require a new file-name suffix (`feedback-collective-runs-v2-*.jsonl`) so consumers don't silently misparse. Additive changes (new optional fields) ship without a version bump but should be announced in the manifest's `version` field once that lands.

Schema source-of-truth: the TypeScript interfaces in [`training-data-export-job.ts`](../src/jobs/training-data-export-job.ts) (`OutcomeRecord`, `ShadowRecord`, `CollectiveRunExportRecord`, `CollectiveSignalExportRecord`, `ExtractionManifest`) — when those change, this doc must be updated in the same commit.
