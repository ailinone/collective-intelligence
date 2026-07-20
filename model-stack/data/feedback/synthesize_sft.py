# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Synthesize SFT Training Records from Teacher Traces
====================================================

Reads teacher_traces JSONL files (produced by `teacher_proxy.py` in
TEACHER_PROXY mode) and transforms each (request, teacher_decision)
tuple into a chat-format SFT record compatible with the existing
`alignment/sft/train_sft.py` trainer.

Pipeline shape:
    teacher-traces-2026-05-05.jsonl       (raw teacher decisions)
        ↓
    synthesize_sft.py                     (this module)
        ↓
    sft-coord-2026-05-05.jsonl            (training data)
        ↓
    alignment/sft/train_sft_coord.py      (per-coord LoRA training)
        ↓
    24 LoRA adapters (one per coordinator student)

Output format (per record):
    {
        "messages": [
            {"role": "system", "content": "<coordination teacher prompt>"},
            {"role": "user", "content": "<request_context as JSON>"},
            {"role": "assistant", "content": "<decision as JSON>"}
        ],
        "metadata": {
            "trace_id": "...",
            "strategy": "debate",
            "decision_type": "moderator-selection",
            "teacher_confidence": 0.85,
            "teacher_scheduler": "teacher-triage-proxy"
        }
    }

The system prompt mirrors `teacher_proxy._build_triage_payload` so the
student learns to predict the teacher's structured-decision shape.

Filtering:
- Only records with non-fallback teacher decisions are kept (i.e.
  records where the teacher_proxy successfully called triage). Records
  with reason starting "teacher-proxy-error:" are discarded — they
  represent teacher-side failures, not training signal.
- Optional confidence threshold (default 0.5) filters low-confidence
  teacher decisions.

Usage:
    python -m data.feedback.synthesize_sft \\
        --input ./data/feedback/staging \\
        --output ./data/feedback/sft-coord \\
        --min-confidence 0.5
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import click

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Prompt template — MUST match teacher_proxy._build_triage_payload so the
# student sees the same surface the teacher saw.
# ---------------------------------------------------------------------------

COORDINATION_SYSTEM_PROMPT = (
    "You are the coordination teacher. Given the strategy "
    "context below, decide the next role/scheduler decision "
    "and return it as JSON: {role, reason, confidence}. "
    "Reason MUST come from the stable vocabulary in "
    "coord-stable/_shared.yaml."
)


@dataclass
class SynthesisStats:
    """Pipeline counters for observability."""

    files_seen: int = 0
    records_seen: int = 0
    records_kept: int = 0
    records_dropped_fallback: int = 0
    records_dropped_low_confidence: int = 0
    records_dropped_malformed: int = 0
    by_strategy: dict[str, int] = field(default_factory=dict)
    by_decision_type: dict[str, int] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Per-record transform
# ---------------------------------------------------------------------------


def _build_user_content(strategy: str, decision_type: str, request_context: dict[str, Any]) -> str:
    """Build the user-side message that wraps the coordination request.

    Mirrors teacher_proxy._build_triage_payload's user message so the
    student sees the same input surface the teacher saw at training-data
    capture time.
    """
    coordination_brief = {
        "strategy": strategy,
        "decision_type": decision_type,
        "context": request_context,
    }
    return f"Coordination request: {coordination_brief}"


def _build_assistant_content(
    teacher_role: str,
    teacher_reason: str,
    teacher_confidence: float,
) -> str:
    """Build the assistant-side completion as a JSON-encoded decision.

    The student learns to emit this exact shape — a JSON object with
    `role`, `reason`, `confidence`. This matches teacher_proxy's
    `_wrap_as_vote` parsing, so a trained student can be plugged in
    behind the same parser without contract changes.
    """
    return json.dumps(
        {
            "role": teacher_role,
            "reason": teacher_reason,
            "confidence": teacher_confidence,
        },
        ensure_ascii=False,
    )


