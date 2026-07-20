# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Tests for evaluate_coord_decisions.py — offline coord eval pipeline.

Covers:
- parse_sft_record extracts truth from synthesize_sft output shape
- iter_sft_records walks dir + skips malformed lines
- evaluate() metrics: role_accuracy, reason_match_rate, brier_score
- per-strategy breakdown
- divergence samples capped at max
- in-process decider via mock_cascade
- CLI E2E with synthesized input
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

# ---------------------------------------------------------------------------
# Helpers — construct sft-coord records mimicking synthesize_sft output
# ---------------------------------------------------------------------------


def _make_sft_record(
    *,
    strategy: str = "debate",
    decision_type: str = "moderator-selection",
    context: dict | None = None,
    teacher_role: str = "moderator",
    teacher_reason: str = "task-type-match",
    teacher_confidence: float = 0.85,
    trace_id: str = "trace-x",
) -> dict:
    """Match the shape produced by synthesize_sft.transform_trace."""
    coordination_brief = {
        "strategy": strategy,
        "decision_type": decision_type,
        "context": context or {"requestId": trace_id},
    }
    return {
        "messages": [
            {"role": "system", "content": "You are the coordination teacher..."},
            {"role": "user", "content": f"Coordination request: {coordination_brief}"},
            {
                "role": "assistant",
                "content": json.dumps(
                    {
                        "role": teacher_role,
                        "reason": teacher_reason,
                        "confidence": teacher_confidence,
                    }
                ),
            },
        ],
        "metadata": {
            "trace_id": trace_id,
            "strategy": strategy,
            "decision_type": decision_type,
            "teacher_confidence": teacher_confidence,
            "teacher_scheduler": "teacher-triage-proxy",
        },
    }


# ---------------------------------------------------------------------------
# parse_sft_record
# ---------------------------------------------------------------------------


class TestParseSftRecord:
    def test_well_formed_record_yields_truth(self):
        from evals.evaluate_coord_decisions import parse_sft_record

        record = _make_sft_record()
        truth = parse_sft_record(record)

        assert truth is not None
        assert truth.strategy == "debate"
        assert truth.decision_type == "moderator-selection"
        assert truth.teacher_role == "moderator"
        assert truth.teacher_reason == "task-type-match"
        assert truth.teacher_confidence == 0.85
        assert truth.trace_id == "trace-x"
        assert truth.context["requestId"] == "trace-x"

    def test_malformed_record_returns_none(self):
        from evals.evaluate_coord_decisions import parse_sft_record

        assert parse_sft_record({}) is None
        assert parse_sft_record({"messages": []}) is None

    def test_assistant_message_invalid_json_returns_none(self):
        from evals.evaluate_coord_decisions import parse_sft_record

        record = _make_sft_record()
        # Corrupt the assistant content
        record["messages"][2]["content"] = "{not-valid-json"
        assert parse_sft_record(record) is None

    def test_context_extraction_handles_missing_marker(self):
        from evals.evaluate_coord_decisions import parse_sft_record

        record = _make_sft_record()
        record["messages"][1]["content"] = "Random text without marker"
        truth = parse_sft_record(record)
        # Truth still parses (context falls back to empty dict)
        assert truth is not None
        assert truth.context == {}


# ---------------------------------------------------------------------------
# iter_sft_records
# ---------------------------------------------------------------------------


class TestIterSftRecords:
    def test_reads_all_files_in_dir(self, tmp_path: Path):
        from evals.evaluate_coord_decisions import iter_sft_records

        f1 = tmp_path / "sft-coord-2026-05-05.jsonl"
        f1.write_text(json.dumps(_make_sft_record(trace_id="t1")) + "\n", encoding="utf-8")
        f2 = tmp_path / "sft-coord-2026-05-06.jsonl"
        f2.write_text(
            json.dumps(_make_sft_record(trace_id="t2"))
            + "\n"
            + json.dumps(_make_sft_record(trace_id="t3"))
            + "\n",
            encoding="utf-8",
        )

        truths = list(iter_sft_records(tmp_path))
        ids = [t.trace_id for t in truths]
        assert sorted(ids) == ["t1", "t2", "t3"]

    def test_skips_malformed_lines(self, tmp_path: Path):
        from evals.evaluate_coord_decisions import iter_sft_records

        f = tmp_path / "sft-coord-2026-05-05.jsonl"
        f.write_text(
            json.dumps(_make_sft_record(trace_id="ok"))
            + "\n"
            + "{not-json\n"
            + json.dumps(_make_sft_record(trace_id="ok2"))
            + "\n",
            encoding="utf-8",
        )

        truths = list(iter_sft_records(tmp_path))
        assert sorted(t.trace_id for t in truths) == ["ok", "ok2"]


