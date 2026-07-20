# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Tests for synthesize_sft.py — teacher_traces → SFT pipeline.

Covers:
- happy-path transform of well-formed teacher traces
- filter rules (fallback teacher, low-confidence, malformed)
- file-level driver (read JSONL, write SFT JSONL, daily rotation mirror)
- CLI smoke via click's CliRunner
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def well_formed_trace():
    return {
        "trace_id": "abc123",
        "timestamp_iso": "2026-05-05T12:00:00+00:00",
        "strategy": "debate",
        "decision_type": "moderator-selection",
        "request_context": {
            "requestId": "req-1",
            "participantCount": 3,
            "taskType": "reasoning",
        },
        "teacher_role": "moderator",
        "teacher_reason": "task-type-match",
        "teacher_scheduler": "teacher-triage-proxy",
        "teacher_confidence": 0.85,
        "teacher_aggregation_method": "teacher_proxy_passthrough",
    }


@pytest.fixture
def fallback_trace():
    return {
        "trace_id": "fall1",
        "timestamp_iso": "2026-05-05T12:00:00+00:00",
        "strategy": "debate",
        "decision_type": "moderator-selection",
        "request_context": {"requestId": "req-2"},
        "teacher_role": "fallback-default",
        "teacher_reason": "teacher-proxy-error:TimeoutException",
        "teacher_scheduler": "teacher-triage-proxy",
        "teacher_confidence": 0.0,
        "teacher_aggregation_method": "teacher_proxy_fallback",
    }


# ---------------------------------------------------------------------------
# transform_trace
# ---------------------------------------------------------------------------


class TestTransformTrace:
    def test_well_formed_trace_yields_messages_record(self, well_formed_trace):
        from data.feedback.synthesize_sft import SynthesisStats, transform_trace

        stats = SynthesisStats()
        record = transform_trace(well_formed_trace, min_confidence=0.5, stats=stats)

        assert record is not None
        assert "messages" in record
        msgs = record["messages"]
        assert len(msgs) == 3
        assert msgs[0]["role"] == "system"
        assert msgs[1]["role"] == "user"
        assert msgs[2]["role"] == "assistant"
        # System prompt must mention coordination + JSON shape
        assert "coordination" in msgs[0]["content"].lower()
        assert "{role" in msgs[0]["content"] or "role," in msgs[0]["content"]
        # Assistant content is JSON with role/reason/confidence
        completion = json.loads(msgs[2]["content"])
        assert completion["role"] == "moderator"
        assert completion["reason"] == "task-type-match"
        assert completion["confidence"] == 0.85
        # Metadata preserves trace identity
        assert record["metadata"]["trace_id"] == "abc123"
        assert record["metadata"]["strategy"] == "debate"
        assert stats.records_kept == 1
        assert stats.by_strategy["debate"] == 1
        assert stats.by_decision_type["moderator-selection"] == 1

    def test_fallback_record_dropped(self, fallback_trace):
        from data.feedback.synthesize_sft import SynthesisStats, transform_trace

        stats = SynthesisStats()
        record = transform_trace(fallback_trace, min_confidence=0.0, stats=stats)

        assert record is None
        assert stats.records_kept == 0
        assert stats.records_dropped_fallback == 1

    def test_low_confidence_dropped(self, well_formed_trace):
        from data.feedback.synthesize_sft import SynthesisStats, transform_trace

        well_formed_trace["teacher_confidence"] = 0.3
        stats = SynthesisStats()
        record = transform_trace(well_formed_trace, min_confidence=0.5, stats=stats)

        assert record is None
        assert stats.records_dropped_low_confidence == 1

    def test_malformed_record_dropped(self):
        from data.feedback.synthesize_sft import SynthesisStats, transform_trace

        stats = SynthesisStats()
        record = transform_trace({"strategy": "debate"}, min_confidence=0.0, stats=stats)

        assert record is None
        assert stats.records_dropped_malformed == 1

    def test_user_content_carries_request_context(self, well_formed_trace):
        from data.feedback.synthesize_sft import SynthesisStats, transform_trace

        stats = SynthesisStats()
        record = transform_trace(well_formed_trace, min_confidence=0.5, stats=stats)

        assert record is not None
        user_content = record["messages"][1]["content"]
        # Strategy and decision type appear in the brief
        assert "debate" in user_content
        assert "moderator-selection" in user_content
        # Context fields appear too
        assert "participantCount" in user_content
        assert "reasoning" in user_content


