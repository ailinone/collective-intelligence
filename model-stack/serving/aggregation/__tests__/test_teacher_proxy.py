# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Unit tests for the teacher proxy."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from serving.aggregation.teacher_proxy import TeacherProxy, TeacherProxyConfig
from serving.aggregation.tiered_voter import Tier

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _triage_response(
    role: str, reason: str = "task-type-match", confidence: float = 0.9
) -> dict[str, Any]:
    """Build a fake triage chat-completion response."""
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": json.dumps(
                        {
                            "role": role,
                            "reason": reason,
                            "confidence": confidence,
                        }
                    ),
                },
            }
        ],
    }


def _malformed_triage_response() -> dict[str, Any]:
    return {
        "id": "chatcmpl-test",
        "object": "chat.completion",
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {"role": "assistant", "content": "not-json garbage"},
            }
        ],
    }


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------


class TestTeacherProxyConfig:
    def test_defaults_apply_when_env_unset(self, monkeypatch):
        monkeypatch.delenv("COORD_TEACHER_CI_API_URL", raising=False)
        monkeypatch.delenv("COORD_TEACHER_AUTH_TOKEN", raising=False)
        monkeypatch.delenv("COORD_TEACHER_TIMEOUT_SECONDS", raising=False)
        config = TeacherProxyConfig.from_env()
        assert config.ci_api_endpoint == "http://ci-api:3000"
        assert config.auth_token is None
        assert config.timeout_seconds == 5.0
        assert config.log_payloads is False

    def test_env_overrides_defaults(self, monkeypatch):
        monkeypatch.setenv("COORD_TEACHER_CI_API_URL", "http://custom:9999")
        monkeypatch.setenv("COORD_TEACHER_AUTH_TOKEN", "t0k3n")
        monkeypatch.setenv("COORD_TEACHER_TIMEOUT_SECONDS", "10")
        monkeypatch.setenv("COORD_TEACHER_LOG_PAYLOADS", "true")
        config = TeacherProxyConfig.from_env()
        assert config.ci_api_endpoint == "http://custom:9999"
        assert config.auth_token == "t0k3n"
        assert config.timeout_seconds == 10.0
        assert config.log_payloads is True


# ---------------------------------------------------------------------------
# Decide path
# ---------------------------------------------------------------------------


class TestTeacherProxyDecide:
    @pytest.mark.asyncio
    async def test_well_formed_triage_response_yields_aggregated_decision(self):
        proxy = TeacherProxy(TeacherProxyConfig(ci_api_endpoint="http://stub"))
        with patch.object(
            proxy, "_call_triage", new=AsyncMock(return_value=_triage_response("auditor"))
        ):
            decision = await proxy.decide(
                strategy="tri-role-collective",
                decision_type="role-for-turn",
                context={"turn": 3},
            )
        assert decision.role == "auditor"
        assert decision.reason == "task-type-match"
        assert decision.scheduler == TeacherProxy.SCHEDULER_NAME
        assert decision.aggregation_method == "teacher_proxy_passthrough"
        assert decision.total_votes == 1
        assert decision.dissent_count == 0
        assert decision.short_circuited is True
        assert decision.tiers_activated == (Tier.ENCODER,)
        assert decision.final_tier == Tier.ENCODER

    @pytest.mark.asyncio
    async def test_confidence_clamped_to_unit_interval(self):
        proxy = TeacherProxy(TeacherProxyConfig())
        # Triage returns out-of-range confidence — must be clamped.
        with patch.object(
            proxy,
            "_call_triage",
            new=AsyncMock(return_value=_triage_response("solver", confidence=99.5)),
        ):
            decision = await proxy.decide(
                strategy="debate",
                decision_type="moderator-selection",
                context={},
            )
        assert decision.confidence == 1.0

    @pytest.mark.asyncio
    async def test_malformed_triage_falls_back_to_strategy_default(self):
        proxy = TeacherProxy(TeacherProxyConfig())
        with patch.object(
            proxy,
            "_call_triage",
            new=AsyncMock(return_value=_malformed_triage_response()),
        ):
            decision = await proxy.decide(
                strategy="debate",
                decision_type="moderator-selection",
                context={},
            )
        # Default for debate is "moderator" — set in _default_role_for.
        assert decision.role == "moderator"
        assert decision.aggregation_method == "teacher_proxy_passthrough"

    @pytest.mark.asyncio
    async def test_upstream_error_returns_defensive_fallback(self):
        proxy = TeacherProxy(TeacherProxyConfig())
        with patch.object(
            proxy,
            "_call_triage",
            new=AsyncMock(side_effect=httpx.ConnectError("boom")),
        ):
            decision = await proxy.decide(
                strategy="tri-role-collective",
                decision_type="role-for-turn",
                context={},
            )
        assert decision.role == "fallback-default"
        assert decision.reason.startswith("teacher-proxy-error:")
        assert decision.confidence == 0.0
        assert decision.aggregation_method == "teacher_proxy_fallback"

    @pytest.mark.asyncio
    async def test_default_roles_are_strategy_appropriate(self):
        """Each strategy has a sensible default role for fallback."""
        assert TeacherProxy._default_role_for("tri-role-collective", "role-for-turn") == "auditor"
        assert TeacherProxy._default_role_for("debate", "moderator-selection") == "moderator"
        assert TeacherProxy._default_role_for("expert-panel", "panel-composition") == "coordinator"
        assert TeacherProxy._default_role_for("consensus", "synthesis-coordinator") == "synthesizer"
        assert TeacherProxy._default_role_for("parallel-race", "race-candidates") == "candidate"
        assert (
            TeacherProxy._default_role_for("sensitivity-consensus", "aggregation-method")
            == "weighted_confidence"
        )
        assert TeacherProxy._default_role_for("unknown-strategy", "x") == "fallback-default"

    @pytest.mark.asyncio
    async def test_request_payload_carries_context(self):
        """The payload sent to triage embeds the strategy + decision_type + context."""
        proxy = TeacherProxy(TeacherProxyConfig())
        captured = {}

        async def fake_call(payload):
            captured["payload"] = payload
            return _triage_response("auditor")

        with patch.object(proxy, "_call_triage", new=fake_call):
            await proxy.decide(
                strategy="tri-role-collective",
                decision_type="role-for-turn",
                context={"turn": 5, "transcript_len": 4},
            )

        # The strategy + decision_type + context all appear in the user message.
        user_msg = next(m for m in captured["payload"]["messages"] if m["role"] == "user")
        assert "tri-role-collective" in user_msg["content"]
        assert "role-for-turn" in user_msg["content"]
        assert "turn" in user_msg["content"]
