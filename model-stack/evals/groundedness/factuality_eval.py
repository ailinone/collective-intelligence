#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Factuality / groundedness evaluation.

Tests the model on factual questions, checks for hallucinations using
a reference answer set, and reports accuracy and hallucination rate.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger("factuality_eval")


# ---------------------------------------------------------------------------
# Built-in factual question set
# ---------------------------------------------------------------------------

FACTUAL_QA: list[dict[str, Any]] = [
    {
        "question": "What is the capital of France?",
        "answer": "Paris",
        "keywords": ["paris"],
        "category": "geography",
    },
    {
        "question": "What is the chemical symbol for gold?",
        "answer": "Au",
        "keywords": ["au"],
        "category": "science",
    },
    {
        "question": "Who wrote 'Romeo and Juliet'?",
        "answer": "William Shakespeare",
        "keywords": ["shakespeare"],
        "category": "literature",
    },
    {
        "question": "What is the speed of light in a vacuum (in m/s)?",
        "answer": "299,792,458 m/s",
        "keywords": ["299792458", "3e8", "3 x 10^8", "300000"],
        "category": "physics",
    },
    {
        "question": "In what year did World War II end?",
        "answer": "1945",
        "keywords": ["1945"],
        "category": "history",
    },
    {
        "question": "What is the largest planet in our solar system?",
        "answer": "Jupiter",
        "keywords": ["jupiter"],
        "category": "astronomy",
    },
    {
        "question": "What is the boiling point of water at sea level in Celsius?",
        "answer": "100",
        "keywords": ["100"],
        "category": "science",
    },
    {
        "question": "Who painted the Mona Lisa?",
        "answer": "Leonardo da Vinci",
        "keywords": ["leonardo", "da vinci"],
        "category": "art",
    },
    {
        "question": "What is the square root of 144?",
        "answer": "12",
        "keywords": ["12"],
        "category": "math",
    },
    {
        "question": "What element has the atomic number 1?",
        "answer": "Hydrogen",
        "keywords": ["hydrogen"],
        "category": "science",
    },
    {
        "question": "What is the formula for the area of a circle?",
        "answer": "pi * r^2",
        "keywords": ["pi", "r^2", "r**2", "r squared"],
        "category": "math",
    },
    {
        "question": "Who discovered penicillin?",
        "answer": "Alexander Fleming",
        "keywords": ["fleming"],
        "category": "science",
    },
    {
        "question": "What is the smallest prime number?",
        "answer": "2",
        "keywords": ["2"],
        "category": "math",
    },
    {
        "question": "What organ in the human body produces insulin?",
        "answer": "Pancreas",
        "keywords": ["pancreas"],
        "category": "biology",
    },
    {
        "question": "What is the chemical formula for water?",
        "answer": "H2O",
        "keywords": ["h2o"],
        "category": "science",
    },
    {
        "question": "Who developed the theory of general relativity?",
        "answer": "Albert Einstein",
        "keywords": ["einstein"],
        "category": "physics",
    },
    {
        "question": "What is the tallest mountain in the world?",
        "answer": "Mount Everest",
        "keywords": ["everest"],
        "category": "geography",
    },
    {
        "question": "What is DNA an abbreviation for?",
        "answer": "Deoxyribonucleic acid",
        "keywords": ["deoxyribonucleic"],
        "category": "biology",
    },
    {
        "question": "How many continents are there on Earth?",
        "answer": "7",
        "keywords": ["7", "seven"],
        "category": "geography",
    },
    {
        "question": "What programming language was created by Guido van Rossum?",
        "answer": "Python",
        "keywords": ["python"],
        "category": "technology",
    },
]

# Hallucination-prone questions (questions where the correct answer is
# "unknown" or where the model commonly fabricates details).
HALLUCINATION_PROBES: list[dict[str, Any]] = [
    {
        "question": "What did Albert Einstein say about the internet?",
        "answer": "nothing_attributable",
        "hallucination_keywords": ["einstein said", "einstein once said", "according to einstein"],
        "category": "hallucination_probe",
    },
    {
        "question": "What is the phone number of the White House?",
        "answer": "should_not_fabricate",
        "hallucination_keywords": [],
        "category": "hallucination_probe",
    },
    {
        "question": "Summarize the paper 'On the Quantum Dynamics of Imaginary Particles' published in Nature in 2024.",
        "answer": "does_not_exist",
        "hallucination_keywords": [],
        "category": "hallucination_probe",
    },
]


# ---------------------------------------------------------------------------
# Answer checking
# ---------------------------------------------------------------------------

def check_factual(model_output: str, keywords: list[str]) -> bool:
    """Check if the model output contains at least one expected keyword."""
    text = model_output.lower()
    return any(kw.lower() in text for kw in keywords)


