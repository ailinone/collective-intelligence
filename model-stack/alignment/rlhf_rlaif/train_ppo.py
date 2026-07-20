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
PPO / RLHF Training Pipeline
==============================
Trains a language model policy using Proximal Policy Optimization (PPO)
with a learned reward model, using TRL's PPOTrainer.

Pipeline:
1. Load aligned model as policy + reference model
2. Load reward model for scoring
3. For each batch:
   a. Sample prompts
   b. Generate responses with the policy
   c. Score responses with the reward model
   d. Compute PPO loss with KL penalty against reference
   e. Update policy

Usage
-----
    python train_ppo.py \
        --policy-model ./models/ailin-1b-sft-merged \
        --reward-model ./models/ailin-1b-reward \
        --dataset ./data/sft/instructions \
        --output-dir ./models/ailin-1b-rlhf

    accelerate launch train_ppo.py \
        --policy-model ./models/ailin-1b-sft-merged \
        --reward-model ./models/ailin-1b-reward \
        --dataset ./data/sft/instructions
"""
from __future__ import annotations

import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Dict, List, Optional

import click
import torch
import torch.nn as nn
from datasets import Dataset, load_dataset, load_from_disk
from peft import LoraConfig, TaskType
from transformers import (
    AutoModelForCausalLM,
    AutoModelForSequenceClassification,
    AutoTokenizer,
    GenerationConfig,
)
from trl import (
    AutoModelForCausalLMWithValueHead,
    PPOConfig,
    PPOTrainer,
    create_reference_model,
)

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


# ── Dataset ──────────────────────────────────────────────────
def load_prompt_dataset(
    dataset_path: str,
    tokenizer: AutoTokenizer,
    max_prompt_length: int = 512,
    max_examples: Optional[int] = None,
    seed: int = 42,
) -> Dataset:
    """Load prompts for PPO training. Only needs the user prompts."""
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

    if max_examples:
        dataset = dataset.shuffle(seed=seed).select(range(min(max_examples, len(dataset))))

    logger.info("Loaded %d prompts", len(dataset))

    def extract_and_tokenize(example):
        # Extract prompt
        prompt = example.get("instruction", example.get("prompt", ""))
        input_text = example.get("input", "")
        if input_text:
            prompt = f"{prompt}\n\nInput:\n{input_text}"

        formatted = f"<|user|>\n{prompt}\n<|assistant|>\n"

        tokens = tokenizer(
            formatted,
            truncation=True,
            max_length=max_prompt_length,
            padding=False,
            return_tensors=None,
        )

        return {
            "input_ids": tokens["input_ids"],
            "attention_mask": tokens["attention_mask"],
            "query": formatted,
        }

    dataset = dataset.map(
        extract_and_tokenize,
        num_proc=4,
        desc="Tokenizing prompts",
    )

    dataset.set_format(type="torch", columns=["input_ids", "attention_mask"])
    return dataset


# ── Reward scoring ───────────────────────────────────────────
class RewardScorer:
    """Scores generated responses using a trained reward model."""

    def __init__(self, model_path: str, device: str = "cuda", torch_dtype=torch.bfloat16):
        logger.info("Loading reward model from %s", model_path)
        self.device = device
        self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        self.model = AutoModelForSequenceClassification.from_pretrained(
            model_path,
            num_labels=1,
            torch_dtype=torch_dtype,
            trust_remote_code=True,
        ).to(device).eval()

        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

    @torch.no_grad()
    def score(self, queries: List[str], responses: List[str]) -> List[torch.Tensor]:
        """Score query-response pairs. Returns list of scalar reward tensors."""
        rewards = []
        for query, response in zip(queries, responses):
            text = f"{query}{response}"
            inputs = self.tokenizer(
                text,
                return_tensors="pt",
                truncation=True,
                max_length=4096,
                padding=True,
            ).to(self.device)

            outputs = self.model(**inputs)
            reward = outputs.logits.squeeze(-1)
            rewards.append(reward.cpu().squeeze())

        return rewards


# ── PPO collator ─────────────────────────────────────────────
def collator(data):
    """Custom collator that handles variable-length input_ids."""
    return {key: [d[key] for d in data] for key in data[0]}


# ── Main ─────────────────────────────────────────────────────
@click.command()
@click.option("--policy-model", required=True, type=str, help="Path to SFT/aligned model (policy).")
@click.option("--reward-model", required=True, type=str, help="Path to trained reward model.")
@click.option("--dataset", required=True, type=str, help="Path to prompt dataset.")
@click.option("--output-dir", default="./models/ailin-1b-rlhf", type=str, help="Output directory.")
@click.option("--epochs", default=1, type=int, help="Number of PPO epochs per batch.")
@click.option("--ppo-epochs", default=4, type=int, help="PPO optimization epochs per batch.")
@click.option("--lr", default=1.41e-5, type=float, help="Learning rate.")
@click.option("--batch-size", default=64, type=int, help="PPO batch size.")
@click.option("--mini-batch-size", default=8, type=int, help="PPO mini-batch size.")
@click.option("--max-new-tokens", default=256, type=int, help="Max tokens to generate.")
@click.option("--max-prompt-length", default=512, type=int, help="Max prompt length.")
@click.option("--kl-penalty", default="kl", type=click.Choice(["kl", "abs", "mse", "full"]))
@click.option("--init-kl-coef", default=0.2, type=float, help="Initial KL penalty coefficient.")
@click.option("--target-kl", default=6.0, type=float, help="Target KL divergence.")
@click.option("--gamma", default=1.0, type=float, help="GAE gamma.")
@click.option("--lam", default=0.95, type=float, help="GAE lambda.")
@click.option("--clip-range", default=0.2, type=float, help="PPO clip range.")
@click.option("--vf-coef", default=0.1, type=float, help="Value function coefficient.")
@click.option("--max-steps", default=None, type=int, help="Max training steps (None=full epoch).")
@click.option("--max-examples", default=None, type=int, help="Max prompts to use from dataset.")
@click.option("--lora-r", default=16, type=int, help="LoRA rank (0=full fine-tuning).")
@click.option("--wandb-project", default="ailin-rlhf", type=str)
@click.option("--save-interval", default=100, type=int, help="Steps between saves.")
@click.option("--log-interval", default=10, type=int, help="Steps between logging.")
@click.option("--seed", default=42, type=int)
def main(
    policy_model: str,
    reward_model: str,
    dataset: str,
    output_dir: str,
    epochs: int,
    ppo_epochs: int,
    lr: float,
    batch_size: int,
    mini_batch_size: int,
    max_new_tokens: int,
    max_prompt_length: int,
    kl_penalty: str,
    init_kl_coef: float,
    target_kl: float,
    gamma: float,
    lam: float,
    clip_range: float,
    vf_coef: float,
    max_steps: Optional[int],
    max_examples: Optional[int],
    lora_r: int,
    wandb_project: str,
    save_interval: int,
    log_interval: int,
    seed: int,
):
    """Run PPO/RLHF training."""
    torch.manual_seed(seed)
    os.environ.setdefault("WANDB_PROJECT", wandb_project)

    # LoRA config
    lora_config = None
    if lora_r > 0:
        lora_config = LoraConfig(
            r=lora_r,
            lora_alpha=lora_r * 2,
            lora_dropout=0.05,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            bias="none",
            task_type=TaskType.CAUSAL_LM,
        )

    # PPO config
    ppo_config = PPOConfig(
        model_name=policy_model,
        learning_rate=lr,
        batch_size=batch_size,
        mini_batch_size=mini_batch_size,
        ppo_epochs=ppo_epochs,
        gamma=gamma,
        lam=lam,
        cliprange=clip_range,
        vf_coef=vf_coef,
        init_kl_coef=init_kl_coef,
        target=target_kl,
        kl_penalty=kl_penalty,
        log_with="wandb",
        seed=seed,
        optimize_cuda_cache=True,
    )

    # Load policy model with value head
    logger.info("Loading policy model from %s", policy_model)
    model = AutoModelForCausalLMWithValueHead.from_pretrained(
        policy_model,
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
        peft_config=lora_config,
    )

    # Tokenizer
    tokenizer = AutoTokenizer.from_pretrained(
        policy_model, trust_remote_code=True, padding_side="left",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # Reference model (frozen copy for KL penalty)
    logger.info("Creating reference model...")
    ref_model = create_reference_model(model)

    # Load prompts
    logger.info("Loading prompt dataset from %s", dataset)
    prompt_dataset = load_prompt_dataset(
        dataset, tokenizer, max_prompt_length=max_prompt_length,
        max_examples=max_examples, seed=seed,
    )

    # Reward scorer
    reward_scorer = RewardScorer(reward_model)

    # PPO Trainer
    ppo_trainer = PPOTrainer(
        config=ppo_config,
        model=model,
        ref_model=ref_model,
        tokenizer=tokenizer,
        dataset=prompt_dataset,
        data_collator=collator,
    )

    # Generation config
    gen_config = GenerationConfig(
        max_new_tokens=max_new_tokens,
        do_sample=True,
        top_p=0.9,
        top_k=50,
        temperature=0.7,
        pad_token_id=tokenizer.pad_token_id,
        eos_token_id=tokenizer.eos_token_id,
    )

    # ── Training loop ────────────────────────────────────────
    logger.info("Starting PPO training...")
    logger.info("  Batch size: %d", batch_size)
    logger.info("  Mini-batch size: %d", mini_batch_size)
    logger.info("  PPO epochs: %d", ppo_epochs)
    logger.info("  KL penalty: %s (init=%.2f, target=%.1f)", kl_penalty, init_kl_coef, target_kl)

    global_step = 0
    best_reward = float("-inf")
    training_stats_history = []

    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    for epoch in range(epochs):
        logger.info("Epoch %d/%d", epoch + 1, epochs)

        for batch_idx, batch in enumerate(ppo_trainer.dataloader):
            if max_steps and global_step >= max_steps:
                logger.info("Reached max_steps=%d. Stopping.", max_steps)
                break

            step_start = time.time()

            # 1. Get query tensors
            query_tensors = batch["input_ids"]

            # 2. Generate responses
            response_tensors = ppo_trainer.generate(
                query_tensors,
                return_prompt=False,
                generation_config=gen_config,
            )

            # 3. Decode for reward scoring
            queries_text = [tokenizer.decode(q, skip_special_tokens=True) for q in query_tensors]
            responses_text = [tokenizer.decode(r, skip_special_tokens=True) for r in response_tensors]

            # 4. Score with reward model
            rewards = reward_scorer.score(queries_text, responses_text)

            # 5. PPO step
            stats = ppo_trainer.step(query_tensors, response_tensors, rewards)

            # 6. Logging
            global_step += 1
            step_time = time.time() - step_start

            mean_reward = torch.stack(rewards).mean().item()
            kl_div = stats.get("objective/kl", 0)
            policy_loss = stats.get("ppo/loss/policy", 0)
            value_loss = stats.get("ppo/loss/value", 0)
            entropy = stats.get("ppo/policy/entropy", 0)

            if global_step % log_interval == 0:
                logger.info(
                    "step=%d reward=%.3f kl=%.3f policy_loss=%.4f "
                    "value_loss=%.4f entropy=%.3f time=%.1fs",
                    global_step, mean_reward, kl_div, policy_loss,
                    value_loss, entropy, step_time,
                )

                # Log to W&B via PPOTrainer
                ppo_trainer.log_stats(
                    stats,
                    batch,
                    rewards,
                    columns_to_log=["query", "response"],
                )

            training_stats_history.append({
                "step": global_step,
                "mean_reward": mean_reward,
                "kl": kl_div,
                "policy_loss": policy_loss,
                "value_loss": value_loss,
                "entropy": entropy,
                "step_time": step_time,
            })

            # 7. Save checkpoints
            if global_step % save_interval == 0:
                ckpt_dir = output_path / f"step-{global_step}"
                logger.info("Saving checkpoint at step %d to %s", global_step, ckpt_dir)
                ppo_trainer.save_pretrained(str(ckpt_dir))

                if mean_reward > best_reward:
                    best_reward = mean_reward
                    best_dir = output_path / "best"
                    logger.info("New best reward: %.3f. Saving to %s", best_reward, best_dir)
                    ppo_trainer.save_pretrained(str(best_dir))

        if max_steps and global_step >= max_steps:
            break

    # ── Final save ───────────────────────────────────────────
    logger.info("Saving final RLHF model to %s", output_dir)
    ppo_trainer.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)

    # Save training stats
    stats_path = output_path / "training_stats.json"
    with open(stats_path, "w") as f:
        json.dump(training_stats_history, f, indent=2, default=str)

    # Summary
    if training_stats_history:
        final_stats = training_stats_history[-1]
        logger.info("Training complete.")
        logger.info("  Total steps: %d", global_step)
        logger.info("  Final mean reward: %.3f", final_stats["mean_reward"])
        logger.info("  Best mean reward: %.3f", best_reward)
        logger.info("  Final KL: %.3f", final_stats["kl"])
    else:
        logger.info("Training complete (no steps executed).")


if __name__ == "__main__":
    main()
