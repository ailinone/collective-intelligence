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
Ailin-1B Pre-training Launcher
===============================
Distributed pre-training with Accelerate + DeepSpeed ZeRO-2.
Supports resumption, W&B logging, gradient health checks, and
throughput tracking.

Usage
-----
    accelerate launch --config_file accelerate_config.yaml \
        train.py --config ../configs/pretrain_1b.yaml

    # Resume from latest checkpoint
    accelerate launch ... train.py --config ... --resume
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import signal
import sys
import time
from contextlib import nullcontext
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Optional

import click
import torch
import torch.nn as nn
import yaml
from accelerate import Accelerator, DistributedDataParallelKwargs
from accelerate.utils import set_seed
from torch.utils.data import DataLoader, Dataset, IterableDataset

logger = logging.getLogger(__name__)

# ── Graceful shutdown ────────────────────────────────────────
_SHUTDOWN_REQUESTED = False


def _signal_handler(signum, frame):
    global _SHUTDOWN_REQUESTED
    _SHUTDOWN_REQUESTED = True
    logger.warning("Shutdown requested (signal %s). Will save checkpoint and exit.", signum)


signal.signal(signal.SIGINT, _signal_handler)
signal.signal(signal.SIGTERM, _signal_handler)


# ── Config loading ───────────────────────────────────────────
@dataclass
class TrainConfig:
    """Flat representation of the YAML config for easy access."""

    run_name: str = "ailin-pretrain"
    seed: int = 42

    # model
    hidden_size: int = 2048
    num_attention_heads: int = 16
    num_key_value_heads: int = 4
    num_hidden_layers: int = 24
    intermediate_size: int = 5504
    vocab_size: int = 32000
    max_position_embeddings: int = 4096
    rms_norm_eps: float = 1e-5
    rope_theta: float = 10000.0
    tie_word_embeddings: bool = False
    attention_dropout: float = 0.0
    hidden_dropout: float = 0.0

    # optimizer
    lr: float = 3e-4
    weight_decay: float = 0.1
    betas: tuple = (0.9, 0.95)
    eps: float = 1e-8

    # scheduler
    scheduler_name: str = "cosine"
    warmup_steps: int = 2000
    min_lr_ratio: float = 0.1

    # training
    global_batch_size: int = 512
    micro_batch_size: int = 4
    gradient_accumulation_steps: int = 128
    max_steps: int = 100000
    max_seq_length: int = 4096
    gradient_clipping: float = 1.0

    # precision
    dtype: str = "bf16"
    tf32: bool = True

    # checkpointing
    save_interval: int = 1000
    save_dir: str = "./checkpoints/ailin-1b"
    keep_last_n: int = 5
    keep_best_k: int = 3
    save_optimizer: bool = True

    # evaluation
    eval_interval: int = 500
    eval_steps: int = 50

    # logging
    log_interval: int = 10
    wandb_enabled: bool = True
    wandb_project: str = "ailin-pretrain"
    wandb_entity: Optional[str] = None
    wandb_tags: list = field(default_factory=lambda: ["1b", "pretrain"])

    # data
    train_path: str = "./data/pretrain/train"
    val_path: str = "./data/pretrain/val"
    tokenizer_path: str = "./tokenizer/ailin-32k"
    num_workers: int = 8
    prefetch_factor: int = 4

    # distributed
    deepspeed_config: str = "../distributed/deepspeed_config.json"
    gradient_checkpointing: bool = True

    # raw yaml for hashing
    _raw: Dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def from_yaml(cls, path: str) -> "TrainConfig":
        with open(path) as f:
            raw = yaml.safe_load(f)

        m = raw.get("model", {})
        opt = raw.get("optimizer", {})
        sched = raw.get("scheduler", {})
        tr = raw.get("training", {})
        prec = raw.get("precision", {})
        ckpt = raw.get("checkpointing", {})
        ev = raw.get("evaluation", {})
        lg = raw.get("logging", {})
        data = raw.get("data", {})
        dist = raw.get("distributed", {})
        wb = lg.get("wandb", {})

        return cls(
            run_name=raw.get("run_name", "ailin-pretrain"),
            seed=raw.get("seed", 42),
            hidden_size=m.get("hidden_size", 2048),
            num_attention_heads=m.get("num_attention_heads", 16),
            num_key_value_heads=m.get("num_key_value_heads", 4),
            num_hidden_layers=m.get("num_hidden_layers", 24),
            intermediate_size=m.get("intermediate_size", 5504),
            vocab_size=m.get("vocab_size", 32000),
            max_position_embeddings=m.get("max_position_embeddings", 4096),
            rms_norm_eps=m.get("rms_norm_eps", 1e-5),
            rope_theta=m.get("rope_theta", 10000.0),
            tie_word_embeddings=m.get("tie_word_embeddings", False),
            attention_dropout=m.get("attention_dropout", 0.0),
            hidden_dropout=m.get("hidden_dropout", 0.0),
            lr=opt.get("lr", 3e-4),
            weight_decay=opt.get("weight_decay", 0.1),
            betas=tuple(opt.get("betas", [0.9, 0.95])),
            eps=opt.get("eps", 1e-8),
            scheduler_name=sched.get("name", "cosine"),
            warmup_steps=sched.get("warmup_steps", 2000),
            min_lr_ratio=sched.get("min_lr_ratio", 0.1),
            global_batch_size=tr.get("global_batch_size", 512),
            micro_batch_size=tr.get("micro_batch_size", 4),
            gradient_accumulation_steps=tr.get("gradient_accumulation_steps", 128),
            max_steps=tr.get("max_steps", 100000),
            max_seq_length=tr.get("max_seq_length", 4096),
            gradient_clipping=tr.get("gradient_clipping", 1.0),
            dtype=prec.get("dtype", "bf16"),
            tf32=prec.get("tf32", True),
            save_interval=ckpt.get("save_interval", 1000),
            save_dir=ckpt.get("save_dir", "./checkpoints/ailin-1b"),
            keep_last_n=ckpt.get("keep_last_n", 5),
            keep_best_k=ckpt.get("keep_best_k", 3),
            save_optimizer=ckpt.get("save_optimizer", True),
            eval_interval=ev.get("eval_interval", 500),
            eval_steps=ev.get("eval_steps", 50),
            log_interval=lg.get("log_interval", 10),
            wandb_enabled=wb.get("enabled", True),
            wandb_project=wb.get("project", "ailin-pretrain"),
            wandb_entity=wb.get("entity"),
            wandb_tags=wb.get("tags", ["1b", "pretrain"]),
            train_path=data.get("train_path", "./data/pretrain/train"),
            val_path=data.get("val_path", "./data/pretrain/val"),
            tokenizer_path=data.get("tokenizer", "./tokenizer/ailin-32k"),
            num_workers=data.get("num_workers", 8),
            prefetch_factor=data.get("prefetch_factor", 4),
            deepspeed_config=dist.get("deepspeed_config", "../distributed/deepspeed_config.json"),
            gradient_checkpointing=dist.get("gradient_checkpointing", True),
            _raw=raw,
        )

    def config_hash(self) -> str:
        """Deterministic hash of the model-relevant config (for checkpoint validation)."""
        keys = [
            "hidden_size", "num_attention_heads", "num_key_value_heads",
            "num_hidden_layers", "intermediate_size", "vocab_size",
            "max_position_embeddings",
        ]
        payload = {k: getattr(self, k) for k in keys}
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()[:16]


