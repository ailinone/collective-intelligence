# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Architecture tests for the 2026-10 SOTA changes.

Runs wherever torch is installed (CI unit-tests job on the self-hosted
runner; the local lint env has no torch by design).

Covers:
  - SDPA == manual-math equivalence (incl. GQA)
  - cached incremental decode == full forward (RoPE position fix)
  - QK-norm forward shapes
  - YaRN / linear RoPE scaling
  - from_config wiring of the new keys
"""

from __future__ import annotations

import pytest

torch = pytest.importorskip("torch")

from model.architectures.transformer import (  # noqa: E402
    Attention,
    RotaryEmbedding,
    from_config,
)


def _attn(**kwargs: object) -> Attention:
    defaults: dict[str, object] = {
        "hidden_size": 64,
        "num_attention_heads": 4,
        "num_key_value_heads": 2,
        "max_position_embeddings": 64,
        "use_flash_attention": False,
    }
    defaults.update(kwargs)
    return Attention(**defaults)  # type: ignore[arg-type]


class TestBackends:
    def test_sdpa_matches_manual_math_gqa(self) -> None:
        attn = _attn()
        attn.eval()
        torch.manual_seed(0)
        q = torch.randn(2, 4, 16, 16)
        k = torch.randn(2, 2, 16, 16)
        v = torch.randn(2, 2, 16, 16)
        with torch.no_grad():
            sdpa = attn._sdpa_attention(q, k, v, None)
            manual = attn._standard_attention(q, attn._repeat_kv(k, 2), attn._repeat_kv(v, 2), None)
        assert torch.allclose(sdpa, manual, atol=1e-4)

    def test_sdpa_matches_manual_math_mha(self) -> None:
        attn = _attn(num_key_value_heads=4)
        attn.eval()
        torch.manual_seed(1)
        q = torch.randn(1, 4, 8, 16)
        k = torch.randn(1, 4, 8, 16)
        v = torch.randn(1, 4, 8, 16)
        with torch.no_grad():
            sdpa = attn._sdpa_attention(q, k, v, None)
            manual = attn._standard_attention(q, k, v, None)
        assert torch.allclose(sdpa, manual, atol=1e-4)

    def test_cached_decode_matches_full_forward(self) -> None:
        """Regression test for the RoPE position fix (2026-10-19).

        Before the fix, every decoded query token was rotated with position 0
        instead of its true offset, so incremental decode silently diverged
        from the full forward pass.
        """
        attn = _attn()
        attn.eval()
        torch.manual_seed(2)
        x = torch.randn(2, 16, 64)
        with torch.no_grad():
            full, _ = attn(x)
            _, cache = attn(x[:, :8, :], use_cache=True)
            inc, _ = attn(x[:, 8:9, :], past_key_value=cache)
        assert torch.allclose(full[0, 8, :], inc[0, 0, :], atol=1e-4)
        assert torch.allclose(full[1, 8, :], inc[1, 0, :], atol=1e-4)

    def test_qk_norm_forward_shape(self) -> None:
        attn = _attn(qk_norm=True)
        attn.eval()
        x = torch.randn(2, 10, 64)
        with torch.no_grad():
            out, _ = attn(x)
        assert out.shape == (2, 10, 64)


class TestRoPEScaling:
    def test_yarn_attention_scaling(self) -> None:
        rope = RotaryEmbedding(
            16, max_position_embeddings=32, scaling={"type": "yarn", "factor": 4.0}
        )
        expected = 0.1 * float(torch.log(torch.tensor(4.0))) + 1.0
        assert rope.attention_scaling == pytest.approx(expected)

    def test_yarn_extends_cache(self) -> None:
        rope = RotaryEmbedding(
            16, max_position_embeddings=32, scaling={"type": "yarn", "factor": 4.0}
        )
        cos, sin = rope(torch.zeros(1, 1, 1, 16), 128)
        assert cos.shape[0] == 128

    def test_linear_interpolates_positions(self) -> None:
        scaled = RotaryEmbedding(
            16, max_position_embeddings=64, scaling={"type": "linear", "factor": 2.0}
        )
        raw = RotaryEmbedding(16, max_position_embeddings=64)
        with torch.no_grad():
            # 65 positions: forward() returns cos_cached[:seq_len], so row 64
            # requires requesting 65 (64 was an off-by-one OOB; CI run 39314637719).
            cos_s, _ = scaled(torch.zeros(1), 65)
            cos_r, _ = raw(torch.zeros(1), 33)
        # Scaled position 64 must equal unscaled position 32 (factor 2).
        assert torch.allclose(cos_s[64], cos_r[32], atol=1e-5)

    def test_no_scaling_is_identity(self) -> None:
        rope = RotaryEmbedding(16, max_position_embeddings=32)
        assert rope.attention_scaling == 1.0
        assert rope.scaling_type is None


class TestFromConfig:
    def test_wires_qk_norm_and_scaling(self) -> None:
        cfg = {
            "vocab_size": 96,
            "hidden_size": 64,
            "num_layers": 2,
            "num_attention_heads": 4,
            "num_key_value_heads": 2,
            "intermediate_size": 128,
            "qk_norm": True,
            "rope_scaling": {"type": "yarn", "factor": 4.0},
        }
        model = from_config(cfg)
        first = model.layers[0].self_attn
        assert first.qk_norm is True
        assert first.rotary_emb.scaling_type == "yarn"
        assert first.rotary_emb.attention_scaling > 1.0

    def test_defaults_unchanged_for_v1(self) -> None:
        cfg = {
            "vocab_size": 96,
            "hidden_size": 64,
            "num_layers": 2,
            "num_attention_heads": 4,
            "num_key_value_heads": 2,
            "intermediate_size": 128,
        }
        model = from_config(cfg)
        first = model.layers[0].self_attn
        assert first.qk_norm is False
        assert first.rotary_emb.scaling_type is None