# ---------------------------------------------------------------------------
# synthesize() driver
# ---------------------------------------------------------------------------


class TestSynthesizeDriver:
    def test_synthesize_writes_per_input_file(
        self, tmp_path: Path, well_formed_trace, fallback_trace
    ):
        from data.feedback.synthesize_sft import synthesize

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()

        # Two input files, daily-rotation pattern
        f1 = input_dir / "teacher-traces-2026-05-05.jsonl"
        f1.write_text(
            json.dumps(well_formed_trace) + "\n" + json.dumps(fallback_trace) + "\n",
            encoding="utf-8",
        )
        f2 = input_dir / "teacher-traces-2026-05-06.jsonl"
        # Same well-formed trace duplicated — synth keeps both, dedup is a
        # downstream transform concern.
        f2.write_text(
            json.dumps(well_formed_trace) + "\n" + json.dumps(well_formed_trace) + "\n",
            encoding="utf-8",
        )

        stats = synthesize(input_dir, output_dir, min_confidence=0.5)

        # Output mirrors input layout with renamed prefix
        out1 = output_dir / "sft-coord-2026-05-05.jsonl"
        out2 = output_dir / "sft-coord-2026-05-06.jsonl"
        assert out1.exists()
        assert out2.exists()
        # File 1 had 1 valid + 1 fallback → 1 line; File 2 had 2 valid → 2 lines
        assert len(out1.read_text(encoding="utf-8").strip().splitlines()) == 1
        assert len(out2.read_text(encoding="utf-8").strip().splitlines()) == 2
        assert stats.files_seen == 2
        assert stats.records_seen == 4
        assert stats.records_kept == 3
        assert stats.records_dropped_fallback == 1

    def test_empty_input_dir_is_noop(self, tmp_path: Path):
        from data.feedback.synthesize_sft import synthesize

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()

        stats = synthesize(input_dir, output_dir)

        assert stats.files_seen == 0
        assert stats.records_seen == 0
        assert stats.records_kept == 0

    def test_malformed_jsonl_lines_skipped_not_fatal(self, tmp_path: Path, well_formed_trace):
        from data.feedback.synthesize_sft import synthesize

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()

        f = input_dir / "teacher-traces-2026-05-05.jsonl"
        # Mix of valid + truncated final line (writer-crash simulation)
        f.write_text(
            json.dumps(well_formed_trace) + "\n" + "{not-valid-json\n",
            encoding="utf-8",
        )

        stats = synthesize(input_dir, output_dir, min_confidence=0.5)

        # Driver doesn't count malformed JSON lines toward records_seen (they
        # never parse), so we just verify we got the one valid record out.
        assert stats.records_kept == 1
        out = (output_dir / "sft-coord-2026-05-05.jsonl").read_text(encoding="utf-8").strip()
        assert len(out.splitlines()) == 1


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class TestCli:
    def test_cli_runs_end_to_end(self, tmp_path: Path, well_formed_trace):
        from click.testing import CliRunner

        from data.feedback.synthesize_sft import cli

        input_dir = tmp_path / "input"
        output_dir = tmp_path / "output"
        input_dir.mkdir()
        (input_dir / "teacher-traces-2026-05-05.jsonl").write_text(
            json.dumps(well_formed_trace) + "\n",
            encoding="utf-8",
        )

        runner = CliRunner()
        result = runner.invoke(
            cli,
            [
                "--input",
                str(input_dir),
                "--output",
                str(output_dir),
                "--min-confidence",
                "0.5",
            ],
        )

        assert result.exit_code == 0, result.output
        assert (output_dir / "sft-coord-2026-05-05.jsonl").exists()
