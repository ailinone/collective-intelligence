# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Teacher Traces — append (request, teacher_decision) tuples to F3.3 SFT staging.

Each call to coord_serving in TEACHER_PROXY mode produces a tuple that
becomes immediate SFT training data for the eventual 24 student models.
This module owns the on-disk format + watermark file + retention sweep.

Format: JSONL with one record per line. Each record has the canonical
shape:

  {
    "trace_id": "uuid",
    "timestamp_iso": "2026-05-05T...",
    "strategy": "debate",
    "decision_type": "moderator-selection",
    "request_context": { ... },              // input — strategy-specific
    "teacher_role": "moderator",             // output — the label
    "teacher_reason": "task-type-match",
    "teacher_scheduler": "teacher-triage-proxy",
    "teacher_confidence": 0.85,
    "teacher_aggregation_method": "teacher_proxy_passthrough",
    "teacher_full_decision": { ... }         // verbatim AggregatedDecision
  }

The output dir mirrors the F3.3 staging contract (data/feedback/staging/)
so the existing transform/load pipeline picks these up alongside the
real-traffic outcomes when the SFT job runs.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from collections.abc import Mapping
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from serving.aggregation.tiered_voter import AggregatedDecision

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DEFAULT_STAGING_DIR = Path(
    os.environ.get(
        "COORD_TEACHER_TRACES_DIR",
        "/tmp/coord-stable/teacher-traces",  # overridden in container/prod
    )
)

# Rotate trace files daily so the SFT job can pick up by date.
DEFAULT_FILE_PATTERN = "teacher-traces-{date}.jsonl"


# ---------------------------------------------------------------------------
# TraceWriter — thread-safe append-only JSONL writer
# ---------------------------------------------------------------------------


class TeacherTraceWriter:
    """Append-only JSONL writer for teacher-proxy decisions.

    Thread-safe: a process-wide lock guards file open + write so multiple
    concurrent FastAPI requests don't interleave bytes within a line.
    The lock is per-instance, so callers should share one writer.
    """

    def __init__(
        self,
        staging_dir: Path | None = None,
        file_pattern: str = DEFAULT_FILE_PATTERN,
    ) -> None:
        self.staging_dir = staging_dir or DEFAULT_STAGING_DIR
        self.file_pattern = file_pattern
        self._lock = threading.Lock()
        self._ensure_staging_dir()

    def _ensure_staging_dir(self) -> None:
        try:
            self.staging_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            logger.error("Cannot create staging dir %s: %s", self.staging_dir, exc)
            raise

    def _current_file(self) -> Path:
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        return self.staging_dir / self.file_pattern.format(date=date_str)

    def append(
        self,
        strategy: str,
        decision_type: str,
        request_context: Mapping[str, Any],
        decision: AggregatedDecision,
    ) -> str:
        """Append one trace record. Returns the trace_id."""
        trace_id = uuid.uuid4().hex
        record = self._build_record(
            trace_id=trace_id,
            strategy=strategy,
            decision_type=decision_type,
            request_context=request_context,
            decision=decision,
        )

        target_file = self._current_file()
        line = json.dumps(record, ensure_ascii=False, default=_json_default)

        with self._lock:
            try:
                with open(target_file, "a", encoding="utf-8") as f:
                    f.write(line)
                    f.write("\n")
            except OSError as exc:
                # Trace logging must NEVER kill the request path. Log
                # and swallow — the (request, decision) is lost but
                # the upstream caller still gets its response.
                logger.warning(
                    "Failed to write teacher trace to %s: %s",
                    target_file,
                    exc,
                )
        return trace_id

    @staticmethod
    def _build_record(
        trace_id: str,
        strategy: str,
        decision_type: str,
        request_context: Mapping[str, Any],
        decision: AggregatedDecision,
    ) -> dict[str, Any]:
        """Construct the canonical JSONL record shape."""
        return {
            "trace_id": trace_id,
            "timestamp_iso": datetime.now(timezone.utc).isoformat(),
            "strategy": strategy,
            "decision_type": decision_type,
            "request_context": dict(request_context),
            "teacher_role": decision.role,
            "teacher_reason": decision.reason,
            "teacher_scheduler": decision.scheduler,
            "teacher_confidence": decision.confidence,
            "teacher_aggregation_method": decision.aggregation_method,
            "teacher_full_decision": _decision_as_dict(decision),
        }


# ---------------------------------------------------------------------------
# Retention sweep — prune files older than the configured age
# ---------------------------------------------------------------------------


