"""Text-only typed decisions through the experimental llama.cpp DiffusionGemma server."""
from __future__ import annotations

import asyncio
import math
import os
from typing import Any

import httpx

from .contracts import MAX_IMAGE_ATTACHMENTS, description_images, question_descriptions, request_image_count
from .engine import (
    BackendError,
    CompiledSchema,
    DiffusionEngine,
    ImageState,
    ReadResult,
    SchemaError,
    _PreparedSchema,
    _description,
)
from .images import validate_image_data_url


class LlamaCppDiffusionEngine(DiffusionEngine):
    """Adapter for PR #24427 plus its private one-pass structured-read endpoint.

    It deliberately accepts tokenized prompts only. This avoids relying on a
    separate chat-template implementation in the experimental C++ server.
    """

    supports_images = True

    def _request_state(self, request):
        images = getattr(request, "images", None)
        if images and (not isinstance(images, (list, tuple)) or len(images) != 1):
            raise SchemaError("at most one state image is supported per request")
        try:
            if request_image_count(request) > MAX_IMAGE_ATTACHMENTS:
                raise ValueError(f"at most {MAX_IMAGE_ATTACHMENTS} image attachments are supported")
            for image in images or ():
                validate_image_data_url(image)
            for question in request.questions.values():
                for value in question_descriptions(question):
                    for image in description_images(value):
                        validate_image_data_url(image)
        except ValueError as exc:
            raise SchemaError(str(exc)) from None
        return ImageState(_description(request.state), tuple(images)) if images else _description(request.state)

    def _check_context(self, compiled, state):
        # libmtmd expands each media marker to vision embeddings; the C++ read
        # endpoint owns the authoritative expanded-token context check.
        if isinstance(state, ImageState) or compiled.question_images:
            return compiled
        return super()._check_context(compiled, state)

    def _multimodal_prompt(self, compiled: CompiledSchema, state: str | ImageState) -> tuple[str, list[str]]:
        images = list(state.images) if isinstance(state, ImageState) else []
        user = "".join("<__media__>\n" for _ in images)
        user += state.text if isinstance(state, ImageState) else state
        for index, image in enumerate(compiled.question_images, 1):
            images.append(image)
            user += f"\nQuestion attachment {index}:\n<__media__>"
        messages = [
            {"role": "system", "content": compiled.system_prompt},
            {"role": "user", "content": user},
        ]
        try:
            prompt = self.tokenizer.apply_chat_template(
                messages, tokenize=False, add_generation_prompt=True, enable_thinking=False,
            )
        except Exception as exc:
            raise SchemaError("the tokenizer could not render the multimodal chat prompt") from exc
        if not isinstance(prompt, str) or prompt.count("<__media__>") != len(images):
            raise SchemaError("the tokenizer did not preserve all multimodal image markers")
        return prompt, images

    async def generate(self, request):
        result = await super().generate(request)
        if request.options.diagnostics:
            body = dict(result.body)
            diagnostics = dict(body["diagnostics"])
            diagnostics.update({
                "engine": "diffusiongemma-llamacpp-experimental",
                "quantization": "server-reported GGUF; inspect /props for model_path",
                "images": True,
            })
            body["diagnostics"] = diagnostics
            return type(result)(body, result.compile_ms, result.model_ms)
        return result

    async def _read(self, compiled: CompiledSchema, state: str | ImageState, seed: int) -> ReadResult:
        multimodal = isinstance(state, ImageState) or bool(compiled.question_images)
        if not multimodal and not isinstance(compiled, _PreparedSchema):
            raise SchemaError("the llama.cpp backend requires tokenizer token-ID input")
        body = {
            "prompt_token_ids": [] if multimodal else list(compiled.prompt_token_ids),
            "seed_canvas": self._canvas(compiled, seed),
            "canvas_length": compiled.canvas_width,
            "max_steps": 1,
            "read_only": True,
            "logprob_token_ids": list(compiled.label_ids),
        }
        if multimodal:
            prompt, images = self._multimodal_prompt(compiled, state)
            body.update({"multimodal_prompt": prompt, "images": images})
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
                and structured.get("images") is True):
            raise ValueError("missing structured-read capabilities")
    except (httpx.HTTPError, TypeError, ValueError):
        await engine.close()
        raise RuntimeError("the llama.cpp server lacks Djev's required structured-read endpoint") from None
    return engine
