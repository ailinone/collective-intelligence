#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Integration smoke against the REAL installed ML stack (2026-10 SOTA set).

2026-10-19 — new CI vehicle. The lint gate deliberately does NOT install the
ML stack (hermetic venv), which is correct for reproducible static analysis
but left runtime rot invisible: serve.py targeted the removed vLLM V0 API and
train_ppo.py imported TRL's deleted PPOTrainer for months while CI was green
(nothing imported them). This script is the counterweight: it runs on a
runner with the full stack installed (``pip install -e ".[dev]"``) and
validates that the code we ship actually WORKS against the versions we pin:

  1. Resolved-version report + floor enforcement (fails on version drift,
     so the pinned contract in pyproject is load-bearing, not decorative).
  2. vLLM V1 API gate: AsyncLLM/EngineArgs/SamplingParams + VLLMEngine wiring.
  3. Quantization module: transformers GPTQConfig / BitsAndBytesConfig paths
     (producer backends llmcompressor/gptqmodel are gpu-extra, probed softly).
  4. TRL GRPO: config construction + a real 1-step CPU GRPO train run with a
     verifiable reward (the new post-training path, end to end).
  5. transformers forward/backward on a tiny Llama (compile-level runtime).
  6. model/architectures: SDPA==math equivalence, cached-decode RoPE position
     fix, QK-norm forward, YaRN scaling — the 2026-10 architecture changes.