def prune_old_traces(
    staging_dir: Path,
    *,
    max_age_days: int = 30,
    file_pattern: str = "teacher-traces-*.jsonl",
    now: datetime | None = None,
) -> list[Path]:
    """Delete trace files whose mtime is older than `max_age_days`.

    Returns the list of paths that were removed. Errors during deletion
    are logged at warn level and the file is skipped — retention is
    best-effort, not transactional.

    Why mtime instead of parsing the date out of the filename: simpler,
    robust to filename-format drift (synthesize_sft already glob-matches
    `teacher-traces-*.jsonl`; any future rename keeps working without
    coordinated changes here).

    Default 30 days is conservative — a typical SFT job re-trains weekly,
    so 30d gives operators 4 weeks of data including the most recent
    cycle. For prod with high volume, 7d is reasonable; for low-volume
    dev, 90d keeps everything for a quarter. Configurable via the
    COORD_TEACHER_TRACES_RETENTION_DAYS env var.
    """
    now = now or datetime.now(timezone.utc)
    cutoff = now.timestamp() - (max_age_days * 86400)
    removed: list[Path] = []

    if not staging_dir.exists():
        return removed

    for path in staging_dir.glob(file_pattern):
        try:
            mtime = path.stat().st_mtime
            if mtime < cutoff:
                path.unlink()
                removed.append(path)
                logger.info(
                    "Pruned old trace file %s (mtime %s, cutoff %d days)",
                    path.name,
                    datetime.fromtimestamp(mtime, tz=timezone.utc).isoformat(),
                    max_age_days,
                )
        except OSError as exc:
            logger.warning("Failed to prune %s: %s", path, exc)

    return removed


def retention_days_from_env(default: int = 30) -> int:
    """Read COORD_TEACHER_TRACES_RETENTION_DAYS, falling back to default."""
    raw = os.environ.get("COORD_TEACHER_TRACES_RETENTION_DAYS", "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
        if value <= 0:
            logger.warning(
                "COORD_TEACHER_TRACES_RETENTION_DAYS=%r ignored (must be positive)",
                raw,
            )
            return default
        return value
    except ValueError:
        logger.warning("COORD_TEACHER_TRACES_RETENTION_DAYS=%r not an int; using %d", raw, default)
        return default


# ---------------------------------------------------------------------------
# Singleton accessor — coord_serving uses one writer per process
# ---------------------------------------------------------------------------

_writer_singleton: TeacherTraceWriter | None = None
_singleton_lock = threading.Lock()


def get_default_writer() -> TeacherTraceWriter:
    """Return the process-wide TeacherTraceWriter, creating it lazily.

    Callers in tests should construct their own writer with a temp dir
    rather than relying on the singleton.
    """
    global _writer_singleton
    if _writer_singleton is not None:
        return _writer_singleton
    with _singleton_lock:
        if _writer_singleton is None:
            _writer_singleton = TeacherTraceWriter()
        return _writer_singleton


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _decision_as_dict(decision: AggregatedDecision) -> dict[str, Any]:
    """Convert an AggregatedDecision dataclass tree to a JSON-safe dict.

    `asdict()` doesn't know how to handle Enum values (Tier) or tuples
    nested inside dataclasses, so we walk the structure manually for
    the parts that need it.
    """
    return {
        "role": decision.role,
        "reason": decision.reason,
        "scheduler": decision.scheduler,
        "confidence": decision.confidence,
        "aggregation_method": decision.aggregation_method,
        "tier_results": [
            {
                "tier": int(tr.tier),
                "votes": [
                    {
                        "model_id": v.model_id,
                        "scheduler": v.scheduler,
                        "tier": int(v.tier),
                        "role": v.role,
                        "reason": v.reason,
                        "confidence": v.confidence,
                        "rationale": v.rationale,
                        "features": dict(v.features),
                    }
                    for v in tr.votes
                ],
                "failed_models": list(tr.failed_models),
            }
            for tr in decision.tier_results
        ],
        "vote_distribution": dict(decision.vote_distribution),
        "total_votes": decision.total_votes,
        "dissent_count": decision.dissent_count,
        "tiers_activated": [int(t) for t in decision.tiers_activated],
        "final_tier": int(decision.final_tier) if decision.final_tier is not None else None,
        "short_circuited": decision.short_circuited,
    }


def _json_default(obj: Any) -> Any:
    """Last-resort JSON serializer for unexpected types."""
    if hasattr(obj, "value"):
        return obj.value
    if hasattr(obj, "__dict__"):
        return obj.__dict__
    return str(obj)
