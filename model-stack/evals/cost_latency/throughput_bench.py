#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Throughput and latency benchmark.

Sends concurrent requests to a serving endpoint and measures:
- Time to first token (TTFT)
- Tokens per second (TPS) per request
- Total latency per request
- Aggregate throughput (requests/sec, tokens/sec)
- Percentile breakdowns (p50, p90, p95, p99)
"""

from __future__ import annotations

import asyncio
import json
import logging
import statistics
import time
from dataclasses import dataclass, field
from typing import Any

import httpx

logger = logging.getLogger("throughput_bench")


# ---------------------------------------------------------------------------
# Test prompts (varying length)
# ---------------------------------------------------------------------------

TEST_PROMPTS: list[dict[str, Any]] = [
    {"prompt": "Explain the theory of relativity in one paragraph.", "max_tokens": 128},
    {"prompt": "Write a short Python function to compute Fibonacci numbers.", "max_tokens": 128},
    {"prompt": "What are the three laws of thermodynamics?", "max_tokens": 128},
    {"prompt": "Summarize the history of the Roman Empire.", "max_tokens": 256},
    {"prompt": "Describe how a compiler works, step by step.", "max_tokens": 256},
    {"prompt": "Explain the difference between SQL and NoSQL databases.", "max_tokens": 128},
    {"prompt": "Write a haiku about mountains.", "max_tokens": 64},
    {"prompt": "What is the Turing test and why is it significant?", "max_tokens": 128},
]


# ---------------------------------------------------------------------------
# Single request measurement
# ---------------------------------------------------------------------------

@dataclass
class RequestResult:
    prompt_index: int
    ttft_ms: float = 0.0         # time to first token
    total_latency_ms: float = 0.0
    tokens_generated: int = 0
    tps: float = 0.0             # tokens per second
    status_code: int = 0
    error: str = ""


async def measure_streaming_request(
    client: httpx.AsyncClient,
    endpoint: str,
    prompt: str,
    max_tokens: int,
    prompt_index: int,
) -> RequestResult:
    """Send a single streaming request and measure timing."""
    result = RequestResult(prompt_index=prompt_index)
    start = time.perf_counter()
    first_token_time: float | None = None
    tokens = 0

    try:
        async with client.stream(
            "POST",
            f"{endpoint}/v1/completions",
            json={
                "prompt": prompt,
                "max_tokens": max_tokens,
                "temperature": 0.7,
                "stream": True,
            },
            timeout=60.0,
        ) as resp:
            result.status_code = resp.status_code
            if resp.status_code != 200:
                result.error = f"HTTP {resp.status_code}"
                return result

            async for line in resp.aiter_lines():
                if not line.startswith("data: "):
                    continue
                payload = line[6:].strip()
                if payload == "[DONE]":
                    break
                try:
                    data = json.loads(payload)
                    text = data.get("choices", [{}])[0].get("text", "")
                    if text and first_token_time is None:
                        first_token_time = time.perf_counter()
                    tokens += len(text.split()) if text else 0
                except json.JSONDecodeError:
                    continue

    except Exception as exc:
        result.error = str(exc)
        return result

    end = time.perf_counter()
    result.total_latency_ms = (end - start) * 1000
    if first_token_time is not None:
        result.ttft_ms = (first_token_time - start) * 1000
    result.tokens_generated = tokens
    duration_secs = max((end - start), 1e-6)
    result.tps = tokens / duration_secs
    return result


async def measure_non_streaming_request(
    client: httpx.AsyncClient,
    endpoint: str,
    prompt: str,
    max_tokens: int,
    prompt_index: int,
) -> RequestResult:
    """Non-streaming fallback."""
    result = RequestResult(prompt_index=prompt_index)
    start = time.perf_counter()

    try:
        resp = await client.post(
            f"{endpoint}/v1/completions",
            json={
                "prompt": prompt,
                "max_tokens": max_tokens,
                "temperature": 0.7,
            },
            timeout=60.0,
        )
        result.status_code = resp.status_code
        if resp.status_code != 200:
            result.error = f"HTTP {resp.status_code}"
            return result

        data = resp.json()
        usage = data.get("usage", {})
        result.tokens_generated = usage.get("completion_tokens", 0)

    except Exception as exc:
        result.error = str(exc)
        return result

    end = time.perf_counter()
    result.total_latency_ms = (end - start) * 1000
    result.ttft_ms = result.total_latency_ms  # approximation
    duration_secs = max((end - start), 1e-6)
    result.tps = result.tokens_generated / duration_secs
    return result


# ---------------------------------------------------------------------------
# Benchmark driver
# ---------------------------------------------------------------------------

def _percentiles(values: list[float], ps: list[int]) -> dict[str, float]:
    if not values:
        return {f"p{p}": 0.0 for p in ps}
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    result = {}
    for p in ps:
        idx = int(p / 100.0 * n)
        idx = min(idx, n - 1)
        result[f"p{p}"] = round(sorted_vals[idx], 2)
    return result


async def run_benchmark(
    endpoint: str,
    concurrency_levels: list[int],
    requests_per_level: int = 20,
    use_streaming: bool = True,
) -> tuple[dict[str, float], list[dict]]:
    """Run the benchmark at each concurrency level."""
    all_results: list[RequestResult] = []
    level_metrics: list[dict] = []

    async with httpx.AsyncClient() as client:
        for concurrency in concurrency_levels:
            logger.info("Running at concurrency=%d (%d requests) ...", concurrency, requests_per_level)
            tasks = []
            for i in range(requests_per_level):
                p = TEST_PROMPTS[i % len(TEST_PROMPTS)]
                if use_streaming:
                    coro = measure_streaming_request(client, endpoint, p["prompt"], p["max_tokens"], i)
                else:
                    coro = measure_non_streaming_request(client, endpoint, p["prompt"], p["max_tokens"], i)
                tasks.append(coro)

            # Run in batches of *concurrency*
            level_results: list[RequestResult] = []
            start_level = time.perf_counter()

            for batch_start in range(0, len(tasks), concurrency):
                batch = tasks[batch_start : batch_start + concurrency]
                batch_results = await asyncio.gather(*batch, return_exceptions=True)
                for r in batch_results:
                    if isinstance(r, Exception):
                        level_results.append(RequestResult(prompt_index=-1, error=str(r)))
                    else:
                        level_results.append(r)

            elapsed_level = time.perf_counter() - start_level

            all_results.extend(level_results)

            # Compute level stats
            ok_results = [r for r in level_results if not r.error]
            ttfts = [r.ttft_ms for r in ok_results if r.ttft_ms > 0]
            latencies = [r.total_latency_ms for r in ok_results]
            tps_values = [r.tps for r in ok_results if r.tps > 0]
            total_tokens = sum(r.tokens_generated for r in ok_results)

            level_meta = {
                "concurrency": concurrency,
                "total_requests": requests_per_level,
                "successful": len(ok_results),
                "failed": len(level_results) - len(ok_results),
                "wall_time_s": round(elapsed_level, 2),
                "requests_per_sec": round(len(ok_results) / max(elapsed_level, 1e-6), 2),
                "tokens_per_sec": round(total_tokens / max(elapsed_level, 1e-6), 2),
                "ttft": _percentiles(ttfts, [50, 90, 95, 99]),
                "latency": _percentiles(latencies, [50, 90, 95, 99]),
                "tps": _percentiles(tps_values, [50, 90, 95, 99]),
            }
            level_metrics.append(level_meta)
            logger.info(
                "  concurrency=%d  rps=%.1f  tok/s=%.1f  latency_p50=%.0fms  ttft_p50=%.0fms",
                concurrency,
                level_meta["requests_per_sec"],
                level_meta["tokens_per_sec"],
                level_meta["latency"].get("p50", 0),
                level_meta["ttft"].get("p50", 0),
            )

    # Aggregate metrics (from the highest concurrency level)
    agg = level_metrics[-1] if level_metrics else {}
    metrics: dict[str, float] = {
        "max_concurrency": concurrency_levels[-1] if concurrency_levels else 0,
        "requests_per_sec": agg.get("requests_per_sec", 0),
        "tokens_per_sec": agg.get("tokens_per_sec", 0),
        "latency_p50_ms": agg.get("latency", {}).get("p50", 0),
        "latency_p95_ms": agg.get("latency", {}).get("p95", 0),
        "latency_p99_ms": agg.get("latency", {}).get("p99", 0),
        "ttft_p50_ms": agg.get("ttft", {}).get("p50", 0),
        "ttft_p95_ms": agg.get("ttft", {}).get("p95", 0),
        "ttft_p99_ms": agg.get("ttft", {}).get("p99", 0),
    }

    return metrics, level_metrics


# ---------------------------------------------------------------------------
# Entry point for eval runner
# ---------------------------------------------------------------------------

def run(
    client,
    num_samples: int | None = None,
    concurrency_levels: list[int] | None = None,
    **_kwargs,
) -> tuple[dict[str, float], Any]:
    """Called by the central eval runner.

    Requires client.endpoint to be set (remote serving).
    """
    if not client.is_remote():
        return {"error": 1.0}, {"message": "Throughput bench requires a remote endpoint"}

    if concurrency_levels is None:
        concurrency_levels = [1, 4, 8, 16]

    requests_per_level = num_samples or 20

    metrics, details = asyncio.run(
        run_benchmark(
            endpoint=client.endpoint,
            concurrency_levels=concurrency_levels,
            requests_per_level=requests_per_level,
        )
    )
    return metrics, details