# ---------------------------------------------------------------------------
# evaluate() — metrics
# ---------------------------------------------------------------------------


class TestEvaluate:
    @pytest.mark.asyncio
    async def test_perfect_decider_yields_full_accuracy(self):
        from evals.evaluate_coord_decisions import (
            DeciderOutput,
            TeacherTruth,
            evaluate,
        )

        truths = [
            TeacherTruth(
                strategy="debate",
                decision_type="moderator-selection",
                context={},
                teacher_role="moderator",
                teacher_reason="task-type-match",
                teacher_confidence=0.85,
                trace_id=f"t{i}",
            )
            for i in range(5)
        ]

        async def perfect_decider(t):
            return DeciderOutput(
                role=t.teacher_role,
                reason=t.teacher_reason,
                confidence=1.0,  # confident-and-correct → brier = 0
            )

        report = await evaluate(truths, perfect_decider, decider_label="perfect")

        assert report.total_records == 5
        assert report.role_accuracy == 1.0
        assert report.reason_match_rate == 1.0
        assert report.brier_score == 0.0
        assert report.divergence_samples == []

    @pytest.mark.asyncio
    async def test_always_wrong_decider_yields_zero_accuracy(self):
        from evals.evaluate_coord_decisions import (
            DeciderOutput,
            TeacherTruth,
            evaluate,
        )

        truths = [
            TeacherTruth(
                strategy="debate",
                decision_type="moderator-selection",
                context={},
                teacher_role="moderator",
                teacher_reason="task-type-match",
                teacher_confidence=0.85,
                trace_id=f"t{i}",
            )
            for i in range(3)
        ]

        async def wrong_decider(t):
            return DeciderOutput(role="WRONG", reason="WRONG-reason", confidence=1.0)

        report = await evaluate(truths, wrong_decider)

        assert report.role_accuracy == 0.0
        assert report.reason_match_rate == 0.0
        # confident-and-wrong → brier = 1.0 each
        assert report.brier_score == 1.0
        assert len(report.divergence_samples) == 3

    @pytest.mark.asyncio
    async def test_per_strategy_breakdown(self):
        from evals.evaluate_coord_decisions import (
            DeciderOutput,
            TeacherTruth,
            evaluate,
        )

        truths = [
            TeacherTruth("debate", "moderator-selection", {}, "moderator", "r1", 0.9, "d1"),
            TeacherTruth("debate", "moderator-selection", {}, "moderator", "r1", 0.9, "d2"),
            TeacherTruth("expert-panel", "panel-composition", {}, "coordinator", "r2", 0.9, "p1"),
        ]

        async def half_correct_decider(t):
            # Correct on debate, wrong on expert-panel
            if t.strategy == "debate":
                return DeciderOutput(t.teacher_role, t.teacher_reason, 0.9)
            return DeciderOutput("WRONG", "WRONG-reason", 0.9)

        report = await evaluate(truths, half_correct_decider)

        assert report.role_accuracy == pytest.approx(2 / 3)
        assert "debate/moderator-selection" in report.per_strategy
        assert report.per_strategy["debate/moderator-selection"]["role_accuracy"] == 1.0
        assert report.per_strategy["expert-panel/panel-composition"]["role_accuracy"] == 0.0

    @pytest.mark.asyncio
    async def test_divergence_samples_capped(self):
        from evals.evaluate_coord_decisions import (
            DeciderOutput,
            TeacherTruth,
            evaluate,
        )

        truths = [
            TeacherTruth("debate", "moderator-selection", {}, "moderator", "r", 0.9, f"d{i}")
            for i in range(20)
        ]

        async def wrong_decider(t):
            return DeciderOutput("WRONG", "r", 0.9)

        report = await evaluate(truths, wrong_decider, max_divergence_samples=5)
        assert len(report.divergence_samples) == 5

    @pytest.mark.asyncio
    async def test_role_confusion_matrix(self):
        from evals.evaluate_coord_decisions import (
            DeciderOutput,
            TeacherTruth,
            evaluate,
        )

        truths = [
            TeacherTruth("debate", "moderator-selection", {}, "moderator", "r", 0.9, "d1"),
            TeacherTruth("debate", "moderator-selection", {}, "moderator", "r", 0.9, "d2"),
            TeacherTruth("debate", "moderator-selection", {}, "synthesizer", "r", 0.9, "d3"),
        ]

        async def confused_decider(t):
            return DeciderOutput("moderator", "r", 0.9)

        report = await evaluate(truths, confused_decider)
        # Predicted "moderator" matched teacher "moderator" twice and
        # teacher "synthesizer" once.
        assert report.role_confusion["moderator"] == {"moderator": 2, "synthesizer": 1}