# ── Model builder ────────────────────────────────────────────
def build_model(cfg: TrainConfig) -> nn.Module:
    """Build an LLaMA-style model using HuggingFace transformers."""
    from transformers import LlamaConfig, LlamaForCausalLM

    model_config = LlamaConfig(
        hidden_size=cfg.hidden_size,
        num_attention_heads=cfg.num_attention_heads,
        num_key_value_heads=cfg.num_key_value_heads,
        num_hidden_layers=cfg.num_hidden_layers,
        intermediate_size=cfg.intermediate_size,
        vocab_size=cfg.vocab_size,
        max_position_embeddings=cfg.max_position_embeddings,
        rms_norm_eps=cfg.rms_norm_eps,
        rope_theta=cfg.rope_theta,
        tie_word_embeddings=cfg.tie_word_embeddings,
        attention_dropout=cfg.attention_dropout,
        hidden_act="silu",
    )
    model = LlamaForCausalLM(model_config)

    if cfg.gradient_checkpointing:
        model.gradient_checkpointing_enable()

    # Log parameter count
    total_params = sum(p.numel() for p in model.parameters())
    trainable_params = sum(p.numel() for p in model.parameters() if p.requires_grad)
    logger.info("Total parameters: %s (%.2fB)", f"{total_params:,}", total_params / 1e9)
    logger.info("Trainable parameters: %s", f"{trainable_params:,}")

    return model


