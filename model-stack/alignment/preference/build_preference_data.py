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
Preference Data Construction
==============================
Generates preference pairs (chosen/rejected) from an instruction dataset
by sampling multiple completions and scoring them.

Usage
-----
    python build_preference_data.py \
        --model ./models/ailin-1b-sft-merged \
        --dataset ./data/sft/instructions \
        --output ./data/preference/pairs.jsonl \
        --num-completions 4 \
        --max-examples 10000

    # With a separate reward model for scoring
    python build_preference_data.py \
        --model ./models/ailin-1b-sft-merged \
        --dataset ./data/sft/instructions \
        --output ./data/preference/pairs.jsonl \
        --reward-model ./models/ailin-1b-reward
"""
from __future__ import annotations

import json
import logging
import os
import random
import re
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import click
import torch
from datasets import Dataset, load_dataset, load_from_disk
from torch.utils.data import DataLoader
from tqdm import tqdm
from transformers import (
    AutoModelForCausalLM,
    AutoModelForSequenceClassification,
    AutoTokenizer,
    GenerationConfig,
)

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


# ── Scoring criteria ─────────────────────────────────────────
class HeuristicScorer:
    """
    Rule-based scorer when no reward model is available.
    Scores based on helpfulness, harmlessness, and honesty heuristics.
    """

    # Basic harmful patterns (simplified; real systems use classifiers)
    HARMFUL_PATTERNS = [
        r"\b(kill|murder|attack|bomb|weapon|hack|exploit)\b",
        r"\b(I cannot|I can't|I won't|I'm unable)\b.*\b(but here's how|however|nevertheless)\b",
    ]

    def __init__(self):
        self.weights = {
            "length_quality": 0.2,
            "instruction_following": 0.3,
            "harmlessness": 0.2,
            "coherence": 0.15,
            "formatting": 0.15,
        }

    def score(self, prompt: str, completion: str) -> Dict[str, float]:
        scores = {}

        # Length quality: penalize too short or too long
        word_count = len(completion.split())
        if word_count < 10:
            scores["length_quality"] = 0.2
        elif word_count < 50:
            scores["length_quality"] = 0.5
        elif word_count < 500:
            scores["length_quality"] = 1.0
        elif word_count < 1000:
            scores["length_quality"] = 0.8
        else:
            scores["length_quality"] = 0.6

        # Instruction following: does it address the prompt?
        prompt_keywords = set(prompt.lower().split())
        completion_lower = completion.lower()
        keyword_overlap = sum(1 for kw in prompt_keywords if kw in completion_lower)
        scores["instruction_following"] = min(1.0, keyword_overlap / max(len(prompt_keywords), 1))

        # Harmlessness: check for harmful patterns
        harm_score = 1.0
        for pattern in self.HARMFUL_PATTERNS:
            if re.search(pattern, completion, re.IGNORECASE):
                harm_score -= 0.3
        scores["harmlessness"] = max(0.0, harm_score)

        # Coherence: sentence count ratio, repetition check
        sentences = [s.strip() for s in re.split(r'[.!?]+', completion) if s.strip()]
        if len(sentences) > 1:
            unique_ratio = len(set(sentences)) / len(sentences)
            scores["coherence"] = unique_ratio
        else:
            scores["coherence"] = 0.5

        # Formatting: proper structure (paragraphs, lists, etc.)
        has_structure = bool(
            re.search(r'\n\n|\n-|\n\d+\.|\n\*', completion)
        )
        starts_well = not completion.startswith((" ", "\n", "  "))
        scores["formatting"] = 0.5 + 0.25 * has_structure + 0.25 * starts_well

        # Weighted total
        total = sum(scores[k] * self.weights[k] for k in self.weights)
        scores["total"] = total

        return scores


class RewardModelScorer:
    """Score completions using a trained reward model."""

    def __init__(self, model_path: str, device: str = "cuda"):
        self.device = device
        logger.info("Loading reward model from %s", model_path)
        self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        self.model = AutoModelForSequenceClassification.from_pretrained(
            model_path,
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        ).to(device).eval()

        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

    @torch.no_grad()
    def score(self, prompt: str, completion: str) -> Dict[str, float]:
        text = f"<|user|>\n{prompt}\n<|assistant|>\n{completion}"
        inputs = self.tokenizer(
            text, return_tensors="pt", truncation=True, max_length=4096, padding=True,
        ).to(self.device)
        outputs = self.model(**inputs)
        reward = outputs.logits.squeeze(-1).item()
        return {"total": reward, "reward_model": reward}


# ── Completion generation ────────────────────────────────────
class CompletionGenerator:
    """Generate multiple completions for each prompt."""

    def __init__(
        self,
        model_path: str,
        device: str = "cuda",
        max_new_tokens: int = 1024,
    ):
        self.device = device
        self.max_new_tokens = max_new_tokens

        logger.info("Loading generation model from %s", model_path)
        self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        self.model = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch.bfloat16,
            trust_remote_code=True,
        ).to(device).eval()

        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        self.gen_config = GenerationConfig(
            max_new_tokens=max_new_tokens,
            do_sample=True,
            top_p=0.9,
            top_k=50,
            temperature=0.8,
            repetition_penalty=1.1,
            pad_token_id=self.tokenizer.pad_token_id,
            eos_token_id=self.tokenizer.eos_token_id,
        )

    @torch.no_grad()
    def generate(self, prompt: str, num_completions: int = 4) -> List[str]:
        """Generate multiple completions for a single prompt."""
        formatted = f"<|user|>\n{prompt}\n<|assistant|>\n"
        inputs = self.tokenizer(formatted, return_tensors="pt").to(self.device)

        completions = []
        for _ in range(num_completions):
            # Vary temperature slightly for diversity
            gen_config = GenerationConfig(
                max_new_tokens=self.max_new_tokens,
                do_sample=True,
                top_p=random.uniform(0.85, 0.95),
                top_k=random.randint(30, 70),
                temperature=random.uniform(0.6, 1.0),
                repetition_penalty=1.1,
                pad_token_id=self.tokenizer.pad_token_id,
                eos_token_id=self.tokenizer.eos_token_id,
            )

            output = self.model.generate(**inputs, generation_config=gen_config)
            generated_tokens = output[0][inputs["input_ids"].shape[1]:]
            text = self.tokenizer.decode(generated_tokens, skip_special_tokens=True)
            completions.append(text.strip())

        return completions


# ── Pair construction ────────────────────────────────────────
def construct_pairs(
    prompt: str,
    completions: List[str],
    scores: List[Dict[str, float]],
    margin: float = 0.1,
) -> List[Dict]:
    """
    Create chosen/rejected pairs from scored completions.
    Only creates pairs where the score difference exceeds the margin.
    """
    indexed = list(enumerate(scores))
    indexed.sort(key=lambda x: x[1]["total"], reverse=True)

    pairs = []
    for i in range(len(indexed)):
        for j in range(i + 1, len(indexed)):
            idx_chosen, score_chosen = indexed[i]
            idx_rejected, score_rejected = indexed[j]

            if score_chosen["total"] - score_rejected["total"] >= margin:
                pairs.append({
                    "prompt": prompt,
                    "chosen": completions[idx_chosen],
                    "rejected": completions[idx_rejected],
                    "chosen_score": score_chosen["total"],
                    "rejected_score": score_rejected["total"],
                    "score_diff": score_chosen["total"] - score_rejected["total"],
                })

    return pairs


# ── Dataset loading ──────────────────────────────────────────
def load_instruction_dataset(path: str, max_examples: Optional[int] = None) -> List[Dict]:
    """Load instruction dataset."""
    p = Path(path)
    if p.exists():
        if p.suffix in (".json", ".jsonl"):
            ds = load_dataset("json", data_files=str(p), split="train")
        elif p.is_dir():
            try:
                ds = load_from_disk(str(p))
                if hasattr(ds, "keys"):
                    ds = ds["train"] if "train" in ds else list(ds.values())[0]
            except Exception:
                ds = load_dataset(str(p), split="train")
        else:
            ds = load_dataset(str(p), split="train")
    else:
        ds = load_dataset(path, split="train")

    examples = list(ds)
    if max_examples:
        examples = examples[:max_examples]

    return examples


def extract_prompt(example: Dict) -> str:
    """Extract the prompt/instruction from various formats."""
    if "instruction" in example:
        prompt = example["instruction"]
        if example.get("input"):
            prompt += f"\n\nInput:\n{example['input']}"
        return prompt
    elif "prompt" in example:
        return example["prompt"]
    elif "messages" in example:
        for msg in example["messages"]:
            if msg.get("role") == "user":
                return msg["content"]
    return str(example.get("text", ""))


# ── Main pipeline ────────────────────────────────────────────
@click.command()
@click.option("--model", required=True, type=str, help="Path to SFT model for generating completions.")
@click.option("--dataset", required=True, type=str, help="Path to instruction dataset.")
@click.option("--output", required=True, type=str, help="Output path for preference pairs (JSONL).")
@click.option("--reward-model", default=None, type=str, help="Optional reward model for scoring.")
@click.option("--num-completions", default=4, type=int, help="Completions to generate per prompt.")
@click.option("--max-examples", default=None, type=int, help="Max number of prompts to process.")
@click.option("--batch-size", default=1, type=int, help="Batch size for generation.")
@click.option("--margin", default=0.1, type=float, help="Minimum score difference for pair creation.")
@click.option("--max-new-tokens", default=1024, type=int, help="Max tokens per completion.")
@click.option("--device", default="cuda", type=str, help="Device for inference.")
@click.option("--seed", default=42, type=int, help="Random seed.")
def main(
    model: str,
    dataset: str,
    output: str,
    reward_model: Optional[str],
    num_completions: int,
    max_examples: Optional[int],
    batch_size: int,
    margin: float,
    max_new_tokens: int,
    device: str,
    seed: int,
):
    """Build preference dataset from instruction data + model completions."""
    random.seed(seed)
    torch.manual_seed(seed)

    # Load instruction data
    logger.info("Loading instruction dataset from %s", dataset)
    examples = load_instruction_dataset(dataset, max_examples)
    logger.info("Loaded %d examples", len(examples))

    # Initialize generator and scorer
    generator = CompletionGenerator(model, device=device, max_new_tokens=max_new_tokens)

    if reward_model:
        scorer = RewardModelScorer(reward_model, device=device)
    else:
        logger.info("No reward model specified; using heuristic scorer.")
        scorer = HeuristicScorer()

    # Process examples
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    total_pairs = 0
    stats = {"total_prompts": 0, "total_completions": 0, "total_pairs": 0}

    with open(output_path, "w") as fout:
        for idx, example in enumerate(tqdm(examples, desc="Building preferences")):
            prompt = extract_prompt(example)
            if not prompt.strip():
                continue

            # Generate completions
            completions = generator.generate(prompt, num_completions=num_completions)
            stats["total_completions"] += len(completions)

            # Score each completion
            scores = [scorer.score(prompt, c) for c in completions]

            # Create pairs
            pairs = construct_pairs(prompt, completions, scores, margin=margin)

            for pair in pairs:
                fout.write(json.dumps(pair, ensure_ascii=False) + "\n")
                total_pairs += 1

            stats["total_prompts"] += 1
            stats["total_pairs"] = total_pairs

            if (idx + 1) % 100 == 0:
                logger.info(
                    "Progress: %d/%d prompts, %d pairs generated",
                    idx + 1, len(examples), total_pairs,
                )

    # Summary
    logger.info("Preference data construction complete.")
    logger.info("  Prompts processed: %d", stats["total_prompts"])
    logger.info("  Total completions: %d", stats["total_completions"])
    logger.info("  Total pairs: %d", stats["total_pairs"])
    logger.info("  Avg pairs/prompt: %.1f", stats["total_pairs"] / max(stats["total_prompts"], 1))
    logger.info("  Output: %s", output_path)

    # Save stats
    stats_path = output_path.with_suffix(".stats.json")
    with open(stats_path, "w") as f:
        json.dump(stats, f, indent=2)
    logger.info("Stats saved to %s", stats_path)


if __name__ == "__main__":
    main()
