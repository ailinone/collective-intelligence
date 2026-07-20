# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Scaling law estimator based on Chinchilla-optimal compute/data/parameter relationships.

Implements the power-law relationships from Hoffmann et al. (2022) "Training Compute-Optimal
Large Language Models" (Chinchilla paper) and the earlier Kaplan et al. (2020) scaling laws.

Given a compute budget (in FLOPs), estimates optimal model size and training token count.
Given a model size, estimates the training tokens needed for compute-optimal training.
"""

from __future__ import annotations

import json
import logging
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import click

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Scaling law constants
# ---------------------------------------------------------------------------

# Chinchilla scaling law parameters (Hoffmann et al., 2022)
# Loss L(N, D) = E + A/N^alpha + B/D^beta
# where N = parameters, D = training tokens
# Optimal allocation: N_opt ~ C^a, D_opt ~ C^b where a + b = 1

CHINCHILLA = {
    # Loss model parameters
    "E": 1.69,          # Irreducible loss (entropy of natural language)
    "A": 406.4,         # Parameter scaling coefficient
    "alpha": 0.34,      # Parameter scaling exponent
    "B": 410.7,         # Data scaling coefficient
    "beta": 0.28,       # Data scaling exponent

    # Optimal allocation (from parametric fits)
    # N_opt = a_N * C^p_N
    "a_N": 0.7057,      # Coefficient for optimal N
    "p_N": 0.4988,      # Exponent for optimal N (close to 0.5)

    # D_opt = a_D * C^p_D
    "a_D": 0.2360,      # Coefficient for optimal D
    "p_D": 0.5012,      # Exponent for optimal D (close to 0.5)

    # Ratio: Chinchilla recommends ~20 tokens per parameter
    "tokens_per_param": 20.0,
}

# Kaplan et al. (2020) scaling law parameters (for comparison)
KAPLAN = {
    # N_opt ~ C^0.73 / 6  (approximately)
    "compute_exponent_N": 0.73,
    "compute_exponent_D": 0.27,
    # Kaplan recommended ~1.7 tokens per parameter (now considered suboptimal)
    "tokens_per_param": 1.7,
}


# ---------------------------------------------------------------------------
# Compute estimation
# ---------------------------------------------------------------------------

def estimate_flops_per_token(num_params: int) -> float:
    """
    Estimate FLOPs per token for a forward pass.

    Approximate rule: ~6N FLOPs per token for a forward+backward pass
    (2N for forward, 4N for backward with gradient computation).
    For forward only: ~2N.
    """
    return 6.0 * num_params


def estimate_training_flops(num_params: int, num_tokens: int) -> float:
    """
    Estimate total training FLOPs.

    C ≈ 6 * N * D (Chinchilla approximation)
    """
    return 6.0 * num_params * num_tokens


def estimate_gpu_hours(
    total_flops: float,
    gpu_flops: float = 312e12,  # A100 BF16 peak: 312 TFLOPS
    mfu: float = 0.40,          # Model FLOP utilization (typical: 30-50%)
) -> float:
    """Estimate GPU hours needed for training."""
    effective_flops = gpu_flops * mfu
    seconds = total_flops / effective_flops
    return seconds / 3600.0


# ---------------------------------------------------------------------------
# Chinchilla-optimal estimation
# ---------------------------------------------------------------------------

@dataclass
class ScalingEstimate:
    """Result of a scaling law estimation."""

    # Inputs
    compute_budget_flops: float | None = None
    target_params: int | None = None
    target_tokens: int | None = None

    # Chinchilla-optimal outputs
    optimal_params: int = 0
    optimal_tokens: int = 0
    optimal_compute_flops: float = 0.0

    # Predicted loss
    predicted_loss: float = 0.0

    # Resource estimates
    gpu_hours_a100: float = 0.0
    gpu_hours_h100: float = 0.0
    tokens_per_param_ratio: float = 0.0

    # Architecture suggestions
    suggested_hidden_size: int = 0
    suggested_num_layers: int = 0
    suggested_num_heads: int = 0
    suggested_intermediate_size: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "inputs": {
                "compute_budget_flops": self.compute_budget_flops,
                "target_params": self.target_params,
                "target_tokens": self.target_tokens,
            },
            "optimal": {
                "params": self.optimal_params,
                "params_billions": round(self.optimal_params / 1e9, 3),
                "tokens": self.optimal_tokens,
                "tokens_billions": round(self.optimal_tokens / 1e9, 1),
                "compute_flops": self.optimal_compute_flops,
                "tokens_per_param": round(self.tokens_per_param_ratio, 1),
            },
            "predicted_loss": round(self.predicted_loss, 4),
            "resource_estimates": {
                "gpu_hours_a100_40pct_mfu": round(self.gpu_hours_a100, 1),
                "gpu_hours_h100_40pct_mfu": round(self.gpu_hours_h100, 1),
                "gpu_days_a100_8gpu": round(self.gpu_hours_a100 / (8 * 24), 1),
                "gpu_days_h100_8gpu": round(self.gpu_hours_h100 / (8 * 24), 1),
            },
            "suggested_architecture": {
                "hidden_size": self.suggested_hidden_size,
                "num_layers": self.suggested_num_layers,
                "num_heads": self.suggested_num_heads,
                "intermediate_size": self.suggested_intermediate_size,
            },
        }


def predict_loss(num_params: int, num_tokens: int) -> float:
    """
    Predict training loss using Chinchilla parametric loss model.

    L(N, D) = E + A/N^alpha + B/D^beta
    """
    c = CHINCHILLA
    loss = c["E"] + c["A"] / (num_params ** c["alpha"]) + c["B"] / (num_tokens ** c["beta"])
    return loss


def _round_to_multiple(value: int, multiple: int) -> int:
    """Round value to nearest multiple."""
    return max(multiple, round(value / multiple) * multiple)


def suggest_architecture(num_params: int) -> dict[str, int]:
    """
    Suggest transformer architecture dimensions for a target parameter count.

    Uses empirical ratios from successful models:
      - intermediate_size ≈ 2.7 * hidden_size (for SwiGLU)
      - num_layers chosen to balance depth vs width
      - head_dim = 128 is standard
    """
    head_dim = 128

    # Approximate: params ≈ 12 * L * d^2 for a standard transformer (with SwiGLU factor)
    # More precisely: params ≈ L * (12*d^2 + 13*d) + vocab*d where 12 comes from
    # Q,K,V,O (4*d^2) + SwiGLU (8/3*d * d * 3) ≈ 8*d^2, so total ≈ 12*d^2
    # We solve for d given target params and estimated layers

    # Heuristic: deeper models are generally better
    # Use depth-to-width ratio that scales ~sqrt(N)
    if num_params < 500e6:
        depth_factor = 1.0
    elif num_params < 5e9:
        depth_factor = 1.2
    elif num_params < 50e9:
        depth_factor = 1.4
    else:
        depth_factor = 1.6

    # Estimate hidden_size
    # params ≈ num_layers * (12 * d^2) for the transformer layers
    # Initial guess: num_layers ≈ 2 * (d / head_dim), then d = sqrt(params / (24 * d / head_dim))
    # Simplified: d ≈ (params * head_dim / 24)^(1/3) * depth_factor^(-1/3)

    d_estimate = (num_params * head_dim / 24.0) ** (1.0 / 3.0) * depth_factor ** (-1.0 / 3.0)
    hidden_size = _round_to_multiple(int(d_estimate), 128)
    hidden_size = max(256, hidden_size)

    # Estimate layers from remaining params
    per_layer_params = 12 * hidden_size * hidden_size  # Approximate
    num_layers = max(4, round(num_params / max(per_layer_params, 1)))

    # Adjust to get closer to target
    vocab_size = 32000
    actual_params = num_layers * per_layer_params + vocab_size * hidden_size
    while actual_params < num_params * 0.9 and num_layers < 200:
        num_layers += 1
        actual_params = num_layers * per_layer_params + vocab_size * hidden_size
    while actual_params > num_params * 1.1 and num_layers > 4:
        num_layers -= 1
        actual_params = num_layers * per_layer_params + vocab_size * hidden_size

    num_heads = max(1, hidden_size // head_dim)
    intermediate_size = _round_to_multiple(int(hidden_size * 2.7), 256)

    return {
        "hidden_size": hidden_size,
        "num_layers": num_layers,
        "num_heads": num_heads,
        "intermediate_size": intermediate_size,
    }


def estimate_from_compute(compute_budget_flops: float) -> ScalingEstimate:
    """
    Given a compute budget in FLOPs, estimate optimal model size and token count.

    Uses Chinchilla scaling laws.
    """
    c = CHINCHILLA

    # Chinchilla-optimal allocation
    optimal_params = int(c["a_N"] * (compute_budget_flops ** c["p_N"]))
    optimal_tokens = int(c["a_D"] * (compute_budget_flops ** c["p_D"]))

    # Predicted loss
    loss = predict_loss(optimal_params, optimal_tokens)

    # Resource estimates
    actual_compute = estimate_training_flops(optimal_params, optimal_tokens)
    a100_hours = estimate_gpu_hours(actual_compute, gpu_flops=312e12, mfu=0.40)
    h100_hours = estimate_gpu_hours(actual_compute, gpu_flops=989e12, mfu=0.40)

    # Architecture
    arch = suggest_architecture(optimal_params)

    return ScalingEstimate(
        compute_budget_flops=compute_budget_flops,
        optimal_params=optimal_params,
        optimal_tokens=optimal_tokens,
        optimal_compute_flops=actual_compute,
        predicted_loss=loss,
        gpu_hours_a100=a100_hours,
        gpu_hours_h100=h100_hours,
        tokens_per_param_ratio=optimal_tokens / max(optimal_params, 1),
        suggested_hidden_size=arch["hidden_size"],
        suggested_num_layers=arch["num_layers"],
        suggested_num_heads=arch["num_heads"],
        suggested_intermediate_size=arch["intermediate_size"],
    )


def estimate_from_params(target_params: int, tokens_per_param: float | None = None) -> ScalingEstimate:
    """
    Given a target model size, estimate training tokens needed.

    Uses Chinchilla-optimal ratio (~20 tokens per parameter) by default.
    """
    if tokens_per_param is None:
        tokens_per_param = CHINCHILLA["tokens_per_param"]

    optimal_tokens = int(target_params * tokens_per_param)
    compute = estimate_training_flops(target_params, optimal_tokens)
    loss = predict_loss(target_params, optimal_tokens)

    a100_hours = estimate_gpu_hours(compute, gpu_flops=312e12, mfu=0.40)
    h100_hours = estimate_gpu_hours(compute, gpu_flops=989e12, mfu=0.40)

    arch = suggest_architecture(target_params)

    return ScalingEstimate(
        target_params=target_params,
        optimal_params=target_params,
        optimal_tokens=optimal_tokens,
        optimal_compute_flops=compute,
        predicted_loss=loss,
        gpu_hours_a100=a100_hours,
        gpu_hours_h100=h100_hours,
        tokens_per_param_ratio=tokens_per_param,
        suggested_hidden_size=arch["hidden_size"],
        suggested_num_layers=arch["num_layers"],
        suggested_num_heads=arch["num_heads"],
        suggested_intermediate_size=arch["intermediate_size"],
    )


def estimate_from_tokens(target_tokens: int) -> ScalingEstimate:
    """
    Given a training token budget, estimate optimal model size.

    Uses Chinchilla ratio: N_opt = D / 20.
    """
    optimal_params = int(target_tokens / CHINCHILLA["tokens_per_param"])
    compute = estimate_training_flops(optimal_params, target_tokens)
    loss = predict_loss(optimal_params, target_tokens)

    a100_hours = estimate_gpu_hours(compute, gpu_flops=312e12, mfu=0.40)
    h100_hours = estimate_gpu_hours(compute, gpu_flops=989e12, mfu=0.40)

    arch = suggest_architecture(optimal_params)

    return ScalingEstimate(
        target_tokens=target_tokens,
        optimal_params=optimal_params,
        optimal_tokens=target_tokens,
        optimal_compute_flops=compute,
        predicted_loss=loss,
        gpu_hours_a100=a100_hours,
        gpu_hours_h100=h100_hours,
        tokens_per_param_ratio=target_tokens / max(optimal_params, 1),
        suggested_hidden_size=arch["hidden_size"],
        suggested_num_layers=arch["num_layers"],
        suggested_num_heads=arch["num_heads"],
        suggested_intermediate_size=arch["intermediate_size"],
    )


def compare_scaling(
    param_sizes: list[int] | None = None,
) -> list[dict[str, Any]]:
    """
    Compare Chinchilla-optimal estimates across multiple model sizes.

    Useful for planning a model family or choosing the right scale.
    """
    if param_sizes is None:
        param_sizes = [
            int(70e6), int(160e6), int(410e6),
            int(1e9), int(3e9), int(7e9),
            int(13e9), int(30e9), int(70e9),
        ]

    results: list[dict[str, Any]] = []
    for n in param_sizes:
        est = estimate_from_params(n)
        results.append(est.to_dict())

    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("scaling-laws")
@click.option("--compute", default=None, type=float, help="Compute budget in FLOPs (e.g., 1e21)")
@click.option("--params", default=None, type=float, help="Target parameter count (e.g., 1e9 for 1B)")
@click.option("--tokens", default=None, type=float, help="Training token budget (e.g., 3e11 for 300B)")
@click.option("--tokens-per-param", default=None, type=float, help="Override tokens-per-param ratio")
@click.option("--compare", is_flag=True, help="Compare estimates across standard model sizes")
@click.option("--output", default=None, type=click.Path(), help="Save report to JSON file")
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    compute: float | None,
    params: float | None,
    tokens: float | None,
    tokens_per_param: float | None,
    compare: bool,
    output: str | None,
    log_level: str,
) -> None:
    """Estimate optimal model size and training tokens using Chinchilla scaling laws."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    if compare:
        results = compare_scaling()
        click.echo("\n--- Scaling Law Comparison (Chinchilla-Optimal) ---")
        click.echo(f"{'Params':>12s} {'Tokens':>12s} {'FLOPs':>12s} {'Loss':>8s} {'A100 hrs':>10s} {'H100 hrs':>10s}")
        click.echo("-" * 70)
        for r in results:
            o = r["optimal"]
            res = r["resource_estimates"]
            click.echo(
                f"{o['params_billions']:>10.3f}B "
                f"{o['tokens_billions']:>10.1f}B "
                f"{o['compute_flops']:>12.2e} "
                f"{r['predicted_loss']:>8.4f} "
                f"{res['gpu_hours_a100_40pct_mfu']:>10.0f} "
                f"{res['gpu_hours_h100_40pct_mfu']:>10.0f}"
            )

        if output:
            with open(output, "w") as f:
                json.dump(results, f, indent=2)
            click.echo(f"\nReport saved to {output}")
        return

    if compute is not None:
        estimate = estimate_from_compute(compute)
        mode = "compute"
    elif params is not None:
        estimate = estimate_from_params(int(params), tokens_per_param=tokens_per_param)
        mode = "params"
    elif tokens is not None:
        estimate = estimate_from_tokens(int(tokens))
        mode = "tokens"
    else:
        # Default: estimate for a 1B parameter model
        click.echo("No input specified, estimating for 1B parameter model...")
        estimate = estimate_from_params(int(1e9))
        mode = "params"

    report = estimate.to_dict()

    click.echo(f"\n--- Scaling Law Estimate (mode: {mode}) ---")
    o = report["optimal"]
    click.echo(f"Optimal parameters:  {o['params_billions']:.3f}B ({o['params']:,})")
    click.echo(f"Optimal tokens:      {o['tokens_billions']:.1f}B ({o['tokens']:,})")
    click.echo(f"Tokens/param ratio:  {o['tokens_per_param']:.1f}x")
    click.echo(f"Compute (FLOPs):     {o['compute_flops']:.2e}")
    click.echo(f"Predicted loss:      {report['predicted_loss']:.4f}")

    res = report["resource_estimates"]
    click.echo(f"\nResource estimates (40% MFU):")
    click.echo(f"  A100 GPU-hours:    {res['gpu_hours_a100_40pct_mfu']:,.0f}")
    click.echo(f"  A100 8-GPU days:   {res['gpu_days_a100_8gpu']:,.1f}")
    click.echo(f"  H100 GPU-hours:    {res['gpu_hours_h100_40pct_mfu']:,.0f}")
    click.echo(f"  H100 8-GPU days:   {res['gpu_days_h100_8gpu']:,.1f}")

    arch = report["suggested_architecture"]
    click.echo(f"\nSuggested architecture:")
    click.echo(f"  hidden_size:       {arch['hidden_size']}")
    click.echo(f"  num_layers:        {arch['num_layers']}")
    click.echo(f"  num_heads:         {arch['num_heads']}")
    click.echo(f"  intermediate_size: {arch['intermediate_size']}")

    if output:
        with open(output, "w") as f:
            json.dump(report, f, indent=2)
        click.echo(f"\nReport saved to {output}")


if __name__ == "__main__":
    cli()
