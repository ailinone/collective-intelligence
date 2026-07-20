# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Offline evaluation tool for coordinator decisions.
====================================================

Consumes sft-coord JSONL (teacher decisions captured by `teacher_proxy.py`
+ shaped by `synthesize_sft.py`) and measures how well an arbitrary
"decider" reproduces the teacher's decisions. The decider can be:

  - **in-process** : the mock cascade aggregator (no server needed)
  - **HTTP**       : a running coord_serving (any mode)
  - any callable   : trained student inference, sklearn baseline, etc.

This is the "did training work?" gate for the champion-challenger
flywheel — when Phase 2c.2 trains the 24 students, we run this against
held-out sft-coord records and decide promote vs rollback based on
role_accuracy + brier_score deltas vs the current champion.

Metrics computed:
  - **role_accuracy**       : fraction of requests where decider's role
                              matches teacher's role (the primary signal)
  - **reason_match_rate**   : fraction with matching reason token
  - **brier_score**         : calibration of decider's confidence — lower is
                              better; sum((conf - correct)²) / N
  - **per-strategy breakdown** : same metrics sliced by strategy
  - **role_confusion**      : predicted_role × teacher_role counts
  - **divergence_samples**  : first N disagreements with full request
                              context, for human inspection

Usage:
  # In-process against mock_cascade (no server needed)
  python -m evals.evaluate_coord_decisions \\
      --input ./data/feedback/sft-coord \\
      --mode mock_cascade \\
      --output ./eval-results/mock_cascade.json

  # Against a running coord_serving HTTP endpoint
  python -m evals.evaluate_coord_decisions \\
      --input ./data/feedback/sft-coord \\
      --mode http --endpoint http://127.0.0.1:8090 \\
      --output ./eval-results/teacher_proxy.json
