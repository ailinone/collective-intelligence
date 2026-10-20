#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""vLLM-based model serving runtime with OpenAI-compatible API."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import signal
import sys
import time
import uuid
from collections.abc import AsyncGenerator, AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import FrameType
from typing import Any

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    CollectorRegistry,
    Counter,
    Gauge,
    Histogram,
    generate_latest,
)
from pydantic import BaseModel
from starlette.responses import Response

logger = logging.getLogger("serve")

# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------
PROM_REGISTRY = CollectorRegistry()

REQUEST_COUNT = Counter(
    "serving_request_total",
    "Total inference requests",
    ["endpoint", "status"],
    registry=PROM_REGISTRY,
)
REQUEST_LATENCY = Histogram(
    "serving_request_latency_seconds",
    "Request latency in seconds",
    ["endpoint"],
    buckets=(0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0),
    registry=PROM_REGISTRY,
)
TOKENS_GENERATED = Counter(
    "serving_tokens_generated_total",
    "Total tokens generated",
    registry=PROM_REGISTRY,
)
ACTIVE_REQUESTS = Gauge(
    "serving_active_requests",
    "Currently in-flight requests",
    registry=PROM_REGISTRY,
)
MODEL_LOADED = Gauge(
    "serving_model_loaded",
    "1 if model is loaded and ready",
    registry=PROM_REGISTRY,
)

# ---------------------------------------------------------------------------
# Request / response schemas (OpenAI-compatible)
# ---------------------------------------------------------------------------


class ChatMessage(BaseModel):
    role: str
    content: str
    name: str | None = None


class ChatCompletionRequest(BaseModel):
    model: str = ""
    messages: list[ChatMessage]
    temperature: float = 0.7
    top_p: float = 1.0
    max_tokens: int | None = None
    stream: bool = False
    stop: list[str] | None = None
    frequency_penalty: float = 0.0
    presence_penalty: float = 0.0
    n: int = 1


class CompletionRequest(BaseModel):
    model: str = ""
    prompt: str | list[str]
    temperature: float = 0.7
    top_p: float = 1.0
    max_tokens: int | None = 256
    stream: bool = False
    stop: list[str] | None = None
    n: int = 1


