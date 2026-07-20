# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Feedback Pipeline: CI API → Model-Stack Training Loop

Transforms execution outcomes and shadow evaluations exported from the CI API
into SFT and DPO training data for the model-stack training pipeline.

Pipeline stages:
  1. extract.py  — Validate extraction manifest, read JSONL, verify SHA-256
  2. transform.py — PII filter, quality gates, build SFT/DPO training pairs
  3. load.py     — Register in dataset manifests, write to training directories
"""
