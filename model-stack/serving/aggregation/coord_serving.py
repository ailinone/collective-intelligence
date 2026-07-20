#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Coordinator Stable Serving — HTTP endpoint that fronts the 24-model
ensemble (or its teacher-proxy stand-in for Phase 2c).

Endpoints:
  POST /v1/ensemble/decide     — main coordination endpoint
  GET  /health                 — k8s liveness probe
  GET  /ready                  — k8s readiness probe
  GET  /metrics                — Prometheus scrape

Modes (env: COORD_SERVING_MODE):
  TEACHER_PROXY (default)      — proxy all decisions through ci-api triage
  MOCK_DETERMINISTIC           — return canned single-vote responses (Tier 1
                                 only) keyed by request shape; cheapest mode
                                 for HTTP-contract tests
  MOCK_CASCADE                 — run the full TieredEnsembleVoter with 24
                                 synthetic mock executors so the cascade
                                 (short-circuit, dissent escalation, tier
                                 failure, Tier 6 fallthrough) is exercised
                                 end-to-end through HTTP. Drop-in for
                                 REAL_ENSEMBLE — same code path, mock
                                 executors instead of vLLM.
  REAL_ENSEMBLE                — call the 24 trained students via vLLM
                                 (Phase 2c.2 — currently raises NotImplementedError)

