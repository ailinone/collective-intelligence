#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Needle-in-a-Haystack evaluation.

Generates documents of varying length, inserts a unique "needle" fact
at different depth positions, and measures retrieval accuracy across
a grid of (document_length, needle_depth) combinations.

Produces heatmap data suitable for visualization.
"""

from __future__ import annotations

import hashlib
import logging
import random
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("needle_haystack_eval")


# ---------------------------------------------------------------------------
# Filler text
# ---------------------------------------------------------------------------

_FILLER_PARAGRAPHS: list[str] = [
    "The global economy continues to evolve as nations adapt to shifting trade patterns and technological disruption. Central banks around the world monitor inflation indicators while adjusting monetary policy. Supply chain resilience has become a priority for manufacturers seeking to diversify their sourcing strategies.",
    "Marine biologists recently documented a new species of deep-sea fish near hydrothermal vents in the Pacific Ocean. The creature possesses bioluminescent organs arranged in patterns unlike any previously catalogued organism. Researchers believe it may hold clues to understanding life in extreme environments.",
    "Urban planners are re-examining transportation infrastructure to accommodate growing populations. Light rail projects, cycling networks, and pedestrian zones are being integrated into city master plans. The goal is to reduce dependence on personal vehicles while improving air quality.",
    "Advances in materials science have led to the development of self-healing polymers that can repair micro-cracks autonomously. These materials are being tested in aerospace components where maintenance access is limited. Early results suggest a significant extension of component lifespan.",
    "The history of cartography reflects humanity's evolving understanding of geography and mathematics. From Ptolemy's projections to satellite imagery, map-making has advanced alongside scientific progress. Modern GIS systems combine multiple data layers for spatial analysis.",
    "Renewable energy installations have grown exponentially over the past decade. Solar farms now operate in regions previously considered impractical due to cloud cover. Battery storage technologies enable grid balancing even when generation is intermittent.",
    "Classical music has influenced countless genres, from jazz to electronic. Composers like Bach and Beethoven established harmonic frameworks still taught in conservatories worldwide. Contemporary orchestras continue to premiere new works alongside beloved repertoire.",
    "The philosophy of language examines how meaning is conveyed through words, sentences, and discourse. Wittgenstein argued that language games define usage, while Chomsky proposed innate grammatical structures. The debate continues to shape linguistics and cognitive science.",
    "Agricultural practices are adapting to climate change through precision farming, drought-resistant crop varieties, and improved water management. Satellite monitoring helps farmers optimize planting schedules and fertilizer application. These technologies are gradually becoming accessible to smallholders.",
    "Space agencies have announced plans for permanent lunar habitats that could support research crews for extended missions. In-situ resource utilization, which converts lunar regolith into building materials, is a key enabling technology. International cooperation is expected to play a major role in these efforts.",
]


def generate_filler(target_tokens: int, seed: int = 42) -> str:
    """Generate filler text of approximately *target_tokens* tokens."""
    rng = random.Random(seed)
    paragraphs: list[str] = []
    approx_tokens = 0
    while approx_tokens < target_tokens:
        p = rng.choice(_FILLER_PARAGRAPHS)
        paragraphs.append(p)
        approx_tokens += len(p.split())
    return "\n\n".join(paragraphs)


# ---------------------------------------------------------------------------
# Needle generation
# ---------------------------------------------------------------------------

def make_needle(trial_id: int) -> tuple[str, str]:
    """Create a unique needle fact and the expected retrieval answer.

    Returns (needle_text, expected_answer).
    """
    h = hashlib.md5(str(trial_id).encode()).hexdigest()[:6]
    city = f"Veritas-{h}"
    year = 1900 + (trial_id * 7) % 100
    needle = f"The secret annual festival of {city} was first celebrated in {year}."
    answer = str(year)
    return needle, answer


def insert_needle(document: str, needle: str, depth: float) -> str:
    """Insert *needle* at the given *depth* fraction (0.0 = start, 1.0 = end)."""
    paragraphs = document.split("\n\n")
    idx = max(0, min(int(depth * len(paragraphs)), len(paragraphs) - 1))
    paragraphs.insert(idx, needle)
    return "\n\n".join(paragraphs)


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

@dataclass
class NeedleResult:
    doc_length_tokens: int
    needle_depth: float
    needle_text: str
    expected_answer: str
    model_answer: str
    correct: bool


def run(
    client,
    num_samples: int | None = None,
    doc_lengths: list[int] | None = None,
    depths: list[float] | None = None,
    **_kwargs,
) -> tuple[dict[str, float], list[dict]]:
    """Entry point for the eval runner.

    Evaluates over a grid of (doc_length, depth).
    """
    if doc_lengths is None:
        doc_lengths = [512, 1024, 2048, 4096]
    if depths is None:
        depths = [0.0, 0.25, 0.5, 0.75, 1.0]

    if num_samples:
        # Limit grid size
        max_cells = num_samples
        while len(doc_lengths) * len(depths) > max_cells:
            if len(doc_lengths) > len(depths):
                doc_lengths = doc_lengths[::2]
            else:
                depths = depths[::2]

    results: list[NeedleResult] = []
    trial_id = 0

    for length in doc_lengths:
        filler = generate_filler(length, seed=length)

        for depth in depths:
            trial_id += 1
            needle_text, expected_answer = make_needle(trial_id)
            document = insert_needle(filler, needle_text, depth)

            prompt = (
                "Read the following document carefully, then answer the question at the end.\n\n"
                "--- DOCUMENT START ---\n"
                f"{document}\n"
                "--- DOCUMENT END ---\n\n"
                f"Question: What year was the secret annual festival first celebrated?\n"
                "Answer (provide only the year):"
            )

            try:
                output = client.generate(prompt, max_tokens=32, temperature=0.0)
            except Exception as exc:
                logger.warning("Generation failed (length=%d, depth=%.2f): %s", length, depth, exc)
                output = ""

            # Extract year from output
            answer = output.strip().split()[0] if output.strip() else ""
            # Clean non-digit characters
            answer_digits = "".join(c for c in answer if c.isdigit())

            correct = answer_digits == expected_answer

            results.append(
                NeedleResult(
                    doc_length_tokens=length,
                    needle_depth=depth,
                    needle_text=needle_text,
                    expected_answer=expected_answer,
                    model_answer=answer_digits,
                    correct=correct,
                )
            )

            logger.debug(
                "length=%d depth=%.2f correct=%s (expected=%s got=%s)",
                length, depth, correct, expected_answer, answer_digits,
            )

    # Metrics
    total = len(results)
    total_correct = sum(1 for r in results if r.correct)
    overall_accuracy = total_correct / max(total, 1)

    metrics: dict[str, float] = {
        "accuracy": round(overall_accuracy, 4),
        "total_trials": total,
        "correct": total_correct,
    }

    # Per-length accuracy
    for length in doc_lengths:
        subset = [r for r in results if r.doc_length_tokens == length]
        acc = sum(1 for r in subset if r.correct) / max(len(subset), 1)
        metrics[f"accuracy_{length}tok"] = round(acc, 4)

    # Per-depth accuracy
    for depth in depths:
        subset = [r for r in results if abs(r.needle_depth - depth) < 0.01]
        acc = sum(1 for r in subset if r.correct) / max(len(subset), 1)
        metrics[f"accuracy_depth_{depth:.2f}"] = round(acc, 4)

    # Heatmap data (length x depth -> correct)
    heatmap: list[dict] = []
    for r in results:
        heatmap.append({
            "doc_length": r.doc_length_tokens,
            "depth": r.needle_depth,
            "correct": r.correct,
        })

    details = {
        "heatmap": heatmap,
        "results": [
            {
                "length": r.doc_length_tokens,
                "depth": r.needle_depth,
                "expected": r.expected_answer,
                "predicted": r.model_answer,
                "correct": r.correct,
            }
            for r in results
        ],
    }

    logger.info(
        "Needle-in-haystack: accuracy=%.4f (%d/%d) over %d lengths x %d depths",
        overall_accuracy, total_correct, total, len(doc_lengths), len(depths),
    )
    return metrics, details
