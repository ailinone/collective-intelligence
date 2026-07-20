<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Changelog

All notable changes to the public repository are documented here.
The project is **pre-1.0**: minor versions may include breaking changes,
each called out explicitly below until a compatibility policy ships with 1.0.

## [0.1.0] — first public release (2026-07)

Initial open-source publication under AGPL-3.0-or-later:

- OpenAI-compatible API surface (chat, responses, embeddings, images, files)
  in front of ~90 providers with health-gated dynamic discovery.
- 32 registered orchestration strategies plus the `ailin-auto` cascade,
  with full decision provenance in `ailin_metadata`.
- The July 2026 collective-vs-frontier benchmark: report, raw per-execution
  CSVs, and the analysis scripts that regenerate every published table
  (`reports/experiments/`, `docs/experiments/REPRODUCING_THE_BENCHMARK.md`).
- AGPL §13 tooling: `/source` and `/license` endpoints,
  `X-License`/`X-Source-Code`/`X-Copyright` response headers, REUSE-compliant
  license metadata, SPDX headers across the tree.
- Governance: DCO sign-off, Contributor Covenant 2.1, security policy,
  SLSA/Sigstore release provenance with a fail-closed SPDX SBOM.