Wire format matches the TypeScript types in
api/src/core/coordination/ensemble-coordinator-types.ts. Any change to the
request/response shape MUST be made in BOTH places.
"""

from __future__ import annotations

import hmac
import logging
import os
import time
import uuid
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from enum import Enum
from threading import Lock as _Lock
from typing import Any, Literal

import uvicorn
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Histogram,
    generate_latest,
)
from pydantic import BaseModel, Field, field_validator
from starlette.responses import Response

from data.feedback.teacher_traces import (
    DEFAULT_STAGING_DIR,
    TeacherTraceWriter,
    get_default_writer,
    prune_old_traces,
    retention_days_from_env,
)
from serving.aggregation.mock_cascade import mock_cascade_decide
from serving.aggregation.teacher_proxy import TeacherProxy, TeacherProxyConfig
from serving.aggregation.tiered_voter import (
    AggregatedDecision,
    Tier,
    TierResult,
)

logger = logging.getLogger("coord_serving")


# ---------------------------------------------------------------------------
# Modes
# ---------------------------------------------------------------------------


class ServingMode(str, Enum):
    TEACHER_PROXY = "TEACHER_PROXY"
    MOCK_DETERMINISTIC = "MOCK_DETERMINISTIC"
    MOCK_CASCADE = "MOCK_CASCADE"
    REAL_ENSEMBLE = "REAL_ENSEMBLE"


def get_serving_mode() -> ServingMode:
    raw = os.environ.get("COORD_SERVING_MODE", ServingMode.TEACHER_PROXY.value)
    try:
        return ServingMode(raw)
    except ValueError:
        logger.warning(
            "Unknown COORD_SERVING_MODE=%r; falling back to TEACHER_PROXY",
            raw,
        )
        return ServingMode.TEACHER_PROXY


# ---------------------------------------------------------------------------
# Pydantic request/response models — MUST match the TypeScript types in
# api/src/core/coordination/ensemble-coordinator-types.ts
# ---------------------------------------------------------------------------


class EnsembleOverrides(BaseModel):
    forceTier: int | None = None
    forceAggregation: Literal["weighted_bayesian_majority", "dissent_aware_synthesis"] | None = None
    skipTiers: list[int] = Field(default_factory=list)


class EnsembleDecisionRequest(BaseModel):
    strategy: Literal[
        "tri-role-collective",
        "debate",
        "expert-panel",
        "consensus",
        "parallel-race",
        "sensitivity-consensus",
    ]
    decisionType: Literal[
        "role-for-turn",
        "moderator-selection",
        "panel-composition",
        "synthesis-coordinator",
        "race-candidates",
        "aggregation-method",
    ]
    context: dict[str, Any] = Field(default_factory=dict)
    overrides: EnsembleOverrides | None = None

    @field_validator("context")
    @classmethod
    def _bound_context_size(cls, value: dict[str, Any]) -> dict[str, Any]:
        """Reject contexts that would blow up downstream serialization.

        Bearer auth blocks unauthorized callers, but an authenticated
        caller (or a buggy strategy) can still submit a context that
        explodes when we json.dumps it into the JSONL trace. The bounds
        here are conservative — well above any legitimate strategy
        payload (typical: ~500 bytes; worst observed: ~3KB) but well
        below the FastAPI default body limit (~1MB) and the Postgres
        JSONB row limit (~1GB).

        Two invariants:
          1. Re-serialized JSON must fit in COORD_MAX_CONTEXT_BYTES
             (default 64KB — gives 100x slack vs typical, refuses
             pathological recursion / large arrays before they touch
             the trace writer)
          2. Top-level key count must fit in COORD_MAX_CONTEXT_KEYS
             (default 256 — guards against dictionary bombs that pass
             the byte check via short keys)

        Configurable via env so operators can tighten in production
        without a code change.
        """
        max_bytes = int(os.environ.get("COORD_MAX_CONTEXT_BYTES", "65536"))
        max_keys = int(os.environ.get("COORD_MAX_CONTEXT_KEYS", "256"))

        if len(value) > max_keys:
            raise ValueError(
                f"context has {len(value)} keys; max {max_keys} "
                f"(set COORD_MAX_CONTEXT_KEYS to override)"
            )

        # Use json.dumps to measure post-serialization size — what
        # actually hits the trace writer. ensure_ascii=False so
        # non-ASCII chars don't inflate the count via \uXXXX escapes.
        import json as _json

        try:
            serialized = _json.dumps(value, ensure_ascii=False, default=str)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"context not JSON-serializable: {exc}") from exc

        if len(serialized.encode("utf-8")) > max_bytes:
            raise ValueError(
                f"context size {len(serialized)} bytes exceeds max {max_bytes} "
                f"(set COORD_MAX_CONTEXT_BYTES to override)"
            )
        return value


class CoordinatorVoteOut(BaseModel):
    modelId: str
    scheduler: str
    tier: int
    role: str
    reason: str
    confidence: float
    rationale: str | None = None
    features: dict[str, Any] = Field(default_factory=dict)


class TierResultOut(BaseModel):
    tier: int
    votes: list[CoordinatorVoteOut]
    failedModels: list[str] = Field(default_factory=list)
    majorityRole: str | None = None
    dissentCount: int = 0
    averageConfidence: float = 0.0


class AggregatedEnsembleDecisionOut(BaseModel):
    role: str
    reason: str
    scheduler: str
    confidence: float
    aggregationMethod: str
    tierResults: list[TierResultOut]
    voteDistribution: dict[str, int]
    totalVotes: int
    dissentCount: int
    tiersActivated: list[int]
    finalTier: int | None
    shortCircuited: bool


class TierLatencyOut(BaseModel):
    tier: int
    ms: float


class LatencyBreakdownOut(BaseModel):
    totalMs: float
    tierLatencies: list[TierLatencyOut]


class EnsembleDecisionResponse(BaseModel):
    decision: AggregatedEnsembleDecisionOut
    latencyBreakdown: LatencyBreakdownOut
    requestId: str


# ---------------------------------------------------------------------------
# Conversion: AggregatedDecision (dataclass) → AggregatedEnsembleDecisionOut
# ---------------------------------------------------------------------------


def _decision_to_output(decision: AggregatedDecision) -> AggregatedEnsembleDecisionOut:
    """Map dataclass-based AggregatedDecision to wire format."""
    return AggregatedEnsembleDecisionOut(
        role=decision.role,
        reason=decision.reason,
        scheduler=decision.scheduler,
        confidence=decision.confidence,
        aggregationMethod=decision.aggregation_method,
        tierResults=[
            TierResultOut(
                tier=int(tr.tier),
                votes=[
                    CoordinatorVoteOut(
                        modelId=v.model_id,
                        scheduler=v.scheduler,
                        tier=int(v.tier),
                        role=v.role,
                        reason=v.reason,
                        confidence=v.confidence,
                        rationale=v.rationale,
                        features=dict(v.features),
                    )
                    for v in tr.votes
                ],
                failedModels=list(tr.failed_models),
                majorityRole=tr.majority_role,
                dissentCount=tr.dissent_count,
                averageConfidence=tr.average_confidence,
            )
            for tr in decision.tier_results
        ],
        voteDistribution=dict(decision.vote_distribution),
        totalVotes=decision.total_votes,
        dissentCount=decision.dissent_count,
        tiersActivated=[int(t) for t in decision.tiers_activated],
        finalTier=int(decision.final_tier) if decision.final_tier is not None else None,
        shortCircuited=decision.short_circuited,
    )


# ---------------------------------------------------------------------------
# Mock deterministic mode — used in tests
# ---------------------------------------------------------------------------


def _mock_deterministic_decision(req: EnsembleDecisionRequest) -> AggregatedDecision:
    """Returns canned decisions keyed by (strategy, decisionType).

    Used in unit tests + load-testing the cascade aggregator without
    an upstream teacher. The shape exercises Tier 1 short-circuit so
    test latency is bounded.
    """
    role_map: dict[tuple[str, str], str] = {
        ("tri-role-collective", "role-for-turn"): "auditor",
        ("debate", "moderator-selection"): "moderator",
        ("expert-panel", "panel-composition"): "coordinator",
        ("consensus", "synthesis-coordinator"): "synthesizer",
        ("parallel-race", "race-candidates"): "candidate",
        ("sensitivity-consensus", "aggregation-method"): "weighted_confidence",
    }
    role = role_map.get((req.strategy, req.decisionType), "fallback-default")
    from .tiered_voter import CoordinatorVote

    vote = CoordinatorVote(
        model_id="mock-deterministic",
        scheduler="mock-deterministic",
        tier=Tier.ENCODER,
        role=role,
        reason="task-type-match",
        confidence=0.95,
    )
    tier_result = TierResult(tier=Tier.ENCODER, votes=(vote,))
    return AggregatedDecision(
        role=role,
        reason="task-type-match",
        scheduler="mock-deterministic",
        confidence=0.95,
        aggregation_method="mock_deterministic",
        tier_results=(tier_result,),
        vote_distribution={role: 1},
        total_votes=1,
        dissent_count=0,
        tiers_activated=(Tier.ENCODER,),
        final_tier=Tier.ENCODER,
        short_circuited=True,
    )


# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------

PROM_REGISTRY = CollectorRegistry()

REQUEST_COUNT = Counter(
    "coord_ensemble_request_total",
    "Total coordinator-ensemble requests",
    ["mode", "strategy", "decision_type", "status"],
    registry=PROM_REGISTRY,
)
REQUEST_LATENCY = Histogram(
    "coord_ensemble_request_latency_seconds",
    "End-to-end ensemble decision latency",
    ["mode", "strategy"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0),
    registry=PROM_REGISTRY,
)
TRACE_WRITES = Counter(
    "coord_ensemble_trace_writes_total",
    "Total teacher-trace records written to F3.3 staging",
    ["status"],
    registry=PROM_REGISTRY,
)


# ---------------------------------------------------------------------------
# Application state — initialized on startup, not at import time
# ---------------------------------------------------------------------------


class AppState:
    serving_mode: ServingMode = ServingMode.TEACHER_PROXY
    teacher_proxy: TeacherProxy | None = None
    trace_writer: TeacherTraceWriter | None = None
    write_traces: bool = True
    # Bearer token gating /v1/ensemble/decide. Empty string disables auth
    # (dev / single-tenant compose). When set, callers must pass
    # `Authorization: Bearer <token>` matching exactly. Health probes
    # (/health, /ready, /metrics) are intentionally unauthenticated so
    # k8s/swarm orchestrators can read them without a credential.
    auth_token: str = ""


STATE = AppState()


def _require_auth(authorization: str | None = Header(default=None)) -> None:
    """FastAPI dependency: verify Bearer token when configured.

    No-op when STATE.auth_token is empty (dev default). When set,
    rejects 401 unless the Authorization header matches exactly via
    `hmac.compare_digest` to avoid timing leaks. The header check is
    case-insensitive on the "Bearer" prefix per RFC 6750.
    """
    if not STATE.auth_token:
        return  # auth disabled
    if not authorization:
        raise HTTPException(status_code=401, detail="missing Authorization header")
    parts = authorization.split(maxsplit=1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="malformed Authorization header")
    presented = parts[1].strip()
    if not hmac.compare_digest(presented, STATE.auth_token):
        raise HTTPException(status_code=401, detail="invalid token")


# ---------------------------------------------------------------------------
# Rate limiting — token bucket per client IP, in-memory
# ---------------------------------------------------------------------------
#
# Bearer auth blocks unauthorized callers but an authenticated caller can
# still DoS the service via runaway loops or buggy retries. The bucket
# refills at COORD_RATE_LIMIT_RPS tokens/sec with a burst of
# COORD_RATE_LIMIT_BURST. Default 100 RPS / 200 burst — well above any
# legitimate strategy traffic (typical: 1-10 RPS sustained per gateway
# instance), but tight enough to fast-fail a runaway in milliseconds.
#
# In-memory state is the right scope: each coord-serving replica enforces
# its own bucket. A multi-replica setup would need redis or the load
# balancer's rate-limiter; that's out of scope here. The container is
# small and stateless so per-replica is fine for the scale this serves.


class _TokenBucket:
    """Simple thread-safe token bucket. Math is: tokens += elapsed * rps,
    clamped to burst; consume returns False when no token available.

    Per-IP state is held in `_TokenBucketRegistry`. Eviction (to bound
    memory under sustained traffic from many distinct IPs) happens
    lazily — when an IP hasn't been seen for >5min, its entry is
    removed on the next sweep.
    """

    __slots__ = ("tokens", "last_refill")

    def __init__(self, initial_tokens: float, now: float) -> None:
        self.tokens = initial_tokens
        self.last_refill = now

    def consume(self, rps: float, burst: float, now: float) -> bool:
        elapsed = max(0.0, now - self.last_refill)
        self.tokens = min(burst, self.tokens + elapsed * rps)
        self.last_refill = now
        if self.tokens < 1.0:
            return False
        self.tokens -= 1.0
        return True


class _TokenBucketRegistry:
    """Per-key token-bucket store with lazy eviction.

    The lock is short-held — only the bucket lookup + creation. Bucket
    math runs without the lock since each bucket has its own fields
    that are touched by at most one request at a time per IP (FastAPI
    serializes per-connection).
    """

    EVICTION_AGE_SECONDS = 300  # 5min idle → drop

    def __init__(self) -> None:
        self._buckets: dict[str, _TokenBucket] = {}
        self._lock = _Lock()
        self._last_sweep = 0.0

    def consume(self, key: str, rps: float, burst: float) -> bool:
        now = time.monotonic()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                bucket = _TokenBucket(initial_tokens=burst, now=now)
                self._buckets[key] = bucket
            # Sweep expired entries opportunistically (every 60s)
            if now - self._last_sweep > 60.0:
                stale = [
                    k
                    for k, b in self._buckets.items()
                    if now - b.last_refill > self.EVICTION_AGE_SECONDS
                ]
                for k in stale:
                    del self._buckets[k]
                self._last_sweep = now
        return bucket.consume(rps, burst, now)


_RATE_LIMIT_REGISTRY = _TokenBucketRegistry()


def _require_rate_limit(request: Request) -> None:
    """FastAPI dependency: throttle per-IP via token bucket.

    Disabled when COORD_RATE_LIMIT_RPS=0 (the default). Operator opts
    in by setting it to a positive number. Burst defaults to 2*rps but
    is independently configurable.

    Rejected requests get 429 Too Many Requests with a `Retry-After`
    header indicating ~1s (long enough to refill, short enough that
    well-behaved clients converge quickly).
    """
    rps = float(os.environ.get("COORD_RATE_LIMIT_RPS", "0"))
    if rps <= 0:
        return  # rate limiting disabled
    burst = float(os.environ.get("COORD_RATE_LIMIT_BURST", str(rps * 2)))

    # Trust the X-Forwarded-For header from the gateway when present
    # (proxy_headers=True on uvicorn already populated request.client
    # accordingly). Falls back to the direct client address.
    client = request.client
    key = client.host if client else "unknown"

    if not _RATE_LIMIT_REGISTRY.consume(key, rps=rps, burst=burst):
        raise HTTPException(
            status_code=429,
            detail="rate limit exceeded",
            headers={"Retry-After": "1"},
        )


# ---------------------------------------------------------------------------
# FastAPI lifespan
# ---------------------------------------------------------------------------


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Startup + shutdown hooks."""
    STATE.serving_mode = get_serving_mode()
    STATE.auth_token = os.environ.get("COORD_SERVING_AUTH_TOKEN", "").strip()
    logger.info(
        "coord_serving starting in mode=%s auth=%s",
        STATE.serving_mode.value,
        "enabled" if STATE.auth_token else "disabled",
    )

    if STATE.serving_mode == ServingMode.TEACHER_PROXY:
        STATE.teacher_proxy = TeacherProxy(TeacherProxyConfig.from_env())
    elif STATE.serving_mode == ServingMode.REAL_ENSEMBLE:
        # Phase 2c.2 — wire vLLM clients here.
        raise NotImplementedError(
            "REAL_ENSEMBLE mode requires the 24 students trained and served. "
            "Use TEACHER_PROXY or MOCK_CASCADE mode until Phase 2b training completes."
        )
    # MOCK_DETERMINISTIC and MOCK_CASCADE need no setup — both are stateless.

    if STATE.write_traces:
        try:
            STATE.trace_writer = get_default_writer()
        except OSError as exc:
            logger.warning("Trace writer init failed (%s); traces disabled", exc)
            STATE.trace_writer = None

        # Best-effort retention sweep on every container boot. Containers
        # restart often enough (deploys, OOM, scaling) that this gives
        # us "at least daily" pruning without a separate cron. Runs
        # AFTER the writer init so a sweep failure can't prevent the
        # writer from coming up.
        try:
            retention_days = retention_days_from_env()
            removed = prune_old_traces(DEFAULT_STAGING_DIR, max_age_days=retention_days)
            if removed:
                logger.info(
                    "Pruned %d trace files older than %d days on boot",
                    len(removed),
                    retention_days,
                )
        except OSError as exc:
            logger.warning("Retention sweep failed (%s); continuing", exc)

    yield

    logger.info("coord_serving shutting down")


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Ailin Coordinator Stable",
    version="0.1.0-phase-2c",
    lifespan=lifespan,
)


