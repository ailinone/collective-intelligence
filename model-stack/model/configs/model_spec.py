# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Pydantic model specification for transformer model configuration.

Loads from YAML, validates all fields, and provides computed properties
like parameter count.
"""

from __future__ import annotations

import logging
import math
from enum import Enum
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class PositionEmbeddingType(str, Enum):
    ROPE = "rope"
    ALIBI = "alibi"
    ABSOLUTE = "absolute"
    RELATIVE = "relative"


class NormType(str, Enum):
    RMSNORM = "rmsnorm"
    LAYERNORM = "layernorm"


class HiddenAct(str, Enum):
    SILU = "silu"
    GELU = "gelu"
    RELU = "relu"
    GELU_NEW = "gelu_new"


class Optimizer(str, Enum):
    ADAMW = "adamw"
    ADAM = "adam"
    SGD = "sgd"
    ADAFACTOR = "adafactor"


class LRScheduler(str, Enum):
    COSINE = "cosine"
    LINEAR = "linear"
    CONSTANT = "constant"
    COSINE_RESTARTS = "cosine_restarts"
    POLYNOMIAL = "polynomial"


# ---------------------------------------------------------------------------
# RoPE scaling config
# ---------------------------------------------------------------------------

class RoPEScalingConfig(BaseModel):
    type: Literal["linear", "dynamic", "ntk"] = "linear"
    factor: float = Field(gt=1.0)


# ---------------------------------------------------------------------------
# Model specification
# ---------------------------------------------------------------------------

class ModelSpec(BaseModel):
    """Complete specification for a decoder-only transformer model."""

    name: str
    architecture: str = "decoder_only_transformer"

    # Core dimensions
    hidden_size: int = Field(gt=0)
    num_layers: int = Field(gt=0)
    num_attention_heads: int = Field(gt=0)
    num_key_value_heads: int = Field(gt=0)
    intermediate_size: int = Field(gt=0)
    vocab_size: int = Field(gt=0)
    max_position_embeddings: int = Field(gt=0)

    # Positional encoding
    position_embedding_type: PositionEmbeddingType = PositionEmbeddingType.ROPE
    rope_theta: float = 10000.0
    rope_scaling: RoPEScalingConfig | None = None

    # Normalization
    norm_type: NormType = NormType.RMSNORM
    layer_norm_eps: float = 1e-5

    # Activation
    hidden_act: HiddenAct = HiddenAct.SILU
    use_gated_mlp: bool = True

    # Attention
    attention_dropout: float = Field(default=0.0, ge=0.0, le=1.0)
    attention_bias: bool = False
    use_flash_attention: bool = True

    # Embeddings
    tie_word_embeddings: bool = True
    embedding_dropout: float = Field(default=0.0, ge=0.0, le=1.0)

    # Initialization
    initializer_range: float = 0.02
    use_scaled_init: bool = True

    # Gradient checkpointing
    gradient_checkpointing: bool = True

    # Precision
    dtype: str = "bfloat16"
    use_mixed_precision: bool = True

    @field_validator("num_key_value_heads")
    @classmethod
    def validate_kv_heads(cls, v: int, info: Any) -> int:
        n_heads = info.data.get("num_attention_heads")
        if n_heads is not None and n_heads % v != 0:
            raise ValueError(
                f"num_attention_heads ({n_heads}) must be divisible by "
                f"num_key_value_heads ({v})"
            )
        return v

    @field_validator("hidden_size")
    @classmethod
    def validate_hidden_size(cls, v: int, info: Any) -> int:
        n_heads = info.data.get("num_attention_heads")
        if n_heads is not None and v % n_heads != 0:
            raise ValueError(
                f"hidden_size ({v}) must be divisible by "
                f"num_attention_heads ({n_heads})"
            )
        return v

    @property
    def head_dim(self) -> int:
        return self.hidden_size // self.num_attention_heads

    @property
    def kv_head_dim(self) -> int:
        return self.hidden_size // self.num_attention_heads

    @property
    def num_kv_groups(self) -> int:
        """Number of query heads per KV head (for GQA)."""
        return self.num_attention_heads // self.num_key_value_heads

    @property
    def is_gqa(self) -> bool:
        """Whether grouped-query attention is used."""
        return self.num_key_value_heads < self.num_attention_heads

    @property
    def embedding_params(self) -> int:
        """Number of parameters in the embedding layer."""
        return self.vocab_size * self.hidden_size

    @property
    def attention_params_per_layer(self) -> int:
        """Parameters in attention projections per layer."""
        h = self.hidden_size
        kv_dim = self.num_key_value_heads * self.head_dim

        q_params = h * h  # Query projection
        k_params = h * kv_dim  # Key projection
        v_params = h * kv_dim  # Value projection
        o_params = h * h  # Output projection

        bias_params = 0
        if self.attention_bias:
            bias_params = h + kv_dim + kv_dim + h

        return q_params + k_params + v_params + o_params + bias_params

    @property
    def mlp_params_per_layer(self) -> int:
        """Parameters in MLP per layer."""
        h = self.hidden_size
        inter = self.intermediate_size

        if self.use_gated_mlp:
            # SwiGLU: gate_proj + up_proj + down_proj
            return h * inter + h * inter + inter * h
        else:
            # Standard: up_proj + down_proj
            return h * inter + inter * h

    @property
    def norm_params_per_layer(self) -> int:
        """Parameters in normalization layers per layer (2 norms: attention + MLP)."""
        return 2 * self.hidden_size

    @property
    def params_per_layer(self) -> int:
        """Total parameters per transformer layer."""
        return (
            self.attention_params_per_layer
            + self.mlp_params_per_layer
            + self.norm_params_per_layer
        )

    @property
    def total_params(self) -> int:
        """Total model parameter count."""
        embedding = self.embedding_params
        layers = self.num_layers * self.params_per_layer
        final_norm = self.hidden_size  # Final RMSNorm/LayerNorm

        # LM head
        if self.tie_word_embeddings:
            lm_head = 0
        else:
            lm_head = self.hidden_size * self.vocab_size

        return embedding + layers + final_norm + lm_head

    @property
    def non_embedding_params(self) -> int:
        """Parameters excluding the embedding table."""
        return self.total_params - self.embedding_params

    @property
    def total_params_billions(self) -> float:
        return self.total_params / 1e9

    @property
    def estimated_memory_gb(self) -> dict[str, float]:
        """Estimate memory usage for different dtypes."""
        params = self.total_params
        return {
            "fp32": round(params * 4 / 1e9, 2),
            "fp16": round(params * 2 / 1e9, 2),
            "bf16": round(params * 2 / 1e9, 2),
            "int8": round(params * 1 / 1e9, 2),
            "int4": round(params * 0.5 / 1e9, 2),
        }

    def param_breakdown(self) -> dict[str, Any]:
        """Detailed parameter count breakdown."""
        return {
            "embedding": self.embedding_params,
            "per_layer": {
                "attention": self.attention_params_per_layer,
                "mlp": self.mlp_params_per_layer,
                "norm": self.norm_params_per_layer,
                "total": self.params_per_layer,
            },
            "all_layers": self.num_layers * self.params_per_layer,
            "final_norm": self.hidden_size,
            "lm_head": 0 if self.tie_word_embeddings else self.hidden_size * self.vocab_size,
            "total": self.total_params,
            "non_embedding": self.non_embedding_params,
            "total_billions": round(self.total_params_billions, 3),
        }


# ---------------------------------------------------------------------------
# Training specification
# ---------------------------------------------------------------------------

class TrainingSpec(BaseModel):
    """Training hyperparameters."""

    optimizer: Optimizer = Optimizer.ADAMW
    learning_rate: float = Field(gt=0)
    min_learning_rate: float = Field(gt=0)
    weight_decay: float = Field(ge=0)
    adam_beta1: float = Field(gt=0, lt=1)
    adam_beta2: float = Field(gt=0, lt=1)
    adam_epsilon: float = Field(gt=0)
    max_grad_norm: float = Field(gt=0)

    lr_scheduler: LRScheduler = LRScheduler.COSINE
    warmup_steps: int = Field(ge=0)
    total_steps: int = Field(gt=0)
    cooldown_steps: int = Field(ge=0, default=0)

    micro_batch_size: int = Field(gt=0)
    gradient_accumulation_steps: int = Field(gt=0)
    global_batch_size: int = Field(gt=0)
    sequence_length: int = Field(gt=0)
    tokens_per_step: int | None = None

    num_workers: int = Field(ge=0, default=8)
    pin_memory: bool = True
    prefetch_factor: int = Field(ge=1, default=2)

    save_interval_steps: int = Field(gt=0)
    eval_interval_steps: int = Field(gt=0)
    log_interval_steps: int = Field(gt=0)

    distributed_backend: str = "nccl"
    deepspeed_stage: int = Field(ge=0, le=3, default=2)
    activation_checkpointing: bool = True

    @model_validator(mode="after")
    def validate_lr_range(self) -> "TrainingSpec":
        if self.min_learning_rate >= self.learning_rate:
            raise ValueError("min_learning_rate must be less than learning_rate")
        return self

    @property
    def total_tokens(self) -> int:
        """Total tokens processed during training."""
        tps = self.tokens_per_step or (self.global_batch_size * self.sequence_length)
        return tps * self.total_steps


# ---------------------------------------------------------------------------
# Evaluation benchmark spec
# ---------------------------------------------------------------------------

class BenchmarkSpec(BaseModel):
    name: str
    shots: int = Field(ge=0, default=0)


class EvaluationSpec(BaseModel):
    benchmarks: list[BenchmarkSpec] = Field(default_factory=list)
    eval_batch_size: int = Field(gt=0, default=16)


# ---------------------------------------------------------------------------
# Full config
# ---------------------------------------------------------------------------

class FullModelConfig(BaseModel):
    """Complete model + training + evaluation config."""

    model: ModelSpec
    training: TrainingSpec | None = None
    evaluation: EvaluationSpec | None = None

    @classmethod
    def from_yaml(cls, path: Path) -> "FullModelConfig":
        """Load a complete model config from a YAML file."""
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"Config file not found: {path}")

        with open(path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)

        return cls(**raw)

    def to_yaml(self, path: Path) -> None:
        """Save config to a YAML file."""
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)

        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(
                self.model_dump(mode="json"),
                f,
                default_flow_style=False,
                sort_keys=False,
            )

    def summary(self) -> str:
        """Human-readable summary of the model config."""
        m = self.model
        lines = [
            f"Model: {m.name}",
            f"  Architecture:  {m.architecture}",
            f"  Parameters:    {m.total_params_billions:.3f}B",
            f"  Hidden size:   {m.hidden_size}",
            f"  Layers:        {m.num_layers}",
            f"  Attn heads:    {m.num_attention_heads} (KV heads: {m.num_key_value_heads})",
            f"  Head dim:      {m.head_dim}",
            f"  Intermediate:  {m.intermediate_size}",
            f"  Vocab:         {m.vocab_size}",
            f"  Max pos:       {m.max_position_embeddings}",
            f"  GQA:           {m.is_gqa}",
            f"  Gated MLP:     {m.use_gated_mlp}",
            f"  Flash Attn:    {m.use_flash_attention}",
            f"  Dtype:         {m.dtype}",
        ]

        mem = m.estimated_memory_gb
        lines.append(f"  Memory (bf16): {mem['bf16']:.2f} GB")
        lines.append(f"  Memory (fp32): {mem['fp32']:.2f} GB")

        if self.training:
            t = self.training
            lines.extend([
                f"\nTraining:",
                f"  LR:            {t.learning_rate}",
                f"  Scheduler:     {t.lr_scheduler.value}",
                f"  Warmup:        {t.warmup_steps} steps",
                f"  Total steps:   {t.total_steps}",
                f"  Batch size:    {t.global_batch_size}",
                f"  Seq length:    {t.sequence_length}",
                f"  Total tokens:  {t.total_tokens / 1e9:.1f}B",
            ])

        return "\n".join(lines)


# ---------------------------------------------------------------------------
# CLI demo
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys

    logging.basicConfig(level=logging.INFO)

    if len(sys.argv) < 2:
        print("Usage: python model_spec.py <config.yaml>")
        sys.exit(1)

    config = FullModelConfig.from_yaml(Path(sys.argv[1]))
    print(config.summary())
    print("\nParameter breakdown:")

    import json
    print(json.dumps(config.model.param_breakdown(), indent=2))
