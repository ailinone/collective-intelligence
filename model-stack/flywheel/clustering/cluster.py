#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Failure clustering.

Loads captured failures, computes text embeddings (via sentence-transformers
or a simple TF-IDF fallback), clusters them using HDBSCAN or KMeans, labels
each cluster by dominant capability gap, and outputs a cluster report.
"""

from __future__ import annotations

import json
import logging
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

import click
import numpy as np

logger = logging.getLogger("failure_clustering")

DEFAULT_FAILURE_STORE = Path(__file__).resolve().parents[1] / "failures" / "captured_failures.json"


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

@dataclass
class FailureItem:
    failure_id: str
    suite: str
    capability: str
    question: str
    expected: str
    actual: str
    metadata: dict[str, Any] = field(default_factory=dict)


def load_failures(path: Path) -> list[FailureItem]:
    if not path.exists():
        return []
    data = json.loads(path.read_text())
    return [FailureItem(**{k: f[k] for k in FailureItem.__dataclass_fields__ if k in f}) for f in data.get("failures", [])]


# ---------------------------------------------------------------------------
# Embedding
# ---------------------------------------------------------------------------

def embed_sentence_transformers(texts: list[str], model_name: str = "all-MiniLM-L6-v2") -> np.ndarray:
    """Compute embeddings using sentence-transformers."""
    from sentence_transformers import SentenceTransformer

    model = SentenceTransformer(model_name)
    embeddings = model.encode(texts, show_progress_bar=True, batch_size=32)
    return np.array(embeddings)


def embed_tfidf(texts: list[str], max_features: int = 512) -> np.ndarray:
    """Fallback: compute TF-IDF vectors."""
    from sklearn.feature_extraction.text import TfidfVectorizer

    vectorizer = TfidfVectorizer(max_features=max_features, stop_words="english")
    matrix = vectorizer.fit_transform(texts)
    return matrix.toarray()


def compute_embeddings(texts: list[str], method: str = "auto") -> np.ndarray:
    if method == "sentence_transformers":
        return embed_sentence_transformers(texts)
    if method == "tfidf":
        return embed_tfidf(texts)

    # Auto: try sentence-transformers, fall back to TF-IDF
    try:
        return embed_sentence_transformers(texts)
    except ImportError:
        logger.info("sentence-transformers not available, falling back to TF-IDF")
        return embed_tfidf(texts)


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------

def cluster_hdbscan(embeddings: np.ndarray, min_cluster_size: int = 3) -> np.ndarray:
    """Cluster embeddings using HDBSCAN."""
    import hdbscan

    clusterer = hdbscan.HDBSCAN(min_cluster_size=min_cluster_size, metric="euclidean")
    labels = clusterer.fit_predict(embeddings)
    return labels


def cluster_kmeans(embeddings: np.ndarray, n_clusters: int = 5) -> np.ndarray:
    """Cluster embeddings using KMeans."""
    from sklearn.cluster import KMeans

    kmeans = KMeans(n_clusters=n_clusters, random_state=42, n_init=10)
    labels = kmeans.fit_predict(embeddings)
    return labels


def run_clustering(
    embeddings: np.ndarray,
    method: str = "auto",
    n_clusters: int = 5,
    min_cluster_size: int = 3,
) -> np.ndarray:
    if method == "hdbscan":
        return cluster_hdbscan(embeddings, min_cluster_size)
    if method == "kmeans":
        return cluster_kmeans(embeddings, n_clusters)

    # Auto: try HDBSCAN, fall back to KMeans
    try:
        return cluster_hdbscan(embeddings, min_cluster_size)
    except ImportError:
        logger.info("hdbscan not available, using KMeans")
        return cluster_kmeans(embeddings, n_clusters)


# ---------------------------------------------------------------------------
# Cluster labelling
# ---------------------------------------------------------------------------

@dataclass
class ClusterInfo:
    cluster_id: int
    size: int
    dominant_capability: str
    capability_distribution: dict[str, int]
    representative_questions: list[str]
    label: str = ""


def label_clusters(
    failures: list[FailureItem],
    labels: np.ndarray,
) -> list[ClusterInfo]:
    """Assign a human-readable label to each cluster based on capability."""
    unique_labels = sorted(set(labels))
    clusters: list[ClusterInfo] = []

    for cid in unique_labels:
        if cid == -1:
            continue  # noise cluster in HDBSCAN
        members = [f for f, l in zip(failures, labels) if l == cid]
        cap_counts = Counter(f.capability for f in members)
        dominant = cap_counts.most_common(1)[0][0] if cap_counts else "unknown"

        # Pick up to 3 representative questions (shortest ones for readability)
        sorted_by_len = sorted(members, key=lambda f: len(f.question))
        representatives = [f.question[:120] for f in sorted_by_len[:3]]

        # Build label
        suite_counts = Counter(f.suite for f in members)
        top_suite = suite_counts.most_common(1)[0][0] if suite_counts else ""
        label = f"{dominant} ({top_suite})" if top_suite != dominant else dominant

        clusters.append(
            ClusterInfo(
                cluster_id=cid,
                size=len(members),
                dominant_capability=dominant,
                capability_distribution=dict(cap_counts),
                representative_questions=representatives,
                label=label,
            )
        )

    # Handle noise
    noise_members = [f for f, l in zip(failures, labels) if l == -1]
    if noise_members:
        cap_counts = Counter(f.capability for f in noise_members)
        clusters.append(
            ClusterInfo(
                cluster_id=-1,
                size=len(noise_members),
                dominant_capability="mixed",
                capability_distribution=dict(cap_counts),
                representative_questions=[f.question[:120] for f in noise_members[:3]],
                label="noise / unclustered",
            )
        )

    return sorted(clusters, key=lambda c: -c.size)


# ---------------------------------------------------------------------------
# Report generation
# ---------------------------------------------------------------------------

def generate_report(
    clusters: list[ClusterInfo],
    output_path: Path | None = None,
) -> dict:
    report = {
        "num_clusters": len([c for c in clusters if c.cluster_id >= 0]),
        "total_failures": sum(c.size for c in clusters),
        "clusters": [asdict(c) for c in clusters],
    }

    if output_path:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(json.dumps(report, indent=2))
        logger.info("Cluster report written to %s", output_path)

    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command()
@click.option("--failures-path", type=click.Path(exists=True), default=str(DEFAULT_FAILURE_STORE))
@click.option("--embedding-method", type=click.Choice(["auto", "sentence_transformers", "tfidf"]), default="auto")
@click.option("--cluster-method", type=click.Choice(["auto", "hdbscan", "kmeans"]), default="auto")
@click.option("--n-clusters", type=int, default=5, help="Number of clusters (KMeans only)")
@click.option("--min-cluster-size", type=int, default=3, help="Min cluster size (HDBSCAN only)")
@click.option("--output", type=click.Path(), default=None, help="Output report JSON path")
def main(
    failures_path: str,
    embedding_method: str,
    cluster_method: str,
    n_clusters: int,
    min_cluster_size: int,
    output: str | None,
):
    """Cluster captured failures and produce a report."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

    failures = load_failures(Path(failures_path))
    if not failures:
        click.echo("No failures to cluster.")
        return

    click.echo(f"Loaded {len(failures)} failures")

    # Build text for embedding (combine question + expected + actual)
    texts = [f"{f.question} | expected: {f.expected} | actual: {f.actual}" for f in failures]

    click.echo("Computing embeddings ...")
    embeddings = compute_embeddings(texts, method=embedding_method)

    click.echo("Clustering ...")
    labels = run_clustering(
        embeddings,
        method=cluster_method,
        n_clusters=n_clusters,
        min_cluster_size=min_cluster_size,
    )

    clusters = label_clusters(failures, labels)

    click.echo(f"\nFound {len([c for c in clusters if c.cluster_id >= 0])} clusters:")
    for c in clusters:
        click.echo(f"  Cluster {c.cluster_id:3d}: {c.size:4d} failures | {c.label}")
        for q in c.representative_questions:
            click.echo(f"    - {q}")

    out_path = Path(output) if output else Path(failures_path).parent.parent / "clustering" / "cluster_report.json"
    generate_report(clusters, out_path)
    click.echo(f"\nReport saved to {out_path}")


if __name__ == "__main__":
    main()
