<!--
Copyright (C) 2026 Ailin One, Inc.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Third-party notices

The engine depends on 1439 production npm packages (api workspace,
generated with `pnpm licenses list` on 2026-07-19, lockfile-pinned).
**Every license found is compatible with AGPL-3.0-or-later distribution**:
permissive licenses dominate, dual-licensed packages are consumed under
their permissive option, and the single LGPL-3.0-or-later component is
dynamically linked in the AGPL-compatible sense.

| License | Packages |
|---|---|
| MIT | 988 |
| Apache-2.0 | 283 |
| ISC | 54 |
| BSD-3-Clause | 52 |
| BSD-2-Clause | 17 |
| BlueOak-1.0.0 | 11 |
| Unknown | 6 |
| Artistic-2.0 | 5 |
| MIT-0 | 3 |
| Unlicense | 3 |
| CC0-1.0 | 2 |
| MIT/X11 | 2 |
| Apache-2.0 AND LGPL-3.0-or-later | 1 |
| Apache-2.0 AND MIT | 1 |
| Python-2.0 | 1 |
| (MIT OR WTFPL) | 1 |
| (AFL-2.1 OR BSD-3-Clause) | 1 |
| (MIT OR GPL-3.0-or-later) | 1 |
| (BSD-3-Clause OR GPL-2.0) | 1 |
| (WTFPL OR MIT) | 1 |
| (MIT AND Zlib) | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| 0BSD | 1 |
| (MIT OR CC0-1.0) | 1 |
| BSD | 1 |

Packages reporting no machine-readable license metadata (manually reviewed;
follow-up tracked to upstream a license declaration):

- `@anthropic-ai/claude-agent-sdk@0.2.42`
- `ansi-color@0.2.1`
- `buffers@0.1.1`
- `graphmatch@1.1.0`
- `sylvester@0.0.12`
- `union@0.5.0`

Prisma query-engine WASM binaries shipped under `api/src/generated/` are
**Apache-2.0, © Prisma Data, Inc. and contributors** (see `REUSE.toml` and
`LICENSES/Apache-2.0.txt`).

Python dependencies of `model-stack/` are declared in
`model-stack/pyproject.toml`; the training stack is optional for running
the engine and its dependency licenses are reviewed before any release
that bundles it.
