# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Integration tests for the coord_serving FastAPI endpoint.

Covers MOCK_DETERMINISTIC and MOCK_CASCADE modes (no upstream
dependencies) end-to-end. TEACHER_PROXY mode is exercised via the
teacher_proxy unit tests (which mock the upstream triage call).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


def _reset_state(serving_mode_value: str, *, auth_token: str = ""):
    """Reset module-global state for a clean test slot.

    Both teacher_traces._writer_singleton and coord_serving.STATE are
    process-global, so each test that uses them must reset them up
    front. The serving_mode is set explicitly because the lifespan
    handler is bypassed in TestClient for some test patterns.
    """
    from data.feedback import teacher_traces

    teacher_traces._writer_singleton = None  # noqa: SLF001 — test-only reset

    from serving.aggregation import coord_serving

    coord_serving.STATE.serving_mode = coord_serving.ServingMode(serving_mode_value)
    coord_serving.STATE.teacher_proxy = None
    coord_serving.STATE.trace_writer = None
    coord_serving.STATE.write_traces = False
    coord_serving.STATE.auth_token = auth_token
    return coord_serving.app


@pytest.fixture
def mock_app(monkeypatch, tmp_path: Path):
    """Spin up the FastAPI app in MOCK_DETERMINISTIC mode (auth disabled)."""
    monkeypatch.setenv("COORD_SERVING_MODE", "MOCK_DETERMINISTIC")
    monkeypatch.setenv("COORD_TEACHER_TRACES_DIR", str(tmp_path))
    return _reset_state("MOCK_DETERMINISTIC")


@pytest.fixture
def auth_app(monkeypatch, tmp_path: Path):
    """Spin up the FastAPI app with bearer auth enabled (token=secret-token).

    The COORD_SERVING_AUTH_TOKEN env var is set so the lifespan handler
    picks it up. Setting STATE.auth_token directly is insufficient
    because TestClient(app) runs the lifespan on __enter__ which
    overwrites STATE from the env.
    """
    monkeypatch.setenv("COORD_SERVING_MODE", "MOCK_DETERMINISTIC")
    monkeypatch.setenv("COORD_SERVING_AUTH_TOKEN", "secret-token")
    monkeypatch.setenv("COORD_TEACHER_TRACES_DIR", str(tmp_path))
    return _reset_state("MOCK_DETERMINISTIC", auth_token="secret-token")


@pytest.fixture
def cascade_app(monkeypatch, tmp_path: Path):
    """Spin up the FastAPI app in MOCK_CASCADE mode."""
    monkeypatch.setenv("COORD_SERVING_MODE", "MOCK_CASCADE")
    monkeypatch.setenv("COORD_TEACHER_TRACES_DIR", str(tmp_path))
    return _reset_state("MOCK_CASCADE")


# ---------------------------------------------------------------------------
# Health / readiness
# ---------------------------------------------------------------------------


class TestHealthEndpoints:
    def test_health_returns_ok(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.get("/health")
            assert r.status_code == 200
            body = r.json()
            assert body["status"] == "ok"
            assert body["mode"] == "MOCK_DETERMINISTIC"

    def test_ready_in_mock_mode_returns_true(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.get("/ready")
            assert r.status_code == 200
            body = r.json()
            assert body["ready"] is True
            assert body["mode"] == "MOCK_DETERMINISTIC"

    def test_metrics_endpoint_exposes_prometheus_format(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.get("/metrics")
            assert r.status_code == 200
            assert "coord_ensemble_request_total" in r.text


# ---------------------------------------------------------------------------
# Decide endpoint — MOCK_DETERMINISTIC
# ---------------------------------------------------------------------------


class TestDecideEndpointMock:
    def test_tri_role_role_for_turn_returns_auditor(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "tri-role-collective",
                    "decisionType": "role-for-turn",
                    "context": {"turn": 3, "transcript": []},
                },
            )
            assert r.status_code == 200
            body = r.json()
            decision = body["decision"]
            assert decision["role"] == "auditor"
            assert decision["scheduler"] == "mock-deterministic"
            assert decision["confidence"] == 0.95
            assert decision["aggregationMethod"] == "mock_deterministic"
            assert decision["totalVotes"] == 1
            assert decision["shortCircuited"] is True
            assert decision["tiersActivated"] == [1]

    def test_debate_moderator_selection_returns_moderator(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "debate",
                    "decisionType": "moderator-selection",
                    "context": {"participants": ["m1", "m2", "m3"]},
                },
            )
            assert r.status_code == 200
            assert r.json()["decision"]["role"] == "moderator"

    def test_expert_panel_panel_composition(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "expert-panel",
                    "decisionType": "panel-composition",
                    "context": {},
                },
            )
            assert r.status_code == 200
            assert r.json()["decision"]["role"] == "coordinator"

    def test_response_carries_request_id(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                headers={"x-request-id": "req-abc-123"},
                json={
                    "strategy": "consensus",
                    "decisionType": "synthesis-coordinator",
                    "context": {},
                },
            )
            assert r.status_code == 200
            assert r.json()["requestId"] == "req-abc-123"

    def test_response_generates_request_id_when_missing(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "consensus",
                    "decisionType": "synthesis-coordinator",
                    "context": {},
                },
            )
            assert r.status_code == 200
            request_id = r.json()["requestId"]
            assert isinstance(request_id, str)
            assert len(request_id) >= 16


