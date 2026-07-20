# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Tests for teacher_traces retention sweep."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path


def _touch_trace(staging_dir: Path, name: str, age_days: float) -> Path:
    """Create a trace file and backdate its mtime by `age_days`."""
    path = staging_dir / name
    path.write_text("dummy", encoding="utf-8")
    cutoff = datetime.now(timezone.utc).timestamp() - (age_days * 86400)
    os.utime(path, (cutoff, cutoff))
    return path


class TestPruneOldTraces:
    def test_removes_files_older_than_threshold(self, tmp_path: Path):
        from data.feedback.teacher_traces import prune_old_traces

        old1 = _touch_trace(tmp_path, "teacher-traces-2026-01-01.jsonl", age_days=60)
        old2 = _touch_trace(tmp_path, "teacher-traces-2026-02-01.jsonl", age_days=45)
        recent = _touch_trace(tmp_path, "teacher-traces-2026-05-01.jsonl", age_days=5)

        removed = prune_old_traces(tmp_path, max_age_days=30)

        assert sorted(p.name for p in removed) == [
            "teacher-traces-2026-01-01.jsonl",
            "teacher-traces-2026-02-01.jsonl",
        ]
        assert not old1.exists()
        assert not old2.exists()
        assert recent.exists()

    def test_keeps_files_at_exactly_threshold(self, tmp_path: Path):
        from data.feedback.teacher_traces import prune_old_traces

        # Right at threshold should NOT be pruned (cutoff is strict <)
        # Use 29.5 days so we stay within the 30-day boundary even with
        # microsecond drift between mtime calculation and now().
        recent = _touch_trace(tmp_path, "teacher-traces-2026-04-01.jsonl", age_days=29.5)

        removed = prune_old_traces(tmp_path, max_age_days=30)

        assert removed == []
        assert recent.exists()

    def test_only_matches_default_glob(self, tmp_path: Path):
        from data.feedback.teacher_traces import prune_old_traces

        # File matching the glob should be pruned
        target = _touch_trace(tmp_path, "teacher-traces-2026-01-01.jsonl", age_days=60)
        # File NOT matching (different prefix) should be untouched even
        # if old — operators may keep other JSONL data in the same dir.
        unrelated = _touch_trace(tmp_path, "outcomes-2026-01-01.jsonl", age_days=60)

        prune_old_traces(tmp_path, max_age_days=30)

        assert not target.exists()
        assert unrelated.exists()

    def test_missing_dir_is_noop(self, tmp_path: Path):
        from data.feedback.teacher_traces import prune_old_traces

        missing = tmp_path / "does-not-exist"
        removed = prune_old_traces(missing, max_age_days=30)
        assert removed == []

    def test_custom_pattern(self, tmp_path: Path):
        from data.feedback.teacher_traces import prune_old_traces

        target = _touch_trace(tmp_path, "custom-prefix-2026-01-01.jsonl", age_days=60)
        ignored = _touch_trace(tmp_path, "teacher-traces-2026-01-01.jsonl", age_days=60)

        prune_old_traces(tmp_path, max_age_days=30, file_pattern="custom-prefix-*.jsonl")

        assert not target.exists()
        assert ignored.exists()


class TestRetentionDaysFromEnv:
    def test_default_when_unset(self, monkeypatch):
        from data.feedback.teacher_traces import retention_days_from_env

        monkeypatch.delenv("COORD_TEACHER_TRACES_RETENTION_DAYS", raising=False)
        assert retention_days_from_env() == 30

    def test_custom_default(self, monkeypatch):
        from data.feedback.teacher_traces import retention_days_from_env

        monkeypatch.delenv("COORD_TEACHER_TRACES_RETENTION_DAYS", raising=False)
        assert retention_days_from_env(default=7) == 7

    def test_reads_valid_int(self, monkeypatch):
        from data.feedback.teacher_traces import retention_days_from_env

        monkeypatch.setenv("COORD_TEACHER_TRACES_RETENTION_DAYS", "60")
        assert retention_days_from_env() == 60

    def test_falls_back_on_negative(self, monkeypatch):
        from data.feedback.teacher_traces import retention_days_from_env

        monkeypatch.setenv("COORD_TEACHER_TRACES_RETENTION_DAYS", "-1")
        assert retention_days_from_env(default=30) == 30

    def test_falls_back_on_non_int(self, monkeypatch):
        from data.feedback.teacher_traces import retention_days_from_env

        monkeypatch.setenv("COORD_TEACHER_TRACES_RETENTION_DAYS", "thirty")
        assert retention_days_from_env(default=30) == 30

    def test_falls_back_on_empty_string(self, monkeypatch):
        from data.feedback.teacher_traces import retention_days_from_env

        monkeypatch.setenv("COORD_TEACHER_TRACES_RETENTION_DAYS", "  ")
        assert retention_days_from_env(default=30) == 30
