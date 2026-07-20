#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""GSM8K math reasoning evaluation.

Loads the GSM8K test set, generates chain-of-thought answers, extracts
the final numeric answer, and computes per-difficulty accuracy.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

from datasets import load_dataset

logger = logging.getLogger("gsm8k_eval")


# ---------------------------------------------------------------------------
# Answer extraction
# ---------------------------------------------------------------------------

_ANSWER_RE = re.compile(r"####\s*(-?[\d,]+\.?\d*)")
_NUMERIC_RE = re.compile(r"(-?[\d,]+\.?\d*)")


def extract_answer(text: str) -> str | None:
    """Extract the final numeric answer from model output.

    First tries the GSM8K canonical ``#### <number>`` marker.
    Falls back to the last number in the text.
    """
    m = _ANSWER_RE.search(text)
    if m:
        return m.group(1).replace(",", "")
    # Fallback: last number in text
    nums = _NUMERIC_RE.findall(text)
    if nums:
        return nums[-1].replace(",", "")
    return None


def normalize_answer(answer: str | None) -> float | None:
    if answer is None:
        return None
    try:
        return float(answer.replace(",", ""))
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# Difficulty heuristic
# ---------------------------------------------------------------------------

def estimate_difficulty(question: str, solution: str) -> str:
    """Assign a rough difficulty bucket based on solution length."""
    steps = solution.count("\n")
    if steps <= 3:
        return "easy"
    if steps <= 6:
        return "medium"
    return "hard"


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

@dataclass
class GSM8KResult:
    question: str
    gold_answer: str
    model_output: str
    extracted: str | None
    correct: bool
    difficulty: str


def build_prompt(question: str) -> str:
    return (
        "Solve the following math problem step by step. "
        "After your reasoning, output the final numeric answer on a new line "
        "preceded by '####'.\n\n"
        f"Question: {question}\n\n"
        "Solution:"
    )


def run(client, num_samples: int | None = None, **_kwargs) -> tuple[dict[str, float], list[dict]]:
    """Entry point called by the central eval runner.

    Returns (metrics_dict, details_list).
    """
    logger.info("Loading GSM8K test set ...")
    ds = load_dataset("gsm8k", "main", split="test")

    if num_samples:
        ds = ds.select(range(min(num_samples, len(ds))))

    results: list[GSM8KResult] = []
    difficulty_counts: dict[str, int] = {}
    difficulty_correct: dict[str, int] = {}

    for idx, example in enumerate(ds):
        question = example["question"]
        gold_raw = example["answer"]

        # GSM8K ground-truth format: reasoning text then #### <number>
        gold_match = _ANSWER_RE.search(gold_raw)
        gold_answer = gold_match.group(1).replace(",", "") if gold_match else ""
        gold_numeric = normalize_answer(gold_answer)

        difficulty = estimate_difficulty(question, gold_raw)

        prompt = build_prompt(question)
        try:
            output = client.generate(prompt, max_tokens=512, temperature=0.0, stop=["Question:"])
        except Exception as exc:
            logger.warning("Generation failed for sample %d: %s", idx, exc)
            output = ""

        extracted = extract_answer(output)
        pred_numeric = normalize_answer(extracted)

        correct = (
            gold_numeric is not None
            and pred_numeric is not None
            and abs(gold_numeric - pred_numeric) < 1e-3
        )

        results.append(
            GSM8KResult(
                question=question,
                gold_answer=gold_answer,
                model_output=output,
                extracted=extracted,
                correct=correct,
                difficulty=difficulty,
            )
        )

        difficulty_counts[difficulty] = difficulty_counts.get(difficulty, 0) + 1
        if correct:
            difficulty_correct[difficulty] = difficulty_correct.get(difficulty, 0) + 1

        if (idx + 1) % 50 == 0:
            running_acc = sum(1 for r in results if r.correct) / len(results)
            logger.info("Progress: %d/%d  running accuracy=%.3f", idx + 1, len(ds), running_acc)

    total = len(results)
    total_correct = sum(1 for r in results if r.correct)
    accuracy = total_correct / max(total, 1)

    metrics: dict[str, float] = {"accuracy": round(accuracy, 4), "total": total, "correct": total_correct}

    for diff in ("easy", "medium", "hard"):
        cnt = difficulty_counts.get(diff, 0)
        cor = difficulty_correct.get(diff, 0)
        if cnt > 0:
            metrics[f"accuracy_{diff}"] = round(cor / cnt, 4)
            metrics[f"count_{diff}"] = cnt

    details = [
        {
            "question": r.question[:200],
            "gold": r.gold_answer,
            "predicted": r.extracted,
            "correct": r.correct,
            "difficulty": r.difficulty,
        }
        for r in results
    ]

    logger.info("GSM8K accuracy: %.4f (%d/%d)", accuracy, total_correct, total)
    return metrics, details
