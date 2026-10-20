# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Config-level tests for the 2026-10 v2 recipe (no torch needed)."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from model.configs.model_spec import FullModelConfig

CONFIGS = Path(__file__).resolve().parent.parent


class TestAilinV2:
    def test_loads_and_validates(self) -> None:
        config = FullModelConfig.from_yaml(CONFIGS / "ailin-1b-v2.yaml")
        spec = config.model
        assert spec.name == "ailin-1b-v2"
        assert spec.vocab_size == 131072
        assert spec.max_position_embeddings == 32768
        assert spec.rope_theta == 1_000_000.0
        assert spec.qk_norm is True
        assert spec.num_attention_heads // spec.num_key_value_heads == 2  # GQA 2:1
        assert spec.rope_scaling is None  # native 32k, no post-hoc scaling

    def test_param_count_matches_design(self) -> None:
        config = FullModelConfig.from_yaml(CONFIGS / "ailin-1b-v2.yaml")
        total = config.model.total_params
        # Design: ~1.477B total, ~1.209B non-embedding (see config header).
        assert 1.40e9 < total < 1.55e9
        assert 1.15e9 < config.model.non_embedding_params < 1.28e9

    def test_tokenizer_vocab_matches_model(self) -> None:
        model_cfg = FullModelConfig.from_yaml(CONFIGS / "ailin-1b-v2.yaml")
        tok_path = CONFIGS.parent.parent / "tokenizer" / "configs" / "bpe_128k.yaml"
        with open(tok_path, encoding="utf-8") as f:
            tok = yaml.safe_load(f)
        assert tok["tokenizer"]["vocab_size"] == model_cfg.model.vocab_size
        assert tok["tokenizer"]["max_sequence_length"] == model_cfg.model.max_position_embeddings

    def test_v1_still_loads_unchanged(self) -> None:
        config = FullModelConfig.from_yaml(CONFIGS / "ailin-1b.yaml")
        assert config.model.vocab_size == 32000
        assert config.model.qk_norm is False


class TestYarnSpec:
    def test_yarn_type_accepted(self) -> None:
        config = FullModelConfig.from_yaml(CONFIGS / "ailin-1b-v2.yaml")
        raw = config.model.model_dump()
        raw["rope_scaling"] = {
            "type": "yarn",
            "factor": 4.0,
            "original_max_position_embeddings": 32768,
        }
        spec = FullModelConfig.model_validate({"model": raw}).model
        assert spec.rope_scaling is not None
        assert spec.rope_scaling.type == "yarn"

    def test_bad_scaling_type_rejected(self) -> None:
        with pytest.raises(ValueError, match="type"):
            FullModelConfig.model_validate(
                {
                    "model": {
                        "name": "x",
                        "hidden_size": 64,
                        "num_layers": 2,
                        "num_attention_heads": 4,
                        "num_key_value_heads": 2,
                        "intermediate_size": 128,
                        "vocab_size": 96,
                        "max_position_embeddings": 64,
                        "rope_scaling": {"type": "bogus", "factor": 2.0},
                    }
                }
            )
