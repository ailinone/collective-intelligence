#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""HumanEval coding evaluation.

Loads the OpenAI HumanEval benchmark, generates code completions,
executes them in a sandboxed subprocess, and computes pass@k rates.
"""

from __future__ import annotations

import logging
import math
import multiprocessing
import signal
import subprocess
import sys
import tempfile
import textwrap
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from datasets import load_dataset

logger = logging.getLogger("humaneval_eval")

EXECUTION_TIMEOUT = 10  # seconds per test execution


# ---------------------------------------------------------------------------
# pass@k estimator (unbiased, from the original paper)
# ---------------------------------------------------------------------------

def pass_at_k(n: int, c: int, k: int) -> float:
    """Unbiased estimator for pass@k.

    n = total samples, c = number of correct samples, k = target k.
    """
    if n - c < k:
        return 1.0
    return 1.0 - math.prod((n - c - i) / (n - i) for i in range(k))


# ---------------------------------------------------------------------------
# Sandboxed execution
# ---------------------------------------------------------------------------

def execute_code(code: str, test_code: str, timeout: int = EXECUTION_TIMEOUT) -> tuple[bool, str]:
    """Run generated code + unit tests in a subprocess with a timeout.

    Returns (passed: bool, error_message: str).
    """
    full_code = code + "\n" + test_code + "\n"

    with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False) as f:
        f.write(full_code)
        tmp_path = f.name

    try:
        result = subprocess.run(
            [sys.executable, tmp_path],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if result.returncode == 0:
            return True, ""
        return False, (result.stderr or result.stdout)[:500]
    except subprocess.TimeoutExpired:
        return False, f"Execution timed out after {timeout}s"
    except Exception as exc:
        return False, str(exc)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

def build_prompt(prompt: str, entry_point: str) -> str:
    """Build a completion prompt from the HumanEval problem signature."""
    return (
        "Complete the following Python function. "
        "Only output the function body, nothing else.\n\n"
        f"{prompt}"
    )


def extract_function(model_output: str, prompt: str) -> str:
    """Combine the original prompt (signature) with the model completion."""
    # The model should provide the function body.
    # If the model repeated the signature, strip it.
    output = model_output

    # Simple heuristic: if the output starts with "def ", assume the model
    # re-wrote the entire function.
    if output.lstrip().startswith("def "):
        return output

    # Otherwise, append the completion to the prompt.
    return prompt + output


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

@dataclass
class HumanEvalResult:
    task_id: str
    prompt: str
    entry_point: str
    completions: list[str]
    test_results: list[bool]
    errors: list[str]


def run(
    client,
    num_samples: int | None = None,
    n_completions: int = 5,
    temperature: float = 0.2,
    **_kwargs,
) -> tuple[dict[str, float], list[dict]]:
    """Entry point called by the central eval runner."""
    logger.info("Loading HumanEval dataset ...")
    ds = load_dataset("openai_humaneval", split="test")

    if num_samples:
        ds = ds.select(range(min(num_samples, len(ds))))

    results: list[HumanEvalResult] = []

    for idx, problem in enumerate(ds):
        task_id = problem["task_id"]
        prompt = problem["prompt"]
        test_code = problem["test"]
        entry_point = problem["entry_point"]

        completions: list[str] = []
        test_results: list[bool] = []
        errors: list[str] = []

        for k in range(n_completions):
            try:
                raw = client.generate(
                    build_prompt(prompt, entry_point),
                    max_tokens=512,
                    temperature=temperature if k > 0 else 0.0,
                    stop=["\nclass ", "\ndef ", "\n#", "\nif __name__"],
                )
            except Exception as exc:
                logger.warning("Generation failed for %s (sample %d): %s", task_id, k, exc)
                raw = ""

            code = extract_function(raw, prompt)
            completions.append(code)

            # Build the test harness
            harness = f"{code}\n\n{test_code}\n\ncheck({entry_point})\n"
            passed, err = execute_code(code, f"{test_code}\n\ncheck({entry_point})\n")
            test_results.append(passed)
            errors.append(err)

        results.append(
            HumanEvalResult(
                task_id=task_id,
                prompt=prompt,
                entry_point=entry_point,
                completions=completions,
                test_results=test_results,
                errors=errors,
            )
        )

        if (idx + 1) % 20 == 0:
            pass1_running = sum(1 for r in results if r.test_results[0]) / len(results)
            logger.info("Progress: %d/%d  pass@1=%.3f", idx + 1, len(ds), pass1_running)

    # Compute pass@k
    total = len(results)
    per_problem_correct = [sum(r.test_results) for r in results]

    pass_1 = sum(pass_at_k(n_completions, c, 1) for c in per_problem_correct) / max(total, 1)
    pass_5 = sum(pass_at_k(n_completions, c, min(5, n_completions)) for c in per_problem_correct) / max(total, 1)

    metrics = {
        "pass_at_1": round(pass_1, 4),
        "pass_at_5": round(pass_5, 4),
        "total_problems": total,
        "n_completions": n_completions,
    }

    details = [
        {
            "task_id": r.task_id,
            "passed": r.test_results,
            "num_correct": sum(r.test_results),
            "errors": [e for e in r.errors if e],
        }
        for r in results
    ]

    logger.info("HumanEval pass@1=%.4f  pass@5=%.4f  (%d problems)", pass_1, pass_5, total)
    return metrics, details
