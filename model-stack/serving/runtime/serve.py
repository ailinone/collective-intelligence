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
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncGenerator, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from prometheus_client import (
    CollectorRegistry,
    Counter,
    Histogram,
    Gauge,
    generate_latest,
    CONTENT_TYPE_LATEST,
)
from pydantic import BaseModel, Field
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
    name: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model: str = ""
    messages: list[ChatMessage]
    temperature: float = 0.7
    top_p: float = 1.0
    max_tokens: Optional[int] = None
    stream: bool = False
    stop: Optional[list[str]] = None
    frequency_penalty: float = 0.0
    presence_penalty: float = 0.0
    n: int = 1


class CompletionRequest(BaseModel):
    model: str = ""
    prompt: str | list[str]
    temperature: float = 0.7
    top_p: float = 1.0
    max_tokens: Optional[int] = 256
    stream: bool = False
    stop: Optional[list[str]] = None
    n: int = 1


class UsageInfo(BaseModel):
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0


class ChatChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: Optional[str] = "stop"


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
    finish_reason: Optional[str] = "stop"


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
    quantization: Optional[str] = None
    enforce_eager: bool = False
    swap_space: int = 4
    max_num_seqs: int = 256
    seed: int = 0


class VLLMEngine:
    """Wraps vLLM's AsyncLLMEngine for serving."""

    def __init__(self, config: EngineConfig) -> None:
        self.config = config
        self.engine = None
        self.model_name: str = config.model_path.rstrip("/").split("/")[-1]
        self._ready = False

    async def start(self) -> None:
        from vllm.engine.arg_utils import AsyncEngineArgs
        from vllm.engine.async_llm_engine import AsyncLLMEngine

        engine_args = AsyncEngineArgs(
            model=self.config.model_path,
            tensor_parallel_size=self.config.tensor_parallel_size,
            max_model_len=self.config.max_model_len,
            gpu_memory_utilization=self.config.gpu_memory_utilization,
            dtype=self.config.dtype,
            trust_remote_code=self.config.trust_remote_code,
            quantization=self.config.quantization,
            enforce_eager=self.config.enforce_eager,
            swap_space=self.config.swap_space,
            max_num_seqs=self.config.max_num_seqs,
            seed=self.config.seed,
        )
        self.engine = AsyncLLMEngine.from_engine_args(engine_args)
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
    ) -> AsyncGenerator[dict, None]:
        from vllm import SamplingParams

        sampling_params = SamplingParams(
            temperature=temperature,
            top_p=top_p,
            max_tokens=max_tokens,
            stop=stop or [],
            frequency_penalty=frequency_penalty,
            presence_penalty=presence_penalty,
        )

        results_generator = self.engine.generate(prompt, sampling_params, request_id)

        previous_text = ""
        async for request_output in results_generator:
            output = request_output.outputs[0]
            delta = output.text[len(previous_text):]
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
            # vLLM engines do not always expose an explicit shutdown
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
    async def lifespan(app: FastAPI):
        global _engine
        _engine = VLLMEngine(config)
        await _engine.start()
        logger.info("Serving %s on tensor_parallel=%d", config.model_path, config.tensor_parallel_size)
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
    async def log_requests(request: Request, call_next):
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
    async def health():
        return {"status": "ok"}

    @app.get("/ready")
    async def ready():
        if _engine is None or not _engine.ready:
            raise HTTPException(503, detail="Model not ready")
        return {"status": "ready"}

    # --- graceful shutdown via HTTP ---
    @app.post("/shutdown")
    async def shutdown():
        """Graceful shutdown endpoint used by deploy/rollback scripts."""
        logger.info("Received /shutdown request — initiating graceful shutdown")
        # Signal uvicorn to stop after responding
        asyncio.get_event_loop().call_later(1.0, lambda: sys.exit(0))
        return {"status": "shutting_down"}

    # --- Prometheus metrics ---
    @app.get("/metrics")
    async def metrics():
        return Response(
            content=generate_latest(PROM_REGISTRY),
            media_type=CONTENT_TYPE_LATEST,
        )

    # --- list models ---
    @app.get("/v1/models")
    async def list_models():
        models = []
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
    async def chat_completions(req: ChatCompletionRequest):
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
            final: dict = {}
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
            raise HTTPException(500, detail=str(exc))
        finally:
            ACTIVE_REQUESTS.dec()

    async def _stream_chat(
        request_id: str, prompt: str, req: ChatCompletionRequest
    ) -> AsyncGenerator[str, None]:
        try:
            async for chunk in _engine.generate(
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
                    "model": _engine.model_name,
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
    async def completions(req: CompletionRequest):
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
                final: dict = {}
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
            raise HTTPException(500, detail=str(exc))
        finally:
            ACTIVE_REQUESTS.dec()

    async def _stream_completion(
        request_id: str, prompt: str, req: CompletionRequest
    ) -> AsyncGenerator[str, None]:
        try:
            async for chunk in _engine.generate(
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
                    "model": _engine.model_name,
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
    parser.add_argument("--quantization", default=None, choices=["awq", "gptq", "squeezellm", None])
    parser.add_argument("--max-num-seqs", type=int, default=256)
    parser.add_argument("--swap-space", type=int, default=4)
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
        swap_space=args.swap_space,
        max_num_seqs=args.max_num_seqs,
    )

    app = create_app(config)

    shutdown_event = asyncio.Event()

    def _handle_signal(sig, frame):
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
