<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Troubleshooting

## 1. `401 Unauthorized`

Checks:

- token/key present and valid
- correct header format
- key/token belongs to the expected tenant/org

## 2. `403 Forbidden`

Checks:

- role and permission scope
- tenant and organization boundary
- policy gates and restricted operations

## 3. `429 Too Many Requests`

Checks:

- request burst above limits
- tenant quota exhaustion
- missing backoff in client

Actions:

- add retry with exponential backoff + jitter
- reduce concurrency
- move heavy workloads to batch/asynchronous flows

## 4. `502/503` on model execution

Checks:

- provider health and operability
- transient upstream incidents
- overloaded strategy path

Actions:

- retry with bounded attempts
- verify fallback chain behavior
- inspect request/correlation IDs in logs

## 5. Empty or low-quality response

Checks:

- selected strategy too cost/latency biased
- insufficient capabilities in constraints
- prompt/context quality

Actions:

- raise `quality_target`
- use `ailin-best` or consensus-quality profile
- revise required capabilities and context inputs

## 6. OpenAPI validation failures

Run:

```bash
npm -C ci run check:openapi
```

Fix schema incompatibilities before publishing docs artifacts.
