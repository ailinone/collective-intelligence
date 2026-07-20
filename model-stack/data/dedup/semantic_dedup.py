# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Semantic deduplication using sentence-transformer embeddings and cosine similarity clustering.

Computes dense embeddings for each document, finds near-duplicate clusters
using cosine similarity, and removes redundant documents.
"""

from __future__ import annotations

import json
import logging
import time
from pathlib import Path
from typing import Any

import click
import jsonlines
import numpy as np
from tqdm import tqdm

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Embedding computation
# ---------------------------------------------------------------------------

def compute_embeddings(
    texts: list[str],
    model_name: str = "all-MiniLM-L6-v2",
    batch_size: int = 256,
    max_seq_length: int = 512,
    device: str | None = None,
) -> np.ndarray:
    """
    Compute sentence embeddings using a sentence-transformers model.

    Returns an (N, D) float32 numpy array of L2-normalized embeddings.
    """
    from sentence_transformers import SentenceTransformer

    logger.info("Loading embedding model: %s", model_name)
    model = SentenceTransformer(model_name, device=device)
    model.max_seq_length = max_seq_length

    logger.info("Computing embeddings for %d texts (batch_size=%d)", len(texts), batch_size)
    embeddings = model.encode(
        texts,
        batch_size=batch_size,
        show_progress_bar=True,
        normalize_embeddings=True,
        convert_to_numpy=True,
    )

    logger.info("Embeddings shape: %s", embeddings.shape)
    return embeddings


# ---------------------------------------------------------------------------
# Clustering / duplicate detection
# ---------------------------------------------------------------------------

def find_semantic_duplicates_faiss(
    embeddings: np.ndarray,
    threshold: float = 0.9,
    batch_size: int = 1024,
) -> dict[int, int]:
    """
    Find near-duplicate pairs using FAISS cosine similarity search.

    Returns a mapping of duplicate_index -> canonical_index.
    """
    try:
        import faiss
    except ImportError:
        logger.warning("FAISS not available, falling back to sklearn-based approach")
        return find_semantic_duplicates_sklearn(embeddings, threshold)

    n, d = embeddings.shape
    logger.info("Building FAISS index for %d vectors of dim %d", n, d)

    # Use inner product (cosine similarity since vectors are normalized)
    index = faiss.IndexFlatIP(d)
    index.add(embeddings.astype(np.float32))

    duplicate_of: dict[int, int] = {}
    removed: set[int] = set()

    for start in tqdm(range(0, n, batch_size), desc="FAISS search", unit=" batches"):
        end = min(start + batch_size, n)
        query = embeddings[start:end].astype(np.float32)

        # Search for k nearest neighbors — we cap k to avoid excessive memory
        k = min(50, n)
        similarities, indices = index.search(query, k)

        for i_in_batch in range(end - start):
            global_idx = start + i_in_batch
            if global_idx in removed:
                continue

            for j in range(k):
                neighbor_idx = int(indices[i_in_batch, j])
                sim = float(similarities[i_in_batch, j])

                if neighbor_idx == global_idx:
                    continue
                if neighbor_idx in removed:
                    continue
                if sim < threshold:
                    break  # Sorted by similarity, so remaining will be lower

                # Mark the higher-indexed document as duplicate
                dup_idx = max(global_idx, neighbor_idx)
                canon_idx = min(global_idx, neighbor_idx)

                if dup_idx not in duplicate_of:
                    duplicate_of[dup_idx] = canon_idx
                    removed.add(dup_idx)

    return duplicate_of


def find_semantic_duplicates_sklearn(
    embeddings: np.ndarray,
    threshold: float = 0.9,
    chunk_size: int = 5000,
) -> dict[int, int]:
    """
    Fallback: find near-duplicates using sklearn cosine similarity in chunks.

    Processes the similarity matrix in chunks to manage memory.
    """
    from sklearn.metrics.pairwise import cosine_similarity

    n = embeddings.shape[0]
    logger.info("Computing pairwise cosine similarities for %d documents (chunked)", n)

    duplicate_of: dict[int, int] = {}
    removed: set[int] = set()

    for start in tqdm(range(0, n, chunk_size), desc="Cosine similarity", unit=" chunks"):
        end = min(start + chunk_size, n)
        chunk = embeddings[start:end]

        # Compare chunk against all embeddings
        sim_matrix = cosine_similarity(chunk, embeddings)

        for i_in_chunk in range(end - start):
            global_idx = start + i_in_chunk
            if global_idx in removed:
                continue

            # Only look at indices > global_idx to avoid double counting
            for j in range(global_idx + 1, n):
                if j in removed:
                    continue
                if sim_matrix[i_in_chunk, j] >= threshold:
                    duplicate_of[j] = global_idx
                    removed.add(j)

    return duplicate_of


# ---------------------------------------------------------------------------
# Core pipeline
# ---------------------------------------------------------------------------

def run_semantic_dedup(
    input_path: Path,
    output_path: Path,
    report_path: Path,
    threshold: float = 0.9,
    model_name: str = "all-MiniLM-L6-v2",
    batch_size: int = 256,
    text_field: str = "text",
    max_docs: int | None = None,
    device: str | None = None,
    use_faiss: bool = True,
) -> dict[str, Any]:
    """Run the full semantic dedup pipeline. Returns a summary report."""
    start_time = time.time()

    # Phase 1: Load data
    logger.info("Phase 1: Loading data from %s", input_path)
    records: list[dict[str, Any]] = []
    texts: list[str] = []

    with jsonlines.open(input_path, mode="r") as reader:
        for record in tqdm(reader, desc="Loading", unit=" docs"):
            text = record.get(text_field, "")
            if not text.strip():
                # Keep record but use empty string placeholder
                texts.append("")
            else:
                # Truncate very long texts for embedding (keep first ~1000 chars)
                texts.append(text[:2000])
            records.append(record)

            if max_docs is not None and len(records) >= max_docs:
                break

    total_docs = len(records)
    logger.info("Loaded %d documents", total_docs)

    # Phase 2: Compute embeddings
    logger.info("Phase 2: Computing embeddings...")
    # Filter out empty texts for embedding but keep track of indices
    valid_indices = [i for i, t in enumerate(texts) if t.strip()]
    valid_texts = [texts[i] for i in valid_indices]

    if not valid_texts:
        logger.warning("No valid texts found for embedding")
        # Write all records as-is
        with jsonlines.open(output_path, mode="w") as writer:
            for r in records:
                writer.write(r)
        report = {
            "total_documents": total_docs,
            "documents_kept": total_docs,
            "documents_removed": 0,
            "reduction_percent": 0.0,
            "elapsed_seconds": round(time.time() - start_time, 2),
        }
        with open(report_path, "w") as f:
            json.dump(report, f, indent=2)
        return report

    embeddings = compute_embeddings(
        valid_texts,
        model_name=model_name,
        batch_size=batch_size,
        device=device,
    )

    # Phase 3: Find duplicates
    logger.info("Phase 3: Finding semantic duplicates (threshold=%.3f)...", threshold)
    if use_faiss:
        dup_map_local = find_semantic_duplicates_faiss(embeddings, threshold=threshold)
    else:
        dup_map_local = find_semantic_duplicates_sklearn(embeddings, threshold=threshold)

    # Map local indices back to global indices
    duplicate_of: dict[int, int] = {}
    for local_dup, local_canon in dup_map_local.items():
        global_dup = valid_indices[local_dup]
        global_canon = valid_indices[local_canon]
        duplicate_of[global_dup] = global_canon

    num_duplicates = len(duplicate_of)
    logger.info("Found %d semantic duplicates", num_duplicates)

    # Phase 4: Write output
    logger.info("Phase 4: Writing deduplicated dataset...")
    kept = 0
    removed = 0

    with jsonlines.open(output_path, mode="w") as writer:
        for idx, record in enumerate(records):
            if idx in duplicate_of:
                removed += 1
                continue
            writer.write(record)
            kept += 1

    elapsed = time.time() - start_time

    report = {
        "input_file": str(input_path),
        "output_file": str(output_path),
        "config": {
            "threshold": threshold,
            "model_name": model_name,
            "use_faiss": use_faiss,
            "text_field": text_field,
        },
        "total_documents": total_docs,
        "documents_with_text": len(valid_texts),
        "documents_kept": kept,
        "documents_removed": removed,
        "reduction_percent": round(100.0 * removed / total_docs, 2) if total_docs > 0 else 0.0,
        "embedding_dim": int(embeddings.shape[1]),
        "elapsed_seconds": round(elapsed, 2),
    }

    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    logger.info("Semantic dedup complete: kept=%d removed=%d (%.1f%% reduction)", kept, removed, report["reduction_percent"])
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("semantic-dedup")
@click.option("--input", "input_path", required=True, type=click.Path(exists=True), help="Input JSONL file")
@click.option("--output", "output_path", required=True, type=click.Path(), help="Output deduplicated JSONL file")
@click.option("--report", "report_path", default=None, type=click.Path(), help="Output report JSON path")
@click.option("--threshold", default=0.9, type=float, help="Cosine similarity threshold (0.0-1.0)")
@click.option("--model", "model_name", default="all-MiniLM-L6-v2", help="Sentence transformer model name")
@click.option("--batch-size", default=256, type=int, help="Embedding batch size")
@click.option("--text-field", default="text", help="Field name containing document text")
@click.option("--max-docs", default=None, type=int, help="Maximum documents to process")
@click.option("--device", default=None, help="Device for embedding model (cuda, cpu, mps)")
@click.option("--no-faiss", is_flag=True, default=False, help="Disable FAISS, use sklearn fallback")
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    input_path: str,
    output_path: str,
    report_path: str | None,
    threshold: float,
    model_name: str,
    batch_size: int,
    text_field: str,
    max_docs: int | None,
    device: str | None,
    no_faiss: bool,
    log_level: str,
) -> None:
    """Perform semantic deduplication using sentence embeddings."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    output_p = Path(output_path)
    output_p.parent.mkdir(parents=True, exist_ok=True)

    if report_path is None:
        report_p = output_p.with_suffix(".semantic_dedup_report.json")
    else:
        report_p = Path(report_path)

    report = run_semantic_dedup(
        input_path=Path(input_path),
        output_path=output_p,
        report_path=report_p,
        threshold=threshold,
        model_name=model_name,
        batch_size=batch_size,
        text_field=text_field,
        max_docs=max_docs,
        device=device,
        use_faiss=not no_faiss,
    )

    click.echo(f"\n--- Semantic Dedup Report ---")
    click.echo(f"Total documents:   {report['total_documents']:>10,}")
    click.echo(f"Documents kept:    {report['documents_kept']:>10,}")
    click.echo(f"Documents removed: {report['documents_removed']:>10,}")
    click.echo(f"Reduction:         {report['reduction_percent']:>9.1f}%")
    click.echo(f"Elapsed time:      {report['elapsed_seconds']:>10.1f}s")
    click.echo(f"Report:            {report_p}")


if __name__ == "__main__":
    cli()