"""

from __future__ import annotations

import asyncio
import json
import logging
import sys
from collections import Counter, defaultdict
from collections.abc import Awaitable, Callable, Iterable, Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import click

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Record shapes
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TeacherTruth:
    """Ground truth extracted from one sft-coord JSONL record."""

    strategy: str
    decision_type: str
    context: Mapping[str, Any]
    teacher_role: str
    teacher_reason: str
    teacher_confidence: float
    trace_id: str


@dataclass(frozen=True)
class DeciderOutput:
    """What the evaluator needs from the system being tested."""

    role: str
    reason: str
    confidence: float


@dataclass(frozen=True)
class ComparedRecord:
    """One (truth, prediction, comparison) triple."""

    truth: TeacherTruth
    prediction: DeciderOutput
    role_match: bool
    reason_match: bool

    @property
    def brier_term(self) -> float:
        """Brier score contribution: (conf - correctness)²."""
        correct = 1.0 if self.role_match else 0.0
        return (self.prediction.confidence - correct) ** 2


# ---------------------------------------------------------------------------
# Reading sft-coord JSONL — shape mirrors synthesize_sft.py output
# ---------------------------------------------------------------------------


def parse_sft_record(record: Mapping[str, Any]) -> TeacherTruth | None:
    """Convert one sft-coord JSONL record into a TeacherTruth.

    Returns None when the record is malformed (logs a warning). The
    expected shape is:
      {
        "messages": [
            {"role": "system", "content": "..."},
            {"role": "user", "content": "Coordination request: {strategy, decision_type, ...}"},
            {"role": "assistant", "content": "{role, reason, confidence}"}
        ],
        "metadata": {"trace_id": ..., "strategy": ..., "decision_type": ...,
                     "teacher_confidence": ..., "teacher_scheduler": ...}
      }
    """
    try:
        metadata = record["metadata"]
        messages = record["messages"]
        assistant_msg = next(m for m in messages if m.get("role") == "assistant")
        decision = json.loads(assistant_msg["content"])

        return TeacherTruth(
            strategy=str(metadata["strategy"]),
            decision_type=str(metadata["decision_type"]),
            context=_extract_context(messages),
            teacher_role=str(decision["role"]),
            teacher_reason=str(decision["reason"]),
            teacher_confidence=float(
                decision.get("confidence", metadata.get("teacher_confidence", 0.0))
            ),
            trace_id=str(metadata.get("trace_id", "")),
        )
    except (KeyError, ValueError, TypeError, StopIteration, json.JSONDecodeError) as exc:
        logger.debug("malformed sft-coord record: %s", exc)
        return None


def _extract_context(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """Recover the request_context dict from the user message.

    The user message uses the format
    `Coordination request: {strategy, decision_type, context}` produced
    by `synthesize_sft._build_user_content`. The whole thing is a Python
    repr (not JSON) because that's what teacher_proxy emits, so we
    extract the context dict best-effort using a literal-eval fallback.
    """
    user_msg = next(m for m in messages if m.get("role") == "user")
    content = user_msg.get("content", "")
    # The format is "Coordination request: {...}" — take everything after
    # the colon and parse with literal_eval.
    marker = "Coordination request: "
    idx = content.find(marker)
    if idx < 0:
        return {}
    payload = content[idx + len(marker) :].strip()
    try:
        import ast

        parsed = ast.literal_eval(payload)
        if isinstance(parsed, dict):
            ctx = parsed.get("context")
            return ctx if isinstance(ctx, dict) else {}
    except (ValueError, SyntaxError):
        return {}
    return {}


def iter_sft_records(
    input_dir: Path, file_glob: str = "sft-coord-*.jsonl"
) -> Iterator[TeacherTruth]:
    """Yield TeacherTruth instances from every sft-coord file in input_dir.

    Malformed lines and malformed records are skipped with debug logs.
    """
    for path in sorted(input_dir.glob(file_glob)):
        with open(path, encoding="utf-8") as f:
            for line_no, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    logger.debug("%s:%d malformed JSON", path, line_no)
                    continue
                truth = parse_sft_record(record)
                if truth is not None:
                    yield truth


# ---------------------------------------------------------------------------
# Decider — the system under test
# ---------------------------------------------------------------------------

# A decider is an async callable: TeacherTruth → DeciderOutput. We use
# async because both in-process (mock_cascade) and HTTP (httpx) paths
# benefit from awaitable dispatch — the eval loop runs them serially
# but the contract is async to keep both adapters simple.
Decider = Callable[[TeacherTruth], Awaitable[DeciderOutput]]


def make_inprocess_decider() -> Decider:
    """Return a decider that calls mock_cascade in-process.

    No server needed. The mock cascade exercises the full real cascade
    aggregator with synthetic tier executors, so the eval signal is
    "how well does the cascade aggregator reproduce the teacher" — a
    useful baseline before any students are trained.
    """
    from serving.aggregation.mock_cascade import mock_cascade_decide

    async def decider(truth: TeacherTruth) -> DeciderOutput:
        decision = await mock_cascade_decide(
            strategy=truth.strategy,
            decision_type=truth.decision_type,
            context=truth.context,
        )
        return DeciderOutput(
            role=decision.role,
            reason=decision.reason,
            confidence=decision.confidence,
        )

    return decider


def make_http_decider(endpoint: str, *, timeout_seconds: float = 5.0) -> Decider:
    """Return a decider that POSTs to a coord_serving endpoint.

    The endpoint URL is the BASE — we append /v1/ensemble/decide.
    Each call is a fresh async client; for high-volume eval consider
    swapping in a pooled client.
    """
    import httpx

    decide_url = endpoint.rstrip("/") + "/v1/ensemble/decide"

    async def decider(truth: TeacherTruth) -> DeciderOutput:
        async with httpx.AsyncClient(timeout=timeout_seconds) as client:
            response = await client.post(
                decide_url,
                json={
                    "strategy": truth.strategy,
                    "decisionType": truth.decision_type,
                    "context": dict(truth.context),
                },
                headers={"content-type": "application/json"},
            )
            response.raise_for_status()
            body = response.json()
            decision = body["decision"]
            return DeciderOutput(
                role=str(decision["role"]),
                reason=str(decision["reason"]),
                confidence=float(decision["confidence"]),
            )

    return decider


# ---------------------------------------------------------------------------
# Evaluator
# ---------------------------------------------------------------------------


@dataclass
class EvaluationReport:
    """All the metrics + sample divergences a single eval run produces."""

    total_records: int = 0
    role_matches: int = 0
    reason_matches: int = 0
    brier_score_sum: float = 0.0
    per_strategy: dict[str, dict[str, float]] = field(default_factory=dict)
    role_confusion: dict[str, dict[str, int]] = field(default_factory=dict)
    divergence_samples: list[dict[str, Any]] = field(default_factory=list)
    decider_label: str = ""

    @property
    def role_accuracy(self) -> float:
        return self.role_matches / self.total_records if self.total_records else 0.0

    @property
    def reason_match_rate(self) -> float:
        return self.reason_matches / self.total_records if self.total_records else 0.0

    @property
    def brier_score(self) -> float:
        return self.brier_score_sum / self.total_records if self.total_records else 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "decider_label": self.decider_label,
            "total_records": self.total_records,
            "role_accuracy": self.role_accuracy,
            "reason_match_rate": self.reason_match_rate,
            "brier_score": self.brier_score,
            "role_matches": self.role_matches,
            "reason_matches": self.reason_matches,
            "per_strategy": self.per_strategy,
            "role_confusion": self.role_confusion,
            "divergence_samples": self.divergence_samples,
        }


async def evaluate(
    truths: Iterable[TeacherTruth],
    decider: Decider,
    *,
    decider_label: str = "decider",
    max_divergence_samples: int = 25,
    progress_callback: Callable[[int], None] | None = None,
) -> EvaluationReport:
    """Run the decider against every truth and compute the report.

    Async to keep the decider contract simple, but processes serially.
    For parallel HTTP eval, batch this through asyncio.gather externally
    (the report is not thread-safe).
    """
    report = EvaluationReport(decider_label=decider_label)
    per_strategy_stats: dict[str, dict[str, float]] = defaultdict(
        lambda: {
            "total": 0,
            "role_matches": 0,
            "brier_sum": 0.0,
        }
    )
    confusion: dict[str, Counter[str]] = defaultdict(Counter)

    for idx, truth in enumerate(truths):
        prediction = await decider(truth)
        role_match = prediction.role == truth.teacher_role
        reason_match = prediction.reason == truth.teacher_reason
        compared = ComparedRecord(
            truth=truth,
            prediction=prediction,
            role_match=role_match,
            reason_match=reason_match,
        )

        report.total_records += 1
        if role_match:
            report.role_matches += 1
        if reason_match:
            report.reason_matches += 1
        report.brier_score_sum += compared.brier_term

        # Per-strategy stats
        key = f"{truth.strategy}/{truth.decision_type}"
        per_strategy_stats[key]["total"] += 1
        if role_match:
            per_strategy_stats[key]["role_matches"] += 1
        per_strategy_stats[key]["brier_sum"] += compared.brier_term

        # Confusion matrix (predicted_role → counter of teacher_roles)
        confusion[prediction.role][truth.teacher_role] += 1

        # Sample divergences for inspection
        if not role_match and len(report.divergence_samples) < max_divergence_samples:
            report.divergence_samples.append(
                {
                    "trace_id": truth.trace_id,
                    "strategy": truth.strategy,
                    "decision_type": truth.decision_type,
                    "teacher_role": truth.teacher_role,
                    "predicted_role": prediction.role,
                    "teacher_reason": truth.teacher_reason,
                    "predicted_reason": prediction.reason,
                    "predicted_confidence": prediction.confidence,
                    "context": dict(truth.context),
                }
            )

        if progress_callback and (idx + 1) % 100 == 0:
            progress_callback(idx + 1)

    # Roll up per-strategy stats into the report
    report.per_strategy = {
        key: {
            "total": int(stats["total"]),
            "role_accuracy": stats["role_matches"] / stats["total"] if stats["total"] else 0.0,
            "brier_score": stats["brier_sum"] / stats["total"] if stats["total"] else 0.0,
        }
        for key, stats in per_strategy_stats.items()
    }
    report.role_confusion = {pred: dict(counter) for pred, counter in confusion.items()}
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@click.command()
@click.option(
    "--input",
    "input_dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    required=True,
    help="Directory containing sft-coord-*.jsonl files",
)
@click.option(
    "--output",
    "output_path",
    type=click.Path(dir_okay=False, path_type=Path),
    required=True,
    help="Where to write the JSON report",
)
@click.option(
    "--mode",
    type=click.Choice(["mock_cascade", "http"]),
    default="mock_cascade",
    help="Decider mode (default: mock_cascade in-process)",
)
@click.option(
    "--endpoint",
    type=str,
    default=None,
    help="coord_serving base URL (required when --mode=http)",
)
@click.option(
    "--max-divergence-samples",
    type=int,
    default=25,
    help="Cap on the number of divergence samples in the report",
)
def cli(
    input_dir: Path,
    output_path: Path,
    mode: str,
    endpoint: str | None,
    max_divergence_samples: int,
) -> None:
    """Evaluate a coordinator decider against teacher-truth sft-coord records."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    if mode == "http":
        if not endpoint:
            raise click.UsageError("--endpoint is required when --mode=http")
        decider = make_http_decider(endpoint)
        decider_label = f"http:{endpoint}"
    else:
        decider = make_inprocess_decider()
        decider_label = "in-process:mock_cascade"

    truths = list(iter_sft_records(input_dir))
    if not truths:
        click.echo(f"No sft-coord records found in {input_dir} — nothing to evaluate.")
        sys.exit(1)

    click.echo(f"Evaluating {len(truths)} records via {decider_label} ...")
    report = asyncio.run(
        evaluate(
            truths,
            decider,
            decider_label=decider_label,
            max_divergence_samples=max_divergence_samples,
            progress_callback=lambda n: click.echo(f"  {n} records processed"),
        )
    )

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(report.to_dict(), indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    click.echo(f"Wrote report to {output_path}")
    click.echo(f"  total_records:     {report.total_records}")
    click.echo(f"  role_accuracy:     {report.role_accuracy:.3f}")
    click.echo(f"  reason_match_rate: {report.reason_match_rate:.3f}")
    click.echo(f"  brier_score:       {report.brier_score:.4f}  (lower=better)")


if __name__ == "__main__":
    cli()
