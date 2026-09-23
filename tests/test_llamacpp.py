import base64
from io import BytesIO
import json
import math
import re

import httpx
from PIL import Image
import pytest

from djev.contracts import DjevRequest
from djev.engine import _PreparedSchema
from djev.llamacpp import LlamaCppDiffusionEngine


class Tokenizer:
    vocab_size = 262144

    def encode(self, text, add_special_tokens=False):
        mapping = {"yes": 500, "no": 501, "<|channel>": 100, "<channel|>": 101}
        return [mapping[part] if part in mapping else ord(part) + 1000
                for part in re.findall(r"<\|channel>|<channel\|>|yes|no|.", text, re.DOTALL)]

    def apply_chat_template(self, messages, **kwargs):
        if kwargs.get("tokenize") is False:
            return "\n".join(str(message["content"]) for message in messages)
        return [2, 3, 4]


def request():
    return DjevRequest.model_validate({
        "state": "Cancel my plan",
        "questions": {"cancel": {"type": "noul", "instructions": "Wants cancellation?"}},
        "options": {"seed": 7},
    })


@pytest.mark.asyncio
async def test_llamacpp_adapter_uses_one_pass_seeded_read_and_normalizes_labels():
    async def handler(http_request):
        assert http_request.url.path == "/v1/diffusion/reads"
        body = json.loads(http_request.content)
        assert body["prompt_token_ids"] == [2, 3, 4]
        assert body["read_only"] is True and body["max_steps"] == 1
        assert body["canvas_length"] == len(body["seed_canvas"])
        assert set(body["logprob_token_ids"]) == {500, 501}
        rows = [{"500": math.log(.8), "501": math.log(.2)} for _ in body["seed_canvas"]]
        return httpx.Response(200, json={
            "object": "diffusion.read",
            "logprobs": {"positions": rows},
            "usage": {"prompt_tokens": 3, "completion_tokens": len(rows), "total_tokens": 3 + len(rows)},
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        engine = LlamaCppDiffusionEngine(Tokenizer(), client=client, canvas=32, input_transport="token_ids")
        result = await engine.generate(request())
    assert result.body["answers"]["cancel"]["noul"] == pytest.approx(.8)
    assert result.body["usage"] == {"input_tokens": 3, "output_tokens": 16}


@pytest.mark.asyncio
async def test_llamacpp_adapter_rejects_missing_exact_label_scores():
    async def handler(http_request):
        body = json.loads(http_request.content)
        rows = [{"500": math.log(.8)} for _ in body["seed_canvas"]]
        return httpx.Response(200, json={
            "object": "diffusion.read", "logprobs": {"positions": rows},
            "usage": {"prompt_tokens": 3, "completion_tokens": len(rows), "total_tokens": 3 + len(rows)},
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        engine = LlamaCppDiffusionEngine(Tokenizer(), client=client, canvas=32, input_transport="token_ids")
        with pytest.raises(Exception, match="incomplete or invalid"):
            await engine.generate(request())


@pytest.mark.asyncio
async def test_llamacpp_sends_state_and_question_images_in_marker_order():
    png = BytesIO()
    Image.new("RGB", (32, 32), "red").save(png, format="PNG")
    image = "data:image/png;base64," + base64.b64encode(png.getvalue()).decode()
    payload = DjevRequest.model_validate({
        "state": "Use both images as evidence.", "images": [image],
        "questions": {"red": {"type": "noul", "instructions": {"image": image, "text": "Is red present?"}}},
        "options": {"seed": 0},
    })

    async def handler(http_request):
        body = json.loads(http_request.content)
        assert body["images"] == [image, image]
        assert body["multimodal_prompt"].count("<__media__>") == 2
        if http_request.url.path.endswith("/preflight"):
            return httpx.Response(200, json={"object": "diffusion.preflight", "prompt_tokens": 99,
                                              "canvas_length": body["canvas_length"], "max_context_tokens": 4096,
                                              "fits_context": True})
        assert body["prompt_token_ids"] == []
        rows = [{"500": math.log(.2), "501": math.log(.8)} for _ in body["seed_canvas"]]
        return httpx.Response(200, json={
            "object": "diffusion.read", "logprobs": {"positions": rows},
            "usage": {"prompt_tokens": 99, "completion_tokens": len(rows), "total_tokens": 99 + len(rows)},
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        engine = LlamaCppDiffusionEngine(Tokenizer(), client=client, canvas=32, input_transport="token_ids")
        result = await engine.generate(payload)
    assert result.body["answers"]["red"]["noul"] == pytest.approx(.2)
    assert result.body["usage"] == {"input_tokens": 99, "output_tokens": 16}


def test_llamacpp_validates_image_request_before_backend_call():
    engine = LlamaCppDiffusionEngine(Tokenizer(), canvas=32, input_transport="token_ids")
    # Construct directly: malformed image bytes must be rejected before a read.
    payload = DjevRequest.model_construct(state="state", images=["data:image/png;base64,invalid"], questions={})
    with pytest.raises(Exception, match="valid base64"):
        engine._request_state(payload)
