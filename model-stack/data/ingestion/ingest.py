# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Data ingestion CLI: downloads/loads data from various sources, normalizes to a standard
schema, validates, and outputs standardized JSONL with a dataset manifest.
"""

from __future__ import annotations

import hashlib
import json
import logging
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import urlparse

import click
import jsonlines
import pandas as pd
import pyarrow.parquet as pq
from pydantic import BaseModel, Field, ValidationError
from tqdm import tqdm

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Standard record schema
# ---------------------------------------------------------------------------

class StandardRecord(BaseModel):
    """Canonical record format for the training pipeline."""

    text: str = Field(min_length=1)
    source: str
    language: str = "en"
    timestamp: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


# ---------------------------------------------------------------------------
# Source readers
# ---------------------------------------------------------------------------

def _read_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    with jsonlines.open(path, mode="r") as reader:
        yield from reader


def _read_parquet(path: Path) -> Iterator[dict[str, Any]]:
    table = pq.read_table(path)
    for batch in table.to_batches(max_chunksize=10_000):
        df = batch.to_pandas()
        for _, row in df.iterrows():
            yield row.to_dict()


def _read_csv(path: Path) -> Iterator[dict[str, Any]]:
    for chunk in pd.read_csv(path, chunksize=10_000):
        for _, row in chunk.iterrows():
            yield row.to_dict()


def _read_huggingface(dataset_name: str, split: str = "train") -> Iterator[dict[str, Any]]:
    from datasets import load_dataset

    ds = load_dataset(dataset_name, split=split, streaming=True)
    yield from ds


READERS = {
    "jsonl": _read_jsonl,
    "parquet": _read_parquet,
    "csv": _read_csv,
}


# ---------------------------------------------------------------------------
# Normalizer
# ---------------------------------------------------------------------------

TEXT_FIELD_CANDIDATES = ["text", "content", "body", "document", "passage", "sentence", "input"]


def _normalize_record(raw: dict[str, Any], source_name: str) -> StandardRecord | None:
    """Attempt to normalize a raw record to the standard schema."""
    text = None
    for candidate in TEXT_FIELD_CANDIDATES:
        if candidate in raw and isinstance(raw[candidate], str) and raw[candidate].strip():
            text = raw[candidate].strip()
            break

    if text is None:
        return None

    language = raw.get("language", raw.get("lang", "en"))
    if not isinstance(language, str):
        language = "en"

    timestamp = raw.get("timestamp", raw.get("date", raw.get("created_at")))
    if timestamp is not None:
        timestamp = str(timestamp)

    # Collect remaining fields as metadata
    reserved = set(TEXT_FIELD_CANDIDATES) | {"language", "lang", "timestamp", "date", "created_at", "source"}
    metadata = {k: v for k, v in raw.items() if k not in reserved and _is_serializable(v)}

    return StandardRecord(
        text=text,
        source=raw.get("source", source_name),
        language=language,
        timestamp=timestamp,
        metadata=metadata,
    )


def _is_serializable(v: Any) -> bool:
    try:
        json.dumps(v)
        return True
    except (TypeError, ValueError):
        return False


# ---------------------------------------------------------------------------
# Manifest writer
# ---------------------------------------------------------------------------

def _write_manifest(
    output_path: Path,
    source: str,
    fmt: str,
    row_count: int,
    sha256: str,
) -> Path:
    manifest = {
        "name": output_path.stem,
        "version": "1.0.0",
        "source_url": source,
        "license": "unknown",
        "format": "jsonl",
        "splits": [
            {
                "name": "full",
                "num_rows": row_count,
                "path": output_path.name,
                "sha256": sha256,
            }
        ],
        "row_count": row_count,
        "created_at": datetime.utcnow().isoformat(),
        "tags": [fmt],
        "pii_status": "not_scanned",
        "contamination_status": "not_checked",
        "exclusion_policy": "none",
    }

    import yaml

    manifest_path = output_path.with_suffix(".manifest.yaml")
    with open(manifest_path, "w", encoding="utf-8") as f:
        yaml.dump(manifest, f, default_flow_style=False, sort_keys=False)

    return manifest_path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("ingest")
@click.option("--source", required=True, help="Source URL, file path, or HuggingFace dataset name")
@click.option(
    "--format", "fmt",
    type=click.Choice(["jsonl", "parquet", "csv", "huggingface"]),
    required=True,
    help="Input data format",
)
@click.option("--output", required=True, type=click.Path(), help="Output JSONL file path")
@click.option("--split", default="train", help="HuggingFace split name (only for huggingface format)")
@click.option("--max-rows", default=None, type=int, help="Maximum rows to ingest")
@click.option("--source-name", default=None, help="Override source name in records")
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    source: str,
    fmt: str,
    output: str,
    split: str,
    max_rows: int | None,
    source_name: str | None,
    log_level: str,
) -> None:
    """Ingest data from various sources into standardized JSONL format."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if source_name is None:
        if fmt == "huggingface":
            source_name = source
        else:
            source_name = Path(source).stem

    logger.info("Starting ingestion: source=%s format=%s output=%s", source, fmt, output)
    start_time = time.time()

    # Set up reader
    if fmt == "huggingface":
        records_iter = _read_huggingface(source, split=split)
    else:
        source_path = Path(source)
        if not source_path.exists():
            # Attempt download if it looks like a URL
            parsed = urlparse(source)
            if parsed.scheme in ("http", "https"):
                source_path = _download_file(source, output_path.parent)
            else:
                logger.error("Source file not found: %s", source)
                sys.exit(1)
        reader = READERS.get(fmt)
        if reader is None:
            logger.error("Unsupported format: %s", fmt)
            sys.exit(1)
        records_iter = reader(source_path)

    # Process and write
    sha = hashlib.sha256()
    total_read = 0
    total_written = 0
    total_skipped = 0

    with jsonlines.open(output_path, mode="w") as writer:
        for raw in tqdm(records_iter, desc="Ingesting", unit=" records"):
            total_read += 1

            if max_rows is not None and total_written >= max_rows:
                break

            try:
                record = _normalize_record(raw, source_name)
            except (ValidationError, Exception) as e:
                logger.debug("Skipping invalid record %d: %s", total_read, e)
                total_skipped += 1
                continue

            if record is None:
                total_skipped += 1
                continue

            line = record.model_dump(mode="json")
            writer.write(line)
            sha.update(json.dumps(line, sort_keys=True).encode("utf-8"))
            total_written += 1

    elapsed = time.time() - start_time
    file_sha256 = sha.hexdigest()

    # Write manifest
    manifest_path = _write_manifest(
        output_path,
        source=source,
        fmt=fmt,
        row_count=total_written,
        sha256=file_sha256,
    )

    logger.info(
        "Ingestion complete: read=%d written=%d skipped=%d elapsed=%.1fs",
        total_read,
        total_written,
        total_skipped,
        elapsed,
    )
    logger.info("Output: %s", output_path)
    logger.info("Manifest: %s", manifest_path)
    logger.info("SHA-256: %s", file_sha256)

    # Print summary
    click.echo(f"\n--- Ingestion Summary ---")
    click.echo(f"Records read:    {total_read:>10,}")
    click.echo(f"Records written: {total_written:>10,}")
    click.echo(f"Records skipped: {total_skipped:>10,}")
    click.echo(f"Elapsed time:    {elapsed:>10.1f}s")
    click.echo(f"Output file:     {output_path}")
    click.echo(f"Manifest file:   {manifest_path}")


def _download_file(url: str, dest_dir: Path) -> Path:
    """Download a file from a URL to the destination directory."""
    import urllib.request

    filename = Path(urlparse(url).path).name or "downloaded_data"
    dest = dest_dir / filename
    logger.info("Downloading %s -> %s", url, dest)

    with tqdm(unit="B", unit_scale=True, desc="Downloading") as pbar:
        def _reporthook(block_num: int, block_size: int, total_size: int) -> None:
            if total_size > 0:
                pbar.total = total_size
            pbar.update(block_size)

        urllib.request.urlretrieve(url, dest, reporthook=_reporthook)

    logger.info("Download complete: %s (%.1f MB)", dest, dest.stat().st_size / 1e6)
    return dest


if __name__ == "__main__":
    cli()