# ── Dataset ──────────────────────────────────────────────────
class PreTokenizedDataset(IterableDataset):
    """
    Streams pre-tokenized data stored as memory-mapped numpy arrays or
    HuggingFace datasets on disk.  Falls back to a synthetic dataset
    for smoke-testing if the path doesn't exist.
    """

    def __init__(self, data_path: str, max_seq_length: int, seed: int = 42):
        super().__init__()
        self.data_path = data_path
        self.max_seq_length = max_seq_length
        self.seed = seed
        self._real_data = None
        self._try_load()

    def _try_load(self):
        path = Path(self.data_path)
        if path.exists() and path.is_dir():
            try:
                from datasets import load_from_disk
                self._real_data = load_from_disk(str(path))
                logger.info("Loaded real dataset from %s (%d examples)", path, len(self._real_data))
            except Exception:
                # Try numpy memmap
                npy_files = sorted(path.glob("*.npy"))
                if npy_files:
                    import numpy as np
                    self._mmap_files = [np.load(str(f), mmap_mode="r") for f in npy_files]
                    logger.info("Loaded %d memmap shards from %s", len(npy_files), path)
                else:
                    logger.warning("No loadable data at %s; using synthetic data.", path)
        else:
            logger.warning("Data path %s does not exist; using synthetic data.", path)

    def __iter__(self):
        worker_info = torch.utils.data.get_worker_info()
        worker_id = worker_info.id if worker_info else 0
        rng = torch.Generator().manual_seed(self.seed + worker_id)

        if self._real_data is not None:
            for example in self._real_data:
                input_ids = example["input_ids"]
                if isinstance(input_ids, list):
                    input_ids = torch.tensor(input_ids, dtype=torch.long)
                if len(input_ids) > self.max_seq_length:
                    input_ids = input_ids[: self.max_seq_length]
                yield {
                    "input_ids": input_ids,
                    "labels": input_ids.clone(),
                    "attention_mask": torch.ones_like(input_ids),
                }
        else:
            # Synthetic data for smoke-testing
            while True:
                input_ids = torch.randint(
                    0, 32000, (self.max_seq_length,), generator=rng, dtype=torch.long
                )
                yield {
                    "input_ids": input_ids,
                    "labels": input_ids.clone(),
                    "attention_mask": torch.ones_like(input_ids),
                }


def build_dataloaders(cfg: TrainConfig):
    train_dataset = PreTokenizedDataset(cfg.train_path, cfg.max_seq_length, cfg.seed)
    val_dataset = PreTokenizedDataset(cfg.val_path, cfg.max_seq_length, cfg.seed + 1000)

    train_loader = DataLoader(
        train_dataset,
        batch_size=cfg.micro_batch_size,
        num_workers=cfg.num_workers,
        prefetch_factor=cfg.prefetch_factor if cfg.num_workers > 0 else None,
        pin_memory=True,
    )

    val_loader = DataLoader(
        val_dataset,
        batch_size=cfg.micro_batch_size,
        num_workers=min(cfg.num_workers, 2),
        pin_memory=True,
    )

    return train_loader, val_loader


# ── LR scheduler ─────────────────────────────────────────────
def get_cosine_schedule_with_warmup(
    optimizer: torch.optim.Optimizer,
    warmup_steps: int,
    max_steps: int,
    min_lr_ratio: float = 0.1,
):
    """Cosine schedule with linear warmup and minimum LR floor."""

    def lr_lambda(current_step: int) -> float:
        if current_step < warmup_steps:
            return float(current_step) / float(max(1, warmup_steps))
        progress = float(current_step - warmup_steps) / float(max(1, max_steps - warmup_steps))
        cosine_decay = 0.5 * (1.0 + math.cos(math.pi * progress))
        return max(min_lr_ratio, cosine_decay * (1.0 - min_lr_ratio) + min_lr_ratio)

    return torch.optim.lr_scheduler.LambdaLR(optimizer, lr_lambda)


# ── Throughput / MFU ─────────────────────────────────────────
def estimate_mfu(
    model: nn.Module,
    tokens_per_sec: float,
    num_gpus: int = 1,
    gpu_flops_bf16: float = 312e12,  # A100 peak bf16
) -> float:
    """Estimate Model FLOPs Utilization (MFU).

    Uses the approximation: 6 * N * tokens_per_sec for forward+backward
    where N is the number of parameters.
    """
    n_params = sum(p.numel() for p in model.parameters())
    flops_per_sec = 6 * n_params * tokens_per_sec
    total_gpu_flops = gpu_flops_bf16 * num_gpus
    return flops_per_sec / total_gpu_flops


