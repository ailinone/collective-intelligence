# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
MinHash LSH lexical deduplication using datasketch.

Processes JSONL input, builds MinHash signatures from character n-grams,
applies LSH to find near-duplicate clusters, and outputs a deduplicated dataset.
"""

from __future__ import annotations

import json
import logging
import time
from collections import defaultdict
from pathlib import Path
from typing import Any

import click
import jsonlines
from datasketch import LeanMinHash, MinHash, MinHashLSH
from tqdm import tqdm

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# N-gram extraction
# ---------------------------------------------------------------------------

def extract_ngrams(text: str, n: int = 5) -> set[str]:
    """Extract character-level n-grams from text."""
    text = text.lower().strip()
    if len(text) < n:
        return {text}
    return {text[i : i + n] for i in range(len(text) - n + 1)}


def extract_word_ngrams(text: str, n: int = 3) -> set[str]:
    """Extract word-level n-grams from text."""
    words = text.lower().split()
    if len(words) < n:
        return {" ".join(words)}
    return {" ".join(words[i : i + n]) for i in range(len(words) - n + 1)}


# ---------------------------------------------------------------------------
# MinHash computation
# ---------------------------------------------------------------------------

def compute_minhash(
    ngrams: set[str],
    num_perm: int = 128,
) -> MinHash:
    """Compute a MinHash signature for a set of n-grams."""
    mh = MinHash(num_perm=num_perm)
    for gram in ngrams:
        mh.update(gram.encode("utf-8"))
    return mh


# ---------------------------------------------------------------------------
# Core dedup logic
# ---------------------------------------------------------------------------

def run_lexical_dedup(
    input_path: Path,
    output_path: Path,
    report_path: Path,
    threshold: float = 0.8,
    num_perm: int = 128,
    ngram_size: int = 5,
    ngram_type: str = "char",
    text_field: str = "text",
) -> dict[str, Any]:
    """
    Perform MinHash LSH deduplication on a JSONL dataset.

    Returns a summary report dict.
    """
    logger.info(
        "Starting lexical dedup: threshold=%.2f num_perm=%d ngram_size=%d ngram_type=%s",
        threshold,
        num_perm,
        ngram_size,
        ngram_type,
    )
    start_time = time.time()

    # Phase 1: Build MinHash signatures and LSH index
    logger.info("Phase 1: Computing MinHash signatures...")
    lsh = MinHashLSH(threshold=threshold, num_perm=num_perm)

    signatures: dict[int, LeanMinHash] = {}
    records: list[dict[str, Any]] = []

    with jsonlines.open(input_path, mode="r") as reader:
        for idx, record in enumerate(tqdm(reader, desc="Computing MinHash", unit=" docs")):
            records.append(record)
            text = record.get(text_field, "")
            if not text.strip():
                continue

            if ngram_type == "char":
                ngrams = extract_ngrams(text, n=ngram_size)
            else:
                ngrams = extract_word_ngrams(text, n=ngram_size)

            if not ngrams:
                continue

            mh = compute_minhash(ngrams, num_perm=num_perm)
            lean_mh = LeanMinHash(mh)
            signatures[idx] = lean_mh

            try:
                lsh.insert(str(idx), mh)
            except ValueError:
                # Duplicate key — already inserted (exact duplicate)
                pass

    total_docs = len(records)
    logger.info("Computed %d signatures from %d documents", len(signatures), total_docs)

    # Phase 2: Query LSH for duplicate clusters
    logger.info("Phase 2: Finding duplicate clusters...")
    duplicate_of: dict[int, int] = {}  # Maps doc -> canonical representative
    clusters: dict[int, list[int]] = defaultdict(list)

    for idx in tqdm(sorted(signatures.keys()), desc="Querying LSH", unit=" docs"):
        if idx in duplicate_of:
            continue

        mh = MinHash(num_perm=num_perm, hashvalues=signatures[idx].hashvalues)
        candidates = lsh.query(mh)

        # Find the cluster: the smallest index is the canonical representative
        cluster_indices = [int(c) for c in candidates if int(c) in signatures]
        if len(cluster_indices) <= 1:
            continue

        canonical = min(cluster_indices)
        clusters[canonical] = cluster_indices
        for member in cluster_indices:
            if member != canonical:
                duplicate_of[member] = canonical

    num_duplicates = len(duplicate_of)
    num_clusters = len(clusters)
    logger.info("Found %d duplicates in %d clusters", num_duplicates, num_clusters)

    # Phase 3: Write deduplicated output
    logger.info("Phase 3: Writing deduplicated dataset...")
    kept = 0
    removed = 0

    with jsonlines.open(output_path, mode="w") as writer:
        for idx, record in enumerate(tqdm(records, desc="Writing output", unit=" docs")):
            if idx in duplicate_of:
                removed += 1
                continue
            writer.write(record)
            kept += 1

    elapsed = time.time() - start_time

    # Build report
    cluster_sizes = [len(members) for members in clusters.values()]
    report = {
        "input_file": str(input_path),
        "output_file": str(output_path),
        "config": {
            "threshold": threshold,
            "num_perm": num_perm,
            "ngram_size": ngram_size,
            "ngram_type": ngram_type,
        },
        "total_documents": total_docs,
        "documents_kept": kept,
        "documents_removed": removed,
        "reduction_percent": round(100.0 * removed / total_docs, 2) if total_docs > 0 else 0.0,
        "num_duplicate_clusters": num_clusters,
        "cluster_size_distribution": {
            "min": min(cluster_sizes) if cluster_sizes else 0,
            "max": max(cluster_sizes) if cluster_sizes else 0,
            "mean": round(sum(cluster_sizes) / len(cluster_sizes), 2) if cluster_sizes else 0,
        },
        "elapsed_seconds": round(elapsed, 2),
    }

    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    logger.info("Dedup complete: kept=%d removed=%d (%.1f%% reduction)", kept, removed, report["reduction_percent"])
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("lexical-dedup")
@click.option("--input", "input_path", required=True, type=click.Path(exists=True), help="Input JSONL file")
@click.option("--output", "output_path", required=True, type=click.Path(), help="Output deduplicated JSONL file")
@click.option("--report", "report_path", default=None, type=click.Path(), help="Output report JSON path")
@click.option("--threshold", default=0.8, type=float, help="Jaccard similarity threshold for dedup (0.0-1.0)")
@click.option("--num-perm", default=128, type=int, help="Number of MinHash permutations")
@click.option("--ngram-size", default=5, type=int, help="N-gram size for shingling")
@click.option("--ngram-type", default="char", type=click.Choice(["char", "word"]), help="N-gram type")
@click.option("--text-field", default="text", help="Field name containing document text")
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    input_path: str,
    output_path: str,
    report_path: str | None,
    threshold: float,
    num_perm: int,
    ngram_size: int,
    ngram_type: str,
    text_field: str,
    log_level: str,
) -> None:
    """Perform MinHash LSH lexical deduplication on a JSONL dataset."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    input_p = Path(input_path)
    output_p = Path(output_path)
    output_p.parent.mkdir(parents=True, exist_ok=True)

    if report_path is None:
        report_p = output_p.with_suffix(".dedup_report.json")
    else:
        report_p = Path(report_path)

    report = run_lexical_dedup(
        input_path=input_p,
        output_path=output_p,
        report_path=report_p,
        threshold=threshold,
        num_perm=num_perm,
        ngram_size=ngram_size,
        ngram_type=ngram_type,
        text_field=text_field,
    )

    click.echo(f"\n--- Lexical Dedup Report ---")
    click.echo(f"Total documents:   {report['total_documents']:>10,}")
    click.echo(f"Documents kept:    {report['documents_kept']:>10,}")
    click.echo(f"Documents removed: {report['documents_removed']:>10,}")
    click.echo(f"Reduction:         {report['reduction_percent']:>9.1f}%")
    click.echo(f"Duplicate clusters:{report['num_duplicate_clusters']:>10,}")
    click.echo(f"Elapsed time:      {report['elapsed_seconds']:>10.1f}s")
    click.echo(f"Report:            {report_p}")


if __name__ == "__main__":
    cli()
