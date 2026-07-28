<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Contributing to Collective Intelligence Engine

Thanks for considering a contribution! This document covers the legal
requirements and the practical workflow.

## Legal requirements (read first)

1. **License.** The project is licensed under **AGPL-3.0-or-later** (see
   `LICENSE`). By contributing you agree your contribution will be distributed
   under those terms.

2. **DCO.** Every commit must be signed off under the
   **[Developer Certificate of Origin](DCO.md)** (DCO 1.1). Add the sign-off
   with `git commit -s`, which appends a `Signed-off-by: Your Name
   <your@email>` trailer. The sign-off certifies you wrote the change or have
   the right to submit it under the project license — CI rejects commits
   without it. Questions about licensing (including commercial licensing)
   go to licensing@ailin.one.

3. **License headers.** Every new source file must carry the project's
   SPDX/copyright header. Don't write it by hand — run:

   ```bash
   node scripts/add-copyright-headers.mjs        # inserts where missing
   node scripts/add-copyright-headers.mjs --check # what CI runs
   ```

   CI fails any PR that introduces a header-less source file.

4. **Provenance.** Only submit work you wrote or have the right to submit.
   Third-party code (including AI-assisted output you cannot vouch for line by
   line) must be flagged in the PR description with its origin and license.

## Practical workflow

1. **Discuss first** for anything non-trivial: open an issue describing the
   problem and your proposed approach before writing code.
2. **Branch** from `main`; use a descriptive branch name (`fix/...`,
   `feat/...`).
3. **Develop** — see `docs/getting-started/installation.md` for local setup.
   TypeScript API code lives in `api/`; run checks locally:

   ```bash
   cd api && npx tsc --noEmit   # typecheck
   cd api && npm test           # vitest
   ```

4. **Keep commits clean** — one logical change per commit; explain *why* in the
   commit body when it isn't obvious.
5. **Open the PR** — describe what changes, why, and how it was tested. The PR
   must pass: typecheck, tests, the SPDX-header gate, and REUSE lint.
6. **Review** — maintainers review for correctness, security, and fit. Expect
   requests for changes; that's normal.

## Language policy

English is the canonical language for code, docs, issues, and PRs.
Translations (including pt-BR) are welcome **with a named owner** who commits
to keeping them in sync — a translation PR must add a sync marker (source
commit hash) to the translated file. Unowned translations are not merged:
stale docs are worse than absent ones.

## Security issues

**Never** open a public issue for a vulnerability — follow
[SECURITY.md](SECURITY.md) instead.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md) (v2.1).
Report unacceptable behavior to conduct@ailin.one.