# ── Evaluation ───────────────────────────────────────────────
@torch.no_grad()
def evaluate(
    model: nn.Module,
    val_loader: DataLoader,
    accelerator: Accelerator,
    eval_steps: int,
) -> Dict[str, float]:
    """Run evaluation loop and return val_loss + perplexity."""
    model.eval()
    total_loss = 0.0
    total_tokens = 0

    for step, batch in enumerate(val_loader):
        if step >= eval_steps:
            break
        outputs = model(
            input_ids=batch["input_ids"],
            attention_mask=batch["attention_mask"],
            labels=batch["labels"],
        )
        loss = outputs.loss
        num_tokens = batch["attention_mask"].sum().item()

        # Gather across processes
        gathered_loss = accelerator.gather(loss.unsqueeze(0)).sum().item()
        gathered_tokens = accelerator.gather(
            torch.tensor([num_tokens], device=accelerator.device, dtype=torch.float)
        ).sum().item()

        total_loss += gathered_loss * num_tokens
        total_tokens += gathered_tokens

    avg_loss = total_loss / max(total_tokens, 1)
    perplexity = math.exp(min(avg_loss, 20.0))  # clamp to avoid overflow

    model.train()
    return {"val_loss": avg_loss, "perplexity": perplexity}


# ── Checkpoint helpers ───────────────────────────────────────
def save_checkpoint(
    accelerator: Accelerator,
    model: nn.Module,
    optimizer: torch.optim.Optimizer,
    scheduler: Any,
    step: int,
    cfg: TrainConfig,
    metrics: Dict[str, float],
):
    save_path = Path(cfg.save_dir) / f"step-{step}"
    save_path.mkdir(parents=True, exist_ok=True)

    accelerator.save_state(str(save_path))

    # Save metadata
    if accelerator.is_main_process:
        meta = {
            "step": step,
            "config_hash": cfg.config_hash(),
            "metrics": metrics,
            "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "run_name": cfg.run_name,
        }
        with open(save_path / "metadata.json", "w") as f:
            json.dump(meta, f, indent=2)

    logger.info("Saved checkpoint at step %d to %s", step, save_path)


def load_latest_checkpoint(cfg: TrainConfig) -> Optional[Path]:
    ckpt_dir = Path(cfg.save_dir)
    if not ckpt_dir.exists():
        return None
    checkpoints = sorted(
        [d for d in ckpt_dir.iterdir() if d.is_dir() and d.name.startswith("step-")],
        key=lambda d: int(d.name.split("-")[1]),
    )
    return checkpoints[-1] if checkpoints else None


def prune_checkpoints(cfg: TrainConfig):
    """Keep only the last N checkpoints + best K by val loss."""
    ckpt_dir = Path(cfg.save_dir)
    if not ckpt_dir.exists():
        return

    checkpoints = sorted(
        [d for d in ckpt_dir.iterdir() if d.is_dir() and d.name.startswith("step-")],
        key=lambda d: int(d.name.split("-")[1]),
    )

    if len(checkpoints) <= cfg.keep_last_n:
        return

    # Identify best-K by val loss
    best_by_loss = []
    for ckpt in checkpoints:
        meta_file = ckpt / "metadata.json"
        if meta_file.exists():
            with open(meta_file) as f:
                meta = json.load(f)
            val_loss = meta.get("metrics", {}).get("val_loss", float("inf"))
            best_by_loss.append((ckpt, val_loss))

    best_by_loss.sort(key=lambda x: x[1])
    best_set = {ckpt for ckpt, _ in best_by_loss[: cfg.keep_best_k]}

    # Keep last-N
    keep_set = set(checkpoints[-cfg.keep_last_n:]) | best_set

    for ckpt in checkpoints:
        if ckpt not in keep_set:
            import shutil
            shutil.rmtree(ckpt)
            logger.info("Pruned checkpoint: %s", ckpt)


