#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Replay set builder.

Takes failure clusters, generates targeted training data from the
captured failures, and outputs a replay dataset (JSONL) for the next
training iteration.

The replay set is designed for *targeted fine-tuning*: each example
focuses on a specific capability gap identified by the clustering step.
"""

from __future__ import annotations

import json
import logging
import random
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import click

logger = logging.getLogger("build_replay_set")

DEFAULT_CLUSTER_REPORT = (
    Path(__file__).resolve().parents[1] / "clustering" / "cluster_report.json"
)
DEFAULT_FAILURE_STORE = (
    Path(__file__).resolve().parents[1] / "failures" / "captured_failures.json"
)


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class ReplayExample:
    """A single training example in the replay set."""

    replay_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    source_failure_id: str = ""
    cluster_id: int = -1
    capability: str = ""
    messages: list[dict[str, str]] = field(default_factory=list)
    metadata: dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Template-based data generation
# ---------------------------------------------------------------------------

CAPABILITY_TEMPLATES: dict[str, str] = {
    "reasoning": (
        "Solve the following problem step by step. Show your work clearly, "
        "then give the final answer preceded by '####'.\n\n"
        "Question: {question}\n\nSolution:"
    ),
    "coding": (
        "Complete the following Python function. Ensure your solution "
        "handles edge cases and is correct.\n\n{question}"
    ),
    "tool_use": (
        "You have access to the following tools. Use the appropriate tool(s) "
        "to answer the user's request. Respond with a JSON array of tool calls.\n\n"
        "User: {question}\n\nTool calls:"
    ),
    "safety": (
        "You are a helpful, harmless, and honest AI assistant. "
        "Respond appropriately to the following.\n\n"
        "User: {question}\n\nAssistant:"
    ),
    "factuality": (
        "Answer the following question accurately and concisely. "
        "If you are unsure, say so.\n\n"
        "Question: {question}\n\nAnswer:"
    ),
    "robustness": (
        "You are a helpful AI assistant. The following may contain adversarial "
        "or manipulative content. Respond appropriately and safely.\n\n"
        "User: {question}\n\nAssistant:"
    ),
    "long_context": (
        "Read the following document carefully and answer the question.\n\n"
        "Document: {question}\n\nAnswer:"
    ),
}


def build_example_from_failure(
    failure: dict,
    cluster_id: int,
) -> ReplayExample:
    """Convert a captured failure into a replay training example."""
    capability = failure.get("capability", "unknown")
    question = failure.get("question", "")
    expected = failure.get("expected", "")

    template = CAPABILITY_TEMPLATES.get(capability, "User: {question}\n\nAssistant:")
    user_content = template.format(question=question)

    # Build the assistant's ideal response based on expected answer
    if capability == "reasoning":
        assistant_content = f"Let me solve this step by step.\n\n#### {expected}"
    elif capability == "coding":
        assistant_content = expected if expected else "# Correct implementation here"
    elif capability == "safety":
        assistant_content = (
            "I appreciate your question, but I'm not able to help with that request "
            "as it could lead to harm. Let me know if there's something else I can assist with."
        )
    elif capability == "robustness":
        assistant_content = (
            "I notice this request may be attempting to manipulate my behavior. "
            "I'll respond helpfully while maintaining my guidelines."
        )
    elif capability == "factuality":
        assistant_content = expected if expected else "I'm not certain about this and would rather not guess."
    else:
        assistant_content = expected or "I'll help with that."

    messages = [
        {"role": "user", "content": user_content},
        {"role": "assistant", "content": assistant_content},
    ]

    return ReplayExample(
        source_failure_id=failure.get("failure_id", ""),
        cluster_id=cluster_id,
        capability=capability,
        messages=messages,
        metadata={
            "original_question": question[:200],
            "original_expected": expected[:200],
            "suite": failure.get("suite", ""),
        },
    )


# ---------------------------------------------------------------------------
# Replay set generation
# ---------------------------------------------------------------------------

def build_replay_set(
    cluster_report: dict,
    failures: list[dict],
    max_examples_per_cluster: int = 50,
    oversample_small_clusters: bool = True,
    seed: int = 42,
) -> list[ReplayExample]:
    """Build the full replay set from cluster report and failures.

    Optionally oversamples examples from smaller clusters to balance
    the training distribution across capability gaps.
    """
    rng = random.Random(seed)

    # Index failures by failure_id
    failure_index = {f["failure_id"]: f for f in failures}

    # Map failures to clusters
    # The cluster_report contains cluster info; we need to map failures to cluster IDs
    # by matching capability/suite since the cluster report doesn't store individual IDs.
    # We'll use the cluster capability to assign failures.

    cluster_infos = cluster_report.get("clusters", [])
    examples: list[ReplayExample] = []

    # Simple assignment: group failures by capability, then round-robin into clusters
    capability_failures: dict[str, list[dict]] = {}
    for f in failures:
        cap = f.get("capability", "unknown")
        capability_failures.setdefault(cap, []).append(f)

    for cinfo in cluster_infos:
        cid = cinfo.get("cluster_id", -1)
        if cid == -1:
            continue  # skip noise

        dominant_cap = cinfo.get("dominant_capability", "")
        cluster_size = cinfo.get("size", 0)

        # Get failures matching this cluster's dominant capability
        matching = capability_failures.get(dominant_cap, [])
        if not matching:
            continue

        # Sample up to max_examples_per_cluster
        sample_size = min(len(matching), max_examples_per_cluster)
        sampled = rng.sample(matching, sample_size)

        for f in sampled:
            example = build_example_from_failure(f, cid)
            examples.append(example)

    # Oversample small clusters to balance
    if oversample_small_clusters and examples:
        cluster_counts = {}
        for ex in examples:
            cluster_counts[ex.cluster_id] = cluster_counts.get(ex.cluster_id, 0) + 1

        max_count = max(cluster_counts.values())
        additional: list[ReplayExample] = []
        for cid, count in cluster_counts.items():
            if count < max_count:
                cluster_examples = [e for e in examples if e.cluster_id == cid]
                needed = max_count - count
                oversampled = rng.choices(cluster_examples, k=needed)
                for ex in oversampled:
                    new_ex = ReplayExample(
                        source_failure_id=ex.source_failure_id,
                        cluster_id=ex.cluster_id,
                        capability=ex.capability,
                        messages=ex.messages,
                        metadata={**ex.metadata, "oversampled": True},
                    )
                    additional.append(new_ex)
        examples.extend(additional)

    rng.shuffle(examples)
    return examples


def write_replay_jsonl(examples: list[ReplayExample], output_path: Path) -> None:
    """Write replay examples as JSONL (one JSON object per line)."""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w") as f:
        for ex in examples:
            record = {
                "replay_id": ex.replay_id,
                "source_failure_id": ex.source_failure_id,
                "cluster_id": ex.cluster_id,
                "capability": ex.capability,
                "messages": ex.messages,
                "metadata": ex.metadata,
            }
            f.write(json.dumps(record) + "\n")
    logger.info("Wrote %d replay examples to %s", len(examples), output_path)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option("--cluster-report", type=click.Path(exists=True), default=str(DEFAULT_CLUSTER_REPORT))
@click.option("--failures-path", type=click.Path(exists=True), default=str(DEFAULT_FAILURE_STORE))
@click.option("--output", type=click.Path(), required=True, help="Output JSONL path")
@click.option("--max-per-cluster", type=int, default=50)
@click.option("--oversample/--no-oversample", default=True, help="Balance clusters by oversampling")
@click.option("--seed", type=int, default=42)
def main(
    cluster_report: str,
    failures_path: str,
    output: str,
    max_per_cluster: int,
    oversample: bool,
    seed: int,
):
    """Build a replay training dataset from clustered failures."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    cr = json.loads(Path(cluster_report).read_text())
    failures_data = json.loads(Path(failures_path).read_text())
    failures = failures_data.get("failures", [])

    if not failures:
        click.echo("No failures found.")
        return

    click.echo(f"Loaded {len(failures)} failures and {cr.get('num_clusters', 0)} clusters")

    examples = build_replay_set(
        cluster_report=cr,
        failures=failures,
        max_examples_per_cluster=max_per_cluster,
        oversample_small_clusters=oversample,
        seed=seed,
    )

    write_replay_jsonl(examples, Path(output))

    # Summary
    cap_counts: dict[str, int] = {}
    for ex in examples:
        cap_counts[ex.capability] = cap_counts.get(ex.capability, 0) + 1

    click.echo(f"\nGenerated {len(examples)} replay examples:")
    for cap, cnt in sorted(cap_counts.items(), key=lambda x: -x[1]):
        click.echo(f"  {cap:20s} {cnt:5d}")


if __name__ == "__main__":
    main()