def transform_trace(
    trace: dict[str, Any],
    min_confidence: float,
    stats: SynthesisStats,
) -> dict[str, Any] | None:
    """Transform one teacher_traces JSONL record into an SFT record.

    Returns None when the record is filtered out (fallback teacher,
    low confidence, or malformed input). Stats are mutated in-place
    so the caller can report drop reasons.
    """
    try:
        strategy = trace["strategy"]
        decision_type = trace["decision_type"]
        request_context = trace.get("request_context") or {}
        teacher_role = trace["teacher_role"]
        teacher_reason = trace["teacher_reason"]
        teacher_confidence = float(trace.get("teacher_confidence", 0.0))
    except (KeyError, TypeError, ValueError):
        stats.records_dropped_malformed += 1
        return None

    # Drop teacher_proxy fallback records — they signal upstream
    # failure, not training signal.
    if isinstance(teacher_reason, str) and teacher_reason.startswith("teacher-proxy-error:"):
        stats.records_dropped_fallback += 1
        return None
    if teacher_role == "fallback-default":
        stats.records_dropped_fallback += 1
        return None

    if teacher_confidence < min_confidence:
        stats.records_dropped_low_confidence += 1
        return None

    user_content = _build_user_content(strategy, decision_type, request_context)
    assistant_content = _build_assistant_content(teacher_role, teacher_reason, teacher_confidence)
    record = {
        "messages": [
            {"role": "system", "content": COORDINATION_SYSTEM_PROMPT},
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": assistant_content},
        ],
        "metadata": {
            "trace_id": trace.get("trace_id", ""),
            "strategy": strategy,
            "decision_type": decision_type,
            "teacher_confidence": teacher_confidence,
            "teacher_scheduler": trace.get("teacher_scheduler", ""),
        },
    }

    stats.records_kept += 1
    stats.by_strategy[strategy] = stats.by_strategy.get(strategy, 0) + 1
    stats.by_decision_type[decision_type] = stats.by_decision_type.get(decision_type, 0) + 1
    return record


# ---------------------------------------------------------------------------
# Pipeline driver
# ---------------------------------------------------------------------------


def iter_jsonl(path: Path) -> Iterator[dict[str, Any]]:
    """Yield one parsed JSON record per non-empty line.

    Skips malformed lines with a warning rather than aborting — teacher
    traces are append-only so a partial line at the tail is possible
    if the writer crashed mid-write.
    """
    with open(path, encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError as exc:
                logger.warning("%s:%d malformed JSON: %s", path, line_no, exc)


def synthesize(
    input_dir: Path,
    output_dir: Path,
    min_confidence: float = 0.5,
    file_glob: str = "teacher-traces-*.jsonl",
) -> SynthesisStats:
    """Read all teacher_traces files in input_dir, write SFT records to output_dir.

    Returns counters for observability. Output filenames mirror inputs
    with the prefix swapped: `teacher-traces-DATE.jsonl` →
    `sft-coord-DATE.jsonl`.
    """
    stats = SynthesisStats()
    output_dir.mkdir(parents=True, exist_ok=True)

    inputs = sorted(input_dir.glob(file_glob))
    if not inputs:
        logger.warning("No teacher_traces files matched %s in %s", file_glob, input_dir)
        return stats

    for input_path in inputs:
        stats.files_seen += 1
        output_path = output_dir / input_path.name.replace("teacher-traces-", "sft-coord-")
        kept_in_file = 0

        with open(output_path, "w", encoding="utf-8") as out:
            for trace in iter_jsonl(input_path):
                stats.records_seen += 1
                record = transform_trace(trace, min_confidence, stats)
                if record is not None:
                    out.write(json.dumps(record, ensure_ascii=False))
                    out.write("\n")
                    kept_in_file += 1

        logger.info("%s → %s (%d records kept)", input_path.name, output_path.name, kept_in_file)

    logger.info(
        "Synthesis complete: %d files, %d in / %d kept, "
        "dropped: %d fallback, %d low-conf, %d malformed",
        stats.files_seen,
        stats.records_seen,
        stats.records_kept,
        stats.records_dropped_fallback,
        stats.records_dropped_low_confidence,
        stats.records_dropped_malformed,
    )
    return stats


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


@click.command()
@click.option(
    "--input",
    "input_dir",
    type=click.Path(exists=True, file_okay=False, path_type=Path),
    required=True,
    help="Directory containing teacher-traces-*.jsonl files (F3.3 staging)",
)
@click.option(
    "--output",
    "output_dir",
    type=click.Path(file_okay=False, path_type=Path),
    required=True,
    help="Directory to write sft-coord-*.jsonl files",
)
@click.option(
    "--min-confidence",
    type=float,
    default=0.5,
    show_default=True,
    help="Drop teacher decisions with confidence below this threshold",
)
@click.option(
    "--file-glob",
    type=str,
    default="teacher-traces-*.jsonl",
    show_default=True,
    help="Filename glob for input files",
)
def cli(input_dir: Path, output_dir: Path, min_confidence: float, file_glob: str) -> None:
    """Synthesize SFT records from teacher_traces JSONL files."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
    synthesize(input_dir, output_dir, min_confidence=min_confidence, file_glob=file_glob)


if __name__ == "__main__":
    cli()
