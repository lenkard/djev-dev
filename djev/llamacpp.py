"""Text-only typed decisions through the experimental llama.cpp DiffusionGemma server."""
from __future__ import annotations

import asyncio
import math
import os
from typing import Any

import httpx

from .engine import (
    BackendError,
    CompiledSchema,
    DiffusionEngine,
    ReadResult,
    SchemaError,
    _PreparedSchema,
)


class LlamaCppDiffusionEngine(DiffusionEngine):
    """Adapter for PR #24427 plus its private one-pass structured-read endpoint.

    It deliberately accepts tokenized prompts only. This avoids relying on a
    separate chat-template implementation in the experimental C++ server.
    """

    supports_images = False

    async def generate(self, request):
        result = await super().generate(request)
        if request.options.diagnostics:
            body = dict(result.body)
            diagnostics = dict(body["diagnostics"])
            diagnostics.update({
                "engine": "diffusiongemma-llamacpp-experimental",
                "quantization": "server-reported GGUF; inspect /props for model_path",
                "images": False,
            })
            body["diagnostics"] = diagnostics
            return type(result)(body, result.compile_ms, result.model_ms)
        return result

    async def _read(self, compiled: CompiledSchema, state: str, seed: int) -> ReadResult:
        if not isinstance(compiled, _PreparedSchema):
            raise SchemaError("the llama.cpp backend requires tokenizer token-ID input")
        body = {
            "prompt_token_ids": list(compiled.prompt_token_ids),
            "seed_canvas": self._canvas(compiled, seed),
            "canvas_length": compiled.canvas_width,
            "max_steps": 1,
            "read_only": True,
            "logprob_token_ids": list(compiled.label_ids),
        }
        try:
            response = await self._http().post(f"{self.upstream}/v1/diffusion/reads", json=body)
        except httpx.HTTPError as exc:
            raise BackendError("the llama.cpp inference backend could not be reached") from exc
        if response.status_code != 200:
            raise BackendError(f"the llama.cpp inference backend returned HTTP {response.status_code}")
        try:
            payload = response.json()
            if payload.get("object") != "diffusion.read":
                raise ValueError("unexpected response object")
            rows = payload["logprobs"]["positions"]
            if not isinstance(rows, list) or len(rows) != compiled.canvas_width:
                raise ValueError("misaligned log-probability positions")
            probabilities: list[list[float]] = []
            masses: list[float] = []
            exact_logprobs: list[list[float]] = []
            for slot in compiled.slots:
                row = rows[slot.position]
                if not isinstance(row, dict):
                    raise ValueError("invalid score row")
                scores: list[float] = []
                for token_id in slot.token_ids:
                    value = row.get(str(token_id))
                    if not isinstance(value, (int, float)):
                        raise ValueError("missing exact label score")
                    value = float(value)
                    if math.isnan(value) or value == math.inf or value > 1e-5:
                        raise ValueError("invalid label score")
                    scores.append(value)
                probabilities.append(self._normalize(scores))
                masses.append(math.fsum(math.exp(value) for value in scores))
                exact_logprobs.append(scores)
            usage_raw = payload["usage"]
            usage = {}
            for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
                value = usage_raw[field]
                if type(value) is not int or value < 0:
                    raise ValueError("invalid usage")
                usage[field] = value
            if usage["completion_tokens"] != compiled.canvas_width:
                raise ValueError("unexpected canvas usage")
            return probabilities, masses, usage, exact_logprobs
        except (KeyError, TypeError, ValueError, OverflowError) as exc:
            raise BackendError("the llama.cpp backend returned incomplete or invalid decision evidence") from exc

    @staticmethod
    def _normalize(logprobs: list[float]) -> list[float]:
        peak = max(logprobs)
        if peak == -math.inf:
            raise BackendError("the llama.cpp backend returned no label evidence")
        weights = [math.exp(value - peak) for value in logprobs]
        total = math.fsum(weights)
        if not math.isfinite(total) or total <= 0:
            raise BackendError("the llama.cpp backend returned invalid label evidence")
        return [value / total for value in weights]


async def create_llamacpp_engine() -> LlamaCppDiffusionEngine:
    """Build a text-only adapter and fail early unless the C++ server is compatible."""
    from transformers import AutoTokenizer

    from .config import MODEL, MODEL_REVISION, bounded_integer, get_max_model_len, get_max_request_reads

    tokenizer = await asyncio.to_thread(
        AutoTokenizer.from_pretrained,
        MODEL,
        revision=MODEL_REVISION,
        trust_remote_code=False,
        local_files_only=os.environ.get("DJEV_OFFLINE", "0") == "1",
    )
    engine = LlamaCppDiffusionEngine(
        tokenizer,
        upstream=os.environ.get("DJEV_UPSTREAM", "http://127.0.0.1:18081"),
        model="diffusion-gemma",
        canvas=bounded_integer("DJEV_CANVAS", 128, 16, 256),
        compact=os.environ.get("DJEV_COMPACT_CANVAS", "1") == "1",
        max_model_len=get_max_model_len(),
        max_active_reads=1,
        max_request_reads=1,
        max_reserved_reads=16,
        input_transport="token_ids",
    )
    try:
        response = await engine._http().get(f"{engine.upstream}/props", timeout=5.0)
        structured = response.json().get("structured_read", {}) if response.status_code == 200 else {}
        if not (structured.get("read_only") is True
                and structured.get("decoder_passes") == 1
                and structured.get("exact_requested_logprobs") is True
                and structured.get("token_id_input") is True
                and structured.get("images") is False):
            raise ValueError("missing structured-read capabilities")
    except (httpx.HTTPError, TypeError, ValueError):
        await engine.close()
        raise RuntimeError("the llama.cpp server lacks Djev's required structured-read endpoint") from None
    return engine
