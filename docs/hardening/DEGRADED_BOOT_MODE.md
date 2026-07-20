<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Degraded Boot Mode — Self-Hosted Fallback at Startup

## Problem

Prior to this change, the server would crash-loop when:
- `SECRETS_PROVIDER_PRIMARY=gcp` is set
- Google ADC token is expired (`invalid_rapt`), service account is missing,
  or GCP Secret Manager is unreachable during boot
- No `LLM_PROVIDER_*_API_KEY` env vars are set as local fallback

Symptoms observed:
- Container restart every 3s with exit code 1
- ~5M log lines per restart cycle from the secrets-loader retry loop
- No actionable error message — just `Secret retrieval failed, trying next provider` spam
- Operators waste 10+ minutes chasing the wrong root cause (memory, code bug, etc.)

## Solution

The boot check in `api/src/config/load-secrets-into-env.ts::loadSecretsIntoEnv()`
now evaluates three states:

### State 1 — External keys loaded (normal)
- One or more `LLM_PROVIDER_ENV_VARS` have values
- Behavior: boot normally, all providers available

### State 2 — Zero external keys, self-hosted available (NEW: degraded boot)
- Zero external keys loaded
- At least one of `SELF_HOSTED_ENV_VARS` has a value:
  - `OLLAMA_URL`
  - `SELF_HOSTED_LLM_URL`
  - `LOCAL_LLAMA_URL`
  - `LOCAL_KOBOLD_URL`
- `ALLOW_DEGRADED_BOOT` is not `false` (default: allowed)
- Behavior: boot with WARN log `⚠️ DEGRADED BOOT` — server comes up. Every
  subsequent chat request is routed through the last-resort policy
  (`api/src/core/resilience/last-resort-policy.ts`), tagged as:
  - `execution_mode: last_resort_self_hosted`
  - `degraded: true`
  - `external_pool_exhausted: true`
  - `excluded_from_benchmark: true`

### State 3 — Zero external keys, no self-hosted, or degraded disabled
- Zero external keys AND no self-hosted endpoint configured, OR
- `ALLOW_DEGRADED_BOOT=false` is explicitly set for strict production
- Behavior: `throw new Error(...)` — fail fast with actionable message:
  > Verify GCP Secret Manager access (ADC/Workload Identity) and secret
  > names/prefix, or set OLLAMA_URL for degraded self-hosted boot, or run
  > 'gcloud auth application-default login' if local.

## Environment variables

### Self-hosted fallback endpoints
| Variable | Purpose |
|----------|---------|
| `OLLAMA_URL` | Ollama instance (e.g., `http://host.docker.internal:11434`) |
| `SELF_HOSTED_LLM_URL` | Generic self-hosted OpenAI-compatible endpoint |
| `LOCAL_LLAMA_URL` | llama.cpp server |
| `LOCAL_KOBOLD_URL` | KoboldCpp server |

Only ONE needs to be set for degraded boot to succeed.

### Control variables
| Variable | Default | Meaning |
|----------|---------|---------|
| `ALLOW_DEGRADED_BOOT` | `true` | `false` to disable degraded boot (strict prod) |
| `SECRETS_PROVIDER_PRIMARY` | - | If `gcp`, triggers the fail-fast check |
| `SECRETS_GCP_FAIL_FAST` | auto | Explicitly override fail-fast behavior |

## Recommendations by environment

### Local development
```bash
# In .env:
OLLAMA_URL=http://host.docker.internal:11434
# OR the gateway if you use it:
# OLLAMA_URL=http://gateway:11434

# The server will boot even when ADC expires. You'll see a WARN
# instead of a crash loop, and your chat requests fall back to Ollama.
```

### Staging
```bash
# Same as local, plus at least one real API key:
OPENAI_API_KEY=sk-...
OLLAMA_URL=http://host.docker.internal:11434

# Best of both worlds: real provider for quality, Ollama for resilience.
```

### Production (strict mode)
```bash
# If you absolutely cannot tolerate degraded boot:
ALLOW_DEGRADED_BOOT=false

# The server will refuse to boot without external keys, matching the
# pre-hardening behavior. Use only when runbook requires "no execution
# at all" over "degraded execution".
```

### Production (typical, recommended)
```bash
# Don't set ALLOW_DEGRADED_BOOT — let the default (true) apply.
# If GCP Secret Manager fails at boot (rare), the server still comes up
# degraded and ops gets paged. Beats a crash loop.
SECRETS_PROVIDER_PRIMARY=gcp
# (Self-hosted endpoint NOT recommended in prod unless intentional)
```

## How this relates to the broader hardening work

This closes a gap in the **self-hosted last-resort policy**:
- Before: last-resort worked PER REQUEST when pool was empty
- After: last-resort ALSO works AT BOOT when zero external keys load

The per-request policy in `last-resort-policy.ts` is unchanged — it still
tags `execution_mode`, still excludes from benchmark metrics. What's new is
that the server can reach a state where per-request last-resort is the
primary execution path.

## Recovery from degraded boot

When you see the `⚠️ DEGRADED BOOT` warning:

1. **Don't panic — requests still work** (via self-hosted)
2. **Check ADC status** (most common cause locally):
   ```bash
   gcloud auth application-default print-access-token
   # If it errors with invalid_rapt:
   gcloud auth application-default login
   docker restart ci-api
   ```
3. **Check GCP Secret Manager access** (prod):
   ```bash
   # Verify service account has secretmanager.secretAccessor role
   gcloud secrets list --project=<your-gcp-project> | head -5
   ```
4. **Check env var loading order** (if using .env files):
   ```bash
   # Ensure SECRETS_PROVIDER_PRIMARY is not accidentally 'gcp' in dev
   grep SECRETS_PROVIDER_PRIMARY .env .env.local
   ```

## Observability

The degraded boot state is visible via:

1. **Boot log** — grep for `DEGRADED BOOT`:
   ```bash
   docker logs ci-api 2>&1 | grep -i "DEGRADED BOOT"
   ```

2. **Request metadata** — every response carries:
   ```json
   {
     "ailin_metadata": {
       "execution_mode": "last_resort_self_hosted",
       "degraded": true
     }
   }
   ```

3. **DB analytics** — `experiment_executions.structured_metadata`:
   ```sql
   SELECT COUNT(*) FROM experiment_executions
   WHERE structured_metadata->>'execution_mode' = 'last_resort_self_hosted';
   ```