class UsageInfo(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: str | None = "stop"


class ChatCompletionResponse(BaseModel):
    id: str
    object: str = "chat.completion"
    created: int
    model: str
    choices: list[ChatChoice]
    usage: UsageInfo


class CompletionChoice(BaseModel):
    index: int = 0
    text: str
    finish_reason: str | None = "stop"


class CompletionResponse(BaseModel):
    id: str
    object: str = "text_completion"
    created: int
    model: str
    choices: list[CompletionChoice]
    usage: UsageInfo


# ---------------------------------------------------------------------------
# Engine wrapper
# ---------------------------------------------------------------------------


@dataclass
class EngineConfig:
    model_path: str = ""
    tensor_parallel_size: int = 1
    max_model_len: int = 4096
    gpu_memory_utilization: float = 0.90
    dtype: str = "auto"
    trust_remote_code: bool = False
    quantization: str | None = None
    enforce_eager: bool = False
    # 2026-10-20 — swap_space removed: vLLM V1 dropped the V0 CPU-swap
    # preemption knob (validated against EngineArgs v0.32.0 — no field).
    # V1 preempts by recomputation; offload needs are expressed via
    # cpu_offload_gb / kv_offloading_* when required.
    max_num_seqs: int = 256
    seed: int = 0
    # 2026-10-19 — V1-era options. FP8 KV cache halves KV memory on
    # capable GPUs (Ada/Hopper+); "auto" keeps the checkpoint default.
    kv_cache_dtype: str = "auto"
    # Prefix caching is on by default in vLLM V1; explicit so the config
    # is self-documenting for the orchestration gateway's system prompts
    # (large shared prefixes → big hit-rate wins).
    enable_prefix_caching: bool = True


class VLLMEngine:
    """Wraps vLLM's AsyncLLM (V1 engine) for serving.

    2026-10-19 — migrated off the removed V0 API
    (``vllm.engine.async_llm_engine.AsyncLLMEngine`` + ``AsyncEngineArgs``,
    dead since vLLM ~0.9) to the V1 engine ``AsyncLLM``. Import paths are
    the canonical submodules: vLLM 0.32 does NOT export ``AsyncLLM`` from
    the package top level (validated against vllm/__init__.py v0.32.0 —
    ``MODULE_ATTRS`` has ``AsyncLLMEngine`` as a V1 alias, but no
    ``AsyncLLM``), so the direct import raises ImportError.
    ``generate()`` semantics are unchanged: async iterator of RequestOutput.
    """

    def __init__(self, config: EngineConfig) -> None:
        self.config = config
        # vllm is imported lazily in start() (heavy import, not installed in
        # the lint env), so the engine handle can only be Any.
        self.engine: Any = None
        self.model_name: str = config.model_path.rstrip("/").split("/")[-1]
        self._ready = False

    async def start(self) -> None:
        # Canonical V1 imports — see class docstring (no top-level AsyncLLM).
        from vllm.engine.arg_utils import EngineArgs
        from vllm.v1.engine.async_llm import AsyncLLM

        engine_args = EngineArgs(
            model=self.config.model_path,
            tensor_parallel_size=self.config.tensor_parallel_size,
            max_model_len=self.config.max_model_len,
            gpu_memory_utilization=self.config.gpu_memory_utilization,
            dtype=self.config.dtype,
            trust_remote_code=self.config.trust_remote_code,
            quantization=self.config.quantization,
            enforce_eager=self.config.enforce_eager,
            max_num_seqs=self.config.max_num_seqs,
            seed=self.config.seed,
            kv_cache_dtype=self.config.kv_cache_dtype,
            enable_prefix_caching=self.config.enable_prefix_caching,
        )
        self.engine = AsyncLLM.from_engine_args(engine_args)
        self._ready = True
        MODEL_LOADED.set(1)
        logger.info("Engine loaded model %s", self.config.model_path)

    @property
    def ready(self) -> bool:
        return self._ready

    async def generate(
        self,
        prompt: str,
        request_id: str,
        temperature: float = 0.7,
        top_p: float = 1.0,
        max_tokens: int = 256,
        stop: list[str] | None = None,
        stream: bool = False,
        frequency_penalty: float = 0.0,
        presence_penalty: float = 0.0,
    ) -> AsyncGenerator[dict[str, Any], None]:
        from vllm import SamplingParams

        sampling_params = SamplingParams(
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            stop=stop or [],
            frequency_penalty=frequency_penalty,
            presence_penalty=presence_penalty,
        )

        if self.engine is None:
            # 2026-10-18 — real bug fix: calling generate() before start()
            # used to crash with AttributeError on None; fail loudly instead.
            raise RuntimeError("engine not started — call start() first")
        results_generator = self.engine.generate(prompt, sampling_params, request_id)

        previous_text = ""
        async for request_output in results_generator:
            output = request_output.outputs[0]
            delta = output.text[len(previous_text) :]
            previous_text = output.text
            finished = output.finish_reason is not None

            yield {
                "text": output.text,
                "delta": delta,
                "finish_reason": output.finish_reason,
                "prompt_tokens": len(request_output.prompt_token_ids),
                "completion_tokens": len(output.token_ids),
                "finished": finished,
            }

    async def shutdown(self) -> None:
        self._ready = False
        MODEL_LOADED.set(0)
        if self.engine is not None:
            # V1 AsyncLLM exposes an async shutdown() (stops the background
            # engine core process); guard for builds where it is absent.
            shutdown = getattr(self.engine, "shutdown", None)
            if shutdown is not None:
                result = shutdown()
                if asyncio.iscoroutine(result):
                    await result
            del self.engine
            self.engine = None
        logger.info("Engine shut down")


# ---------------------------------------------------------------------------
# Application factory
# ---------------------------------------------------------------------------

_engine: VLLMEngine | None = None
_shutdown_event = asyncio.Event()


def _build_chat_prompt(messages: list[ChatMessage]) -> str:
    """Simple chat template (override per-model via tokenizer chat template)."""
    parts: list[str] = []
    for m in messages:
        if m.role == "system":
            parts.append(f"<|system|>\n{m.content}")
        elif m.role == "user":
            parts.append(f"<|user|>\n{m.content}")
        elif m.role == "assistant":
            parts.append(f"<|assistant|>\n{m.content}")
    parts.append("<|assistant|>\n")
    return "\n".join(parts)


def create_app(config: EngineConfig) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        global _engine
        _engine = VLLMEngine(config)
        await _engine.start()
        logger.info(
            "Serving %s on tensor_parallel=%d", config.model_path, config.tensor_parallel_size
        )
        yield
        logger.info("Shutting down engine ...")
        await _engine.shutdown()

    app = FastAPI(title="CI Model Serving", lifespan=lifespan)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # --- request logging middleware ---
    @app.middleware("http")
    async def log_requests(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        start = time.perf_counter()
        response = await call_next(request)
        elapsed = time.perf_counter() - start
        logger.info(
            "%s %s %s %.3fs",
            request.method,
            request.url.path,
            response.status_code,
            elapsed,
        )
        return response

    # --- health / readiness ---
    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/ready")
    async def ready() -> dict[str, str]:
        if _engine is None or not _engine.ready:
            raise HTTPException(503, detail="Model not ready")
        return {"status": "ready"}

    # --- graceful shutdown via HTTP ---
    @app.post("/shutdown")
    async def shutdown() -> dict[str, str]:
        """Graceful shutdown endpoint used by deploy/rollback scripts."""
        logger.info("Received /shutdown request — initiating graceful shutdown")
        # Signal uvicorn to stop after responding
        asyncio.get_event_loop().call_later(1.0, lambda: sys.exit(0))
        return {"status": "shutting_down"}

    # --- Prometheus metrics ---
    @app.get("/metrics")
    async def metrics() -> Response:
        return Response(
            content=generate_latest(PROM_REGISTRY),
            media_type=CONTENT_TYPE_LATEST,
        )

    # --- list models ---
    @app.get("/v1/models")
    async def list_models() -> dict[str, Any]:
        models: list[dict[str, Any]] = []
        if _engine is not None:
            models.append(
                {
                    "id": _engine.model_name,
                    "object": "model",
                    "created": int(time.time()),
                    "owned_by": "ci-model-stack",
                }
            )
        return {"object": "list", "data": models}

    # --- chat completions ---
    @app.post("/v1/chat/completions")
    async def chat_completions(
        req: ChatCompletionRequest,
    ) -> ChatCompletionResponse | StreamingResponse:
        if _engine is None or not _engine.ready:
            raise HTTPException(503, detail="Engine not ready")

        request_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        prompt = _build_chat_prompt(req.messages)

        ACTIVE_REQUESTS.inc()
        start = time.perf_counter()

        try:
            if req.stream:
                return StreamingResponse(
                    _stream_chat(request_id, prompt, req),
                    media_type="text/event-stream",
                )
            # non-streaming
            final: dict[str, Any] = {}
            async for chunk in _engine.generate(
                prompt=prompt,
                request_id=request_id,
                temperature=req.temperature,
                top_p=req.top_p,
                max_tokens=req.max_tokens or 512,
                stop=req.stop,
                frequency_penalty=req.frequency_penalty,
                presence_penalty=req.presence_penalty,
            ):
                final = chunk

            elapsed = time.perf_counter() - start
            REQUEST_LATENCY.labels(endpoint="chat_completions").observe(elapsed)
            REQUEST_COUNT.labels(endpoint="chat_completions", status="ok").inc()
            TOKENS_GENERATED.inc(final.get("completion_tokens", 0))

            return ChatCompletionResponse(
                id=request_id,
                created=int(time.time()),
                model=_engine.model_name,
                choices=[
                    ChatChoice(
                        index=0,
                        message=ChatMessage(role="assistant", content=final["text"]),
                        finish_reason=final.get("finish_reason", "stop"),
                    )
                ],
                usage=UsageInfo(
                    prompt_tokens=final.get("prompt_tokens", 0),
                    completion_tokens=final.get("completion_tokens", 0),
                    total_tokens=final.get("prompt_tokens", 0) + final.get("completion_tokens", 0),
                ),
            )
        except Exception as exc:
            REQUEST_COUNT.labels(endpoint="chat_completions", status="error").inc()
            logger.exception("chat_completions error")
            raise HTTPException(500, detail=str(exc)) from exc
        finally:
            ACTIVE_REQUESTS.dec()

    async def _stream_chat(
        request_id: str, prompt: str, req: ChatCompletionRequest
    ) -> AsyncGenerator[str, None]:
        try:
            # 2026-10-18 — capture + narrow the module-global engine; it is
            # Optional and could be torn down while a stream is in flight.
            engine = _engine
            if engine is None:
                raise RuntimeError("engine unavailable during stream")
            async for chunk in engine.generate(
                prompt=prompt,
                request_id=request_id,
                temperature=req.temperature,
                top_p=req.top_p,
                max_tokens=req.max_tokens or 512,
                stop=req.stop,
                stream=True,
                frequency_penalty=req.frequency_penalty,
                presence_penalty=req.presence_penalty,
            ):
                delta_payload = {
                    "id": request_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": engine.model_name,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {"content": chunk["delta"]},
                            "finish_reason": chunk.get("finish_reason"),
                        }
                    ],
                }
                yield f"data: {json.dumps(delta_payload)}\n\n"

                if chunk.get("finished"):
                    TOKENS_GENERATED.inc(chunk.get("completion_tokens", 0))
                    REQUEST_COUNT.labels(endpoint="chat_completions", status="ok").inc()

            yield "data: [DONE]\n\n"
        except Exception:
            logger.exception("streaming error")
            yield f"data: {json.dumps({'error': 'internal error'})}\n\n"
        finally:
            ACTIVE_REQUESTS.dec()

    # --- completions ---
    @app.post("/v1/completions")
    async def completions(
        req: CompletionRequest,
    ) -> CompletionResponse | StreamingResponse:
        if _engine is None or not _engine.ready:
            raise HTTPException(503, detail="Engine not ready")

        prompts = [req.prompt] if isinstance(req.prompt, str) else req.prompt
        request_id = f"cmpl-{uuid.uuid4().hex[:24]}"

        ACTIVE_REQUESTS.inc()
        start = time.perf_counter()

        try:
            if req.stream:
                return StreamingResponse(
                    _stream_completion(request_id, prompts[0], req),
                    media_type="text/event-stream",
                )

            choices: list[CompletionChoice] = []
            total_prompt_tokens = 0
            total_completion_tokens = 0

            for idx, prompt_text in enumerate(prompts):
                final: dict[str, Any] = {}
                async for chunk in _engine.generate(
                    prompt=prompt_text,
                    request_id=f"{request_id}-{idx}",
                    temperature=req.temperature,
                    top_p=req.top_p,
                    max_tokens=req.max_tokens or 256,
                    stop=req.stop,
                ):
                    final = chunk

                choices.append(
                    CompletionChoice(
                        index=idx,
                        text=final.get("text", ""),
                        finish_reason=final.get("finish_reason", "stop"),
                    )
                )
                total_prompt_tokens += final.get("prompt_tokens", 0)
                total_completion_tokens += final.get("completion_tokens", 0)

            elapsed = time.perf_counter() - start
            REQUEST_LATENCY.labels(endpoint="completions").observe(elapsed)
            REQUEST_COUNT.labels(endpoint="completions", status="ok").inc()
            TOKENS_GENERATED.inc(total_completion_tokens)

            return CompletionResponse(
                id=request_id,
                created=int(time.time()),
                model=_engine.model_name,
                choices=choices,
                usage=UsageInfo(
                    prompt_tokens=total_prompt_tokens,
                    completion_tokens=total_completion_tokens,
                    total_tokens=total_prompt_tokens + total_completion_tokens,
                ),
            )
        except Exception as exc:
            REQUEST_COUNT.labels(endpoint="completions", status="error").inc()
            logger.exception("completions error")
            raise HTTPException(500, detail=str(exc)) from exc
        finally:
            ACTIVE_REQUESTS.dec()

    async def _stream_completion(
        request_id: str, prompt: str, req: CompletionRequest
    ) -> AsyncGenerator[str, None]:
        try:
            # 2026-10-18 — capture + narrow the module-global engine (see
            # _stream_chat for rationale).
            engine = _engine
            if engine is None:
                raise RuntimeError("engine unavailable during stream")
            async for chunk in engine.generate(
                prompt=prompt,
                request_id=request_id,
                temperature=req.temperature,
                top_p=req.top_p,
                max_tokens=req.max_tokens or 256,
                stop=req.stop,
                stream=True,
            ):
                payload = {
                    "id": request_id,
                    "object": "text_completion",
                    "created": int(time.time()),
                    "model": engine.model_name,
                    "choices": [
                        {
                            "index": 0,
                            "text": chunk["delta"],
                            "finish_reason": chunk.get("finish_reason"),
                        }
                    ],
                }
                yield f"data: {json.dumps(payload)}\n\n"

                if chunk.get("finished"):
                    TOKENS_GENERATED.inc(chunk.get("completion_tokens", 0))

            yield "data: [DONE]\n\n"
        except Exception:
            logger.exception("streaming completion error")
        finally:
            ACTIVE_REQUESTS.dec()

    return app


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="vLLM model serving runtime")
    parser.add_argument("--model-path", required=True, help="HF model id or local path")
    parser.add_argument("--tensor-parallel", type=int, default=1)
    parser.add_argument("--max-model-len", type=int, default=4096)
    parser.add_argument("--gpu-memory-utilization", type=float, default=0.90)
    parser.add_argument("--dtype", default="auto")
    # 2026-10-20 — vLLM 0.32 methods we actually produce/serve: fp8
    # (llmcompressor → compressed-tensors), gptq (gptqmodel), awq
    # (serving externally produced checkpoints; our producer path was
    # purged). squeezellm is dead in vLLM since ~0.4 — removed.
    parser.add_argument("--quantization", default=None, choices=["fp8", "gptq", "awq", None])
    parser.add_argument("--max-num-seqs", type=int, default=256)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--trust-remote-code", action="store_true")
    parser.add_argument("--enforce-eager", action="store_true")
    parser.add_argument("--log-level", default="info")
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )

    config = EngineConfig(
        model_path=args.model_path,
        tensor_parallel_size=args.tensor_parallel,
        max_model_len=args.max_model_len,
        gpu_memory_utilization=args.gpu_memory_utilization,
        dtype=args.dtype,
        trust_remote_code=args.trust_remote_code,
        quantization=args.quantization,
        enforce_eager=args.enforce_eager,
        max_num_seqs=args.max_num_seqs,
    )

    app = create_app(config)

    shutdown_event = asyncio.Event()

    def _handle_signal(sig: int, frame: FrameType | None) -> None:
        logger.info("Received signal %s, shutting down ...", sig)
        shutdown_event.set()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    uv_config = uvicorn.Config(
        app,
        host=args.host,
        port=args.port,
        log_level=args.log_level,
        access_log=True,
    )
    server = uvicorn.Server(uv_config)
    server.run()


if __name__ == "__main__":
    main()