def _load_allowed_origins() -> list[str]:
    """Read COORD_SERVING_ALLOWED_ORIGINS — comma-separated allowlist.

    Default is `*` (open) — appropriate for dev / single-tenant compose
    where coord-serving sits on a private network. Production should
    set this to the api hostname(s) only, e.g.:

        COORD_SERVING_ALLOWED_ORIGINS=https://api.ailin.one

    Empty string is also treated as `*` for safety (a missing env var
    should not silently disable CORS — the operator must opt-in to
    tightening explicitly).
    """
    raw = os.environ.get("COORD_SERVING_ALLOWED_ORIGINS", "").strip()
    if not raw:
        return ["*"]
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_load_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["authorization", "content-type", "x-request-id"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "mode": STATE.serving_mode.value}


@app.get("/ready")
async def ready() -> dict[str, Any]:
    """Readiness probe — true once mode-specific setup completes."""
    is_ready = True
    detail: dict[str, Any] = {"mode": STATE.serving_mode.value}
    if STATE.serving_mode == ServingMode.TEACHER_PROXY:
        is_ready = STATE.teacher_proxy is not None
        detail["teacher_proxy_initialized"] = is_ready
    elif STATE.serving_mode == ServingMode.REAL_ENSEMBLE:
        is_ready = False
        detail["error"] = "REAL_ENSEMBLE not implemented"
    # MOCK_DETERMINISTIC and MOCK_CASCADE are always ready.
    return {"ready": is_ready, **detail}


