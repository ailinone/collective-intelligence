# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Benchmark contamination detection for training data.

Loads benchmark datasets (MMLU, HumanEval, GSM8K, etc.), computes n-gram overlap
with training data, and reports contamination rates per benchmark. Flags
contaminated samples for removal.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterator

import click
import jsonlines
import xxhash
from tqdm import tqdm

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# N-gram extraction with hashing for memory efficiency
# ---------------------------------------------------------------------------

def extract_ngrams_hashed(text: str, n: int = 13) -> set[int]:
    """Extract word-level n-grams and return their xxhash64 digests."""
    words = text.lower().split()
    if len(words) < n:
        return set()
    ngrams: set[int] = set()
    for i in range(len(words) - n + 1):
        gram = " ".join(words[i : i + n])
        ngrams.add(xxhash.xxh64_intdigest(gram.encode("utf-8")))
    return ngrams


def extract_ngrams_text(text: str, n: int = 13) -> list[str]:
    """Extract word-level n-grams as text strings (for flagging)."""
    words = text.lower().split()
    if len(words) < n:
        return []
    return [" ".join(words[i : i + n]) for i in range(len(words) - n + 1)]


# ---------------------------------------------------------------------------
# Benchmark loaders
# ---------------------------------------------------------------------------

class BenchmarkLoader:
    """Load benchmark datasets for contamination checking."""

    KNOWN_BENCHMARKS = {
        "mmlu": {
            "hf_name": "cais/mmlu",
            "hf_config": "all",
            "splits": ["test", "validation"],
            "text_fields": ["question", "choices"],
        },
        "humaneval": {
            "hf_name": "openai_humaneval",
            "splits": ["test"],
            "text_fields": ["prompt", "canonical_solution"],
        },
        "gsm8k": {
            "hf_name": "gsm8k",
            "hf_config": "main",
            "splits": ["test"],
            "text_fields": ["question", "answer"],
        },
        "hellaswag": {
            "hf_name": "Rowan/hellaswag",
            "splits": ["validation"],
            "text_fields": ["ctx", "endings"],
        },
        "arc_challenge": {
            "hf_name": "allenai/ai2_arc",
            "hf_config": "ARC-Challenge",
            "splits": ["test"],
            "text_fields": ["question", "choices"],
        },
        "winogrande": {
            "hf_name": "winogrande",
            "hf_config": "winogrande_xl",
            "splits": ["validation"],
            "text_fields": ["sentence"],
        },
        "truthfulqa": {
            "hf_name": "truthful_qa",
            "hf_config": "multiple_choice",
            "splits": ["validation"],
            "text_fields": ["question", "mc1_targets", "mc2_targets"],
        },
    }

    @classmethod
    def load_benchmark_texts(cls, benchmark_name: str) -> list[str]:
        """Load and concatenate all text fields from a benchmark."""
        spec = cls.KNOWN_BENCHMARKS.get(benchmark_name)
        if spec is None:
            raise ValueError(
                f"Unknown benchmark: {benchmark_name}. "
                f"Available: {list(cls.KNOWN_BENCHMARKS.keys())}"
            )

        from datasets import load_dataset

        texts: list[str] = []
        hf_config = spec.get("hf_config")

        for split in spec["splits"]:
            try:
                if hf_config:
                    ds = load_dataset(spec["hf_name"], hf_config, split=split, trust_remote_code=True)
                else:
                    ds = load_dataset(spec["hf_name"], split=split, trust_remote_code=True)
            except Exception as e:
                logger.warning("Could not load %s split=%s: %s", benchmark_name, split, e)
                continue

            for row in ds:
                parts: list[str] = []
                for field_name in spec["text_fields"]:
                    val = row.get(field_name)
                    if val is None:
                        continue
                    if isinstance(val, str):
                        parts.append(val)
                    elif isinstance(val, list):
                        # Handle lists of choices/options
                        for item in val:
                            if isinstance(item, str):
                                parts.append(item)
                            elif isinstance(item, dict):
                                parts.extend(str(v) for v in item.values())
                    elif isinstance(val, dict):
                        parts.extend(str(v) for v in val.values())

                combined = " ".join(parts).strip()
                if combined:
                    texts.append(combined)

        logger.info("Loaded %d samples from benchmark: %s", len(texts), benchmark_name)
        return texts

    @classmethod
    def load_from_jsonl(cls, path: Path, text_field: str = "text") -> list[str]:
        """Load benchmark texts from a local JSONL file."""
        texts: list[str] = []
        with jsonlines.open(path, mode="r") as reader:
            for record in reader:
                text = record.get(text_field, "")
                if text.strip():
                    texts.append(text.strip())
        logger.info("Loaded %d samples from local benchmark: %s", len(texts), path)
        return texts


