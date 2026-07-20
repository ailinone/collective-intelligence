# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Tests for train_sft_coord.py — coord-yaml → SFT trainer wiring.

Covers:
- YAML inheritance resolution (_shared.yaml + m{NN}.yaml deep-merge)
- Translation to SFT trainer schema (every required block present)
- Filter by tier / specialty
- Generated config file writing
- Trainer invocation via injected runner (no real subprocess in tests)
- CLI smoke (dry-run path)
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest
import yaml

# ---------------------------------------------------------------------------
# Minimal fake config fixtures
# ---------------------------------------------------------------------------

SHARED_FAKE = """\
fine_tune:
  method: lora
  rank: 16
  alpha: 32
  target_modules:
    - q_proj
    - v_proj
training:
  num_epochs: 3
  learning_rate: 2.0e-4
  micro_batch_size: 4
  precision: bfloat16
  flash_attention_2: true
  max_seq_length: 2048
data:
  validation_split: 0.05
"""

M01_FAKE = """\
inherits: "_shared.yaml"
model_id: m01
display_name: Coord M01 (test)
base_model: answerdotai/ModernBERT-base
architecture: encoder_only
family: modernbert
tier: 1
specialty: generalist
fine_tune:
  rank: 8
  target_modules:
    - query
    - key
    - value
training:
  num_epochs: 5
"""

M13_FAKE = """\
inherits: "_shared.yaml"
model_id: m13
base_model: meta-llama/Llama-3.2-3B-Instruct
architecture: decoder_only
family: llama
tier: 4
specialty: code
"""


@pytest.fixture
def fake_config_dir(tmp_path: Path):
    cfg_dir = tmp_path / "coord-stable"
    cfg_dir.mkdir()
    (cfg_dir / "_shared.yaml").write_text(SHARED_FAKE, encoding="utf-8")
    (cfg_dir / "m01.yaml").write_text(M01_FAKE, encoding="utf-8")
    (cfg_dir / "m13.yaml").write_text(M13_FAKE, encoding="utf-8")
    return cfg_dir


# ---------------------------------------------------------------------------
# Inheritance loader
# ---------------------------------------------------------------------------


class TestLoadCoordConfig:
    def test_child_inherits_parent_defaults(self, fake_config_dir):
        from alignment.sft.train_sft_coord import load_coord_config

        merged = load_coord_config("m13", config_dir=fake_config_dir)

        assert merged["model_id"] == "m13"
        assert merged["base_model"] == "meta-llama/Llama-3.2-3B-Instruct"
        # Inherited from _shared
        assert merged["fine_tune"]["rank"] == 16
        assert merged["fine_tune"]["alpha"] == 32
        assert merged["training"]["num_epochs"] == 3

    def test_child_overrides_parent_dict_leaves(self, fake_config_dir):
        from alignment.sft.train_sft_coord import load_coord_config

        merged = load_coord_config("m01", config_dir=fake_config_dir)

        # Child overrides rank but inherits alpha
        assert merged["fine_tune"]["rank"] == 8
        assert merged["fine_tune"]["alpha"] == 32
        # Child overrides epochs
        assert merged["training"]["num_epochs"] == 5
        assert merged["training"]["learning_rate"] == 2.0e-4

    def test_child_replaces_parent_lists(self, fake_config_dir):
        from alignment.sft.train_sft_coord import load_coord_config

        merged = load_coord_config("m01", config_dir=fake_config_dir)

        # Child target_modules fully replaces parent list, not concat
        assert merged["fine_tune"]["target_modules"] == ["query", "key", "value"]

    def test_missing_config_raises(self, fake_config_dir):
        from alignment.sft.train_sft_coord import load_coord_config

        with pytest.raises(FileNotFoundError):
            load_coord_config("m99", config_dir=fake_config_dir)


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------


class TestTranslateToSftConfig:
    def test_all_required_sections_present(self, fake_config_dir):
        from alignment.sft.train_sft_coord import (
            TranslationOptions,
            load_coord_config,
            translate_to_sft_config,
        )

        coord = load_coord_config("m13", config_dir=fake_config_dir)
        options = TranslationOptions(
            data_dir=Path("/fake/data"),
            checkpoint_root=Path("/fake/ckpt"),
        )
        sft = translate_to_sft_config(coord, options=options)

        for section in (
            "model",
            "data",
            "training",
            "lora",
            "checkpointing",
            "evaluation",
            "logging",
            "merge",
        ):
            assert section in sft, f"missing section: {section}"
        assert sft["run_name"] == "coord-stable-m13"
        assert sft["model"]["base_model"] == "meta-llama/Llama-3.2-3B-Instruct"
        assert sft["data"]["dataset_path"].replace("\\", "/") == "/fake/data"
        assert sft["checkpointing"]["output_dir"].replace("\\", "/") == "/fake/ckpt/m13"
        assert sft["lora"]["enabled"] is True
        assert sft["lora"]["task_type"] == "CAUSAL_LM"

    def test_encoder_arch_maps_to_seq_cls_task(self, fake_config_dir):
        from alignment.sft.train_sft_coord import (
            load_coord_config,
            translate_to_sft_config,
        )

        coord = load_coord_config("m01", config_dir=fake_config_dir)
        sft = translate_to_sft_config(coord)

        assert sft["lora"]["task_type"] == "SEQ_CLS"
        assert sft["lora"]["target_modules"] == ["query", "key", "value"]

    def test_lora_rank_inherits_from_child(self, fake_config_dir):
        from alignment.sft.train_sft_coord import (
            load_coord_config,
            translate_to_sft_config,
        )

        coord = load_coord_config("m01", config_dir=fake_config_dir)
        sft = translate_to_sft_config(coord)

        assert sft["lora"]["r"] == 8
        assert sft["lora"]["lora_alpha"] == 32

    def test_real_coord_stable_configs_translate(self):
        """Sanity: every real m*.yaml in the repo translates without errors."""
        from alignment.sft.train_sft_coord import (
            COORD_CONFIG_DIR,
            discover_model_ids,
            load_coord_config,
            translate_to_sft_config,
        )

        ids = discover_model_ids(COORD_CONFIG_DIR)
        assert len(ids) >= 1, "no coord configs found"
        for mid in ids:
            coord = load_coord_config(mid, COORD_CONFIG_DIR)
            sft = translate_to_sft_config(coord)
            assert sft["run_name"] == f"coord-stable-{mid}"
            assert sft["model"]["base_model"]