# ---------------------------------------------------------------------------
# In-process decider — mock_cascade
# ---------------------------------------------------------------------------


class TestInProcessDecider:
    @pytest.mark.asyncio
    async def test_mock_cascade_decider_returns_canonical_role(self):
        from evals.evaluate_coord_decisions import (
            TeacherTruth,
            make_inprocess_decider,
        )

        decider = make_inprocess_decider()
        truth = TeacherTruth(
            strategy="debate",
            decision_type="moderator-selection",
            context={},
            teacher_role="moderator",
            teacher_reason="r",
            teacher_confidence=0.9,
            trace_id="t1",
        )

        prediction = await decider(truth)
        assert prediction.role == "moderator"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


class TestCli:
    def test_cli_runs_against_mock_cascade(self, tmp_path: Path):
        from click.testing import CliRunner

        from evals.evaluate_coord_decisions import cli

        input_dir = tmp_path / "input"
        output_path = tmp_path / "report.json"
        input_dir.mkdir()

        # Mix of canonical (mock_cascade matches) and non-canonical roles
        f = input_dir / "sft-coord-2026-05-05.jsonl"
        f.write_text(
            json.dumps(
                _make_sft_record(
                    strategy="debate",
                    decision_type="moderator-selection",
                    teacher_role="moderator",
                    trace_id="ok1",
                )
            )
            + "\n"
            + json.dumps(
                _make_sft_record(
                    strategy="debate",
                    decision_type="moderator-selection",
                    teacher_role="WRONG-ROLE",
                    trace_id="bad1",
                )
            )
            + "\n",
            encoding="utf-8",
        )

        runner = CliRunner()
        result = runner.invoke(
            cli,
            [
                "--input",
                str(input_dir),
                "--output",
                str(output_path),
                "--mode",
                "mock_cascade",
            ],
        )

        assert result.exit_code == 0, result.output
        report = json.loads(output_path.read_text(encoding="utf-8"))
        # Canonical mock_cascade returns "moderator" for debate, so 1/2 match
        assert report["total_records"] == 2
        assert report["role_accuracy"] == 0.5
        assert report["decider_label"] == "in-process:mock_cascade"

    def test_cli_http_mode_requires_endpoint(self, tmp_path: Path):
        from click.testing import CliRunner

        from evals.evaluate_coord_decisions import cli

        input_dir = tmp_path / "input"
        output_path = tmp_path / "report.json"
        input_dir.mkdir()
        f = input_dir / "sft-coord-2026-05-05.jsonl"
        f.write_text(json.dumps(_make_sft_record()) + "\n", encoding="utf-8")

        runner = CliRunner()
        result = runner.invoke(
            cli,
            [
                "--input",
                str(input_dir),
                "--output",
                str(output_path),
                "--mode",
                "http",
            ],
        )

        assert result.exit_code != 0
        assert "--endpoint" in result.output

    def test_cli_empty_input_exits_nonzero(self, tmp_path: Path):
        from click.testing import CliRunner

        from evals.evaluate_coord_decisions import cli

        input_dir = tmp_path / "input"
        output_path = tmp_path / "report.json"
        input_dir.mkdir()

        runner = CliRunner()
        result = runner.invoke(
            cli,
            ["--input", str(input_dir), "--output", str(output_path), "--mode", "mock_cascade"],
        )

        assert result.exit_code != 0
        assert "No sft-coord records" in result.output
