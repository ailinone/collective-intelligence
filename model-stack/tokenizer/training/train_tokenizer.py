# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Tokenizer training script using the HuggingFace tokenizers library.

Trains a BPE tokenizer from a text corpus with configurable vocabulary size,
special tokens, normalization, and pre-tokenization settings.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any, Iterator

import click
import yaml
from tokenizers import Tokenizer, decoders, models, normalizers, pre_tokenizers, processors, trainers
from tokenizers.implementations import BaseTokenizer

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Corpus iterator
# ---------------------------------------------------------------------------

def corpus_iterator(
    paths: list[Path],
    text_field: str = "text",
    max_lines: int | None = None,
) -> Iterator[str]:
    """
    Iterate over text from JSONL or plain-text files.

    For JSONL files, extracts the specified text_field.
    For plain-text files, yields each line.
    """
    total_yielded = 0

    for path in paths:
        path = Path(path)
        if not path.exists():
            logger.warning("Corpus file not found: %s", path)
            continue

        logger.info("Reading corpus from %s", path)

        if path.suffix in (".jsonl", ".json"):
            import jsonlines

            with jsonlines.open(path, mode="r") as reader:
                for record in reader:
                    text = record.get(text_field, "")
                    if text.strip():
                        yield text
                        total_yielded += 1
                        if max_lines is not None and total_yielded >= max_lines:
                            return
        else:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        yield line
                        total_yielded += 1
                        if max_lines is not None and total_yielded >= max_lines:
                            return

    logger.info("Corpus iterator yielded %d lines", total_yielded)


# ---------------------------------------------------------------------------
# Tokenizer builder
# ---------------------------------------------------------------------------

def build_tokenizer(config: dict[str, Any]) -> tuple[Tokenizer, trainers.BpeTrainer]:
    """
    Build a tokenizer and trainer from the config dictionary.

    Returns (tokenizer, trainer).
    """
    tok_cfg = config["tokenizer"]
    train_cfg = config.get("training", {})

    vocab_size = tok_cfg["vocab_size"]
    special_tokens = tok_cfg.get("special_tokens", [])
    min_frequency = tok_cfg.get("min_frequency", 2)

    # Initialize BPE model
    tokenizer = Tokenizer(models.BPE())

    # --- Normalizer ---
    norm_cfg = tok_cfg.get("normalizer", {})
    norm_steps = norm_cfg.get("steps", [])
    norm_list: list[normalizers.Normalizer] = []

    for step in norm_steps:
        step_type = step.get("type", "")
        if step_type == "nfc":
            norm_list.append(normalizers.NFC())
        elif step_type == "nfkc":
            norm_list.append(normalizers.NFKC())
        elif step_type == "lowercase_accent_strip":
            if step.get("enabled", True):
                norm_list.append(normalizers.Lowercase())
                norm_list.append(normalizers.StripAccents())

    if norm_list:
        tokenizer.normalizer = normalizers.Sequence(norm_list)
    else:
        tokenizer.normalizer = normalizers.NFC()

    # --- Pre-tokenizer ---
    pre_tok_cfg = tok_cfg.get("pre_tokenizer", {})
    pre_tok_type = pre_tok_cfg.get("type", "byte_level")

    if pre_tok_type == "byte_level":
        tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(
            add_prefix_space=pre_tok_cfg.get("add_prefix_space", False),
        )
    elif pre_tok_type == "whitespace":
        tokenizer.pre_tokenizer = pre_tokenizers.Whitespace()
    elif pre_tok_type == "split":
        pattern = pre_tok_cfg.get("regex_pattern", r"\w+|[^\w\s]+")
        tokenizer.pre_tokenizer = pre_tokenizers.Split(
            pattern=pattern,
            behavior="isolated",
        )
    else:
        tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)

    # --- Decoder ---
    dec_cfg = tok_cfg.get("decoder", {})
    dec_type = dec_cfg.get("type", "byte_level")

    if dec_type == "byte_level":
        tokenizer.decoder = decoders.ByteLevel()
    elif dec_type == "wordpiece":
        tokenizer.decoder = decoders.WordPiece()
    else:
        tokenizer.decoder = decoders.ByteLevel()

    # --- Trainer ---
    byte_fallback = train_cfg.get("byte_fallback", True)
    initial_alphabet: list[str] = []

    if train_cfg.get("initial_alphabet_from_corpus", True) and byte_fallback:
        initial_alphabet = list(pre_tokenizers.ByteLevel.alphabet())

    trainer = trainers.BpeTrainer(
        vocab_size=vocab_size,
        min_frequency=min_frequency,
        special_tokens=special_tokens,
        initial_alphabet=initial_alphabet,
        show_progress=train_cfg.get("show_progress", True),
        limit_alphabet=train_cfg.get("limit_alphabet", 1000),
    )

    return tokenizer, trainer


