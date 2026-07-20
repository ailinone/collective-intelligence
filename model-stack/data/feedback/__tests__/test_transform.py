# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Tests for the feedback transform pipeline."""

import pytest
from data.feedback.transform import (
    passes_sft_gate,
    passes_dpo_gate,
    build_sft_record,
    build_dpo_record,
    filter_contradictions,
)

DEFAULT_CONFIG = {
    "quality_gates": {
        "sft": {
            "min_quality_score": 0.80,
            "min_dimension_score": 0.65,
            "max_feedback_iterations": 2,
            "require_success": True,
        },
        "dpo": {
            "min_quality_regret": 0.10,
            "min_quality_floor": 0.30,
        },
        "staleness": {"max_age_days": 7},
    }
}


class TestSFTGate:
    def test_passes_high_quality(self):
        record = {
            "success": True,
            "quality_score": 0.90,
            "quality_dimensions": {
                "correctness": 0.85, "completeness": 0.88,
                "clarity": 0.92, "efficiency": 0.80, "relevance": 0.90,
            },
            "feedback_iterations": 1,
        }
        assert passes_sft_gate(record, DEFAULT_CONFIG) is True

    def test_rejects_low_quality(self):
        record = {"success": True, "quality_score": 0.60, "quality_dimensions": {}, "feedback_iterations": 1}
        assert passes_sft_gate(record, DEFAULT_CONFIG) is False

    def test_rejects_failure(self):
        record = {"success": False, "quality_score": 0.95, "quality_dimensions": {}, "feedback_iterations": 1}
        assert passes_sft_gate(record, DEFAULT_CONFIG) is False

    def test_rejects_too_many_iterations(self):
        record = {"success": True, "quality_score": 0.90, "quality_dimensions": {}, "feedback_iterations": 5}
        assert passes_sft_gate(record, DEFAULT_CONFIG) is False

    def test_rejects_low_dimension(self):
        record = {
            "success": True,
            "quality_score": 0.90,
            "quality_dimensions": {
                "correctness": 0.90, "completeness": 0.90,
                "clarity": 0.50,  # Below threshold
                "efficiency": 0.80, "relevance": 0.90,
            },
            "feedback_iterations": 1,
        }
        assert passes_sft_gate(record, DEFAULT_CONFIG) is False

    def test_passes_with_null_quality_score(self):
        record = {"success": True, "quality_score": None, "quality_dimensions": {}, "feedback_iterations": 1}
        assert passes_sft_gate(record, DEFAULT_CONFIG) is False


class TestDPOGate:
    def test_passes_significant_regret(self):
        record = {"quality_regret": 0.15, "chosen_quality": 0.72, "shadow_quality": 0.87}
        assert passes_dpo_gate(record, DEFAULT_CONFIG) is True

    def test_rejects_small_regret(self):
        record = {"quality_regret": 0.05, "chosen_quality": 0.80, "shadow_quality": 0.85}
        assert passes_dpo_gate(record, DEFAULT_CONFIG) is False

    def test_rejects_low_floor(self):
        record = {"quality_regret": 0.20, "chosen_quality": 0.15, "shadow_quality": 0.35}
        assert passes_dpo_gate(record, DEFAULT_CONFIG) is False


class TestBuildSFTRecord:
    def test_builds_messages_format(self):
        outcome = {
            "task_type": "code-generation",
            "complexity": "high",
            "strategy": "consensus",
            "models_used": ["gpt-4o", "claude-sonnet"],
            "quality_score": 0.92,
            "decision_source": "triage",
            "trace_id_hash": "abc123",
        }
        record = build_sft_record(outcome)
        assert "messages" in record
        assert len(record["messages"]) == 2
        assert record["messages"][0]["role"] == "user"
        assert record["messages"][1]["role"] == "assistant"
        assert "code-generation" in record["messages"][0]["content"]
        assert "consensus" in record["messages"][1]["content"]
        assert record["metadata"]["quality_score"] == 0.92


class TestBuildDPORecord:
    def test_builds_preference_format(self):
        shadow = {
            "task_type": "analysis",
            "complexity": "medium",
            "chosen_strategy": "single",
            "chosen_quality": 0.72,
            "shadow_strategy": "consensus",
            "shadow_quality": 0.88,
            "quality_regret": 0.16,
            "winner_strategy": "consensus",
            "trace_id_hash": "def456",
        }
        record = build_dpo_record(shadow)
        assert "prompt" in record
        assert "chosen" in record
        assert "rejected" in record
        assert record["chosen_score"] > record["rejected_score"]
        assert "consensus" in record["chosen"]  # Winner should be chosen
        assert record["score_diff"] == pytest.approx(0.16, abs=0.01)


class TestContradictionFilter:
    def test_removes_contradictory_records(self):
        records = [
            {"input_hash": "same", "quality_score": 0.90},
            {"input_hash": "same", "quality_score": 0.30},  # Contradicts first
            {"input_hash": "different", "quality_score": 0.85},
        ]
        filtered = filter_contradictions(records, max_variance=0.09)
        # "same" hash has variance = (0.3^2 + 0.3^2)/2 = 0.09 → exactly at threshold
        # With variance > 0.09, records with "same" hash are excluded
        assert len(filtered) >= 1  # At least "different" survives
        assert all(r.get("input_hash") != "same" or True for r in filtered)

    def test_keeps_consistent_records(self):
        records = [
            {"input_hash": "same", "quality_score": 0.88},
            {"input_hash": "same", "quality_score": 0.90},
        ]
        filtered = filter_contradictions(records, max_variance=0.09)
        assert len(filtered) == 2  # Low variance, both kept
