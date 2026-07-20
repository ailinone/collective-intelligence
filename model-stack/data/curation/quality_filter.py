# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Quality filtering pipeline for training data.

Applies multiple configurable filters:
  - Length filter (min/max token count)
  - Language detection filter
  - Repetition filter (character/word n-gram repetition ratios)
  - Special character ratio filter
  - Perplexity filter (heuristic word-rank proxy)

Configuration is loaded from a YAML file. Each filter can be independently enabled/disabled
and has configurable thresholds.
"""

from __future__ import annotations

import json
import logging
import math
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import click
import jsonlines
import yaml
from tqdm import tqdm

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Default config
# ---------------------------------------------------------------------------

DEFAULT_CONFIG: dict[str, Any] = {
    "length_filter": {
        "enabled": True,
        "min_tokens": 50,
        "max_tokens": 100000,
        "min_chars": 100,
        "max_chars": 1000000,
    },
    "language_filter": {
        "enabled": True,
        "allowed_languages": ["en"],
        "min_confidence": 0.8,
    },
    "repetition_filter": {
        "enabled": True,
        "max_char_ngram_rep_ratio": 0.2,
        "max_word_ngram_rep_ratio": 0.2,
        "char_ngram_size": 10,
        "word_ngram_size": 5,
        "max_line_dup_ratio": 0.3,
    },
    "special_char_filter": {
        "enabled": True,
        "max_special_ratio": 0.3,
        "max_digit_ratio": 0.5,
        "max_uppercase_ratio": 0.8,
    },
    "perplexity_filter": {
        "enabled": True,
        "max_perplexity": 10000.0,
        "min_perplexity": 5.0,
    },
}


# ---------------------------------------------------------------------------
# Filter implementations
# ---------------------------------------------------------------------------

def _count_tokens_approx(text: str) -> int:
    """Approximate token count using whitespace splitting (fast heuristic)."""
    return len(text.split())


def filter_length(text: str, cfg: dict[str, Any]) -> tuple[bool, str]:
    """Return (passed, reason)."""
    n_chars = len(text)
    n_tokens = _count_tokens_approx(text)

    if n_chars < cfg["min_chars"]:
        return False, f"too_short_chars({n_chars}<{cfg['min_chars']})"
    if n_chars > cfg["max_chars"]:
        return False, f"too_long_chars({n_chars}>{cfg['max_chars']})"
    if n_tokens < cfg["min_tokens"]:
        return False, f"too_few_tokens({n_tokens}<{cfg['min_tokens']})"
    if n_tokens > cfg["max_tokens"]:
        return False, f"too_many_tokens({n_tokens}>{cfg['max_tokens']})"
    return True, ""


def filter_language(text: str, cfg: dict[str, Any]) -> tuple[bool, str]:
    """Detect language and check against allowed list."""
    try:
        from langdetect import detect_langs
        from langdetect.lang_detect_exception import LangDetectException
    except ImportError:
        logger.warning("langdetect not installed; skipping language filter")
        return True, ""

    try:
        detections = detect_langs(text[:5000])  # Limit for speed
    except LangDetectException:
        return False, "language_detect_failed"

    if not detections:
        return False, "no_language_detected"

    top = detections[0]
    if top.prob < cfg["min_confidence"]:
        return False, f"low_lang_confidence({top.lang}:{top.prob:.2f})"
    if top.lang not in cfg["allowed_languages"]:
        return False, f"wrong_language({top.lang})"

    return True, ""


def _compute_ngram_rep_ratio(tokens: list[str], n: int) -> float:
    """Fraction of n-grams that are duplicated."""
    if len(tokens) < n:
        return 0.0
    ngrams = [tuple(tokens[i : i + n]) for i in range(len(tokens) - n + 1)]
    counts = Counter(ngrams)
    if not counts:
        return 0.0
    total = sum(counts.values())
    duplicated = sum(c - 1 for c in counts.values() if c > 1)
    return duplicated / total


def filter_repetition(text: str, cfg: dict[str, Any]) -> tuple[bool, str]:
    """Check for excessive n-gram repetition."""
    # Character n-gram repetition
    chars = list(text.replace(" ", "").replace("\n", ""))
    char_rep = _compute_ngram_rep_ratio(chars, cfg["char_ngram_size"])
    if char_rep > cfg["max_char_ngram_rep_ratio"]:
        return False, f"char_ngram_rep({char_rep:.3f}>{cfg['max_char_ngram_rep_ratio']})"

    # Word n-gram repetition
    words = text.lower().split()
    word_rep = _compute_ngram_rep_ratio(words, cfg["word_ngram_size"])
    if word_rep > cfg["max_word_ngram_rep_ratio"]:
        return False, f"word_ngram_rep({word_rep:.3f}>{cfg['max_word_ngram_rep_ratio']})"

    # Line duplication ratio
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    if lines:
        line_counts = Counter(lines)
        dup_lines = sum(c - 1 for c in line_counts.values() if c > 1)
        dup_ratio = dup_lines / len(lines)
        if dup_ratio > cfg["max_line_dup_ratio"]:
            return False, f"line_dup_ratio({dup_ratio:.3f}>{cfg['max_line_dup_ratio']})"

    return True, ""


def filter_special_chars(text: str, cfg: dict[str, Any]) -> tuple[bool, str]:
    """Check special character, digit, and uppercase ratios."""
    if not text:
        return False, "empty_text"

    n = len(text)
    n_alpha = sum(1 for c in text if c.isalpha())
    n_digit = sum(1 for c in text if c.isdigit())
    n_upper = sum(1 for c in text if c.isupper())
    n_special = n - n_alpha - n_digit - sum(1 for c in text if c.isspace())

    special_ratio = n_special / n
    digit_ratio = n_digit / n
    upper_ratio = n_upper / max(n_alpha, 1)

    if special_ratio > cfg["max_special_ratio"]:
        return False, f"special_ratio({special_ratio:.3f}>{cfg['max_special_ratio']})"
    if digit_ratio > cfg["max_digit_ratio"]:
        return False, f"digit_ratio({digit_ratio:.3f}>{cfg['max_digit_ratio']})"
    if upper_ratio > cfg["max_uppercase_ratio"]:
        return False, f"uppercase_ratio({upper_ratio:.3f}>{cfg['max_uppercase_ratio']})"

    return True, ""


# Simple word frequency rank table for perplexity estimation (top English words)
_COMMON_WORDS: set[str] = {
    "the", "be", "to", "of", "and", "a", "in", "that", "have", "i",
    "it", "for", "not", "on", "with", "he", "as", "you", "do", "at",
    "this", "but", "his", "by", "from", "they", "we", "say", "her", "she",
    "or", "an", "will", "my", "one", "all", "would", "there", "their", "what",
    "so", "up", "out", "if", "about", "who", "get", "which", "go", "me",
    "when", "make", "can", "like", "time", "no", "just", "him", "know", "take",
    "people", "into", "year", "your", "good", "some", "could", "them", "see",
    "other", "than", "then", "now", "look", "only", "come", "its", "over",
    "think", "also", "back", "after", "use", "two", "how", "our", "work",
    "first", "well", "way", "even", "new", "want", "because", "any", "these",
    "give", "day", "most", "us", "is", "was", "are", "were", "been", "has",
    "had", "did", "does", "am",
}


def _estimate_perplexity(text: str) -> float:
    """
    Heuristic perplexity estimate based on word rank frequency.

    This uses a simplified approach: words not in a common-word set receive a
    higher "surprise" score. The geometric mean of per-word surprise gives a
    rough perplexity proxy. This avoids needing a full LM for filtering.
    """
    words = re.findall(r"[a-zA-Z]+", text.lower())
    if not words:
        return float("inf")

    log_probs_sum = 0.0
    for w in words:
        if w in _COMMON_WORDS:
            log_probs_sum += math.log(0.02)  # High probability
        elif len(w) <= 3:
            log_probs_sum += math.log(0.005)
        elif len(w) <= 8:
            log_probs_sum += math.log(0.001)
        else:
            log_probs_sum += math.log(0.0002)  # Rare words

    avg_log_prob = log_probs_sum / len(words)
    perplexity = math.exp(-avg_log_prob)
    return perplexity


def filter_perplexity(text: str, cfg: dict[str, Any]) -> tuple[bool, str]:
    """Filter based on heuristic perplexity estimate."""
    ppl = _estimate_perplexity(text)

    if ppl > cfg["max_perplexity"]:
        return False, f"high_perplexity({ppl:.1f}>{cfg['max_perplexity']})"
    if ppl < cfg["min_perplexity"]:
        return False, f"low_perplexity({ppl:.1f}<{cfg['min_perplexity']})"

    return True, ""


# ---------------------------------------------------------------------------
# Filter registry
# ---------------------------------------------------------------------------

FILTERS = {
    "length_filter": filter_length,
    "language_filter": filter_language,
    "repetition_filter": filter_repetition,
    "special_char_filter": filter_special_chars,
    "perplexity_filter": filter_perplexity,
}


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

@dataclass
class FilterStats:
    total: int = 0
    passed: int = 0
    per_filter_rejected: dict[str, int] = field(default_factory=dict)
    rejection_reasons: list[str] = field(default_factory=list)


def run_quality_filter(
    input_path: Path,
    output_path: Path,
    report_path: Path,
    config: dict[str, Any],
    text_field: str = "text",
) -> dict[str, Any]:
    """Run the full quality filtering pipeline."""
    start_time = time.time()
    stats = FilterStats()

    for name in FILTERS:
        stats.per_filter_rejected[name] = 0

    with jsonlines.open(input_path, mode="r") as reader, \
         jsonlines.open(output_path, mode="w") as writer:

        for record in tqdm(reader, desc="Quality filtering", unit=" docs"):
            stats.total += 1
            text = record.get(text_field, "")

            rejected = False
            for filter_name, filter_fn in FILTERS.items():
                filter_cfg = config.get(filter_name, {})
                if not filter_cfg.get("enabled", False):
                    continue

                passed, reason = filter_fn(text, filter_cfg)
                if not passed:
                    stats.per_filter_rejected[filter_name] += 1
                    stats.rejection_reasons.append(reason)
                    rejected = True
                    break  # First failing filter wins

            if not rejected:
                writer.write(record)
                stats.passed += 1

    elapsed = time.time() - start_time

    # Build report
    reason_counts = Counter(stats.rejection_reasons)
    report = {
        "input_file": str(input_path),
        "output_file": str(output_path),
        "total_documents": stats.total,
        "documents_passed": stats.passed,
        "documents_rejected": stats.total - stats.passed,
        "pass_rate_percent": round(100.0 * stats.passed / max(stats.total, 1), 2),
        "per_filter_rejected": stats.per_filter_rejected,
        "top_rejection_reasons": dict(reason_counts.most_common(20)),
        "config": config,
        "elapsed_seconds": round(elapsed, 2),
    }

    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    logger.info(
        "Quality filtering complete: passed=%d rejected=%d (%.1f%% pass rate)",
        stats.passed,
        stats.total - stats.passed,
        report["pass_rate_percent"],
    )
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("quality-filter")
@click.option("--input", "input_path", required=True, type=click.Path(exists=True), help="Input JSONL file")
@click.option("--output", "output_path", required=True, type=click.Path(), help="Output filtered JSONL file")
@click.option("--report", "report_path", default=None, type=click.Path(), help="Output report JSON path")
@click.option("--config", "config_path", default=None, type=click.Path(exists=True), help="Quality filter config YAML")
@click.option("--text-field", default="text", help="Field name containing document text")
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    input_path: str,
    output_path: str,
    report_path: str | None,
    config_path: str | None,
    text_field: str,
    log_level: str,
) -> None:
    """Apply quality filters to a JSONL dataset."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    # Load config
    if config_path is not None:
        with open(config_path, "r", encoding="utf-8") as f:
            config = yaml.safe_load(f)
        logger.info("Loaded config from %s", config_path)
    else:
        config = DEFAULT_CONFIG
        logger.info("Using default quality filter config")

    output_p = Path(output_path)
    output_p.parent.mkdir(parents=True, exist_ok=True)

    if report_path is None:
        report_p = output_p.with_suffix(".quality_report.json")
    else:
        report_p = Path(report_path)

    report = run_quality_filter(
        input_path=Path(input_path),
        output_path=output_p,
        report_path=report_p,
        config=config,
        text_field=text_field,
    )

    click.echo(f"\n--- Quality Filter Report ---")
    click.echo(f"Total documents:    {report['total_documents']:>10,}")
    click.echo(f"Documents passed:   {report['documents_passed']:>10,}")
    click.echo(f"Documents rejected: {report['documents_rejected']:>10,}")
    click.echo(f"Pass rate:          {report['pass_rate_percent']:>9.1f}%")
    click.echo(f"\nPer-filter rejections:")
    for name, count in report["per_filter_rejected"].items():
        if count > 0:
            click.echo(f"  {name:30s} {count:>8,}")
    click.echo(f"\nElapsed time: {report['elapsed_seconds']:.1f}s")
    click.echo(f"Report: {report_p}")


if __name__ == "__main__":
    cli()
