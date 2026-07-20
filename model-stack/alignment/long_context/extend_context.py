#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Context Window Extension
=========================
Extends the context window of an aligned model using RoPE scaling
(NTK-aware interpolation or YaRN) and fine-tunes on long-context data.
Includes needle-in-haystack evaluation.

Usage
-----
    python extend_context.py \
        --base-model ./models/ailin-1b-safety \
        --target-length 32768 \
        --method yarn \
        --dataset ./data/long-context/books.jsonl \
        --output-dir ./models/ailin-1b-32k

    # Evaluate only
    python extend_context.py \
        --base-model ./models/ailin-1b-32k \
        --target-length 32768 \
        --eval-only
"""
from __future__ import annotations

import json
import logging
import math
import os
import random
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import click
import torch
import torch.nn as nn
from datasets import Dataset, load_dataset, load_from_disk
from peft import LoraConfig, PeftModel, TaskType, get_peft_model
from transformers import (
    AutoConfig,
    AutoModelForCausalLM,
    AutoTokenizer,
    GenerationConfig,
)
from trl import SFTConfig, SFTTrainer

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


# ── RoPE scaling methods ─────────────────────────────────────
def apply_rope_scaling(
    config,
    original_max_position: int,
    target_max_position: int,
    method: str = "yarn",
):
    """
    Apply RoPE scaling to a model config.

    Methods:
    - linear: simple linear interpolation (position / scale_factor)
    - ntk: NTK-aware interpolation (changes base frequency)
    - yarn: Yet Another RoPE extensioN (combines NTK + attention scaling)
    - dynamic_ntk: dynamic NTK (scales base at inference time)
    """
    scale_factor = target_max_position / original_max_position
    logger.info(
        "RoPE scaling: %s, factor=%.1fx (%d -> %d)",
        method, scale_factor, original_max_position, target_max_position,
    )

    if method == "linear":
        config.rope_scaling = {
            "type": "linear",
            "factor": scale_factor,
        }

    elif method == "ntk":
        # NTK-aware: scale the base frequency
        # New base = base * (scale_factor ** (dim / (dim - 2)))
        config.rope_scaling = {
            "type": "ntk",
            "factor": scale_factor,
        }

    elif method == "yarn":
        # YaRN: combines NTK interpolation with attention scaling
        config.rope_scaling = {
            "type": "yarn",
            "factor": scale_factor,
            "original_max_position_embeddings": original_max_position,
            "attention_factor": None,  # auto-compute
            "beta_fast": 32,
            "beta_slow": 1,
        }

    elif method == "dynamic_ntk":
        config.rope_scaling = {
            "type": "dynamic",
            "factor": scale_factor,
        }

    else:
        raise ValueError(f"Unknown RoPE scaling method: {method}")

    config.max_position_embeddings = target_max_position
    return config


# ── Long-context dataset ─────────────────────────────────────
def load_long_context_dataset(
    dataset_path: str,
    tokenizer: AutoTokenizer,
    target_length: int,
    eval_split: float = 0.05,
    seed: int = 42,
) -> dict:
    """Load and prepare long-context training data.

    Concatenates shorter documents to fill the target context length.
    """
    path = Path(dataset_path)

    if path.exists():
        if path.suffix in (".json", ".jsonl"):
            dataset = load_dataset("json", data_files=str(path), split="train")
        elif path.is_dir():
            try:
                dataset = load_from_disk(str(path))
                if hasattr(dataset, "keys") and "train" in dataset:
                    dataset = dataset["train"]
            except Exception:
                dataset = load_dataset(str(path), split="train")
        else:
            dataset = load_dataset(str(path), split="train")
    else:
        dataset = load_dataset(dataset_path, split="train")

    logger.info("Loaded %d documents", len(dataset))

    # Tokenize and pack into long sequences
    all_token_ids = []
    for example in dataset:
        text = example.get("text", example.get("content", ""))
        tokens = tokenizer.encode(text, add_special_tokens=False)
        all_token_ids.extend(tokens)
        all_token_ids.append(tokenizer.eos_token_id)

    logger.info("Total tokens: %d", len(all_token_ids))

    # Chunk into target_length sequences
    sequences = []
    for i in range(0, len(all_token_ids) - target_length, target_length):
        chunk = all_token_ids[i: i + target_length]
        sequences.append({"input_ids": chunk, "text": tokenizer.decode(chunk)})

    logger.info("Created %d long-context sequences (length=%d)", len(sequences), target_length)

    dataset = Dataset.from_list(sequences)
    split = dataset.train_test_split(test_size=eval_split, seed=seed)
    return split


# ── Needle-in-a-Haystack evaluation ─────────────────────────
NEEDLE_TEMPLATE = "The special magic number is: {needle_value}."
HAYSTACK_QUERY = "What is the special magic number mentioned in the text above?"


def create_needle_test(
    tokenizer: AutoTokenizer,
    context_length: int,
    depth_percent: float,
    needle_value: str = "7429",
    filler_text: Optional[str] = None,
) -> Tuple[str, str]:
    """
    Create a needle-in-haystack test case.

    Places a 'needle' sentence at a specific depth within a 'haystack'
    of filler text, then asks the model to retrieve the needle.
    """
    needle = NEEDLE_TEMPLATE.format(needle_value=needle_value)

    if filler_text is None:
        # Generate generic filler
        filler_sentences = [
            "The quick brown fox jumps over the lazy dog.",
            "In a world of constant change, adaptation is key.",
            "Technology continues to reshape how we live and work.",
            "Mountains rise above the clouds in silent majesty.",
            "Rivers flow through valleys, carving paths through stone.",
            "Stars illuminate the night sky with ancient light.",
            "Knowledge grows through curiosity and careful observation.",
            "Communities thrive when cooperation guides their efforts.",
            "The ocean depths hold mysteries still unexplored.",
            "Seasons change, bringing new colors to the landscape.",
        ]
        # Repeat filler to fill context
        filler_text = " ".join(filler_sentences * 500)

    # Tokenize to get approximate length
    filler_tokens = tokenizer.encode(filler_text, add_special_tokens=False)
    needle_tokens = tokenizer.encode(needle, add_special_tokens=False)
    query_tokens = tokenizer.encode(HAYSTACK_QUERY, add_special_tokens=False)

    # Reserve space for needle, query, and formatting
    available = context_length - len(needle_tokens) - len(query_tokens) - 100
    filler_tokens = filler_tokens[:available]

    # Insert needle at depth_percent
    insert_pos = int(len(filler_tokens) * depth_percent / 100)
    tokens_with_needle = filler_tokens[:insert_pos] + needle_tokens + filler_tokens[insert_pos:]

    haystack = tokenizer.decode(tokens_with_needle)
    full_prompt = f"{haystack}\n\n{HAYSTACK_QUERY}"

    return full_prompt, needle_value


@torch.no_grad()
def evaluate_needle_in_haystack(
    model: AutoModelForCausalLM,
    tokenizer: AutoTokenizer,
    context_lengths: List[int],
    depth_percents: List[float],
    device: str = "cuda",
    max_new_tokens: int = 64,
) -> Dict:
    """
    Run needle-in-haystack evaluation across context lengths and depths.
    Returns a matrix of pass/fail results.
    """
    model.eval()
    results = {}

    gen_config = GenerationConfig(
        max_new_tokens=max_new_tokens,
        do_sample=False,
        pad_token_id=tokenizer.pad_token_id,
        eos_token_id=tokenizer.eos_token_id,
    )

    total_tests = len(context_lengths) * len(depth_percents)
    completed = 0

    for ctx_len in context_lengths:
        results[ctx_len] = {}
        for depth in depth_percents:
            needle_value = str(random.randint(1000, 9999))
            prompt, expected = create_needle_test(
                tokenizer, ctx_len, depth, needle_value=needle_value,
            )

            inputs = tokenizer(
                prompt, return_tensors="pt", truncation=True, max_length=ctx_len,
            ).to(device)

            actual_len = inputs["input_ids"].shape[1]

            try:
                output = model.generate(**inputs, generation_config=gen_config)
                response = tokenizer.decode(
                    output[0][inputs["input_ids"].shape[1]:],
                    skip_special_tokens=True,
                )
                found = expected in response
            except torch.cuda.OutOfMemoryError:
                logger.warning("OOM at context_length=%d, depth=%.0f%%", ctx_len, depth)
                found = False
                torch.cuda.empty_cache()

            results[ctx_len][depth] = {
                "found": found,
                "actual_tokens": actual_len,
                "needle_value": expected,
                "response_snippet": response[:200] if "response" in dir() else "OOM",
            }

            completed += 1
            if completed % 10 == 0:
                logger.info("Needle eval progress: %d/%d", completed, total_tests)

    # Compute summary
    total = 0
    correct = 0
    for ctx_len in results:
        for depth in results[ctx_len]:
            total += 1
            if results[ctx_len][depth]["found"]:
                correct += 1

    summary = {
        "overall_accuracy": correct / max(total, 1),
        "total_tests": total,
        "correct": correct,
        "per_length": {},
    }

    for ctx_len in results:
        length_correct = sum(1 for d in results[ctx_len].values() if d["found"])
        length_total = len(results[ctx_len])
        summary["per_length"][ctx_len] = length_correct / max(length_total, 1)

    return {"matrix": results, "summary": summary}


# ── Main ─────────────────────────────────────────────────────
@click.command()
@click.option("--base-model", required=True, type=str, help="Path to aligned base model.")
@click.option("--target-length", default=32768, type=int, help="Target context length.")
@click.option("--method", default="yarn", type=click.Choice(["linear", "ntk", "yarn", "dynamic_ntk"]))
@click.option("--dataset", default=None, type=str, help="Path to long-context dataset.")
@click.option("--output-dir", default="./models/ailin-1b-32k", type=str, help="Output directory.")
@click.option("--epochs", default=1, type=int, help="Training epochs.")
@click.option("--lr", default=2e-5, type=float, help="Learning rate.")
@click.option("--batch-size", default=1, type=int, help="Per-device batch size.")
@click.option("--grad-accum", default=16, type=int, help="Gradient accumulation steps.")
@click.option("--lora-r", default=16, type=int, help="LoRA rank.")
@click.option("--no-lora", is_flag=True, help="Full fine-tuning.")
@click.option("--eval-only", is_flag=True, help="Only run needle-in-haystack evaluation.")
@click.option("--wandb-project", default="ailin-long-context", type=str)
@click.option("--seed", default=42, type=int)
def main(
    base_model: str,
    target_length: int,
    method: str,
    dataset: Optional[str],
    output_dir: str,
    epochs: int,
    lr: float,
    batch_size: int,
    grad_accum: int,
    lora_r: int,
    no_lora: bool,
    eval_only: bool,
    wandb_project: str,
    seed: int,
):
    """Extend model context window and fine-tune on long documents."""
    torch.manual_seed(seed)
    random.seed(seed)

    # Load config to get original max position
    logger.info("Loading model config from %s", base_model)
    config = AutoConfig.from_pretrained(base_model, trust_remote_code=True)
    original_max_pos = config.max_position_embeddings
    logger.info("Original max_position_embeddings: %d", original_max_pos)

    if target_length <= original_max_pos:
        logger.warning(
            "Target length (%d) <= original (%d). No scaling needed.",
            target_length, original_max_pos,
        )
        if not eval_only:
            logger.info("Skipping RoPE scaling.")
    else:
        # Apply RoPE scaling to config
        config = apply_rope_scaling(config, original_max_pos, target_length, method)
        logger.info("Applied %s RoPE scaling: %d -> %d", method, original_max_pos, target_length)

    # Load model with modified config
    logger.info("Loading model...")
    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        config=config,
        torch_dtype=torch.bfloat16,
        attn_implementation="sdpa",
        trust_remote_code=True,
    )

    tokenizer = AutoTokenizer.from_pretrained(
        base_model, trust_remote_code=True, padding_side="right",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.eos_token_id

    # LoRA
    if not no_lora and not eval_only:
        lora_config = LoraConfig(
            r=lora_r,
            lora_alpha=lora_r * 2,
            lora_dropout=0.05,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
            bias="none",
            task_type=TaskType.CAUSAL_LM,
        )
        model = get_peft_model(model, lora_config)
        model.print_trainable_parameters()

    if not eval_only:
        if dataset is None:
            raise click.UsageError("--dataset is required for training (not eval-only mode)")

        # Load long-context dataset
        logger.info("Loading long-context dataset...")
        data_splits = load_long_context_dataset(
            dataset, tokenizer, target_length, seed=seed,
        )

        os.environ.setdefault("WANDB_PROJECT", wandb_project)

        training_args = SFTConfig(
            output_dir=output_dir,
            run_name=f"ailin-long-ctx-{method}-{target_length}",
            num_train_epochs=epochs,
            per_device_train_batch_size=batch_size,
            per_device_eval_batch_size=batch_size,
            gradient_accumulation_steps=grad_accum,
            learning_rate=lr,
            weight_decay=0.01,
            warmup_ratio=0.05,
            lr_scheduler_type="cosine",
            max_grad_norm=1.0,
            bf16=True,
            tf32=True,
            gradient_checkpointing=True,
            max_seq_length=target_length,
            dataset_text_field="text",
            packing=False,
            save_strategy="steps",
            save_steps=50,
            save_total_limit=3,
            load_best_model_at_end=True,
            metric_for_best_model="eval_loss",
            eval_strategy="steps",
            eval_steps=25,
            logging_steps=5,
            report_to="wandb",
            seed=seed,
            remove_unused_columns=False,
            dataloader_num_workers=2,
        )

        trainer = SFTTrainer(
            model=model,
            args=training_args,
            train_dataset=data_splits["train"],
            eval_dataset=data_splits["test"],
            processing_class=tokenizer,
        )

        logger.info("Starting long-context fine-tuning...")
        trainer.train()

        # Save
        logger.info("Saving extended-context model to %s", output_dir)
        if not no_lora and isinstance(model, PeftModel):
            merged = model.merge_and_unload()
            merged.save_pretrained(output_dir)
        else:
            trainer.save_model(output_dir)
        tokenizer.save_pretrained(output_dir)

        # Save config with RoPE scaling info
        config.save_pretrained(output_dir)

    # ── Needle-in-haystack evaluation ────────────────────────
    logger.info("Running needle-in-haystack evaluation...")
    device = "cuda" if torch.cuda.is_available() else "cpu"

    if eval_only:
        model = model.to(device)

    # Test at various lengths and depths
    test_lengths = [
        l for l in [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072]
        if l <= target_length
    ]
    depth_percents = [0, 10, 25, 50, 75, 90, 100]

    needle_results = evaluate_needle_in_haystack(
        model, tokenizer, test_lengths, depth_percents, device=device,
    )

    # Print results
    logger.info("Needle-in-Haystack Results:")
    logger.info("  Overall accuracy: %.1f%%", needle_results["summary"]["overall_accuracy"] * 100)
    for ctx_len, acc in needle_results["summary"]["per_length"].items():
        logger.info("  Context %6d: %.1f%%", ctx_len, acc * 100)

    # Save results
    results_path = Path(output_dir) / "needle_eval_results.json"
    results_path.parent.mkdir(parents=True, exist_ok=True)
    with open(results_path, "w") as f:
        json.dump(needle_results, f, indent=2, default=str)
    logger.info("Needle eval results saved to %s", results_path)

    logger.info("Context extension complete.")


if __name__ == "__main__":
    main()