@app.get("/metrics")
async def metrics() -> Response:
    return Response(content=generate_latest(PROM_REGISTRY), media_type=CONTENT_TYPE_LATEST)


@app.post(
    "/v1/ensemble/decide",
    response_model=EnsembleDecisionResponse,
    dependencies=[Depends(_require_rate_limit), Depends(_require_auth)],
)
async def decide(req: EnsembleDecisionRequest, request: Request) -> EnsembleDecisionResponse:
    """The main ensemble decision endpoint.

    See module docstring for mode dispatch. Always returns a valid
    AggregatedEnsembleDecisionOut even on internal failures — the
    `reason` field carries the failure code.
    """
    request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
    start = time.perf_counter()
    status = "ok"

    try:
        if STATE.serving_mode == ServingMode.MOCK_DETERMINISTIC:
            decision = _mock_deterministic_decision(req)
        elif STATE.serving_mode == ServingMode.MOCK_CASCADE:
            decision = await mock_cascade_decide(
                strategy=req.strategy,
                decision_type=req.decisionType,
                context=req.context,
            )
        elif STATE.serving_mode == ServingMode.TEACHER_PROXY:
            if STATE.teacher_proxy is None:
                raise HTTPException(status_code=503, detail="teacher_proxy not initialized")
            decision = await STATE.teacher_proxy.decide(
                strategy=req.strategy,
                decision_type=req.decisionType,
                context=req.context,
            )
        else:
            raise HTTPException(status_code=501, detail="REAL_ENSEMBLE not implemented")

        # Best-effort trace logging — never blocks the response on failure.
        if STATE.trace_writer is not None and STATE.write_traces:
            try:
                STATE.trace_writer.append(
                    strategy=req.strategy,
                    decision_type=req.decisionType,
                    request_context=req.context,
                    decision=decision,
                )
                TRACE_WRITES.labels(status="ok").inc()
            except Exception as trace_exc:  # noqa: BLE001
                logger.warning("Trace write failed (non-fatal): %s", trace_exc)
                TRACE_WRITES.labels(status="error").inc()

        elapsed_total_ms = (time.perf_counter() - start) * 1000
        REQUEST_LATENCY.labels(mode=STATE.serving_mode.value, strategy=req.strategy).observe(
            elapsed_total_ms / 1000.0
        )
        REQUEST_COUNT.labels(
            mode=STATE.serving_mode.value,
            strategy=req.strategy,
            decision_type=req.decisionType,
            status=status,
        ).inc()

        return EnsembleDecisionResponse(
            decision=_decision_to_output(decision),
            latencyBreakdown=LatencyBreakdownOut(
                totalMs=elapsed_total_ms,
                # Phase 2c only has Tier-1 effective; per-tier breakdown
                # comes in Phase 2c.2 with REAL_ENSEMBLE.
                tierLatencies=[TierLatencyOut(tier=1, ms=elapsed_total_ms)],
            ),
            requestId=request_id,
        )
    except HTTPException:
        status = "http_error"
        REQUEST_COUNT.labels(
            mode=STATE.serving_mode.value,
            strategy=req.strategy,
            decision_type=req.decisionType,
            status=status,
        ).inc()
        raise
    except Exception as exc:  # noqa: BLE001
        status = "internal_error"
        REQUEST_COUNT.labels(
            mode=STATE.serving_mode.value,
            strategy=req.strategy,
            decision_type=req.decisionType,
            status=status,
        ).inc()
        logger.exception("decide() internal error: %s", exc)
        raise HTTPException(
            status_code=500, detail=f"internal error: {type(exc).__name__}"
        ) from exc


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO").upper(),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    host = os.environ.get("COORD_SERVING_HOST", "0.0.0.0")
    port = int(os.environ.get("COORD_SERVING_PORT", "8090"))
    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=os.environ.get("LOG_LEVEL", "info").lower(),
    )


if __name__ == "__main__":
    main()