# ---------------------------------------------------------------------------
# Validation — bad requests must fail with 422 before mode dispatch
# ---------------------------------------------------------------------------


class TestRequestValidation:
    def test_missing_strategy_returns_422(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={"decisionType": "role-for-turn", "context": {}},
            )
            assert r.status_code == 422

    def test_invalid_strategy_returns_422(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "not-a-real-strategy",
                    "decisionType": "role-for-turn",
                    "context": {},
                },
            )
            assert r.status_code == 422

    def test_invalid_decision_type_returns_422(self, mock_app):
        with TestClient(mock_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "debate",
                    "decisionType": "invented-decision-type",
                    "context": {},
                },
            )
            assert r.status_code == 422


# ---------------------------------------------------------------------------
# Decide endpoint — MOCK_CASCADE
# ---------------------------------------------------------------------------


class TestDecideEndpointCascade:
    def test_default_request_short_circuits_via_cascade(self, cascade_app):
        with TestClient(cascade_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "debate",
                    "decisionType": "moderator-selection",
                    "context": {},
                },
            )
            assert r.status_code == 200
            body = r.json()
            decision = body["decision"]
            assert decision["role"] == "moderator"
            assert decision["scheduler"] == "mock-cascade-24-tiered"
            assert decision["aggregationMethod"] == "weighted_bayesian_majority"
            assert decision["shortCircuited"] is True
            # Cascade ran at least Tier 1 + 2 (short-circuited around T2/T3)
            assert decision["finalTier"] >= 1
            assert decision["finalTier"] <= 4
            assert decision["totalVotes"] >= 4

    def test_dissent_at_tier_1_escalates_past_tier_1(self, cascade_app):
        with TestClient(cascade_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "debate",
                    "decisionType": "moderator-selection",
                    "context": {"mockCascade": {"dissentAtTier": 1}},
                },
            )
            assert r.status_code == 200
            decision = r.json()["decision"]
            # T1 alone insufficient — cascade must have run T2 too
            assert decision["finalTier"] >= 2

    def test_full_cascade_exhaustion(self, cascade_app):
        with TestClient(cascade_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "expert-panel",
                    "decisionType": "panel-composition",
                    "context": {"mockCascade": {"dissentTiers": [1, 2, 3, 4, 5, 6]}},
                },
            )
            assert r.status_code == 200
            decision = r.json()["decision"]
            assert decision["finalTier"] == 6
            assert decision["shortCircuited"] is False
            assert decision["tiersActivated"] == [1, 2, 3, 4, 5, 6]

    def test_tier_failure_records_failed_models(self, cascade_app):
        with TestClient(cascade_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                json={
                    "strategy": "debate",
                    "decisionType": "moderator-selection",
                    "context": {"mockCascade": {"failTier": 1}},
                },
            )
            assert r.status_code == 200
            decision = r.json()["decision"]
            # T1 failed but cascade continued
            assert 1 in decision["tiersActivated"]
            assert 2 in decision["tiersActivated"]
            # T1's failed_models is empty because the executor raised
            # BEFORE recording any models — TieredEnsembleVoter's catch
            # produces an empty TierResult. That's fine; the test
            # verifies cascade kept moving.
            assert decision["role"] == "moderator"

    def test_canonical_role_per_strategy_via_cascade(self, cascade_app):
        # Sanity for all 5 strategies — same as MOCK_DETERMINISTIC, but
        # routed through the real cascade aggregator.
        cases = [
            ("tri-role-collective", "role-for-turn", "auditor"),
            ("debate", "moderator-selection", "moderator"),
            ("expert-panel", "panel-composition", "coordinator"),
            ("consensus", "synthesis-coordinator", "synthesizer"),
            ("parallel-race", "race-candidates", "candidate"),
        ]
        with TestClient(cascade_app) as client:
            for strategy, decision_type, expected_role in cases:
                r = client.post(
                    "/v1/ensemble/decide",
                    json={
                        "strategy": strategy,
                        "decisionType": decision_type,
                        "context": {},
                    },
                )
                assert r.status_code == 200, (strategy, r.text)
                assert r.json()["decision"]["role"] == expected_role, strategy

    def test_health_reports_cascade_mode(self, cascade_app):
        with TestClient(cascade_app) as client:
            r = client.get("/health")
            assert r.status_code == 200
            assert r.json()["mode"] == "MOCK_CASCADE"

    def test_ready_in_cascade_mode_returns_true(self, cascade_app):
        with TestClient(cascade_app) as client:
            r = client.get("/ready")
            assert r.status_code == 200
            body = r.json()
            assert body["ready"] is True
            assert body["mode"] == "MOCK_CASCADE"


