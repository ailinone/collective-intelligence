#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Failure capture system.

Reads evaluation results, extracts failed examples, categorizes them
by capability (reasoning, coding, safety, factuality, etc.), and stores
them in a structured JSON format for downstream replay / clustering.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import click

logger = logging.getLogger("failure_capture")

DEFAULT_FAILURE_STORE = Path(__file__).resolve().parent / "captured_failures.json"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

@dataclass
class CapturedFailure:
    failure_id: str
    suite: str
    capability: str
    question: str = ""
    expected: str = ""
    actual: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)
    captured_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    model_name: str = ""
    model_version: str = ""
    tags: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Capability mapping
# ---------------------------------------------------------------------------

SUITE_TO_CAPABILITY: dict[str, str] = {
    "gsm8k": "reasoning",
    "humaneval": "coding",
    "tool_calling": "tool_use",
    "safety": "safety",
    "needle_haystack": "long_context",
    "throughput": "performance",
    "factuality": "factuality",
    "adversarial": "robustness",
}


def infer_capability(suite: str, detail: dict) -> str:
    """Map a suite name and detail record to a capability category."""
    if suite in SUITE_TO_CAPABILITY:
        return SUITE_TO_CAPABILITY[suite]
    # Fallback: check detail keys
    if "difficulty" in detail:
        return "reasoning"
    if "task_id" in detail:
        return "coding"
    if "attack_type" in detail:
        return "robustness"
    return "unknown"


# ---------------------------------------------------------------------------
# Extraction from eval reports
# ---------------------------------------------------------------------------

def extract_failures_from_report(report: dict) -> list[CapturedFailure]:
    """Parse an eval runner report and extract failed examples."""
    failures: list[CapturedFailure] = []
    model_name = report.get("model_name", "")
    model_version = report.get("model_version", "")
    idx = 0

    for suite_result in report.get("suites", []):
        suite = suite_result.get("suite", "")
        details = suite_result.get("details", [])

        # details can be a list of dicts or a dict with sub-keys
        if isinstance(details, dict):
            # e.g. needle_haystack returns {"results": [...], "heatmap": [...]}
            details = details.get("results", [])

        if not isinstance(details, list):
            continue

        for detail in details:
            # Check if this is a failure
            is_failure = False
            if "correct" in detail and not detail["correct"]:
                is_failure = True
            elif "passed" in detail:
                passed = detail["passed"]
                if isinstance(passed, bool) and not passed:
                    is_failure = True
                elif isinstance(passed, list) and not all(passed):
                    is_failure = True
            elif "resisted" in detail and not detail.get("resisted", True):
                is_failure = True

            if not is_failure:
                continue

            idx += 1
            capability = infer_capability(suite, detail)

            failure = CapturedFailure(
                failure_id=f"{suite}-{idx:04d}",
                suite=suite,
                capability=capability,
                question=detail.get("question", detail.get("prompt", detail.get("prompt_preview", "")))[:500],
                expected=str(detail.get("gold", detail.get("expected", "")))[:300],
                actual=str(detail.get("predicted", detail.get("model_answer", "")))[:300],
                metadata={k: v for k, v in detail.items() if k not in ("question", "prompt", "gold", "expected", "predicted")},
                model_name=model_name,
                model_version=model_version,
            )
            failures.append(failure)

    return failures


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

class FailureStore:
    """JSON-backed store for captured failures."""

    def __init__(self, path: Path = DEFAULT_FAILURE_STORE) -> None:
        self.path = path
        self._failures: list[CapturedFailure] = []
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            self._failures = []
            return
        data = json.loads(self.path.read_text())
        self._failures = [CapturedFailure(**f) for f in data.get("failures", [])]

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"failures": [asdict(f) for f in self._failures]}
        self.path.write_text(json.dumps(payload, indent=2))

    def add(self, failures: list[CapturedFailure]) -> int:
        existing_ids = {f.failure_id for f in self._failures}
        added = 0
        for f in failures:
            if f.failure_id not in existing_ids:
                self._failures.append(f)
                existing_ids.add(f.failure_id)
                added += 1
        self._save()
        return added

    def list_failures(
        self,
        capability: str | None = None,
        suite: str | None = None,
        model_version: str | None = None,
    ) -> list[CapturedFailure]:
        results = self._failures
        if capability:
            results = [f for f in results if f.capability == capability]
        if suite:
            results = [f for f in results if f.suite == suite]
        if model_version:
            results = [f for f in results if f.model_version == model_version]
        return results

    def summary(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for f in self._failures:
            counts[f.capability] = counts.get(f.capability, 0) + 1
        return counts

    def clear(self) -> int:
        count = len(self._failures)
        self._failures = []
        self._save()
        return count


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.group()
def cli():
    """Failure capture system."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")


@cli.command()
@click.option("--report", required=True, type=click.Path(exists=True), help="Eval report JSON")
@click.option("--store", type=click.Path(), default=str(DEFAULT_FAILURE_STORE))
def capture(report, store):
    """Extract failures from an eval report and store them."""
    data = json.loads(Path(report).read_text())
    failures = extract_failures_from_report(data)

    fs = FailureStore(Path(store))
    added = fs.add(failures)
    click.echo(f"Captured {len(failures)} failures, {added} new (store has {len(fs._failures)} total)")


@cli.command("list")
@click.option("--capability", default=None)
@click.option("--suite", default=None)
@click.option("--store", type=click.Path(), default=str(DEFAULT_FAILURE_STORE))
def list_cmd(capability, suite, store):
    """List captured failures."""
    fs = FailureStore(Path(store))
    failures = fs.list_failures(capability=capability, suite=suite)
    if not failures:
        click.echo("No failures found.")
        return
    for f in failures[:50]:
        click.echo(f"  [{f.capability:12s}] {f.suite:15s} {f.failure_id} | {f.question[:60]}")
    if len(failures) > 50:
        click.echo(f"  ... and {len(failures) - 50} more")


@cli.command()
@click.option("--store", type=click.Path(), default=str(DEFAULT_FAILURE_STORE))
def summary(store):
    """Show failure counts by capability."""
    fs = FailureStore(Path(store))
    counts = fs.summary()
    if not counts:
        click.echo("No failures captured.")
        return
    total = sum(counts.values())
    for cap, cnt in sorted(counts.items(), key=lambda x: -x[1]):
        click.echo(f"  {cap:20s} {cnt:5d}  ({cnt/total*100:.1f}%)")
    click.echo(f"  {'TOTAL':20s} {total:5d}")


if __name__ == "__main__":
    cli()
