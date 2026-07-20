# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Tokenizer evaluation script.

Evaluates a trained tokenizer on multiple metrics:
  - Fertility (tokens per word) across languages
  - Vocabulary coverage (% of vocab used on eval corpus)
  - Compression ratio (bytes per token)
  - Unknown token rate
  - Sequence length statistics
"""

from __future__ import annotations

import json
import logging
import time
from collections import Counter
from pathlib import Path
from typing import Any, Iterator

import click
import numpy as np
from tokenizers import Tokenizer
from tqdm import tqdm

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Evaluation metrics
# ---------------------------------------------------------------------------

def compute_fertility(
    tokenizer: Tokenizer,
    texts: list[str],
) -> dict[str, float]:
    """
    Compute fertility: average tokens per whitespace word.

    Lower fertility means more efficient tokenization.
    """
    total_tokens = 0
    total_words = 0

    for text in texts:
        words = text.split()
        total_words += len(words)
        encoded = tokenizer.encode(text)
        total_tokens += len(encoded.ids)

    if total_words == 0:
        return {"fertility": 0.0, "total_tokens": 0, "total_words": 0}

    fertility = total_tokens / total_words
    return {
        "fertility": round(fertility, 4),
        "total_tokens": total_tokens,
        "total_words": total_words,
    }


def compute_compression_ratio(
    tokenizer: Tokenizer,
    texts: list[str],
) -> dict[str, float]:
    """
    Compute compression ratio: bytes per token.

    Higher = more bytes packed per token = better compression.
    """
    total_bytes = 0
    total_tokens = 0

    for text in texts:
        total_bytes += len(text.encode("utf-8"))
        encoded = tokenizer.encode(text)
        total_tokens += len(encoded.ids)

    if total_tokens == 0:
        return {"bytes_per_token": 0.0, "chars_per_token": 0.0}

    bytes_per_token = total_bytes / total_tokens
    chars_per_token = sum(len(t) for t in texts) / total_tokens

    return {
        "bytes_per_token": round(bytes_per_token, 4),
        "chars_per_token": round(chars_per_token, 4),
        "total_bytes": total_bytes,
        "total_tokens": total_tokens,
    }


def compute_vocab_coverage(
    tokenizer: Tokenizer,
    texts: list[str],
) -> dict[str, Any]:
    """
    Compute vocabulary coverage: % of vocab tokens seen in the eval corpus.
    """
    vocab_size = tokenizer.get_vocab_size()
    seen_tokens: set[int] = set()

    for text in texts:
        encoded = tokenizer.encode(text)
        seen_tokens.update(encoded.ids)

    coverage = len(seen_tokens) / max(vocab_size, 1)

    return {
        "vocab_size": vocab_size,
        "tokens_seen": len(seen_tokens),
        "coverage_percent": round(100.0 * coverage, 2),
    }


def compute_unknown_rate(
    tokenizer: Tokenizer,
    texts: list[str],
    unk_token: str = "<|unk|>",
) -> dict[str, Any]:
    """
    Compute rate of unknown tokens in the eval corpus.
    """
    vocab = tokenizer.get_vocab()
    unk_id = vocab.get(unk_token)

    if unk_id is None:
        # Try common alternatives
        for alt in ["<unk>", "[UNK]", "<|unk|>"]:
            unk_id = vocab.get(alt)
            if unk_id is not None:
                break

    total_tokens = 0
    unk_count = 0

    for text in texts:
        encoded = tokenizer.encode(text)
        total_tokens += len(encoded.ids)
        if unk_id is not None:
            unk_count += encoded.ids.count(unk_id)

    unk_rate = unk_count / max(total_tokens, 1)

    return {
        "unk_token_id": unk_id,
        "total_tokens": total_tokens,
        "unk_count": unk_count,
        "unk_rate_percent": round(100.0 * unk_rate, 4),
    }


def compute_sequence_length_stats(
    tokenizer: Tokenizer,
    texts: list[str],
) -> dict[str, Any]:
    """
    Compute sequence length distribution statistics.
    """
    lengths: list[int] = []

    for text in texts:
        encoded = tokenizer.encode(text)
        lengths.append(len(encoded.ids))

    if not lengths:
        return {}

    arr = np.array(lengths, dtype=np.float64)

    return {
        "count": len(lengths),
        "mean": round(float(np.mean(arr)), 2),
        "std": round(float(np.std(arr)), 2),
        "min": int(np.min(arr)),
        "p25": int(np.percentile(arr, 25)),
        "p50": int(np.percentile(arr, 50)),
        "p75": int(np.percentile(arr, 75)),
        "p90": int(np.percentile(arr, 90)),
        "p95": int(np.percentile(arr, 95)),
        "p99": int(np.percentile(arr, 99)),
        "max": int(np.max(arr)),
    }


def compute_token_frequency_stats(
    tokenizer: Tokenizer,
    texts: list[str],
    top_k: int = 50,
) -> dict[str, Any]:
    """
    Compute token frequency statistics: most/least common tokens.
    """
    token_counts: Counter[int] = Counter()

    for text in texts:
        encoded = tokenizer.encode(text)
        token_counts.update(encoded.ids)

    vocab = tokenizer.get_vocab()
    id_to_token = {v: k for k, v in vocab.items()}

    most_common = [
        {"token": id_to_token.get(tid, f"[{tid}]"), "id": tid, "count": cnt}
        for tid, cnt in token_counts.most_common(top_k)
    ]

    least_common = [
        {"token": id_to_token.get(tid, f"[{tid}]"), "id": tid, "count": cnt}
        for tid, cnt in token_counts.most_common()[-top_k:]
    ]

    return {
        "unique_tokens_used": len(token_counts),
        "total_token_occurrences": sum(token_counts.values()),
        "most_common": most_common,
        "least_common": least_common,
    }


# ---------------------------------------------------------------------------
# Corpus loading
# ---------------------------------------------------------------------------

def load_eval_texts(
    path: Path,
    text_field: str = "text",
    max_texts: int = 10_000,
) -> list[str]:
    """Load evaluation texts from JSONL or plain text file."""
    texts: list[str] = []

    if path.suffix in (".jsonl", ".json"):
        import jsonlines

        with jsonlines.open(path, mode="r") as reader:
            for record in reader:
                text = record.get(text_field, "")
                if text.strip():
                    texts.append(text)
                if len(texts) >= max_texts:
                    break
    else:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    texts.append(line)
                if len(texts) >= max_texts:
                    break

    logger.info("Loaded %d eval texts from %s", len(texts), path)
    return texts


# ---------------------------------------------------------------------------
# Main evaluation pipeline
# ---------------------------------------------------------------------------

def evaluate_tokenizer(
    tokenizer_path: Path,
    eval_paths: dict[str, Path],
    output_path: Path,
    text_field: str = "text",
    max_texts_per_lang: int = 10_000,
) -> dict[str, Any]:
    """
    Run full tokenizer evaluation across multiple language corpora.

    eval_paths: mapping of language code -> corpus file path
    """
    start_time = time.time()

    logger.info("Loading tokenizer from %s", tokenizer_path)
    tokenizer = Tokenizer.from_file(str(tokenizer_path))

    report: dict[str, Any] = {
        "tokenizer_path": str(tokenizer_path),
        "vocab_size": tokenizer.get_vocab_size(),
        "languages": {},
    }

    for lang, corpus_path in eval_paths.items():
        logger.info("Evaluating language: %s (corpus: %s)", lang, corpus_path)

        texts = load_eval_texts(corpus_path, text_field=text_field, max_texts=max_texts_per_lang)
        if not texts:
            logger.warning("No texts found for language %s", lang)
            report["languages"][lang] = {"error": "no_texts"}
            continue

        lang_report: dict[str, Any] = {
            "num_eval_texts": len(texts),
        }

        # Compute all metrics
        logger.info("  Computing fertility...")
        lang_report["fertility"] = compute_fertility(tokenizer, texts)

        logger.info("  Computing compression ratio...")
        lang_report["compression"] = compute_compression_ratio(tokenizer, texts)

        logger.info("  Computing vocab coverage...")
        lang_report["vocab_coverage"] = compute_vocab_coverage(tokenizer, texts)

        logger.info("  Computing unknown rate...")
        lang_report["unknown_rate"] = compute_unknown_rate(tokenizer, texts)

        logger.info("  Computing sequence length stats...")
        lang_report["sequence_lengths"] = compute_sequence_length_stats(tokenizer, texts)

        report["languages"][lang] = lang_report

    # Aggregate across languages
    all_fertilities = [
        r["fertility"]["fertility"]
        for r in report["languages"].values()
        if isinstance(r, dict) and "fertility" in r and r["fertility"]["fertility"] > 0
    ]
    all_compressions = [
        r["compression"]["bytes_per_token"]
        for r in report["languages"].values()
        if isinstance(r, dict) and "compression" in r and r["compression"]["bytes_per_token"] > 0
    ]

    report["aggregate"] = {
        "mean_fertility": round(np.mean(all_fertilities), 4) if all_fertilities else None,
        "mean_bytes_per_token": round(np.mean(all_compressions), 4) if all_compressions else None,
        "languages_evaluated": len([
            l for l in report["languages"].values()
            if isinstance(l, dict) and "error" not in l
        ]),
    }

    elapsed = time.time() - start_time
    report["elapsed_seconds"] = round(elapsed, 2)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    logger.info("Evaluation complete in %.1fs. Report: %s", elapsed, output_path)
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("eval-tokenizer")
@click.option("--tokenizer", "tokenizer_path", required=True, type=click.Path(exists=True), help="Path to tokenizer.json")
@click.option("--eval-corpus", required=True, multiple=True, help="Eval corpus in format 'lang:path' (e.g. 'en:/data/eval_en.jsonl')")
@click.option("--output", "output_path", required=True, type=click.Path(), help="Output evaluation report JSON")
@click.option("--text-field", default="text", help="Text field name in JSONL files")
@click.option("--max-texts", default=10_000, type=int, help="Max texts per language")
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    tokenizer_path: str,
    eval_corpus: tuple[str, ...],
    output_path: str,
    text_field: str,
    max_texts: int,
    log_level: str,
) -> None:
    """Evaluate a trained tokenizer on multiple corpora."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # Parse eval corpus specs
    eval_paths: dict[str, Path] = {}
    for spec in eval_corpus:
        if ":" not in spec:
            # Assume English
            eval_paths["en"] = Path(spec)
        else:
            lang, path = spec.split(":", 1)
            eval_paths[lang.strip()] = Path(path.strip())

    report = evaluate_tokenizer(
        tokenizer_path=Path(tokenizer_path),
        eval_paths=eval_paths,
        output_path=Path(output_path),
        text_field=text_field,
        max_texts_per_lang=max_texts,
    )

    click.echo(f"\n--- Tokenizer Evaluation Report ---")
    click.echo(f"Vocab size:           {report['vocab_size']:>10,}")
    click.echo(f"Languages evaluated:  {report['aggregate']['languages_evaluated']:>10}")

    if report["aggregate"]["mean_fertility"] is not None:
        click.echo(f"Mean fertility:       {report['aggregate']['mean_fertility']:>10.4f} tokens/word")
    if report["aggregate"]["mean_bytes_per_token"] is not None:
        click.echo(f"Mean compression:     {report['aggregate']['mean_bytes_per_token']:>10.4f} bytes/token")

    click.echo(f"\nPer-language results:")
    for lang, data in report["languages"].items():
        if "error" in data:
            click.echo(f"  {lang:5s}  ERROR: {data['error']}")
            continue
        click.echo(
            f"  {lang:5s}  "
            f"fertility={data['fertility']['fertility']:.3f}  "
            f"bytes/tok={data['compression']['bytes_per_token']:.2f}  "
            f"coverage={data['vocab_coverage']['coverage_percent']:.1f}%  "
            f"unk={data['unknown_rate']['unk_rate_percent']:.2f}%"
        )

    click.echo(f"\nElapsed time: {report['elapsed_seconds']:.1f}s")
    click.echo(f"Report: {output_path}")


if __name__ == "__main__":
    cli()