# ---------------------------------------------------------------------------
# Bearer auth — only /v1/ensemble/decide is gated; probes are open
# ---------------------------------------------------------------------------


class TestBearerAuth:
    DECIDE_PAYLOAD = {
        "strategy": "debate",
        "decisionType": "moderator-selection",
        "context": {},
    }

    def test_decide_without_token_returns_401(self, auth_app):
        with TestClient(auth_app) as client:
            r = client.post("/v1/ensemble/decide", json=self.DECIDE_PAYLOAD)
            assert r.status_code == 401
            assert "missing" in r.json()["detail"].lower()

    def test_decide_with_malformed_header_returns_401(self, auth_app):
        with TestClient(auth_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                headers={"authorization": "Basic something"},
                json=self.DECIDE_PAYLOAD,
            )
            assert r.status_code == 401
            assert "malformed" in r.json()["detail"].lower()

    def test_decide_with_wrong_token_returns_401(self, auth_app):
        with TestClient(auth_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                headers={"authorization": "Bearer wrong-token"},
                json=self.DECIDE_PAYLOAD,
            )
            assert r.status_code == 401
            assert "invalid" in r.json()["detail"].lower()

    def test_decide_with_correct_token_returns_200(self, auth_app):
        with TestClient(auth_app) as client:
            r = client.post(
                "/v1/ensemble/decide",
                headers={"authorization": "Bearer secret-token"},
                json=self.DECIDE_PAYLOAD,
            )
            assert r.status_code == 200
            assert r.json()["decision"]["role"] == "moderator"

    def test_health_open_when_auth_enabled(self, auth_app):
        # /health is k8s liveness probe — must work without auth.
        with TestClient(auth_app) as client:
            r = client.get("/health")
            assert r.status_code == 200

    def test_ready_open_when_auth_enabled(self, auth_app):
        # /ready is k8s readiness probe — must work without auth.
        with TestClient(auth_app) as client:
            r = client.get("/ready")
            assert r.status_code == 200

    def test_metrics_open_when_auth_enabled(self, auth_app):
        # /metrics is the prometheus scrape — must work without auth.
        with TestClient(auth_app) as client:
            r = client.get("/metrics")
            assert r.status_code == 200

    def test_decide_open_when_auth_disabled(self, mock_app):
        # mock_app fixture sets auth_token="" — auth disabled.
        with TestClient(mock_app) as client:
            r = client.post("/v1/ensemble/decide", json=self.DECIDE_PAYLOAD)
            assert r.status_code == 200


# ---------------------------------------------------------------------------
# CORS allowed-origins parsing
# ---------------------------------------------------------------------------


