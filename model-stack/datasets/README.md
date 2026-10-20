<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# model-stack/datasets/ — data assets, NOT a Python package

This directory stores dataset manifests (YAML) and future data-asset metadata
(`lineage/`, `quality/`, `registry/`). It is consumed by filesystem globs,
e.g. the "Validate dataset manifests" gate in
`.github/workflows/model-stack-ci.yml`.

**Do not add `__init__.py` here (2026-10-18).** A regular package named
`datasets/` on the interpreter path SHADOWS the HuggingFace `datasets`
library that the training/eval code imports (`from datasets import
load_dataset`): Python resolves the local package first, so every such
import breaks at runtime with `AttributeError` and mypy reports a wall of
`Module "datasets" has no attribute "load_dataset"` errors. That exact
shadowing was created (and reverted) during the 2026-10-18 lint-debt
cleanup — see the PR that touched this README.
