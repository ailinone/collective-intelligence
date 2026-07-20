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
End-to-end smoke test: train → checkpoint → eval → register → report.

Trains an ailin-tiny (~500K params) model on CPU for a few steps using
synthetic data, then runs a minimal evaluation and registers the checkpoint.
This proves the entire pipeline works operationally.

Usage:
    python scripts/smoke_train_cpu.py --steps 20 --output ./smoke-run
"""

from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import click
import torch
import yaml
from torch.utils.data import DataLoader, Dataset
from transformers import LlamaConfig, LlamaForCausalLM, AutoTokenizer

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("smoke-train")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


# ---------------------------------------------------------------------------
# Synthetic dataset
# ---------------------------------------------------------------------------

class SyntheticDataset(Dataset):
    """Generate random token sequences for smoke testing."""

    def __init__(self, vocab_size: int, seq_len: int, num_samples: int):
        self.vocab_size = vocab_size
        self.seq_len = seq_len
        self.num_samples = num_samples

    def __len__(self) -> int:
        return self.num_samples

    def __getitem__(self, idx: int) -> dict:
        input_ids = torch.randint(0, self.vocab_size, (self.seq_len,))
        return {"input_ids": input_ids, "labels": input_ids.clone()}


# ---------------------------------------------------------------------------
# Training
# ---------------------------------------------------------------------------

def build_model(config_path: Path) -> tuple[LlamaForCausalLM, dict]:
    """Build model from YAML config."""
    with open(config_path) as f:
        raw = yaml.safe_load(f)
    cfg = raw["model"]

    llama_config = LlamaConfig(
        vocab_size=cfg["vocab_size"],
        hidden_size=cfg["hidden_size"],
        intermediate_size=cfg["intermediate_size"],
        num_hidden_layers=cfg["num_layers"],
        num_attention_heads=cfg["num_attention_heads"],
        num_key_value_heads=cfg.get("num_key_value_heads", cfg["num_attention_heads"]),
        max_position_embeddings=cfg.get("max_position_embeddings", 512),
        rms_norm_eps=float(cfg.get("layer_norm_eps", 1e-5)),
        rope_theta=float(cfg.get("rope_theta", 10000.0)),
        tie_word_embeddings=cfg.get("tie_word_embeddings", True),
        hidden_act=cfg.get("hidden_act", "silu"),
        use_cache=False,
    )

    model = LlamaForCausalLM(llama_config)
    param_count = sum(p.numel() for p in model.parameters())
    logger.info("Model built: %s — %s parameters", cfg["name"], f"{param_count:,}")

    return model, cfg


def train(
    model: LlamaForCausalLM,
    cfg: dict,
    output_dir: Path,
    steps: int,
    batch_size: int,
    lr: float,
) -> dict:
    """Run training loop on CPU."""
    vocab_size = cfg["vocab_size"]
    seq_len = min(cfg.get("max_position_embeddings", 512), 128)  # short for CPU
    dataset = SyntheticDataset(vocab_size, seq_len, num_samples=steps * batch_size)
    loader = DataLoader(dataset, batch_size=batch_size, shuffle=True)

    optimizer = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    model.train()

    metrics = {
        "losses": [],
        "grad_norms": [],
        "throughput_tokens_per_sec": [],
        "total_tokens": 0,
        "total_time_sec": 0.0,
    }

    logger.info("Starting training: %d steps, batch_size=%d, seq_len=%d, lr=%s", steps, batch_size, seq_len, lr)
    start = time.time()

    for step, batch in enumerate(loader):
        if step >= steps:
            break

        step_start = time.time()
        outputs = model(input_ids=batch["input_ids"], labels=batch["labels"])
        loss = outputs.loss

        loss.backward()

        grad_norm = torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0).item()
        optimizer.step()
        optimizer.zero_grad()

        step_time = time.time() - step_start
        tokens = batch_size * seq_len
        tps = tokens / step_time if step_time > 0 else 0

        metrics["losses"].append(loss.item())
        metrics["grad_norms"].append(grad_norm)
        metrics["throughput_tokens_per_sec"].append(tps)
        metrics["total_tokens"] += tokens

        if (step + 1) % 5 == 0 or step == 0:
            logger.info(
                "step %d/%d | loss=%.4f | grad_norm=%.4f | tps=%.0f",
                step + 1, steps, loss.item(), grad_norm, tps,
            )

    metrics["total_time_sec"] = time.time() - start
    metrics["final_loss"] = metrics["losses"][-1] if metrics["losses"] else float("nan")
    metrics["mean_tps"] = sum(metrics["throughput_tokens_per_sec"]) / len(metrics["throughput_tokens_per_sec"]) if metrics["throughput_tokens_per_sec"] else 0

    # Save checkpoint
    ckpt_dir = output_dir / "checkpoint"
    ckpt_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(ckpt_dir)
    logger.info("Checkpoint saved to %s", ckpt_dir)

    # Save training metrics
    with open(output_dir / "training_metrics.json", "w") as f:
        json.dump(metrics, f, indent=2)

    return metrics


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

def evaluate(model: LlamaForCausalLM, cfg: dict) -> dict:
    """Run minimal evaluation on the trained model."""
    model.eval()
    results = {}

    # 1. Perplexity on random data
    vocab_size = cfg["vocab_size"]
    seq_len = 64
    total_loss = 0.0
    n_batches = 10

    with torch.no_grad():
        for _ in range(n_batches):
            input_ids = torch.randint(0, vocab_size, (1, seq_len))
            outputs = model(input_ids=input_ids, labels=input_ids)
            total_loss += outputs.loss.item()

    avg_loss = total_loss / n_batches
    perplexity = math.exp(min(avg_loss, 20))  # cap to avoid overflow
    results["perplexity"] = round(perplexity, 2)
    results["avg_loss"] = round(avg_loss, 4)

    # 2. Generation test
    prompt = torch.randint(0, vocab_size, (1, 10))
    with torch.no_grad():
        generated = model.generate(
            input_ids=prompt,
            max_new_tokens=20,
            do_sample=True,
            temperature=0.8,
            top_p=0.9,
        )
    results["generation_length"] = generated.shape[1]
    results["generation_success"] = generated.shape[1] > prompt.shape[1]

    # 3. Param stats
    param_count = sum(p.numel() for p in model.parameters())
    results["param_count"] = param_count
    results["param_count_human"] = f"{param_count:,}"

    # 4. Weight statistics
    weight_norms = []
    for name, param in model.named_parameters():
        weight_norms.append({"name": name, "norm": round(param.data.norm().item(), 4), "shape": list(param.shape)})
    results["weight_stats"] = {
        "num_params": len(weight_norms),
        "mean_norm": round(sum(w["norm"] for w in weight_norms) / len(weight_norms), 4),
    }

    logger.info("Eval results: perplexity=%.2f, loss=%.4f, gen_ok=%s", perplexity, avg_loss, results["generation_success"])
    return results


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

def register_checkpoint(output_dir: Path, cfg: dict, train_metrics: dict, eval_results: dict) -> dict:
    """Register checkpoint in the model registry."""
    config_hash = hashlib.sha256(json.dumps(cfg, sort_keys=True).encode()).hexdigest()[:16]
    timestamp = datetime.now(timezone.utc).isoformat()

    entry = {
        "model_name": cfg["name"],
        "model_family": cfg.get("family", "ailin"),
        "variant": cfg.get("variant", "base"),
        "version": "v0.0.1-smoke",
        "checkpoint_path": str(output_dir / "checkpoint"),
        "config_hash": config_hash,
        "param_count": eval_results["param_count"],
        "created_at": timestamp,
        "training": {
            "steps": len(train_metrics["losses"]),
            "final_loss": train_metrics["final_loss"],
            "total_tokens": train_metrics["total_tokens"],
            "total_time_sec": round(train_metrics["total_time_sec"], 2),
            "mean_tps": round(train_metrics["mean_tps"], 1),
        },
        "eval": {
            "perplexity": eval_results["perplexity"],
            "avg_loss": eval_results["avg_loss"],
            "generation_success": eval_results["generation_success"],
        },
        "status": "registered",
        "promotion": "pending",
    }

    registry_dir = output_dir / "registry"
    registry_dir.mkdir(parents=True, exist_ok=True)
    with open(registry_dir / "checkpoint_entry.yaml", "w") as f:
        yaml.dump(entry, f, default_flow_style=False)

    logger.info("Checkpoint registered: %s %s", cfg["name"], entry["version"])
    return entry


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def generate_report(
    output_dir: Path,
    cfg: dict,
    train_metrics: dict,
    eval_results: dict,
    registry_entry: dict,
) -> Path:
    """Generate a full evaluation report."""
    report = {
        "report_type": "smoke_test_operational_proof",
        "model": cfg["name"],
        "family": cfg.get("family", "ailin"),
        "variant": cfg.get("variant", "base"),
        "version": registry_entry["version"],
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "pipeline_stages_completed": [
            "model_build",
            "training",
            "checkpoint_save",
            "evaluation",
            "registry_registration",
            "report_generation",
        ],
        "training_summary": {
            "steps": len(train_metrics["losses"]),
            "final_loss": train_metrics["final_loss"],
            "initial_loss": train_metrics["losses"][0] if train_metrics["losses"] else None,
            "loss_decreased": (
                train_metrics["losses"][-1] < train_metrics["losses"][0]
                if len(train_metrics["losses"]) > 1
                else False
            ),
            "total_tokens": train_metrics["total_tokens"],
            "wall_time_sec": round(train_metrics["total_time_sec"], 2),
            "mean_throughput_tps": round(train_metrics["mean_tps"], 1),
        },
        "evaluation_summary": {
            "perplexity": eval_results["perplexity"],
            "avg_loss": eval_results["avg_loss"],
            "generation_success": eval_results["generation_success"],
            "param_count": eval_results["param_count"],
        },
        "checkpoint": {
            "path": str(output_dir / "checkpoint"),
            "config_hash": registry_entry["config_hash"],
            "status": registry_entry["status"],
        },
        "verdict": {
            "pipeline_operational": True,
            "all_stages_completed": True,
            "loss_decreased_during_training": (
                train_metrics["losses"][-1] < train_metrics["losses"][0]
                if len(train_metrics["losses"]) > 1
                else False
            ),
            "model_generates_tokens": eval_results["generation_success"],
            "note": "Smoke test on CPU with synthetic data. Proves pipeline works end-to-end. NOT a production model.",
        },
    }

    report_path = output_dir / "eval_report.json"
    with open(report_path, "w") as f:
        json.dump(report, f, indent=2)

    logger.info("Report saved to %s", report_path)
    return report_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option("--config", default=str(ROOT / "model" / "configs" / "ailin-tiny.yaml"), help="Model config YAML")
@click.option("--steps", default=20, help="Training steps")
@click.option("--batch-size", default=2, help="Batch size")
@click.option("--lr", default=1e-3, help="Learning rate")
@click.option("--output", default=str(ROOT / "smoke-run"), help="Output directory")
def main(config: str, steps: int, batch_size: int, lr: float, output: str):
    """Run end-to-end smoke test: train → eval → register → report."""
    output_dir = Path(output)
    output_dir.mkdir(parents=True, exist_ok=True)

    logger.info("=" * 60)
    logger.info("SMOKE TEST: End-to-end pipeline validation")
    logger.info("=" * 60)

    # 1. Build model
    logger.info("[1/5] Building model from %s", config)
    model, cfg = build_model(Path(config))

    # 2. Train
    logger.info("[2/5] Training for %d steps on CPU", steps)
    train_metrics = train(model, cfg, output_dir, steps, batch_size, lr)

    # 3. Evaluate
    logger.info("[3/5] Running evaluation")
    eval_results = evaluate(model, cfg)

    # 4. Register
    logger.info("[4/5] Registering checkpoint")
    registry_entry = register_checkpoint(output_dir, cfg, train_metrics, eval_results)

    # 5. Report
    logger.info("[5/5] Generating report")
    report_path = generate_report(output_dir, cfg, train_metrics, eval_results, registry_entry)

    # Summary
    logger.info("=" * 60)
    logger.info("SMOKE TEST COMPLETE")
    logger.info("  Model:          %s (%s params)", cfg["name"], f"{eval_results['param_count']:,}")
    logger.info("  Steps:          %d", steps)
    logger.info("  Final loss:     %.4f", train_metrics["final_loss"])
    logger.info("  Loss decreased: %s", train_metrics["losses"][-1] < train_metrics["losses"][0] if len(train_metrics["losses"]) > 1 else "N/A")
    logger.info("  Perplexity:     %.2f", eval_results["perplexity"])
    logger.info("  Generation OK:  %s", eval_results["generation_success"])
    logger.info("  Checkpoint:     %s", output_dir / "checkpoint")
    logger.info("  Report:         %s", report_path)
    logger.info("  Registry:       %s", output_dir / "registry" / "checkpoint_entry.yaml")
    logger.info("=" * 60)


if __name__ == "__main__":
    main()