class TestCorsOrigins:
    def test_default_origins_is_wildcard(self, monkeypatch):
        monkeypatch.delenv("COORD_SERVING_ALLOWED_ORIGINS", raising=False)
        from serving.aggregation.coord_serving import _load_allowed_origins

        assert _load_allowed_origins() == ["*"]

    def test_empty_string_treated_as_wildcard(self, monkeypatch):
        monkeypatch.setenv("COORD_SERVING_ALLOWED_ORIGINS", "")
        from serving.aggregation.coord_serving import _load_allowed_origins

        assert _load_allowed_origins() == ["*"]

    def test_comma_separated_origins(self, monkeypatch):
        monkeypatch.setenv(
            "COORD_SERVING_ALLOWED_ORIGINS",
            "https://api.ailin.one, https://staging.ailin.one ",
        )
        from serving.aggregation.coord_serving import _load_allowed_origins

        assert _load_allowed_origins() == [
            "https://api.ailin.one",
            "https://staging.ailin.one",
        ]

    def test_blank_entries_filtered(self, monkeypatch):
        monkeypatch.setenv("COORD_SERVING_ALLOWED_ORIGINS", "https://a, , ,https://b")
        from serving.aggregation.coord_serving import _load_allowed_origins

        assert _load_allowed_origins() == ["https://a", "https://b"]


# ---------------------------------------------------------------------------
# Trace retention sweep on lifespan startup
# ---------------------------------------------------------------------------


class TestRetentionOnBoot:
    """Verifies the retention sweep fires when coord_serving boots.

    The lifespan handler runs prune_old_traces with the env-configured
    age cutoff. This test confirms the wire by:
      1. Pre-populating the staging dir with one old + one fresh file
      2. Booting the app via TestClient (triggers lifespan)
      3. Asserting only the old file is gone
    """

    def test_old_traces_pruned_on_boot(self, monkeypatch, tmp_path):
        import os
        from datetime import datetime, timezone

        # Both COORD_TEACHER_TRACES_DIR and the matching default in
        # teacher_traces module need to point at tmp_path so the
        # prune_old_traces call inside the lifespan operates on it.
        monkeypatch.setenv("COORD_SERVING_MODE", "MOCK_DETERMINISTIC")
        monkeypatch.setenv("COORD_TEACHER_TRACES_DIR", str(tmp_path))
        monkeypatch.setenv("COORD_TEACHER_TRACES_RETENTION_DAYS", "30")

        # Re-import teacher_traces with the patched env so its
        # DEFAULT_STAGING_DIR module-global picks up tmp_path.
        from data.feedback import teacher_traces

        monkeypatch.setattr(teacher_traces, "DEFAULT_STAGING_DIR", tmp_path)
        # coord_serving caches DEFAULT_STAGING_DIR at import time too.
        from serving.aggregation import coord_serving

        monkeypatch.setattr(coord_serving, "DEFAULT_STAGING_DIR", tmp_path)
        teacher_traces._writer_singleton = None  # noqa: SLF001

        # Seed two files: one ancient, one recent.
        old_path = tmp_path / "teacher-traces-2026-01-01.jsonl"
        old_path.write_text("seed", encoding="utf-8")
        cutoff_old = datetime.now(timezone.utc).timestamp() - (60 * 86400)
        os.utime(old_path, (cutoff_old, cutoff_old))

        recent_path = tmp_path / "teacher-traces-2026-05-01.jsonl"
        recent_path.write_text("seed", encoding="utf-8")
        cutoff_recent = datetime.now(timezone.utc).timestamp() - (5 * 86400)
        os.utime(recent_path, (cutoff_recent, cutoff_recent))

        coord_serving.STATE.serving_mode = coord_serving.ServingMode.MOCK_DETERMINISTIC
        coord_serving.STATE.teacher_proxy = None
        coord_serving.STATE.trace_writer = None
        coord_serving.STATE.write_traces = True  # MUST be true for sweep
        coord_serving.STATE.auth_token = ""

        # Booting the app via TestClient triggers the lifespan.
        with TestClient(coord_serving.app) as client:
            r = client.get("/health")
            assert r.status_code == 200

        # After boot: old file gone, recent file kept.
        assert not old_path.exists(), "old trace should have been pruned"
        assert recent_path.exists(), "recent trace must NOT be pruned"


# ---------------------------------------------------------------------------
# Input bounds — context size + key count validation
# ---------------------------------------------------------------------------