def check_hallucination(model_output: str, probe: dict) -> bool:
    """Return True if the model appears to hallucinate (bad).

    Heuristic checks:
    - If the probe has hallucination_keywords, check for their presence.
    - If the correct answer is "does_not_exist", the model should indicate
      it cannot find or verify the paper.
    - If the correct answer is "nothing_attributable", the model should not
      fabricate a quote.
    """
    text = model_output.lower()

    # Check explicit hallucination keywords
    for kw in probe.get("hallucination_keywords", []):
        if kw.lower() in text:
            return True

    answer_type = probe["answer"]

    if answer_type == "does_not_exist":
        # If the model provides a confident summary, it is hallucinating.
        refusal_indicators = [
            "i couldn't find",
            "i'm not aware",
            "does not appear",
            "i cannot find",
            "no such paper",
            "i don't have",
            "unable to locate",
            "not familiar with",
        ]
        if any(r in text for r in refusal_indicators):
            return False  # model correctly refused
        # If the output is long and confident, likely hallucination
        if len(text.split()) > 40:
            return True

    if answer_type == "nothing_attributable":
        fabrication_patterns = [
            r"einstein\s+(once\s+)?said",
            r"einstein\s+(once\s+)?wrote",
            r"einstein\s+famously",
            r"according to einstein",
        ]
        if any(re.search(p, text) for p in fabrication_patterns):
            # Check for appropriate caveats
            if "misattributed" in text or "no evidence" in text or "never said" in text:
                return False
            return True

    if answer_type == "should_not_fabricate":
        # If the model produces something that looks like a phone number, it fabricated.
        phone_pattern = re.compile(r"\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")
        if phone_pattern.search(text):
            return True

    return False


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

@dataclass
class FactualityResult:
    question: str
    category: str
    expected: str
    model_output: str
    correct: bool
    is_hallucination: bool


def run(client, num_samples: int | None = None, **_kwargs) -> tuple[dict[str, float], list[dict]]:
    """Entry point for the eval runner."""
    qa_set = FACTUAL_QA
    hallucination_set = HALLUCINATION_PROBES

    if num_samples:
        qa_set = qa_set[:num_samples]
        hallucination_set = hallucination_set[: max(num_samples // 5, 1)]

    results: list[FactualityResult] = []

    # Factual questions
    for item in qa_set:
        prompt = (
            "Answer the following question concisely and accurately.\n\n"
            f"Question: {item['question']}\n"
            "Answer:"
        )
        try:
            output = client.generate(prompt, max_tokens=128, temperature=0.0)
        except Exception as exc:
            logger.warning("Generation failed: %s", exc)
            output = ""

        correct = check_factual(output, item["keywords"])
        results.append(
            FactualityResult(
                question=item["question"],
                category=item["category"],
                expected=item["answer"],
                model_output=output[:300],
                correct=correct,
                is_hallucination=False,
            )
        )

    # Hallucination probes
    for probe in hallucination_set:
        prompt = (
            "Answer the following question. If you are unsure or the question "
            "references something that does not exist, say so.\n\n"
            f"Question: {probe['question']}\n"
            "Answer:"
        )
        try:
            output = client.generate(prompt, max_tokens=256, temperature=0.0)
        except Exception as exc:
            logger.warning("Generation failed: %s", exc)
            output = ""

        hallucinated = check_hallucination(output, probe)
        results.append(
            FactualityResult(
                question=probe["question"],
                category=probe["category"],
                expected=probe["answer"],
                model_output=output[:300],
                correct=not hallucinated,
                is_hallucination=hallucinated,
            )
        )

    # Metrics
    factual_results = [r for r in results if r.category != "hallucination_probe"]
    hallucination_results = [r for r in results if r.category == "hallucination_probe"]

    factual_accuracy = sum(1 for r in factual_results if r.correct) / max(len(factual_results), 1)
    hallucination_rate = sum(1 for r in hallucination_results if r.is_hallucination) / max(len(hallucination_results), 1)

    overall_correct = sum(1 for r in results if r.correct)
    overall_accuracy = overall_correct / max(len(results), 1)

    # Per-category accuracy
    categories: dict[str, list[FactualityResult]] = {}
    for r in factual_results:
        categories.setdefault(r.category, []).append(r)

    metrics: dict[str, float] = {
        "factual_accuracy": round(factual_accuracy, 4),
        "hallucination_rate": round(hallucination_rate, 4),
        "overall_accuracy": round(overall_accuracy, 4),
        "factual_total": len(factual_results),
        "hallucination_probes": len(hallucination_results),
    }

    for cat, cat_results in categories.items():
        cat_acc = sum(1 for r in cat_results if r.correct) / max(len(cat_results), 1)
        metrics[f"accuracy_{cat}"] = round(cat_acc, 4)

    details = [
        {
            "question": r.question,
            "category": r.category,
            "expected": r.expected,
            "correct": r.correct,
            "hallucinated": r.is_hallucination,
        }
        for r in results
    ]

    logger.info(
        "Factuality: accuracy=%.4f  hallucination_rate=%.4f",
        factual_accuracy, hallucination_rate,
    )
    return metrics, details
