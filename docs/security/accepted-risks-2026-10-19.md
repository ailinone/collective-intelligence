<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Security — accepted risks register (2026-10-19)

Owner decision of 2026-10-19: **keep and document** the items below. No runtime
change is part of this document — it records accepted risk and pending
hardening, so the next audit starts from a known baseline instead of
rediscovering it.

Source of the findings: the internal security/export audit of 2026-10-03 and
the owner's follow-up decision of 2026-10-19.

---

## 1. `ALLOW_LOCAL_SANDBOX_FALLBACK=true` in the `production` environment

**Where:** GitHub Actions environment `production` (confirmed live via API on
2026-10-03). Consumed at `api/src/runtime/sandbox-factory.ts`
(`shouldEnableLocalBackend()`), which gates the `local` backend of the
`/v1/code/execute` sandbox chain.

**Mechanism:** the execution chain is strictly sequential — `e2b` → `daytona` →
`local` — each backend with its own timeout and circuit breaker. With the flag
true, if BOTH external sandbox providers (E2B, Daytona) fail, the request falls
through to `LocalProcessSandbox`, which executes the caller's code as a local
process **on the API host** instead of an isolated cloud sandbox.

**Why it exists:** continuity of the code-execution feature during provider
outages. Without the fallback, both providers failing means every execution
request fails; with it, the feature degrades instead of dying. The breaker and
per-backend timeout exist precisely to bound the blast radius of a provider
outage.

**Why the owner accepts it in production:**
- Simultaneous failure of both external providers has not been observed; the
  fallback is a last-resort path, not the routine one.
- The alternative (fail-closed) converts a provider outage into a full feature
  outage for paying tenants.
- The exposure is bounded to tenants that execute code through this endpoint,
  and the host process runs with the API's own environment — the same trust
  boundary as the rest of the API process.

**Known exposure (explicitly accepted):** a malicious tenant payload reaching
the local backend would run on the API host with `process.env` visible to that
process. This is the risk being accepted; it is NOT mitigated today.

**Pending hardening (not scheduled, recorded for the next security cycle):**
- Make the production fallback fail-closed by default and require an explicit,
  audited override to enable it.
- The path guard does not use `realpath`; symlink-based traversal remains a
  theoretical bypass for the local backend.

## 2. CodeQL alerts #174–#185 (12 open, false positives)

**Status:** all 12 open alerts are false positives introduced by the
public-repo export, which replaced direct `startsWith` path checks with the
`isPathWithinDirectory` helper — CodeQL's JS query does not recognize the
helper as a path-safety check and flags every call site.

**Why they are accepted instead of "fixed":** reverting to `startsWith` would
make the guard objectively weaker (it mishandles edge cases the helper covers).
Each alert was reviewed with one investigator pass plus two independent
verifications during the 2026-10-03 audit before being classified.

**Residual:** the guard still does not use `realpath` (same note as §1).
Dismissal of the 12 alerts on the public repo (`false positive`, with the
rationale above) is the pending housekeeping action.

## 3. Unreachable-from-owner history in the public mirror (parked)

- `refs/pull/*` on the public mirror keep historical commits accessible; the
  owner cannot delete these refs — only GitHub Support or a repository
  recreation would remove them. Accepted as-is for now.
- A small number of AI-attribution trailers remain in `main` (docs/plans
  files) and two Claude-authored commits remain reachable via closed
  Dependabot PRs. Known, low-severity, parked.

---

*Register authored 2026-10-19. Revisit on the next security cycle or when the
sandbox hardening is scheduled.*