# ---------------------------------------------------------------------------
# Contamination detection
# ---------------------------------------------------------------------------

def build_training_ngram_index(
    training_path: Path,
    ngram_size: int = 13,
    text_field: str = "text",
    max_docs: int | None = None,
) -> tuple[set[int], int]:
    """
    Build a set of hashed n-grams from the training data.

    Returns (ngram_set, num_docs_processed).
    """
    logger.info("Building n-gram index from training data: %s (n=%d)", training_path, ngram_size)
    ngram_index: set[int] = set()
    num_docs = 0

    with jsonlines.open(training_path, mode="r") as reader:
        for record in tqdm(reader, desc="Indexing training data", unit=" docs"):
            text = record.get(text_field, "")
            if text.strip():
                ngrams = extract_ngrams_hashed(text, n=ngram_size)
                ngram_index.update(ngrams)
            num_docs += 1
            if max_docs is not None and num_docs >= max_docs:
                break

    logger.info("Training index: %d unique %d-grams from %d documents", len(ngram_index), ngram_size, num_docs)
    return ngram_index, num_docs


def check_contamination(
    benchmark_texts: list[str],
    training_ngrams: set[int],
    ngram_size: int = 13,
) -> list[dict[str, Any]]:
    """
    Check each benchmark sample for n-gram overlap with training data.

    Returns a list of results per benchmark sample.
    """
    results: list[dict[str, Any]] = []

    for idx, text in enumerate(benchmark_texts):
        sample_ngrams = extract_ngrams_hashed(text, n=ngram_size)
        if not sample_ngrams:
            results.append({
                "index": idx,
                "contaminated": False,
                "overlap_ratio": 0.0,
                "num_ngrams": 0,
                "num_overlapping": 0,
            })
            continue

        overlapping = sample_ngrams & training_ngrams
        overlap_ratio = len(overlapping) / len(sample_ngrams)

        results.append({
            "index": idx,
            "contaminated": overlap_ratio > 0.0,
            "overlap_ratio": round(overlap_ratio, 6),
            "num_ngrams": len(sample_ngrams),
            "num_overlapping": len(overlapping),
        })

    return results


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run_contamination_detection(
    training_path: Path,
    benchmarks: list[str],
    output_dir: Path,
    ngram_size: int = 13,
    text_field: str = "text",
    contamination_threshold: float = 0.5,
    max_training_docs: int | None = None,
    benchmark_paths: dict[str, Path] | None = None,
) -> dict[str, Any]:
    """Run contamination detection against multiple benchmarks."""
    start_time = time.time()
    output_dir.mkdir(parents=True, exist_ok=True)

    # Build training n-gram index
    training_ngrams, num_training_docs = build_training_ngram_index(
        training_path,
        ngram_size=ngram_size,
        text_field=text_field,
        max_docs=max_training_docs,
    )

    overall_report: dict[str, Any] = {
        "training_file": str(training_path),
        "training_docs": num_training_docs,
        "training_unique_ngrams": len(training_ngrams),
        "ngram_size": ngram_size,
        "contamination_threshold": contamination_threshold,
        "benchmarks": {},
    }

    for bench_name in benchmarks:
        logger.info("Checking contamination against benchmark: %s", bench_name)

        # Load benchmark
        try:
            if benchmark_paths and bench_name in benchmark_paths:
                bench_texts = BenchmarkLoader.load_from_jsonl(benchmark_paths[bench_name])
            else:
                bench_texts = BenchmarkLoader.load_benchmark_texts(bench_name)
        except Exception:
            logger.exception("Failed to load benchmark %s", bench_name)
            overall_report["benchmarks"][bench_name] = {"error": "failed_to_load"}
            continue

        if not bench_texts:
            overall_report["benchmarks"][bench_name] = {"error": "no_samples"}
            continue

        # Check contamination
        results = check_contamination(bench_texts, training_ngrams, ngram_size=ngram_size)

        # Compute stats
        contaminated_samples = [r for r in results if r["overlap_ratio"] >= contamination_threshold]
        any_overlap = [r for r in results if r["contaminated"]]
        overlap_ratios = [r["overlap_ratio"] for r in results if r["num_ngrams"] > 0]

        bench_report = {
            "total_samples": len(bench_texts),
            "samples_with_any_overlap": len(any_overlap),
            "samples_above_threshold": len(contaminated_samples),
            "contamination_rate_percent": round(
                100.0 * len(contaminated_samples) / len(bench_texts), 2
            ),
            "any_overlap_rate_percent": round(
                100.0 * len(any_overlap) / len(bench_texts), 2
            ),
            "mean_overlap_ratio": round(
                sum(overlap_ratios) / max(len(overlap_ratios), 1), 6
            ),
            "flagged_indices": [r["index"] for r in contaminated_samples],
        }
        overall_report["benchmarks"][bench_name] = bench_report

        # Save per-benchmark detailed results
        detail_path = output_dir / f"{bench_name}_contamination_detail.json"
        with open(detail_path, "w", encoding="utf-8") as f:
            json.dump(results, f, indent=2)

        logger.info(
            "Benchmark %s: %d/%d samples contaminated (%.1f%%), any overlap: %d (%.1f%%)",
            bench_name,
            len(contaminated_samples),
            len(bench_texts),
            bench_report["contamination_rate_percent"],
            len(any_overlap),
            bench_report["any_overlap_rate_percent"],
        )

    elapsed = time.time() - start_time
    overall_report["elapsed_seconds"] = round(elapsed, 2)

    report_path = output_dir / "contamination_report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(overall_report, f, indent=2)

    logger.info("Contamination report saved to %s", report_path)
    return overall_report