def add_post_processor(
    tokenizer: Tokenizer,
    config: dict[str, Any],
) -> None:
    """Configure the post-processor for BOS/EOS injection."""
    tok_cfg = config["tokenizer"]
    pp_cfg = tok_cfg.get("post_processor", {})

    if not pp_cfg:
        return

    pp_type = pp_cfg.get("type", "template")

    if pp_type == "template":
        single_template = pp_cfg.get("single", "$A")
        pair_template = pp_cfg.get("pair", "$A $B")
        special_map = pp_cfg.get("special_tokens", {})

        # Build special tokens list for TemplateProcessing
        special_tokens_list: list[tuple[str, int]] = []
        for token_str, token_id in special_map.items():
            special_tokens_list.append((token_str, token_id))

        try:
            tokenizer.post_processor = processors.TemplateProcessing(
                single=single_template,
                pair=pair_template,
                special_tokens=special_tokens_list,
            )
        except Exception as e:
            logger.warning("Could not set post-processor: %s", e)


# ---------------------------------------------------------------------------
# Training pipeline
# ---------------------------------------------------------------------------

def train_tokenizer(
    config: dict[str, Any],
    corpus_paths: list[Path],
    output_dir: Path,
    text_field: str = "text",
    max_lines: int | None = None,
) -> dict[str, Any]:
    """
    Train a BPE tokenizer and save it.

    Returns a summary report.
    """
    start_time = time.time()
    output_dir.mkdir(parents=True, exist_ok=True)

    # Build tokenizer and trainer
    tokenizer, trainer = build_tokenizer(config)

    # Train
    logger.info("Starting tokenizer training (vocab_size=%d)", config["tokenizer"]["vocab_size"])

    iterator = corpus_iterator(corpus_paths, text_field=text_field, max_lines=max_lines)
    tokenizer.train_from_iterator(iterator, trainer=trainer)

    # Add post-processor
    add_post_processor(tokenizer, config)

    elapsed_train = time.time() - start_time
    logger.info("Training completed in %.1fs", elapsed_train)

    # Save tokenizer
    tokenizer_path = output_dir / "tokenizer.json"
    tokenizer.save(str(tokenizer_path))
    logger.info("Saved tokenizer to %s", tokenizer_path)

    # Save config alongside
    config_path = output_dir / "tokenizer_config.yaml"
    with open(config_path, "w", encoding="utf-8") as f:
        yaml.dump(config, f, default_flow_style=False)

    # Save vocabulary for inspection
    vocab = tokenizer.get_vocab()
    vocab_path = output_dir / "vocab.json"
    with open(vocab_path, "w", encoding="utf-8") as f:
        json.dump(dict(sorted(vocab.items(), key=lambda x: x[1])), f, ensure_ascii=False, indent=0)

    # Quick sanity check
    test_text = "Hello, world! This is a test of the tokenizer."
    encoded = tokenizer.encode(test_text)
    decoded = tokenizer.decode(encoded.ids)

    report = {
        "vocab_size": tokenizer.get_vocab_size(),
        "special_tokens": config["tokenizer"].get("special_tokens", []),
        "training_time_seconds": round(elapsed_train, 2),
        "output_dir": str(output_dir),
        "tokenizer_file": str(tokenizer_path),
        "config_file": str(config_path),
        "sanity_check": {
            "input": test_text,
            "token_ids": encoded.ids[:50],
            "tokens": encoded.tokens[:50],
            "decoded": decoded,
            "round_trip_match": decoded.strip() == test_text.strip(),
        },
    }

    report_path = output_dir / "training_report.json"
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    logger.info("Vocab size: %d", report["vocab_size"])
    logger.info("Sanity check — round-trip match: %s", report["sanity_check"]["round_trip_match"])
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("train-tokenizer")
@click.option("--config", "config_path", required=True, type=click.Path(exists=True), help="Tokenizer config YAML")
@click.option("--corpus", required=True, multiple=True, type=click.Path(exists=True), help="Corpus file(s) for training")
@click.option("--output-dir", required=True, type=click.Path(), help="Output directory for tokenizer files")
@click.option("--text-field", default="text", help="Text field name in JSONL corpus files")
@click.option("--max-lines", default=None, type=int, help="Max lines to read from corpus")
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    config_path: str,
    corpus: tuple[str, ...],
    output_dir: str,
    text_field: str,
    max_lines: int | None,
    log_level: str,
) -> None:
    """Train a BPE tokenizer from a text corpus."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    with open(config_path, "r", encoding="utf-8") as f:
        config = yaml.safe_load(f)

    corpus_paths = [Path(p) for p in corpus]
    output_dir_p = Path(output_dir)

    report = train_tokenizer(
        config=config,
        corpus_paths=corpus_paths,
        output_dir=output_dir_p,
        text_field=text_field,
        max_lines=max_lines,
    )

    click.echo(f"\n--- Tokenizer Training Report ---")
    click.echo(f"Vocab size:      {report['vocab_size']:>10,}")
    click.echo(f"Training time:   {report['training_time_seconds']:>10.1f}s")
    click.echo(f"Round-trip OK:   {report['sanity_check']['round_trip_match']}")
    click.echo(f"Output:          {report['output_dir']}")


if __name__ == "__main__":
    cli()