# ── Main training loop ───────────────────────────────────────
def train(cfg: TrainConfig, resume: bool = False):
    # TF32
    if cfg.tf32:
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True

    # Mixed precision
    mixed_precision = "bf16" if cfg.dtype == "bf16" else "fp16" if cfg.dtype == "fp16" else "no"

    ddp_kwargs = DistributedDataParallelKwargs(find_unused_parameters=False)
    accelerator = Accelerator(
        mixed_precision=mixed_precision,
        gradient_accumulation_steps=cfg.gradient_accumulation_steps,
        log_with="wandb" if cfg.wandb_enabled else None,
        kwargs_handlers=[ddp_kwargs],
    )

    set_seed(cfg.seed)

    if accelerator.is_main_process:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
            handlers=[logging.StreamHandler(sys.stdout)],
        )
        logger.info("Config hash: %s", cfg.config_hash())
        logger.info("World size: %d", accelerator.num_processes)
        logger.info("Gradient accumulation steps: %d", cfg.gradient_accumulation_steps)

    # W&B init
    if cfg.wandb_enabled:
        accelerator.init_trackers(
            project_name=cfg.wandb_project,
            config=cfg._raw,
            init_kwargs={
                "wandb": {
                    "name": cfg.run_name,
                    "entity": cfg.wandb_entity,
                    "tags": cfg.wandb_tags,
                }
            },
        )

    # Build model
    logger.info("Building model...")
    model = build_model(cfg)

    # Optimizer
    no_decay = {"bias", "LayerNorm.weight", "layer_norm.weight", "norm.weight"}
    param_groups = [
        {
            "params": [p for n, p in model.named_parameters() if not any(nd in n for nd in no_decay)],
            "weight_decay": cfg.weight_decay,
        },
        {
            "params": [p for n, p in model.named_parameters() if any(nd in n for nd in no_decay)],
            "weight_decay": 0.0,
        },
    ]
    optimizer = torch.optim.AdamW(
        param_groups,
        lr=cfg.lr,
        betas=cfg.betas,
        eps=cfg.eps,
    )

    # Scheduler
    scheduler = get_cosine_schedule_with_warmup(
        optimizer, cfg.warmup_steps, cfg.max_steps, cfg.min_lr_ratio,
    )

    # Data
    logger.info("Loading data...")
    train_loader, val_loader = build_dataloaders(cfg)

    # Prepare with accelerate
    model, optimizer, train_loader, val_loader, scheduler = accelerator.prepare(
        model, optimizer, train_loader, val_loader, scheduler,
    )

    # Resume
    completed_steps = 0
    best_val_loss = float("inf")

    if resume:
        latest_ckpt = load_latest_checkpoint(cfg)
        if latest_ckpt is not None:
            logger.info("Resuming from checkpoint: %s", latest_ckpt)
            accelerator.load_state(str(latest_ckpt))
            meta_file = latest_ckpt / "metadata.json"
            if meta_file.exists():
                with open(meta_file) as f:
                    meta = json.load(f)
                completed_steps = meta.get("step", 0)
                best_val_loss = meta.get("metrics", {}).get("val_loss", float("inf"))
            logger.info("Resumed at step %d (best val_loss=%.4f)", completed_steps, best_val_loss)
        else:
            logger.warning("No checkpoint found; starting from scratch.")

    # Training loop
    model.train()
    train_iter = iter(train_loader)
    step_tokens = cfg.micro_batch_size * cfg.max_seq_length
    global_step = completed_steps
    running_loss = 0.0
    step_start_time = time.time()
    tokens_since_log = 0

    logger.info("Starting training from step %d...", global_step)

    while global_step < cfg.max_steps:
        if _SHUTDOWN_REQUESTED:
            logger.warning("Graceful shutdown: saving checkpoint at step %d", global_step)
            save_checkpoint(accelerator, model, optimizer, scheduler, global_step, cfg, {"val_loss": best_val_loss})
            break

        # Get batch
        try:
            batch = next(train_iter)
        except StopIteration:
            train_iter = iter(train_loader)
            batch = next(train_iter)

        # Forward + backward (accelerator handles accumulation)
        with accelerator.accumulate(model):
            outputs = model(
                input_ids=batch["input_ids"],
                attention_mask=batch["attention_mask"],
                labels=batch["labels"],
            )
            loss = outputs.loss

            # NaN check
            if torch.isnan(loss):
                logger.error("NaN loss detected at step %d! Skipping batch.", global_step)
                optimizer.zero_grad()
                continue

            accelerator.backward(loss)

            # Gradient clipping
            if accelerator.sync_gradients:
                grad_norm = accelerator.clip_grad_norm_(model.parameters(), cfg.gradient_clipping)

            optimizer.step()
            scheduler.step()
            optimizer.zero_grad()

        running_loss += loss.item()
        tokens_since_log += step_tokens * accelerator.num_processes

        # Step only advances after full accumulation
        if accelerator.sync_gradients:
            global_step += 1

            # ── Logging ──────────────────────────────────────
            if global_step % cfg.log_interval == 0:
                elapsed = time.time() - step_start_time
                avg_loss = running_loss / cfg.log_interval
                tokens_per_sec = tokens_since_log / max(elapsed, 1e-6)
                current_lr = scheduler.get_last_lr()[0]
                mfu = estimate_mfu(model, tokens_per_sec, accelerator.num_processes)

                log_dict = {
                    "train/loss": avg_loss,
                    "train/lr": current_lr,
                    "train/grad_norm": grad_norm.item() if isinstance(grad_norm, torch.Tensor) else grad_norm,
                    "train/tokens_per_sec": tokens_per_sec,
                    "train/mfu": mfu,
                    "train/step": global_step,
                }

                if accelerator.is_main_process:
                    logger.info(
                        "step=%d loss=%.4f lr=%.2e grad_norm=%.3f tok/s=%.0f mfu=%.2f%%",
                        global_step, avg_loss, current_lr,
                        log_dict["train/grad_norm"],
                        tokens_per_sec, mfu * 100,
                    )

                if cfg.wandb_enabled:
                    accelerator.log(log_dict, step=global_step)

                running_loss = 0.0
                tokens_since_log = 0
                step_start_time = time.time()

            # ── Evaluation ───────────────────────────────────
            if global_step % cfg.eval_interval == 0:
                logger.info("Running evaluation at step %d...", global_step)
                eval_metrics = evaluate(model, val_loader, accelerator, cfg.eval_steps)

                if accelerator.is_main_process:
                    logger.info(
                        "Eval step=%d val_loss=%.4f perplexity=%.2f",
                        global_step, eval_metrics["val_loss"], eval_metrics["perplexity"],
                    )

                if cfg.wandb_enabled:
                    accelerator.log(
                        {f"eval/{k}": v for k, v in eval_metrics.items()},
                        step=global_step,
                    )

                if eval_metrics["val_loss"] < best_val_loss:
                    best_val_loss = eval_metrics["val_loss"]
                    logger.info("New best val_loss: %.4f", best_val_loss)

            # ── Checkpointing ────────────────────────────────
            if global_step % cfg.save_interval == 0:
                metrics = {"val_loss": best_val_loss, "step": global_step}
                save_checkpoint(accelerator, model, optimizer, scheduler, global_step, cfg, metrics)

                if accelerator.is_main_process:
                    prune_checkpoints(cfg)

    # Final save
    if not _SHUTDOWN_REQUESTED and global_step >= cfg.max_steps:
        logger.info("Training complete. Saving final checkpoint.")
        metrics = {"val_loss": best_val_loss, "step": global_step}
        save_checkpoint(accelerator, model, optimizer, scheduler, global_step, cfg, metrics)

    if cfg.wandb_enabled:
        accelerator.end_training()

    logger.info("Done. Final step: %d, best val_loss: %.4f", global_step, best_val_loss)


# ── CLI ──────────────────────────────────────────────────────
@click.command()
@click.option("--config", required=True, type=click.Path(exists=True), help="Path to YAML config file.")
@click.option("--resume", is_flag=True, default=False, help="Resume from latest checkpoint.")
@click.option("--override", multiple=True, help="Override config values, e.g. --override training.max_steps=50000")
def main(config: str, resume: bool, override: tuple):
    """Launch pre-training for Ailin-1B."""
    cfg = TrainConfig.from_yaml(config)

    # Apply overrides
    for ov in override:
        key, value = ov.split("=", 1)
        parts = key.split(".")
        # Simple flat override
        attr_name = parts[-1]
        if hasattr(cfg, attr_name):
            current = getattr(cfg, attr_name)
            cast_type = type(current)
            if cast_type == bool:
                setattr(cfg, attr_name, value.lower() in ("true", "1", "yes"))
            else:
                setattr(cfg, attr_name, cast_type(value))
            logger.info("Override: %s = %s", attr_name, getattr(cfg, attr_name))

    train(cfg, resume=resume)


if __name__ == "__main__":
    main()