Exit code 0 only if everything passes. CPU-only; ~2-4 min.
"""

from __future__ import annotations

import json
import logging
import sys
from pathlib import Path
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("integration-smoke")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

# Direct-dependency floor contract — mirrors pyproject.toml [project.dependencies].
# (package, floor) — floor enforcement only; upper caps live in pyproject.
FLOOR_CONTRACT: list[tuple[str, str]] = [
    ("torch", "2.13.0"),
    ("transformers", "5.16.1"),
    ("trl", "1.16.0"),
    ("vllm", "0.32.0"),
    ("accelerate", "1.15.0"),
    ("datasets", "5.1.0"),
    ("tokenizers", "0.23.0"),
    ("peft", "0.21.0"),
    ("deepspeed", "0.19.0"),
]


def _version(pkg: str) -> str:
    from importlib.metadata import PackageNotFoundError, version

    try:
        return version(pkg)
    except PackageNotFoundError:
        return ""


def _ver_tuple(v: str) -> tuple[int, ...]:
    return tuple(int(p) for p in v.split(".")[:3] if p.isdigit())


def step_1_version_contract() -> dict[str, str]:
    logger.info("[1/6] Version contract (floors enforced)")
    resolved: dict[str, str] = {}
    failures: list[str] = []
    for pkg, floor in FLOOR_CONTRACT:
        v = _version(pkg)
        resolved[pkg] = v or "NOT INSTALLED"
        if not v or _ver_tuple(v) < _ver_tuple(floor):
            failures.append(f"{pkg}: installed={v or 'missing'} floor={floor}")
    # Optional producer backends (gpu extra) — report only.
    for pkg in ("llmcompressor", "gptqmodel", "bitsandbytes", "flash_attn"):
        v = _version(pkg)
        resolved[pkg] = v or "absent (gpu-extra; optional here)"
    logger.info("Resolved:\n%s", json.dumps(resolved, indent=2))
    if failures:
        raise RuntimeError("Version contract violated: " + "; ".join(failures))
    return resolved


def step_2_vllm_v1() -> None:
    logger.info("[2/6] vLLM V1 API gate (AsyncLLM)")
    # Canonical V1 paths: vllm 0.32 has no top-level AsyncLLM export
    # (SamplingParams IS top-level). Mirrors serve.py exactly.
    from vllm import SamplingParams  # noqa: F401
    from vllm.engine.arg_utils import EngineArgs
    from vllm.v1.engine.async_llm import AsyncLLM

    # EngineArgs must accept the exact kwargs serve.py passes.
    args = EngineArgs(
        model="dummy",
        tensor_parallel_size=1,
        max_model_len=4096,
        gpu_memory_utilization=0.90,
        dtype="auto",
        trust_remote_code=False,
        quantization=None,
        enforce_eager=False,
        # NOTE: no swap_space — V0 preemption knob, dropped from EngineArgs
        # in vLLM V1 (validated against v0.32.0; V1 preempts by recompute).
        max_num_seqs=256,
        seed=0,
        kv_cache_dtype="auto",
        enable_prefix_caching=True,
    )
    assert args.max_model_len == 4096
    assert hasattr(AsyncLLM, "from_engine_args"), "AsyncLLM.from_engine_args missing"

    from serving.runtime.serve import EngineConfig, VLLMEngine

    engine = VLLMEngine(EngineConfig(model_path="/tmp/dummy-model"))
    assert engine.model_name == "dummy-model"
    logger.info("  serve.VLLMEngine wiring OK (vllm %s)", _version("vllm"))


def step_3_quantization() -> None:
    logger.info("[3/6] Quantization module (fp8/gptq/bnb paths)")
    import serving.quantization.quantize as q

    assert hasattr(q, "quantize_fp8") and hasattr(q, "quantize_gptq")
    assert not hasattr(q, "quantize_awq"), "dead autoawq path must be gone"
    from transformers import BitsAndBytesConfig, GPTQConfig  # noqa: F401

    logger.info("  quantize module OK; transformers GPTQConfig/BitsAndBytesConfig present")


def step_4_grpo_cpu() -> None:
    logger.info("[4/6] TRL GRPO — real 1-step CPU run with verifiable reward")
    # datasets.arrow_dataset — the re-export in datasets/__init__ is not
    # visible to type checkers (same false positive as train_grpo.py).
    from datasets.arrow_dataset import Dataset
    from tokenizers import Tokenizer, models, pre_tokenizers
    from transformers import LlamaConfig, LlamaForCausalLM, PreTrainedTokenizerFast
    from trl import GRPOConfig, GRPOTrainer

    from alignment.grpo.train_grpo import exact_match_reward

    tiny = LlamaConfig(
        vocab_size=96,
        hidden_size=64,
        intermediate_size=128,
        num_hidden_layers=2,
        num_attention_heads=4,
        num_key_value_heads=2,
        max_position_embeddings=128,
    )
    model = LlamaForCausalLM(tiny)

    # 2026-10-20 — GRPOTrainer resolves its tokenizer from
    # model.name_or_path; an in-memory model has "" there
    # (HFValidationError: "Repo id ...: ''", CI run 39364364128), so hand
    # it a tiny offline WordLevel tokenizer (ids < vocab_size=96).
    word_vocab = {
        "[UNK]": 0,
        "[PAD]": 1,
        "[EOS]": 2,
        "0": 3,
        "1": 4,
        "2": 5,
        "3": 6,
        "answer": 7,
        ":": 8,
        "say": 9,
        "the": 10,
        "number": 11,
        ".": 12,
    }
    backend = Tokenizer(models.WordLevel(vocab=word_vocab, unk_token="[UNK]"))
    backend.pre_tokenizer = pre_tokenizers.WhitespaceSplit()
    tokenizer = PreTrainedTokenizerFast(
        tokenizer_object=backend,
        unk_token="[UNK]",
        pad_token="[PAD]",
        eos_token="[EOS]",
    )

    rows = [{"prompt": f"Say the number {i}. Answer:", "answer": str(i)} for i in range(4)]
    dataset = Dataset.from_list(rows)

    cfg = GRPOConfig(
        output_dir="/tmp/grpo-smoke",
        num_generations=2,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=1,
        # NOTE: no max_prompt_length — GRPOConfig dropped it before trl 1.16
        # (validated against trl/trainer/grpo_config.py v1.16.0).
        max_completion_length=8,
        learning_rate=1e-6,
        num_train_epochs=1,
        logging_steps=1,
        save_strategy="no",
        report_to="none",
        use_vllm=False,
        bf16=False,
    )
    trainer = GRPOTrainer(
        model=model,
        reward_funcs=[exact_match_reward],
        args=cfg,
        train_dataset=dataset,
        processing_class=tokenizer,
    )
    result = trainer.train()
    interesting = {k: float(v) for k, v in result.metrics.items() if "reward" in k or "loss" in k}
    logger.info("  GRPO train OK: %s", interesting)


def step_5_transformers_fwdbwd() -> None:
    logger.info("[5/6] transformers tiny forward/backward")
    import torch
    from transformers import LlamaConfig, LlamaForCausalLM

    tiny = LlamaConfig(
        vocab_size=96,
        hidden_size=64,
        intermediate_size=128,
        num_hidden_layers=2,
        num_attention_heads=4,
        num_key_value_heads=2,
        max_position_embeddings=128,
    )
    model = LlamaForCausalLM(tiny)
    ids = torch.randint(0, 96, (2, 32))
    out = model(input_ids=ids, labels=ids)
    out.loss.backward()
    logger.info("  fwd/bwd OK: loss=%.4f", float(out.loss))


def step_6_architecture() -> None:
    logger.info("[6/6] AilinTransformer 2026-10 changes (SDPA/RoPE-fix/QK-norm/YaRN)")
    import torch

    from model.architectures.transformer import Attention, RotaryEmbedding

    torch.manual_seed(0)
    attn = Attention(
        hidden_size=64,
        num_attention_heads=4,
        num_key_value_heads=2,
        max_position_embeddings=64,
        use_flash_attention=False,
        qk_norm=True,
    )
    attn.eval()

    x = torch.randn(2, 16, 64)
    with torch.no_grad():
        out_full, _ = attn(x)

    # SDPA must agree with the manual math path.
    with torch.no_grad():
        q = torch.randn(2, 4, 16, 16)
        k = torch.randn(2, 2, 16, 16)
        v = torch.randn(2, 2, 16, 16)
        sdpa = attn._sdpa_attention(q, k, v, None)
        math_out = attn._standard_attention(q, attn._repeat_kv(k, 2), attn._repeat_kv(v, 2), None)
    assert torch.allclose(sdpa, math_out, atol=1e-4), "SDPA/math mismatch"

    # Cached decode must reproduce the full forward (RoPE position fix).
    with torch.no_grad():
        attn.use_flash_attention = False
        out1, cache = attn(x[:, :8, :], use_cache=True)
        out2, _ = attn(x[:, 8:9, :], past_key_value=cache)
    full_prefix = out_full[1, 8, :]
    inc_prefix = out2[1, 0, :]
    assert torch.allclose(full_prefix, inc_prefix, atol=1e-4), (
        "incremental decode diverges from full forward (RoPE positions)"
    )

    # YaRN: attention scaling + cache shape.
    rope = RotaryEmbedding(16, max_position_embeddings=32, scaling={"type": "yarn", "factor": 4.0})
    assert rope.attention_scaling > 1.0
    cos, sin = rope(torch.zeros(1, 1, 1, 16), 64)
    assert cos.shape[0] == 64, "cache must extend past trained max"

    # Linear scaling: position p*factor maps to unscaled position p.
    rope_lin = RotaryEmbedding(
        16, max_position_embeddings=64, scaling={"type": "linear", "factor": 2.0}
    )
    rope_raw = RotaryEmbedding(16, max_position_embeddings=64)
    with torch.no_grad():
        # 65 positions: forward() returns cos_cached[:seq_len], so index 64
        # requires requesting 65 (the original 64 was an off-by-one OOB).
        cos_l, _ = rope_lin(torch.zeros(1), 65)
        cos_r, _ = rope_raw(torch.zeros(1), 33)
    assert torch.allclose(cos_l[64], cos_r[32], atol=1e-5), "linear interpolation broken"

    logger.info("  architecture checks OK (SDPA==math, cache==full, YaRN, linear)")


def main() -> None:
    steps: list[tuple[str, Any]] = [
        ("version-contract", step_1_version_contract),
        ("vllm-v1", step_2_vllm_v1),
        ("quantization", step_3_quantization),
        ("grpo-cpu", step_4_grpo_cpu),
        ("transformers-fwdbwd", step_5_transformers_fwdbwd),
        ("architecture", step_6_architecture),
    ]
    failed: list[str] = []
    for name, fn in steps:
        try:
            fn()
        except Exception as exc:  # noqa: BLE001 — report every step, then fail
            logger.error("STEP %s FAILED: %s", name, exc)
            import traceback

            traceback.print_exc()
            failed.append(name)
    if failed:
        logger.error("INTEGRATION SMOKE FAILED: %s", ", ".join(failed))
        sys.exit(1)
    logger.info("INTEGRATION SMOKE PASSED (all 6 steps)")


if __name__ == "__main__":
    main()