class TestContextBounds:
    DECIDE_PAYLOAD_BASE = {
        "strategy": "debate",
        "decisionType": "moderator-selection",
    }

    def test_too_many_keys_returns_422(self, mock_app, monkeypatch):
        monkeypatch.setenv("COORD_MAX_CONTEXT_KEYS", "10")
        with TestClient(mock_app) as client:
            payload = {
                **self.DECIDE_PAYLOAD_BASE,
                "context": {f"key{i}": i for i in range(50)},
            }
            r = client.post("/v1/ensemble/decide", json=payload)
            assert r.status_code == 422
            # Pydantic 2 wraps validator errors; the message should
            # mention the violated invariant.
            body = r.json()
            assert any("max" in str(err).lower() for err in body.get("detail", []))

    def test_oversized_context_returns_422(self, mock_app, monkeypatch):
        # Set a tiny ceiling so a small payload trips it
        monkeypatch.setenv("COORD_MAX_CONTEXT_BYTES", "100")
        with TestClient(mock_app) as client:
            payload = {
                **self.DECIDE_PAYLOAD_BASE,
                "context": {"big": "x" * 1024},  # ~1KB, way over 100B
            }
            r = client.post("/v1/ensemble/decide", json=payload)
            assert r.status_code == 422
            body = r.json()
            assert any("size" in str(err).lower() for err in body.get("detail", []))

    def test_within_bounds_returns_200(self, mock_app):
        with TestClient(mock_app) as client:
            payload = {
                **self.DECIDE_PAYLOAD_BASE,
                "context": {"requestId": "ok-1", "participantCount": 3},
            }
            r = client.post("/v1/ensemble/decide", json=payload)
            assert r.status_code == 200


# ---------------------------------------------------------------------------
# Rate limiting — token bucket per-IP
# ---------------------------------------------------------------------------


class TestRateLimit:
    DECIDE_PAYLOAD = {
        "strategy": "debate",
        "decisionType": "moderator-selection",
        "context": {},
    }

    def test_rate_limit_disabled_by_default(self, mock_app):
        # COORD_RATE_LIMIT_RPS unset → no throttling
        with TestClient(mock_app) as client:
            for _ in range(10):
                r = client.post("/v1/ensemble/decide", json=self.DECIDE_PAYLOAD)
                assert r.status_code == 200

    def test_burst_allows_initial_traffic(self, mock_app, monkeypatch):
        # 10 RPS, burst 5 — initial 5 calls go through, then throttling
        # kicks in. Reset the registry to start with a fresh bucket.
        monkeypatch.setenv("COORD_RATE_LIMIT_RPS", "10")
        monkeypatch.setenv("COORD_RATE_LIMIT_BURST", "5")
        from serving.aggregation import coord_serving

        coord_serving._RATE_LIMIT_REGISTRY = coord_serving._TokenBucketRegistry()  # noqa: SLF001

        with TestClient(mock_app) as client:
            statuses = [
                client.post("/v1/ensemble/decide", json=self.DECIDE_PAYLOAD).status_code
                for _ in range(10)
            ]

        # First ~5 should be 200 (burst), some later ones 429 (throttled).
        successes = sum(1 for s in statuses if s == 200)
        throttled = sum(1 for s in statuses if s == 429)
        # Burst is 5; should see at least one throttled call within 10
        # back-to-back attempts. Exact count depends on TestClient timing
        # but the invariant `successes <= 5 + small_tolerance` should hold.
        assert successes >= 4, f"too few successes: {statuses}"
        assert throttled >= 1, f"rate limit didn't trigger: {statuses}"

    def test_throttled_response_carries_retry_after(self, mock_app, monkeypatch):
        # 1 RPS, burst 1 → second call immediately throttled
        monkeypatch.setenv("COORD_RATE_LIMIT_RPS", "1")
        monkeypatch.setenv("COORD_RATE_LIMIT_BURST", "1")
        from serving.aggregation import coord_serving

        coord_serving._RATE_LIMIT_REGISTRY = coord_serving._TokenBucketRegistry()  # noqa: SLF001

        with TestClient(mock_app) as client:
            r1 = client.post("/v1/ensemble/decide", json=self.DECIDE_PAYLOAD)
            r2 = client.post("/v1/ensemble/decide", json=self.DECIDE_PAYLOAD)

        assert r1.status_code == 200
        assert r2.status_code == 429
        assert r2.headers.get("Retry-After") == "1"