# ---------------------------------------------------------------------------
# Filter by tier / specialty
# ---------------------------------------------------------------------------


class TestFilters:
    def test_tier_filter(self, fake_config_dir):
        from alignment.sft.train_sft_coord import filter_by_tier_and_specialty

        result = filter_by_tier_and_specialty(
            ["m01", "m13"],
            tier=1,
            specialty=None,
            config_dir=fake_config_dir,
        )
        assert result == ["m01"]

    def test_specialty_filter(self, fake_config_dir):
        from alignment.sft.train_sft_coord import filter_by_tier_and_specialty

        result = filter_by_tier_and_specialty(
            ["m01", "m13"],
            tier=None,
            specialty="code",
            config_dir=fake_config_dir,
        )
        assert result == ["m13"]

    def test_combined_filter(self, fake_config_dir):
        from alignment.sft.train_sft_coord import filter_by_tier_and_specialty

        # tier 4 + specialty generalist → empty
        result = filter_by_tier_and_specialty(
            ["m01", "m13"],
            tier=4,
            specialty="generalist",
            config_dir=fake_config_dir,
        )
        assert result == []


# ---------------------------------------------------------------------------
# Trainer invocation (no real subprocess)
# ---------------------------------------------------------------------------


class TestInvokeTrainer:
    def test_calls_runner_with_expected_args(self, tmp_path):
        from alignment.sft.train_sft_coord import invoke_trainer

        captured = {}

        @dataclass
        class FakeResult:
            returncode: int = 0

        def fake_runner(cmd, **kw):
            captured["cmd"] = cmd
            captured["kw"] = kw
            return FakeResult(returncode=0)

        cfg = tmp_path / "fake.yaml"
        cfg.write_text("dummy", encoding="utf-8")
        result = invoke_trainer(cfg, runner=fake_runner)

        assert result.returncode == 0
        assert "alignment.sft.train_sft" in captured["cmd"]
        assert "--config" in captured["cmd"]
        assert str(cfg) in captured["cmd"]
        assert captured["kw"]["check"] is False
        assert captured["kw"]["text"] is True


# ---------------------------------------------------------------------------
# CLI dry-run
# ---------------------------------------------------------------------------


class TestCli:
    def test_cli_dry_run_one_model(self, fake_config_dir, tmp_path, monkeypatch):
        from click.testing import CliRunner

        import alignment.sft.train_sft_coord as mod

        # Point CLI at the fake config dir + tmp output for generated configs
        monkeypatch.setattr(mod, "COORD_CONFIG_DIR", fake_config_dir)
        monkeypatch.setattr(mod, "DEFAULT_GENERATED_CONFIG_DIR", tmp_path / "_generated")
        monkeypatch.setattr(mod, "DEFAULT_DATA_DIR", tmp_path / "data")
        monkeypatch.setattr(mod, "DEFAULT_CHECKPOINT_ROOT", tmp_path / "ckpt")

        runner = CliRunner()
        result = runner.invoke(mod.cli, ["--model-id", "m01", "--dry-run"])

        assert result.exit_code == 0, result.output
        # Generated config file exists
        gen = tmp_path / "_generated" / "coord-stable-m01.yaml"
        assert gen.exists()
        # Verify it parses as YAML and has the expected base_model
        parsed = yaml.safe_load(gen.read_text(encoding="utf-8"))
        assert parsed["model"]["base_model"] == "answerdotai/ModernBERT-base"

    def test_cli_filter_returns_no_runs(self, fake_config_dir, tmp_path, monkeypatch):
        from click.testing import CliRunner

        import alignment.sft.train_sft_coord as mod

        monkeypatch.setattr(mod, "COORD_CONFIG_DIR", fake_config_dir)

        runner = CliRunner()
        result = runner.invoke(mod.cli, ["--all", "--tier", "99", "--dry-run"])

        assert result.exit_code == 0
        assert "No coordinators matched" in result.output

    def test_cli_requires_target(self, fake_config_dir, tmp_path, monkeypatch):
        from click.testing import CliRunner

        import alignment.sft.train_sft_coord as mod

        monkeypatch.setattr(mod, "COORD_CONFIG_DIR", fake_config_dir)

        runner = CliRunner()
        result = runner.invoke(mod.cli, [])

        assert result.exit_code != 0
        assert "--model-id" in result.output or "--all" in result.output