# ---------------------------------------------------------------------------
# Training data cleaner
# ---------------------------------------------------------------------------

def remove_contaminated_samples(
    training_path: Path,
    output_path: Path,
    benchmark_ngrams: set[int],
    ngram_size: int = 13,
    threshold: float = 0.5,
    text_field: str = "text",
) -> dict[str, int]:
    """Remove training samples that overlap with benchmark data."""
    kept = 0
    removed = 0

    with jsonlines.open(training_path, mode="r") as reader, \
         jsonlines.open(output_path, mode="w") as writer:

        for record in tqdm(reader, desc="Cleaning training data", unit=" docs"):
            text = record.get(text_field, "")
            sample_ngrams = extract_ngrams_hashed(text, n=ngram_size)

            if sample_ngrams:
                overlap = sample_ngrams & benchmark_ngrams
                ratio = len(overlap) / len(sample_ngrams)
                if ratio >= threshold:
                    removed += 1
                    continue

            writer.write(record)
            kept += 1

    logger.info("Cleaned training data: kept=%d removed=%d", kept, removed)
    return {"kept": kept, "removed": removed}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("contamination-detect")
@click.option("--training-data", required=True, type=click.Path(exists=True), help="Training data JSONL file")
@click.option(
    "--benchmarks",
    required=True,
    help="Comma-separated benchmark names (mmlu, humaneval, gsm8k, hellaswag, arc_challenge, winogrande, truthfulqa)",
)
@click.option("--output-dir", required=True, type=click.Path(), help="Output directory for reports")
@click.option("--ngram-size", default=13, type=int, help="N-gram size for overlap detection")
@click.option("--threshold", default=0.5, type=float, help="Overlap ratio threshold to flag as contaminated")
@click.option("--text-field", default="text", help="Field name containing document text")
@click.option("--max-training-docs", default=None, type=int, help="Max training docs to index")
@click.option("--clean-output", default=None, type=click.Path(), help="Output cleaned training data JSONL (optional)")
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    training_data: str,
    benchmarks: str,
    output_dir: str,
    ngram_size: int,
    threshold: float,
    text_field: str,
    max_training_docs: int | None,
    clean_output: str | None,
    log_level: str,
) -> None:
    """Detect benchmark contamination in training data."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    bench_list = [b.strip() for b in benchmarks.split(",") if b.strip()]
    output_dir_p = Path(output_dir)

    report = run_contamination_detection(
        training_path=Path(training_data),
        benchmarks=bench_list,
        output_dir=output_dir_p,
        ngram_size=ngram_size,
        text_field=text_field,
        contamination_threshold=threshold,
        max_training_docs=max_training_docs,
    )

    click.echo(f"\n--- Contamination Detection Report ---")
    click.echo(f"Training docs indexed: {report['training_docs']:>10,}")
    click.echo(f"Unique {ngram_size}-grams:     {report['training_unique_ngrams']:>10,}")
    click.echo(f"Threshold:             {threshold:>10.2f}")
    click.echo(f"\nPer-benchmark results:")

    for bench_name, bench_data in report["benchmarks"].items():
        if "error" in bench_data:
            click.echo(f"  {bench_name:20s}  ERROR: {bench_data['error']}")
            continue
        click.echo(
            f"  {bench_name:20s}  "
            f"contaminated={bench_data['samples_above_threshold']}/{bench_data['total_samples']} "
            f"({bench_data['contamination_rate_percent']:.1f}%) "
            f"any_overlap={bench_data['any_overlap_rate_percent']:.1f}%"
        )

    click.echo(f"\nElapsed time: {report['elapsed_seconds']:.1f}s")
    click.echo(f"Report: {output_dir_p / 'contamination_report.json'}")


if __name__ == "__main__":
    cli()
