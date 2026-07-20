# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
GPT-style decoder-only transformer with:
  - RoPE (Rotary Positional Encoding)
  - RMSNorm
  - SwiGLU activation (gated MLP)
  - Optional Flash Attention
  - Grouped-Query Attention (GQA) support
  - Gradient checkpointing
  - Configurable from YAML via ModelSpec
"""

from __future__ import annotations

import logging
import math
from pathlib import Path
from typing import Any

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# RMSNorm
# ---------------------------------------------------------------------------

class RMSNorm(nn.Module):
    """Root Mean Square Layer Normalization (Zhang & Sennrich, 2019)."""

    def __init__(self, hidden_size: int, eps: float = 1e-5) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(hidden_size))
        self.eps = eps

    def forward(self, x: Tensor) -> Tensor:
        variance = x.to(torch.float32).pow(2).mean(-1, keepdim=True)
        x = x * torch.rsqrt(variance + self.eps)
        return self.weight * x.to(self.weight.dtype)


# ---------------------------------------------------------------------------
# RoPE (Rotary Positional Encoding)
# ---------------------------------------------------------------------------

class RotaryEmbedding(nn.Module):
    """Rotary Positional Embedding (Su et al., 2021)."""

    def __init__(
        self,
        dim: int,
        max_position_embeddings: int = 4096,
        base: float = 10000.0,
        device: torch.device | None = None,
    ) -> None:
        super().__init__()
        self.dim = dim
        self.max_position_embeddings = max_position_embeddings
        self.base = base

        inv_freq = 1.0 / (
            self.base ** (torch.arange(0, self.dim, 2, dtype=torch.float32, device=device) / self.dim)
        )
        self.register_buffer("inv_freq", inv_freq, persistent=False)
        self._build_cache(max_position_embeddings, device)

    def _build_cache(self, seq_len: int, device: torch.device | None = None) -> None:
        t = torch.arange(seq_len, dtype=torch.float32, device=device or self.inv_freq.device)
        freqs = torch.outer(t, self.inv_freq)
        emb = torch.cat((freqs, freqs), dim=-1)
        self.register_buffer("cos_cached", emb.cos(), persistent=False)
        self.register_buffer("sin_cached", emb.sin(), persistent=False)

    def forward(self, x: Tensor, seq_len: int) -> tuple[Tensor, Tensor]:
        if seq_len > self.cos_cached.shape[0]:
            self._build_cache(seq_len, device=x.device)
        return (
            self.cos_cached[:seq_len].to(x.dtype),
            self.sin_cached[:seq_len].to(x.dtype),
        )


def rotate_half(x: Tensor) -> Tensor:
    """Rotates half the hidden dims of the input."""
    x1 = x[..., : x.shape[-1] // 2]
    x2 = x[..., x.shape[-1] // 2 :]
    return torch.cat((-x2, x1), dim=-1)


def apply_rotary_pos_emb(
    q: Tensor,
    k: Tensor,
    cos: Tensor,
    sin: Tensor,
    position_ids: Tensor | None = None,
) -> tuple[Tensor, Tensor]:
    """Apply rotary positional embedding to query and key tensors."""
    if position_ids is not None:
        cos = cos[position_ids].unsqueeze(1)  # [B, 1, S, D]
        sin = sin[position_ids].unsqueeze(1)
    else:
        cos = cos.unsqueeze(0).unsqueeze(0)  # [1, 1, S, D]
        sin = sin.unsqueeze(0).unsqueeze(0)

    q_embed = (q * cos) + (rotate_half(q) * sin)
    k_embed = (k * cos) + (rotate_half(k) * sin)
    return q_embed, k_embed


# ---------------------------------------------------------------------------
# Attention
# ---------------------------------------------------------------------------

class Attention(nn.Module):
    """
    Multi-Head / Grouped-Query Attention with RoPE.

    Supports Flash Attention when available and enabled.
    """

    def __init__(
        self,
        hidden_size: int,
        num_attention_heads: int,
        num_key_value_heads: int,
        max_position_embeddings: int = 4096,
        rope_theta: float = 10000.0,
        attention_dropout: float = 0.0,
        attention_bias: bool = False,
        use_flash_attention: bool = True,
    ) -> None:
        super().__init__()
        self.hidden_size = hidden_size
        self.num_heads = num_attention_heads
        self.num_kv_heads = num_key_value_heads
        self.head_dim = hidden_size // num_attention_heads
        self.num_kv_groups = num_attention_heads // num_key_value_heads
        self.attention_dropout = attention_dropout

        self.q_proj = nn.Linear(hidden_size, num_attention_heads * self.head_dim, bias=attention_bias)
        self.k_proj = nn.Linear(hidden_size, num_key_value_heads * self.head_dim, bias=attention_bias)
        self.v_proj = nn.Linear(hidden_size, num_key_value_heads * self.head_dim, bias=attention_bias)
        self.o_proj = nn.Linear(num_attention_heads * self.head_dim, hidden_size, bias=attention_bias)

        self.rotary_emb = RotaryEmbedding(
            self.head_dim,
            max_position_embeddings=max_position_embeddings,
            base=rope_theta,
        )

        self.use_flash_attention = use_flash_attention
        self._flash_available = self._check_flash_attention()

    @staticmethod
    def _check_flash_attention() -> bool:
        """Check if Flash Attention 2 is available."""
        try:
            from flash_attn import flash_attn_func
            return True
        except ImportError:
            return False

    def _repeat_kv(self, hidden_states: Tensor, n_rep: int) -> Tensor:
        """Repeat KV heads to match number of query heads (for GQA)."""
        if n_rep == 1:
            return hidden_states
        batch, num_kv_heads, slen, head_dim = hidden_states.shape
        hidden_states = hidden_states[:, :, None, :, :].expand(
            batch, num_kv_heads, n_rep, slen, head_dim
        )
        return hidden_states.reshape(batch, num_kv_heads * n_rep, slen, head_dim)

    def forward(
        self,
        hidden_states: Tensor,
        attention_mask: Tensor | None = None,
        position_ids: Tensor | None = None,
        past_key_value: tuple[Tensor, Tensor] | None = None,
        use_cache: bool = False,
    ) -> tuple[Tensor, tuple[Tensor, Tensor] | None]:
        batch_size, seq_len, _ = hidden_states.shape

        # Project Q, K, V
        q = self.q_proj(hidden_states)
        k = self.k_proj(hidden_states)
        v = self.v_proj(hidden_states)

        # Reshape to [B, num_heads, S, head_dim]
        q = q.view(batch_size, seq_len, self.num_heads, self.head_dim).transpose(1, 2)
        k = k.view(batch_size, seq_len, self.num_kv_heads, self.head_dim).transpose(1, 2)
        v = v.view(batch_size, seq_len, self.num_kv_heads, self.head_dim).transpose(1, 2)

        # Apply RoPE
        cos, sin = self.rotary_emb(q, seq_len)
        q, k = apply_rotary_pos_emb(q, k, cos, sin, position_ids)

        # Handle KV cache for inference
        if past_key_value is not None:
            k = torch.cat([past_key_value[0], k], dim=2)
            v = torch.cat([past_key_value[1], v], dim=2)

        new_cache = (k, v) if use_cache else None

        # Expand KV for GQA
        k = self._repeat_kv(k, self.num_kv_groups)
        v = self._repeat_kv(v, self.num_kv_groups)

        # Compute attention
        if self.use_flash_attention and self._flash_available and not use_cache:
            attn_output = self._flash_attention(q, k, v)
        else:
            attn_output = self._standard_attention(q, k, v, attention_mask)

        # Reshape and project output
        attn_output = attn_output.transpose(1, 2).contiguous().view(batch_size, seq_len, -1)
        output = self.o_proj(attn_output)

        return output, new_cache

    def _flash_attention(self, q: Tensor, k: Tensor, v: Tensor) -> Tensor:
        """Flash Attention 2 forward pass."""
        from flash_attn import flash_attn_func

        # flash_attn expects [B, S, H, D]
        q = q.transpose(1, 2)
        k = k.transpose(1, 2)
        v = v.transpose(1, 2)

        output = flash_attn_func(
            q, k, v,
            dropout_p=self.attention_dropout if self.training else 0.0,
            causal=True,
        )
        return output.transpose(1, 2)  # Back to [B, H, S, D]

    def _standard_attention(
        self,
        q: Tensor,
        k: Tensor,
        v: Tensor,
        attention_mask: Tensor | None = None,
    ) -> Tensor:
        """Standard scaled dot-product attention with causal mask."""
        # Try PyTorch 2.0 SDPA first
        try:
            output = F.scaled_dot_product_attention(
                q, k, v,
                attn_mask=attention_mask,
                dropout_p=self.attention_dropout if self.training else 0.0,
                is_causal=attention_mask is None,
            )
            return output
        except Exception:
            pass

        # Manual fallback
        scale = 1.0 / math.sqrt(self.head_dim)
        attn_weights = torch.matmul(q, k.transpose(-2, -1)) * scale

        # Causal mask
        seq_len = q.shape[2]
        kv_len = k.shape[2]
        causal_mask = torch.triu(
            torch.full((seq_len, kv_len), float("-inf"), device=q.device, dtype=q.dtype),
            diagonal=kv_len - seq_len + 1,
        )
        attn_weights = attn_weights + causal_mask

        if attention_mask is not None:
            attn_weights = attn_weights + attention_mask

        attn_weights = F.softmax(attn_weights, dim=-1, dtype=torch.float32).to(q.dtype)

        if self.training and self.attention_dropout > 0:
            attn_weights = F.dropout(attn_weights, p=self.attention_dropout)

        return torch.matmul(attn_weights, v)


# ---------------------------------------------------------------------------
# MLP with SwiGLU
# ---------------------------------------------------------------------------

class SwiGLUMLP(nn.Module):
    """
    SwiGLU Feed-Forward Network (Shazeer, 2020).

    FFN_SwiGLU(x) = (Swish(xW_gate) * xW_up) @ W_down
    """

    def __init__(self, hidden_size: int, intermediate_size: int) -> None:
        super().__init__()
        self.gate_proj = nn.Linear(hidden_size, intermediate_size, bias=False)
        self.up_proj = nn.Linear(hidden_size, intermediate_size, bias=False)
        self.down_proj = nn.Linear(intermediate_size, hidden_size, bias=False)

    def forward(self, x: Tensor) -> Tensor:
        gate = F.silu(self.gate_proj(x))
        up = self.up_proj(x)
        return self.down_proj(gate * up)


class StandardMLP(nn.Module):
    """Standard FFN with configurable activation."""

    def __init__(
        self,
        hidden_size: int,
        intermediate_size: int,
        hidden_act: str = "gelu",
    ) -> None:
        super().__init__()
        self.up_proj = nn.Linear(hidden_size, intermediate_size, bias=False)
        self.down_proj = nn.Linear(intermediate_size, hidden_size, bias=False)

        act_fns = {
            "gelu": nn.GELU(),
            "gelu_new": nn.GELU(approximate="tanh"),
            "relu": nn.ReLU(),
            "silu": nn.SiLU(),
        }
        self.act_fn = act_fns.get(hidden_act, nn.GELU())

    def forward(self, x: Tensor) -> Tensor:
        return self.down_proj(self.act_fn(self.up_proj(x)))


# ---------------------------------------------------------------------------
# Transformer Layer
# ---------------------------------------------------------------------------

class TransformerLayer(nn.Module):
    """Single transformer decoder layer: pre-norm attention + MLP."""

    def __init__(
        self,
        hidden_size: int,
        num_attention_heads: int,
        num_key_value_heads: int,
        intermediate_size: int,
        max_position_embeddings: int = 4096,
        rope_theta: float = 10000.0,
        layer_norm_eps: float = 1e-5,
        attention_dropout: float = 0.0,
        attention_bias: bool = False,
        use_flash_attention: bool = True,
        use_gated_mlp: bool = True,
        hidden_act: str = "silu",
        norm_type: str = "rmsnorm",
    ) -> None:
        super().__init__()

        # Pre-attention norm
        if norm_type == "rmsnorm":
            self.input_layernorm = RMSNorm(hidden_size, eps=layer_norm_eps)
            self.post_attention_layernorm = RMSNorm(hidden_size, eps=layer_norm_eps)
        else:
            self.input_layernorm = nn.LayerNorm(hidden_size, eps=layer_norm_eps)
            self.post_attention_layernorm = nn.LayerNorm(hidden_size, eps=layer_norm_eps)

        # Attention
        self.self_attn = Attention(
            hidden_size=hidden_size,
            num_attention_heads=num_attention_heads,
            num_key_value_heads=num_key_value_heads,
            max_position_embeddings=max_position_embeddings,
            rope_theta=rope_theta,
            attention_dropout=attention_dropout,
            attention_bias=attention_bias,
            use_flash_attention=use_flash_attention,
        )

        # MLP
        if use_gated_mlp:
            self.mlp = SwiGLUMLP(hidden_size, intermediate_size)
        else:
            self.mlp = StandardMLP(hidden_size, intermediate_size, hidden_act=hidden_act)

    def forward(
        self,
        hidden_states: Tensor,
        attention_mask: Tensor | None = None,
        position_ids: Tensor | None = None,
        past_key_value: tuple[Tensor, Tensor] | None = None,
        use_cache: bool = False,
    ) -> tuple[Tensor, tuple[Tensor, Tensor] | None]:
        # Pre-norm + attention + residual
        residual = hidden_states
        hidden_states = self.input_layernorm(hidden_states)
        attn_output, new_cache = self.self_attn(
            hidden_states,
            attention_mask=attention_mask,
            position_ids=position_ids,
            past_key_value=past_key_value,
            use_cache=use_cache,
        )
        hidden_states = residual + attn_output

        # Pre-norm + MLP + residual
        residual = hidden_states
        hidden_states = self.post_attention_layernorm(hidden_states)
        hidden_states = residual + self.mlp(hidden_states)

        return hidden_states, new_cache


# ---------------------------------------------------------------------------
# Full Model
# ---------------------------------------------------------------------------

class AilinTransformer(nn.Module):
    """
    Complete GPT-style decoder-only transformer.

    Features:
      - RoPE positional encoding
      - RMSNorm (pre-norm architecture)
      - SwiGLU activation
      - Optional Flash Attention
      - GQA support
      - Gradient checkpointing
      - KV cache for efficient inference
    """

    def __init__(
        self,
        vocab_size: int = 32000,
        hidden_size: int = 2048,
        num_layers: int = 24,
        num_attention_heads: int = 16,
        num_key_value_heads: int = 16,
        intermediate_size: int = 5504,
        max_position_embeddings: int = 4096,
        rope_theta: float = 10000.0,
        layer_norm_eps: float = 1e-5,
        attention_dropout: float = 0.0,
        attention_bias: bool = False,
        use_flash_attention: bool = True,
        use_gated_mlp: bool = True,
        hidden_act: str = "silu",
        norm_type: str = "rmsnorm",
        tie_word_embeddings: bool = True,
        initializer_range: float = 0.02,
        use_scaled_init: bool = True,
        gradient_checkpointing: bool = False,
        embedding_dropout: float = 0.0,
    ) -> None:
        super().__init__()
        self.vocab_size = vocab_size
        self.hidden_size = hidden_size
        self.num_layers = num_layers
        self.tie_word_embeddings = tie_word_embeddings
        self.gradient_checkpointing = gradient_checkpointing
        self.initializer_range = initializer_range
        self.use_scaled_init = use_scaled_init

        # Token embedding
        self.embed_tokens = nn.Embedding(vocab_size, hidden_size)
        self.embed_dropout = nn.Dropout(embedding_dropout) if embedding_dropout > 0 else nn.Identity()

        # Transformer layers
        self.layers = nn.ModuleList([
            TransformerLayer(
                hidden_size=hidden_size,
                num_attention_heads=num_attention_heads,
                num_key_value_heads=num_key_value_heads,
                intermediate_size=intermediate_size,
                max_position_embeddings=max_position_embeddings,
                rope_theta=rope_theta,
                layer_norm_eps=layer_norm_eps,
                attention_dropout=attention_dropout,
                attention_bias=attention_bias,
                use_flash_attention=use_flash_attention,
                use_gated_mlp=use_gated_mlp,
                hidden_act=hidden_act,
                norm_type=norm_type,
            )
            for _ in range(num_layers)
        ])

        # Final norm
        if norm_type == "rmsnorm":
            self.norm = RMSNorm(hidden_size, eps=layer_norm_eps)
        else:
            self.norm = nn.LayerNorm(hidden_size, eps=layer_norm_eps)

        # LM head
        if tie_word_embeddings:
            self.lm_head = None  # Will use embed_tokens weight
        else:
            self.lm_head = nn.Linear(hidden_size, vocab_size, bias=False)

        # Initialize weights
        self.apply(self._init_weights)
        self._apply_scaled_init()

    def _init_weights(self, module: nn.Module) -> None:
        """Initialize weights with normal distribution."""
        if isinstance(module, nn.Linear):
            torch.nn.init.normal_(module.weight, mean=0.0, std=self.initializer_range)
            if module.bias is not None:
                torch.nn.init.zeros_(module.bias)
        elif isinstance(module, nn.Embedding):
            torch.nn.init.normal_(module.weight, mean=0.0, std=self.initializer_range)

    def _apply_scaled_init(self) -> None:
        """
        Scale residual-stream projections by 1/sqrt(2*n_layers).

        This stabilizes training by reducing the magnitude of residual updates
        in deeper models (GPT-2 style scaled init).
        """
        if not self.use_scaled_init:
            return

        scale = 1.0 / math.sqrt(2.0 * self.num_layers)
        for layer in self.layers:
            # Scale attention output projection
            torch.nn.init.normal_(
                layer.self_attn.o_proj.weight,
                mean=0.0,
                std=self.initializer_range * scale,
            )
            # Scale MLP down projection
            if hasattr(layer.mlp, "down_proj"):
                torch.nn.init.normal_(
                    layer.mlp.down_proj.weight,
                    mean=0.0,
                    std=self.initializer_range * scale,
                )

    def get_input_embeddings(self) -> nn.Embedding:
        return self.embed_tokens

    def set_input_embeddings(self, value: nn.Embedding) -> None:
        self.embed_tokens = value

    def param_count(self) -> dict[str, int]:
        """Count parameters by component."""
        embedding = sum(p.numel() for p in self.embed_tokens.parameters())

        attn_params = 0
        mlp_params = 0
        norm_params = 0
        for layer in self.layers:
            attn_params += sum(p.numel() for p in layer.self_attn.parameters())
            mlp_params += sum(p.numel() for p in layer.mlp.parameters())
            attn_params -= sum(p.numel() for p in layer.self_attn.rotary_emb.parameters())
            norm_params += sum(p.numel() for p in layer.input_layernorm.parameters())
            norm_params += sum(p.numel() for p in layer.post_attention_layernorm.parameters())

        final_norm = sum(p.numel() for p in self.norm.parameters())
        lm_head_params = sum(p.numel() for p in self.lm_head.parameters()) if self.lm_head else 0

        total = sum(p.numel() for p in self.parameters())

        return {
            "embedding": embedding,
            "attention": attn_params,
            "mlp": mlp_params,
            "norm": norm_params + final_norm,
            "lm_head": lm_head_params,
            "total": total,
            "total_millions": round(total / 1e6, 2),
            "total_billions": round(total / 1e9, 3),
        }

    def forward(
        self,
        input_ids: Tensor,
        attention_mask: Tensor | None = None,
        position_ids: Tensor | None = None,
        past_key_values: list[tuple[Tensor, Tensor]] | None = None,
        use_cache: bool = False,
        labels: Tensor | None = None,
    ) -> dict[str, Tensor | list | None]:
        """
        Forward pass.

        Args:
            input_ids: [B, S] token IDs
            attention_mask: [B, S] mask (1 = attend, 0 = ignore)
            position_ids: [B, S] position indices
            past_key_values: list of (K, V) caches per layer
            use_cache: whether to return new KV caches
            labels: [B, S] target token IDs for loss computation

        Returns:
            dict with keys: loss, logits, past_key_values
        """
        batch_size, seq_len = input_ids.shape

        # Position IDs
        if position_ids is None:
            past_len = past_key_values[0][0].shape[2] if past_key_values is not None else 0
            position_ids = torch.arange(
                past_len, past_len + seq_len, dtype=torch.long, device=input_ids.device
            ).unsqueeze(0).expand(batch_size, -1)

        # Embed tokens
        hidden_states = self.embed_tokens(input_ids)
        hidden_states = self.embed_dropout(hidden_states)

        # Prepare attention mask for scaled_dot_product_attention
        causal_mask = None
        if attention_mask is not None:
            # Convert [B, S] padding mask to [B, 1, S, S] attention bias
            causal_mask = attention_mask[:, None, None, :].to(hidden_states.dtype)
            causal_mask = (1.0 - causal_mask) * torch.finfo(hidden_states.dtype).min

        # Run through transformer layers
        new_caches: list[tuple[Tensor, Tensor]] = []

        for i, layer in enumerate(self.layers):
            past_kv = past_key_values[i] if past_key_values is not None else None

            if self.gradient_checkpointing and self.training and not use_cache:
                hidden_states, cache = torch.utils.checkpoint.checkpoint(
                    layer,
                    hidden_states,
                    causal_mask,
                    position_ids,
                    past_kv,
                    use_cache,
                    use_reentrant=False,
                )
            else:
                hidden_states, cache = layer(
                    hidden_states,
                    attention_mask=causal_mask,
                    position_ids=position_ids,
                    past_key_value=past_kv,
                    use_cache=use_cache,
                )

            if cache is not None:
                new_caches.append(cache)

        # Final norm
        hidden_states = self.norm(hidden_states)

        # LM head
        if self.tie_word_embeddings:
            logits = F.linear(hidden_states, self.embed_tokens.weight)
        else:
            logits = self.lm_head(hidden_states)

        # Compute loss if labels provided
        loss = None
        if labels is not None:
            # Shift logits and labels for next-token prediction
            shift_logits = logits[..., :-1, :].contiguous()
            shift_labels = labels[..., 1:].contiguous()
            loss = F.cross_entropy(
                shift_logits.view(-1, self.vocab_size),
                shift_labels.view(-1),
                ignore_index=-100,
            )

        return {
            "loss": loss,
            "logits": logits,
            "past_key_values": new_caches if use_cache else None,
        }

    @torch.no_grad()
    def generate(
        self,
        input_ids: Tensor,
        max_new_tokens: int = 100,
        temperature: float = 1.0,
        top_k: int = 50,
        top_p: float = 0.9,
        eos_token_id: int = 1,
    ) -> Tensor:
        """
        Simple autoregressive generation with top-k / top-p sampling.
        """
        self.eval()
        generated = input_ids
        past_key_values = None

        for _ in range(max_new_tokens):
            if past_key_values is not None:
                # Only process the last token
                current_input = generated[:, -1:]
            else:
                current_input = generated

            outputs = self.forward(
                current_input,
                past_key_values=past_key_values,
                use_cache=True,
            )

            logits = outputs["logits"][:, -1, :]
            past_key_values = outputs["past_key_values"]

            # Temperature scaling
            if temperature != 1.0:
                logits = logits / temperature

            # Top-k filtering
            if top_k > 0:
                indices_to_remove = logits < torch.topk(logits, top_k)[0][..., -1, None]
                logits[indices_to_remove] = float("-inf")

            # Top-p (nucleus) filtering
            if top_p < 1.0:
                sorted_logits, sorted_indices = torch.sort(logits, descending=True)
                cumulative_probs = torch.cumsum(F.softmax(sorted_logits, dim=-1), dim=-1)
                sorted_indices_to_remove = cumulative_probs > top_p
                sorted_indices_to_remove[..., 1:] = sorted_indices_to_remove[..., :-1].clone()
                sorted_indices_to_remove[..., 0] = False
                indices_to_remove = sorted_indices_to_remove.scatter(
                    1, sorted_indices, sorted_indices_to_remove
                )
                logits[indices_to_remove] = float("-inf")

            # Sample
            probs = F.softmax(logits, dim=-1)
            next_token = torch.multinomial(probs, num_samples=1)
            generated = torch.cat([generated, next_token], dim=-1)

            if (next_token == eos_token_id).all():
                break

        return generated


# ---------------------------------------------------------------------------
# Factory function
# ---------------------------------------------------------------------------

def from_config(config: dict[str, Any]) -> AilinTransformer:
    """Create an AilinTransformer from a config dict (e.g., from YAML)."""
    model_cfg = config.get("model", config)

    return AilinTransformer(
        vocab_size=model_cfg["vocab_size"],
        hidden_size=model_cfg["hidden_size"],
        num_layers=model_cfg["num_layers"],
        num_attention_heads=model_cfg["num_attention_heads"],
        num_key_value_heads=model_cfg.get("num_key_value_heads", model_cfg["num_attention_heads"]),
        intermediate_size=model_cfg["intermediate_size"],
        max_position_embeddings=model_cfg.get("max_position_embeddings", 4096),
        rope_theta=model_cfg.get("rope_theta", 10000.0),
        layer_norm_eps=model_cfg.get("layer_norm_eps", 1e-5),
        attention_dropout=model_cfg.get("attention_dropout", 0.0),
        attention_bias=model_cfg.get("attention_bias", False),
        use_flash_attention=model_cfg.get("use_flash_attention", True),
        use_gated_mlp=model_cfg.get("use_gated_mlp", True),
        hidden_act=model_cfg.get("hidden_act", "silu"),
        norm_type=model_cfg.get("norm_type", "rmsnorm"),
        tie_word_embeddings=model_cfg.get("tie_word_embeddings", True),
        initializer_range=model_cfg.get("initializer_range", 0.02),
        use_scaled_init=model_cfg.get("use_scaled_init", True),
        gradient_checkpointing=model_cfg.get("gradient_checkpointing", False),
        embedding_dropout=model_cfg.get("embedding_dropout", 0.0),
    )


def from_yaml(path: str | Path) -> AilinTransformer:
    """Load model from a YAML config file."""
    import yaml

    with open(path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    model = from_config(config)
    logger.info("Created model from %s: %s", path, model.param_count())
    return model


# ---------------------------------------------------------------------------
# CLI demo / test
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import sys
    import json

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if len(sys.argv) > 1:
        model = from_yaml(sys.argv[1])
    else:
        # Create default 1B config for demo
        logger.info("No config provided, creating default Ailin-1B model")
        model = AilinTransformer(
            vocab_size=32000,
            hidden_size=2048,
            num_layers=24,
            num_attention_heads=16,
            num_key_value_heads=16,
            intermediate_size=5504,
            max_position_embeddings=4096,
            use_flash_attention=False,  # Disable for demo without flash-attn
        )

    # Print parameter count
    params = model.param_count()
    print("\n--- Model Parameter Count ---")
    print(json.dumps(params, indent=2))

    # Quick forward pass test
    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.bfloat16 if device == "cuda" else torch.float32

    model = model.to(device=device, dtype=dtype)

    batch_size = 2
    seq_len = 128
    input_ids = torch.randint(0, 32000, (batch_size, seq_len), device=device)
    labels = torch.randint(0, 32000, (batch_size, seq_len), device=device)

    print(f"\nRunning forward pass: batch={batch_size}, seq_len={seq_len}, device={device}")
    outputs = model(input_ids, labels=labels)

    print(f"Loss: {outputs['loss'].item():.4f}")
    print(f"Logits shape: {outputs['logits'].shape}")
    print(f"Expected logits shape: ({batch_size}, {seq_len}, {model.vocab_size})")

    # Test generation
    print("\nRunning generation test...")
    prompt = torch.randint(0, 32000, (1, 16), device=device)
    generated = model.generate(prompt, max_new_tokens=32, temperature=0.8)
    print(f"Generated shape: {generated.shape} (expected (1, {16 + 32}) or less if EOS)")
    print("Forward pass and generation OK!")
