# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Teacher Proxy — wraps the existing CI triage-service as a synthetic
single-model "ensemble" so the coord-stable serving contract works
end-to-end before the 24 student models are trained.

Strategy: the CI gateway already has a coordinator (triage-service)
that decides strategy/role for every request via a GPT-4-class LLM.
For Phase 2c we proxy that decision through coord_serving so:

  1. The HTTP contract `EnsembleDecisionRequest`/`EnsembleDecisionResponse`
     is exercised end-to-end with REAL responses
  2. Every (request, teacher_decision) pair is captured as F3.3 SFT
     training data via `teacher_traces.py`
  3. When the 24 students are trained (Phase 2b) and swapped in
     (Phase 2c.2), the wire format is identical — drop-in replacement

The single "vote" we return is attributed to a synthetic placeholder
model id ("teacher-triage-proxy"). The cascade aggregator's
`weighted_bayesian_majority` works fine with one tier × one vote.

This module never calls the local strategies — it only consumes
triage-service's already-formed decisions.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import httpx

from .tiered_voter import (
    AggregatedDecision,
    CoordinatorVote,
    Tier,
    TierResult,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Config — env-driven so dev/staging/prod use different triage backends
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TeacherProxyConfig:
    """Runtime config for the teacher proxy.

    Read from environment at startup; pass an instance to
    TeacherProxy() to override for tests.
    """

    # Where the CI gateway exposes triage-service. In prod this is the
    # internal service mesh URL; in dev compose it's ci-api:3000.
    ci_api_endpoint: str = "http://ci-api:3000"
    # Authentication token for the internal triage call. Must have
    # `roles=['admin']` to access internal triage routes.
    auth_token: str | None = None
    # HTTP timeout in seconds for the upstream triage call.
    timeout_seconds: float = 5.0
    # If true, log full request/response shapes at DEBUG. Off in prod
    # because triage payloads can include user prompt fragments.
    log_payloads: bool = False

    @classmethod
    def from_env(cls) -> TeacherProxyConfig:
        return cls(
            ci_api_endpoint=os.environ.get("COORD_TEACHER_CI_API_URL", "http://ci-api:3000"),
            auth_token=os.environ.get("COORD_TEACHER_AUTH_TOKEN"),
            timeout_seconds=float(os.environ.get("COORD_TEACHER_TIMEOUT_SECONDS", "5.0")),
            log_payloads=os.environ.get("COORD_TEACHER_LOG_PAYLOADS", "false").lower() == "true",
        )


# ---------------------------------------------------------------------------
# TeacherProxy
# ---------------------------------------------------------------------------


class TeacherProxy:
    """Wraps a CI triage-service call as an AggregatedDecision.

    The proxy is intentionally stateless — each call constructs a fresh
    httpx.AsyncClient. For high-volume scenarios this can be replaced
    with a pooled client; for Phase 2c the volume is bounded by debate-
    strategy shadow traffic so the simpler design is fine.
    """

    SCHEDULER_NAME = "teacher-triage-proxy"
    SYNTHETIC_MODEL_ID = "teacher-triage-v1"

    def __init__(self, config: TeacherProxyConfig | None = None) -> None:
        self.config = config or TeacherProxyConfig.from_env()

    async def decide(
        self,
        strategy: str,
        decision_type: str,
        context: Mapping[str, Any],
    ) -> AggregatedDecision:
        """Call triage-service and wrap the response as AggregatedDecision.

        On any error (timeout, 5xx, malformed response), returns a
        defensive AggregatedDecision with role='fallback-default' and
        reason indicating the failure mode. The caller (coord_serving)
        is responsible for distinguishing this from a real teacher
        decision via the `reason` field.
        """
        start = time.perf_counter()
        try:
            payload = self._build_triage_payload(strategy, decision_type, context)
            triage_response = await self._call_triage(payload)
            vote = self._wrap_as_vote(triage_response, strategy, decision_type)
            tier_result = TierResult(tier=Tier.ENCODER, votes=(vote,))
            return AggregatedDecision(
                role=vote.role,
                reason=vote.reason,
                scheduler=self.SCHEDULER_NAME,
                confidence=vote.confidence,
                aggregation_method="teacher_proxy_passthrough",
                tier_results=(tier_result,),
                vote_distribution={vote.role: 1},
                total_votes=1,
                dissent_count=0,
                tiers_activated=(Tier.ENCODER,),
                final_tier=Tier.ENCODER,
                short_circuited=True,
            )
        except Exception as exc:  # noqa: BLE001 — must NOT propagate
            elapsed_ms = (time.perf_counter() - start) * 1000
            logger.warning(
                "Teacher proxy call failed after %.0fms: %s — returning defensive fallback",
                elapsed_ms,
                exc,
            )
            return self._fallback_decision(reason=f"teacher-proxy-error:{type(exc).__name__}")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _build_triage_payload(
        self,
        strategy: str,
        decision_type: str,
        context: Mapping[str, Any],
    ) -> dict[str, Any]:
        """Map an EnsembleDecisionRequest shape onto triage-service's payload.

        triage-service expects the conversation messages + capability hints.
        For coordination decisions the relevant signal is in the strategy
        context (turn number, prior decisions, participants, etc.) — we
        flatten it into the messages array as a system note so the
        teacher reasons over the same surface a student would see.
        """
        # The strategy context is opaque to us; we wrap it as a structured
        # JSON payload in the system message so triage's prompt template
        # has all the context to make a coordination decision.
        coordination_brief = {
            "strategy": strategy,
            "decision_type": decision_type,
            "context": dict(context),
        }
        return {
            "model": "auto",
            "messages": [
                {
                    "role": "system",
                    "content": (
                        "You are the coordination teacher. Given the strategy "
                        "context below, decide the next role/scheduler decision "
                        "and return it as JSON: {role, reason, confidence}. "
                        "Reason MUST come from the stable vocabulary in "
                        "coord-stable/_shared.yaml."
                    ),
                },
                {
                    "role": "user",
                    "content": f"Coordination request: {coordination_brief}",
                },
            ],
            "max_tokens": 256,
            "temperature": 0.0,
            "response_format": {"type": "json_object"},
        }

    async def _call_triage(self, payload: dict[str, Any]) -> dict[str, Any]:
        """Make the HTTP call to triage-service.

        Returns the parsed JSON response. Raises on network / HTTP errors;
        the caller wraps in a defensive fallback.
        """
        headers = {
            "content-type": "application/json",
            "accept": "application/json",
        }
        if self.config.auth_token:
            headers["authorization"] = f"Bearer {self.config.auth_token}"

        url = f"{self.config.ci_api_endpoint.rstrip('/')}/v1/chat/completions"
        if self.config.log_payloads:
            logger.debug("Calling triage at %s with payload: %s", url, payload)

        async with httpx.AsyncClient(timeout=self.config.timeout_seconds) as client:
            response = await client.post(url, json=payload, headers=headers)
            response.raise_for_status()
            return response.json()

    def _wrap_as_vote(
        self,
        triage_response: dict[str, Any],
        strategy: str,
        decision_type: str,
    ) -> CoordinatorVote:
        """Extract triage's decision from the chat-completion response.

        triage returns a JSON object in the message content. We parse it
        defensively — any malformed shape falls back to 'task-type-match'
        as the reason and uses the strategy default role.
        """
        # Defensive extraction — chat-completion shape is well-defined
        # but production data can surprise.
        choices = triage_response.get("choices") or []
        first_choice = choices[0] if choices else {}
        message = first_choice.get("message") or {}
        content = message.get("content")

        role = self._default_role_for(strategy, decision_type)
        reason = "task-type-match"
        confidence = 0.85  # teacher-proxy default — high but not dictatorial

        if isinstance(content, str):
            try:
                import json as _json

                parsed = _json.loads(content)
                if isinstance(parsed, dict):
                    if isinstance(parsed.get("role"), str):
                        role = parsed["role"]
                    if isinstance(parsed.get("reason"), str):
                        reason = parsed["reason"]
                    if isinstance(parsed.get("confidence"), (int, float)):
                        confidence = max(0.0, min(1.0, float(parsed["confidence"])))
            except (ValueError, TypeError) as parse_error:
                logger.debug("Could not parse triage JSON content: %s", parse_error)

        return CoordinatorVote(
            model_id=self.SYNTHETIC_MODEL_ID,
            scheduler=self.SCHEDULER_NAME,
            tier=Tier.ENCODER,  # placeholder — teacher acts as if Tier-1 confident
            role=role,
            reason=reason,
            confidence=confidence,
            rationale=f"teacher-proxy:{strategy}:{decision_type}",
        )

    @staticmethod
    def _default_role_for(strategy: str, decision_type: str) -> str:
        """Sensible defaults so the proxy never returns nonsense.

        These match the heuristic fallbacks already in the strategies,
        so a degenerate teacher response still produces a legal decision.
        """
        if strategy == "tri-role-collective":
            # Mirrors decideRoleForTurn defaults.
            if decision_type == "role-for-turn":
                return "auditor"
            return "auditor"
        if strategy == "debate":
            return "moderator"
        if strategy == "expert-panel":
            return "coordinator"
        if strategy == "consensus":
            return "synthesizer"
        if strategy == "parallel-race":
            return "candidate"
        if strategy == "sensitivity-consensus":
            return "weighted_confidence"
        return "fallback-default"

    def _fallback_decision(self, reason: str) -> AggregatedDecision:
        """Return a safe AggregatedDecision when the upstream call fails."""
        empty_tier = TierResult(tier=Tier.ENCODER, votes=())
        return AggregatedDecision(
            role="fallback-default",
            reason=reason,
            scheduler=self.SCHEDULER_NAME,
            confidence=0.0,
            aggregation_method="teacher_proxy_fallback",
            tier_results=(empty_tier,),
            vote_distribution={},
            total_votes=0,
            dissent_count=0,
            tiers_activated=(Tier.ENCODER,),
            final_tier=Tier.ENCODER,
            short_circuited=True,
        )
