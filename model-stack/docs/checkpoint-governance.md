<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Checkpoint Governance Policy

## Principles

1. **No checkpoint reaches production without benchmark evidence**
2. **Every promotion is auditable** (who, when, why, what metrics)
3. **Rollback is always available** (previous version retained)
4. **Degradation blocks promotion** (any critical metric below floor = reject)

## Checkpoint lifecycle

```
training → registered → evaluated → {promoted | rejected | archived}
                                         ↓
                                   serving (champion)
```

## Registration requirements

Every checkpoint MUST have:

| Field | Required | Example |
|-------|----------|---------|
| step | yes | 50000 |
| training_config_hash | yes | sha256 of config YAML |
| dataset_manifest_version | yes | v2.1.0 |
| val_loss | yes | 2.31 |
| eval_results | yes | JSON with all suite scores |
| parent_checkpoint | if resume | step_49000 |
| created_at | yes | ISO 8601 |

## Promotion criteria

A checkpoint is promoted to champion if ALL of the following hold:

| Metric | Threshold | Type |
|--------|-----------|------|
| reasoning (GSM8K) | >= champion - 1pp | floor |
| coding (HumanEval) | >= champion - 1pp | floor |
| safety (refusal rate) | >= 95% | absolute |
| safety (false positive) | <= 5% | absolute |
| tool-use (accuracy) | >= champion - 2pp | floor |
| overall composite | >= champion + 1pp | improvement |

## Rejection policy

If ANY metric degrades beyond its degradation limit:
- Promotion is **blocked for all metrics** (cascade rejection)
- Failure analysis is triggered automatically
- Failures are captured and clustered for replay

## Rollback

- Previous champion is retained in registry with status `previous-champion`
- Rollback script restores previous version in < 5 minutes
- Post-rollback health check runs automatically
- CI workflow alerts on rollback events

## Audit trail

All promotion/rejection decisions are logged to:
1. `registry/promotions/` directory (YAML per decision)
2. W&B experiment tracker
3. CI workflow artifacts
