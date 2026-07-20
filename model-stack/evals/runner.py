#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Central evaluation runner.

Loads a model (local path or remote serving endpoint), runs selected
benchmark suites, collects results, compares against baselines, and
generates a combined evaluation report.
"""

from __future__ import annotations

import importlib
import json
import logging
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import click
import httpx
import yaml

logger = logging.getLogger("eval_runner")

# ---------------------------------------------------------------------------
# Suite registry
# ---------------------------------------------------------------------------

SUITE_MODULES: dict[str, str] = {
    "gsm8k": "evals.reasoning.gsm8k",
    "humaneval": "evals.coding.humaneval",
    "tool_calling": "evals.tool_use.tool_calling_eval",
    "safety": "evals.safety.safety_eval",
    "needle_haystack": "evals.long_context.needle_haystack",
    "throughput": "evals.cost_latency.throughput_bench",
    "factuality": "evals.groundedness.factuality_eval",
    "adversarial": "evals.robustness.adversarial_eval",
}


# ---------------------------------------------------------------------------
# Model client abstraction
# ---------------------------------------------------------------------------

@dataclass
class ModelClient:
    """Unified interface for both local and remote model inference."""

    endpoint: str = ""
    model_path: str = ""
    timeout: float = 120.0

    # If endpoint is set we talk to a running server; otherwise we load locally.
    _local_model: Any = None
    _local_tokenizer: Any = None

    def is_remote(self) -> bool:
        return bool(self.endpoint)

    def load_local(self) -> None:
        if self._local_model is not None:
            return
        from transformers import AutoModelForCausalLM, AutoTokenizer
        import torch

        logger.info("Loading local model from %s ...", self.model_path)
        self._local_tokenizer = AutoTokenizer.from_pretrained(self.model_path, trust_remote_code=True)
        self._local_model = AutoModelForCausalLM.from_pretrained(
            self.model_path,
            device_map="auto",
            torch_dtype=torch.float16,
            trust_remote_code=True,
        )
        self._local_model.eval()

    def generate(
        self,
        prompt: str,
        max_tokens: int = 512,
        temperature: float = 0.0,
        stop: list[str] | None = None,
    ) -> str:
        if self.is_remote():
            return self._generate_remote(prompt, max_tokens, temperature, stop)
        return self._generate_local(prompt, max_tokens, temperature, stop)

    def _generate_remote(self, prompt: str, max_tokens: int, temperature: float, stop: list[str] | None) -> str:
        resp = httpx.post(
            f"{self.endpoint.rstrip('/')}/v1/completions",
            json={
                "prompt": prompt,
                "max_tokens": max_tokens,
                "temperature": temperature,
                "stop": stop or [],
            },
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["text"]

    def _generate_local(self, prompt: str, max_tokens: int, temperature: float, stop: list[str] | None) -> str:
        import torch

        self.load_local()
        inputs = self._local_tokenizer(prompt, return_tensors="pt").to(self._local_model.device)
        with torch.no_grad():
            output_ids = self._local_model.generate(
                **inputs,
                max_new_tokens=max_tokens,
                temperature=max(temperature, 1e-7),
                do_sample=temperature > 0,
            )
        new_tokens = output_ids[0][inputs["input_ids"].shape[1]:]
        text = self._local_tokenizer.decode(new_tokens, skip_special_tokens=True)

        # Apply stop sequences
        if stop:
            for s in stop:
                idx = text.find(s)
                if idx >= 0:
                    text = text[:idx]
        return text

    def chat(
        self,
        messages: list[dict[str, str]],
        max_tokens: int = 512,
        temperature: float = 0.0,
    ) -> str:
        if self.is_remote():
            resp = httpx.post(
                f"{self.endpoint.rstrip('/')}/v1/chat/completions",
                json={
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                },
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]

        # Flatten to a simple prompt for local model
        parts = []
        for m in messages:
            parts.append(f"<|{m['role']}|>\n{m['content']}")
        parts.append("<|assistant|>\n")
        return self.generate("\n".join(parts), max_tokens=max_tokens, temperature=temperature)


# ---------------------------------------------------------------------------
# Evaluation report
# ---------------------------------------------------------------------------

@dataclass
class SuiteResult:
    suite: str
    metrics: dict[str, float] = field(default_factory=dict)
    details: Any = None
    elapsed_seconds: float = 0.0
    error: str = ""


@dataclass
class EvaluationReport:
    model_name: str = ""
    model_version: str = ""
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    suites: list[SuiteResult] = field(default_factory=list)
    aggregate_metrics: dict[str, float] = field(default_factory=dict)
    baseline_comparison: dict[str, dict[str, float]] = field(default_factory=dict)

    def add_suite(self, result: SuiteResult) -> None:
        self.suites.append(result)
        self.aggregate_metrics.update(
            {f"{result.suite}/{k}": v for k, v in result.metrics.items()}
        )

    def compare_baseline(self, baseline: dict[str, float]) -> None:
        for key, value in self.aggregate_metrics.items():
            if key in baseline:
                self.baseline_comparison[key] = {
                    "current": value,
                    "baseline": baseline[key],
                    "delta": round(value - baseline[key], 6),
                }

    def to_dict(self) -> dict:
        return {
            "model_name": self.model_name,
            "model_version": self.model_version,
            "timestamp": self.timestamp,
            "suites": [asdict(s) for s in self.suites],
            "aggregate_metrics": self.aggregate_metrics,
            "baseline_comparison": self.baseline_comparison,
        }

    def save(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2))

    def human_readable(self) -> str:
        lines = [
            f"Evaluation Report: {self.model_name}@{self.model_version}",
            f"Timestamp: {self.timestamp}",
            "=" * 60,
        ]
        for s in self.suites:
            status = "OK" if not s.error else f"ERROR: {s.error}"
            lines.append(f"\n[{s.suite}] ({s.elapsed_seconds:.1f}s) {status}")
            for k, v in s.metrics.items():
                baseline_info = ""
                full_key = f"{s.suite}/{k}"
                if full_key in self.baseline_comparison:
                    delta = self.baseline_comparison[full_key]["delta"]
                    baseline_info = f"  (delta: {delta:+.4f})"
                lines.append(f"  {k}: {v:.4f}{baseline_info}")
        lines.append("\n" + "=" * 60)
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Runner
# ---------------------------------------------------------------------------

def run_suite(suite_name: str, client: ModelClient, **kwargs) -> SuiteResult:
    """Dynamically load and run a benchmark suite."""
    module_path = SUITE_MODULES.get(suite_name)
    if module_path is None:
        return SuiteResult(suite=suite_name, error=f"Unknown suite: {suite_name}")

    try:
        mod = importlib.import_module(module_path)
    except ImportError as exc:
        return SuiteResult(suite=suite_name, error=f"Import error: {exc}")

    run_fn = getattr(mod, "run", None)
    if run_fn is None:
        return SuiteResult(suite=suite_name, error="Module has no 'run' function")

    start = time.time()
    try:
        metrics, details = run_fn(client, **kwargs)
        elapsed = time.time() - start
        return SuiteResult(suite=suite_name, metrics=metrics, details=details, elapsed_seconds=elapsed)
    except Exception as exc:
        elapsed = time.time() - start
        logger.exception("Suite %s failed", suite_name)
        return SuiteResult(suite=suite_name, error=str(exc), elapsed_seconds=elapsed)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option("--model-path", default=None, help="Local model path")
@click.option("--endpoint", default=None, help="Remote serving endpoint (e.g. http://localhost:8000)")
@click.option("--suites", default="all", help="Comma-separated suite names or 'all'")
@click.option("--baseline", default=None, type=click.Path(exists=True), help="Baseline JSON")
@click.option("--output", default="eval_report.json", type=click.Path(), help="Output report JSON")
@click.option("--model-name", default="unknown", help="Model name for the report")
@click.option("--model-version", default="0.0.0", help="Model version for the report")
@click.option("--num-samples", type=int, default=None, help="Override sample count for suites")
def main(
    model_path: str | None,
    endpoint: str | None,
    suites: str,
    baseline: str | None,
    output: str,
    model_name: str,
    model_version: str,
    num_samples: int | None,
):
    """Run evaluation suites and produce a report."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    if not model_path and not endpoint:
        raise click.UsageError("Provide --model-path or --endpoint")

    client = ModelClient(endpoint=endpoint or "", model_path=model_path or "")
    report = EvaluationReport(model_name=model_name, model_version=model_version)

    suite_list: list[str]
    if suites == "all":
        suite_list = list(SUITE_MODULES.keys())
    else:
        suite_list = [s.strip() for s in suites.split(",")]

    kwargs: dict[str, Any] = {}
    if num_samples is not None:
        kwargs["num_samples"] = num_samples

    for suite_name in suite_list:
        logger.info("Running suite: %s", suite_name)
        result = run_suite(suite_name, client, **kwargs)
        report.add_suite(result)
        if result.error:
            logger.error("Suite %s failed: %s", suite_name, result.error)
        else:
            logger.info("Suite %s completed in %.1fs", suite_name, result.elapsed_seconds)

    # Compare against baseline
    if baseline:
        baseline_data = json.loads(Path(baseline).read_text())
        baseline_metrics = baseline_data.get("aggregate_metrics", {})
        report.compare_baseline(baseline_metrics)

    # Save outputs
    out_path = Path(output)
    report.save(out_path)
    logger.info("Report saved to %s", out_path)

    # Human-readable summary
    click.echo(report.human_readable())


if __name__ == "__main__":
    main()
