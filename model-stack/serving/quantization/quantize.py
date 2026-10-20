#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Model quantization: FP8 (llmcompressor), GPTQ, and bitsandbytes.

2026-10-19 — SOTA refresh of the producer paths:
  - FP8 via ``llmcompressor`` (one-shot) — PRIMARY path. Produces a
    compressed-tensors checkpoint that vLLM serves natively on Ada/Hopper+.
    This replaces the AWQ path: ``autoawq`` is unmaintained/dead and its
    checkpoints need per-kernel support that modern vLLM no longer ships.
  - GPTQ via transformers-native ``GPTQConfig`` — replaces ``auto_gptq``
    (also dead); the maintained quantization backend is ``gptqmodel``.
  - bitsandbytes (QLoRA-style) — unchanged, still alive and standard.

Loads a full-precision model, applies the selected quantization scheme,
validates output quality on a calibration set (perplexity check), and
persists the quantized checkpoint.
"""

from __future__ import annotations

import json
import logging
import math
import time
from pathlib import Path
from typing import Any

import click
import torch

# 2026-10-18 — import from datasets.load: the re-export in datasets/__init__
# is not visible to its py.typed metadata (attr-defined false positive);
# this is the exact same function the top-level name is bound to.
from datasets.load import load_dataset
from transformers import AutoModelForCausalLM, AutoTokenizer

logger = logging.getLogger("quantize")


# ---------------------------------------------------------------------------
# Calibration helpers
# ---------------------------------------------------------------------------


def load_calibration_data(
    dataset_name: str = "wikitext",
    dataset_config: str = "wikitext-2-raw-v1",
    split: str = "test",
    num_samples: int = 128,
    seq_length: int = 2048,
    tokenizer: Any = None,
) -> list[torch.Tensor]:
    """Load and tokenize calibration samples from a HuggingFace dataset."""
    ds = load_dataset(dataset_name, dataset_config, split=split)
    text = "\n\n".join(ds["text"])
    encoded = tokenizer(text, return_tensors="pt")
    input_ids: torch.Tensor = encoded.input_ids[0]

    samples: list[torch.Tensor] = []
    for i in range(0, len(input_ids) - seq_length, seq_length):
        if len(samples) >= num_samples:
            break
        samples.append(input_ids[i : i + seq_length].unsqueeze(0))
    return samples


def compute_perplexity(
    model: Any,
    tokenizer: Any,
    samples: list[torch.Tensor],
    device: str = "cuda",
) -> float:
    """Compute perplexity on calibration samples."""
    model.eval()
    total_loss = 0.0
    total_tokens = 0

    with torch.no_grad():
        for sample in samples:
            sample = sample.to(device)
            outputs = model(sample, labels=sample)
            seq_len = sample.size(1)
            total_loss += outputs.loss.item() * seq_len
            total_tokens += seq_len

    avg_loss = total_loss / max(total_tokens, 1)
    return math.exp(avg_loss)


# ---------------------------------------------------------------------------
# Tokenized calibration set (shared by fp8 / gptq paths)
# ---------------------------------------------------------------------------


def _tokenized_calibration(
    tokenizer: Any,
    num_samples: int = 128,
    seq_length: int = 2048,
) -> list[dict[str, Any]]:
    """Build a tokenized calibration corpus for llmcompressor / GPTQConfig."""
    ds = load_dataset("wikitext", "wikitext-2-raw-v1", split="train")
    texts = [t for t in ds["text"] if len(t.strip()) > 100][:num_samples]
    calibration: list[dict[str, Any]] = []
    for t in texts:
        enc = tokenizer(t, return_tensors="pt", max_length=seq_length, truncation=True)
        calibration.append(
            {
                "input_ids": enc.input_ids,
                "attention_mask": enc.attention_mask,
            }
        )
    return calibration


# ---------------------------------------------------------------------------
# FP8 quantization (llmcompressor — primary path)
# ---------------------------------------------------------------------------


def quantize_fp8(
    model_path: str,
    output_path: str,
    num_calibration_samples: int = 128,
    calibration_seq_length: int = 2048,
    ignore_lm_head: bool = True,
) -> Path:
    """Quantize a model to FP8 (dynamic weight+activation) via llmcompressor.

    Produces a compressed-tensors checkpoint served natively by vLLM
    (``--quantization`` auto-detected from the checkpoint config). Requires
    the ``llmcompressor`` package (``pip install -e ".[gpu]"``) and an
    FP8-capable GPU (Ada/Hopper or newer) for the calibration forward passes.
    lm_head is kept in higher precision by default — standard practice to
    avoid measurable quality loss at small vocab-head scale.
    """
    try:
        from llmcompressor import oneshot
        from llmcompressor.modifiers.quantization import QuantizationModifier
    except ImportError as exc:  # pragma: no cover - env-dependent
        raise ImportError(
            "FP8 quantization requires the llmcompressor package: "
            "pip install -e '.[gpu]' (2026-10: llmcompressor>=0.14)"
        ) from exc

    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    calibration = _tokenized_calibration(
        tokenizer, num_samples=num_calibration_samples, seq_length=calibration_seq_length
    )

    logger.info("Loading model %s for FP8 quantization ...", model_path)
    model = AutoModelForCausalLM.from_pretrained(
        model_path, device_map="auto", trust_remote_code=True
    )

    ignore = ["lm_head"] if ignore_lm_head else []
    recipe = QuantizationModifier(
        targets="Linear",
        scheme="FP8_DYNAMIC",
        ignore=ignore,
    )

    logger.info("Running FP8 one-shot quantization (ignore=%s) ...", ignore)
    oneshot(model=model, dataset=calibration, recipe=recipe)

    out = Path(output_path)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(out))
    tokenizer.save_pretrained(str(out))
    logger.info("FP8 quantized model saved to %s", out)
    return out


# ---------------------------------------------------------------------------
# GPTQ quantization (transformers-native, gptqmodel backend)
# ---------------------------------------------------------------------------


def quantize_gptq(
    model_path: str,
    output_path: str,
    bits: int = 4,
    group_size: int = 128,
    desc_act: bool = False,
    num_calibration_samples: int = 128,
    calibration_seq_length: int = 2048,
) -> Path:
    """Quantize a model using GPTQ via transformers-native GPTQConfig.

    2026-10-19 — replaces the dead ``auto_gptq`` producer (unmaintained since
    2024; the maintained GPTQ backend is ``gptqmodel``). Calibration is a
    list of tokenized examples passed straight to ``GPTQConfig(dataset=...)``.
    Requires GPU (``pip install -e ".[gpu]"``).
    """
    try:
        from transformers import GPTQConfig
    except ImportError as exc:  # pragma: no cover - env-dependent
        raise ImportError(
            "GPTQ quantization requires transformers>=5 with GPTQConfig and "
            "the gptqmodel backend (pip install -e '.[gpu]')"
        ) from exc

    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    calibration = _tokenized_calibration(
        tokenizer, num_samples=num_calibration_samples, seq_length=calibration_seq_length
    )

    quantize_config = GPTQConfig(
        bits=bits,
        group_size=group_size,
        desc_act=desc_act,
        dataset=calibration,
    )

    logger.info(
        "Loading model %s for GPTQ quantization (bits=%d, group_size=%d) ...",
        model_path,
        bits,
        group_size,
    )
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        quantization_config=quantize_config,
        trust_remote_code=True,
    )

    out = Path(output_path)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(out))
    tokenizer.save_pretrained(str(out))
    logger.info("GPTQ quantized model saved to %s", out)
    return out


# ---------------------------------------------------------------------------
# bitsandbytes quantization
# ---------------------------------------------------------------------------


def quantize_bitsandbytes(
    model_path: str,
    output_path: str,
    load_in_4bit: bool = True,
    bnb_4bit_compute_dtype: str = "bfloat16",
    bnb_4bit_quant_type: str = "nf4",
    bnb_4bit_use_double_quant: bool = True,
) -> Path:
    """Quantize a model using bitsandbytes (QLoRA-style)."""
    from transformers import BitsAndBytesConfig

    compute_dtype = getattr(torch, bnb_4bit_compute_dtype, torch.bfloat16)
    quantization_config = BitsAndBytesConfig(
        load_in_4bit=load_in_4bit,
        bnb_4bit_compute_dtype=compute_dtype,
        bnb_4bit_quant_type=bnb_4bit_quant_type,
        bnb_4bit_use_double_quant=bnb_4bit_use_double_quant,
    )

    logger.info("Loading model %s with bitsandbytes quantization ...", model_path)
    tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
    model = AutoModelForCausalLM.from_pretrained(
        model_path,
        quantization_config=quantization_config,
        device_map="auto",
        trust_remote_code=True,
    )

    out = Path(output_path)
    out.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(str(out))
    tokenizer.save_pretrained(str(out))
    logger.info("bitsandbytes quantized model saved to %s", out)
    return out


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_quantized_model(
    original_model_path: str,
    quantized_model_path: str,
    max_perplexity_ratio: float = 1.05,
    num_samples: int = 64,
    seq_length: int = 2048,
) -> dict[str, Any]:
    """Compare perplexity of the original vs. quantized model.

    Returns a dict with both perplexities and a pass/fail verdict.
    The quantized model passes if its perplexity is at most
    ``max_perplexity_ratio`` times the original perplexity.
    """
    device = "cuda" if torch.cuda.is_available() else "cpu"

    tokenizer = AutoTokenizer.from_pretrained(original_model_path, trust_remote_code=True)
    calibration = load_calibration_data(
        tokenizer=tokenizer,
        num_samples=num_samples,
        seq_length=seq_length,
    )

    logger.info("Computing original model perplexity ...")
    orig_model = AutoModelForCausalLM.from_pretrained(
        original_model_path, device_map="auto", trust_remote_code=True
    )
    orig_ppl = compute_perplexity(orig_model, tokenizer, calibration, device)
    del orig_model
    torch.cuda.empty_cache()

    logger.info("Computing quantized model perplexity ...")
    quant_model = AutoModelForCausalLM.from_pretrained(
        quantized_model_path, device_map="auto", trust_remote_code=True
    )
    quant_ppl = compute_perplexity(quant_model, tokenizer, calibration, device)
    del quant_model
    torch.cuda.empty_cache()

    ratio = quant_ppl / max(orig_ppl, 1e-9)
    passed = ratio <= max_perplexity_ratio

    result = {
        "original_perplexity": round(orig_ppl, 4),
        "quantized_perplexity": round(quant_ppl, 4),
        "ratio": round(ratio, 4),
        "max_allowed_ratio": max_perplexity_ratio,
        "passed": passed,
    }

    if passed:
        logger.info("Validation PASSED: ratio=%.4f <= %.4f", ratio, max_perplexity_ratio)
    else:
        logger.warning("Validation FAILED: ratio=%.4f > %.4f", ratio, max_perplexity_ratio)

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@click.group()
def cli() -> None:
    """Model quantization toolkit."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )


@cli.command()
@click.option("--model-path", required=True, help="Path or HF id of the source model")
@click.option("--output-path", required=True, help="Directory for the quantized model")
@click.option("--method", type=click.Choice(["fp8", "gptq", "bitsandbytes"]), required=True)
@click.option("--bits", type=int, default=4, help="Quantization bit-width")
@click.option("--group-size", type=int, default=128, help="GPTQ / AWQ group size")
@click.option("--validate/--no-validate", default=True, help="Run perplexity validation")
@click.option("--max-ppl-ratio", type=float, default=1.05, help="Max allowed perplexity ratio")
def quantize(
    model_path: str,
    output_path: str,
    method: str,
    bits: int,
    group_size: int,
    validate: bool,
    max_ppl_ratio: float,
) -> None:
    """Quantize a model using the selected method."""
    start = time.time()

    if method == "fp8":
        quantize_fp8(model_path, output_path)
    elif method == "gptq":
        quantize_gptq(model_path, output_path, bits=bits, group_size=group_size)
    elif method == "bitsandbytes":
        quantize_bitsandbytes(model_path, output_path)
    else:
        raise click.BadParameter(f"Unknown method: {method}")

    elapsed = time.time() - start
    logger.info("Quantization completed in %.1f seconds", elapsed)

    if validate:
        logger.info("Running perplexity validation ...")
        result = validate_quantized_model(
            model_path, output_path, max_perplexity_ratio=max_ppl_ratio
        )
        report_path = Path(output_path) / "quantization_report.json"
        report_path.write_text(json.dumps(result, indent=2))
        logger.info("Validation report saved to %s", report_path)

        if not result["passed"]:
            raise click.ClickException(
                f"Quantized model FAILED validation (ppl ratio {result['ratio']:.4f} "
                f"> {max_ppl_ratio:.4f})"
            )


@cli.command()
@click.option("--original", required=True, help="Original model path")
@click.option("--quantized", required=True, help="Quantized model path")
@click.option("--max-ppl-ratio", type=float, default=1.05)
@click.option("--num-samples", type=int, default=64)
def validate_cmd(original: str, quantized: str, max_ppl_ratio: float, num_samples: int) -> None:
    """Stand-alone perplexity validation."""
    result = validate_quantized_model(
        original, quantized, max_perplexity_ratio=max_ppl_ratio, num_samples=num_samples
    )
    click.echo(json.dumps(result, indent=2))
    if not result["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    cli()
