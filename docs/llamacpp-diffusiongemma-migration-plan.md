# Plan: run Djev on experimental llama.cpp DiffusionGemma server

## Status and decision

**This is not a drop-in vLLM replacement.** Djev's public typed-decision contract depends on a patched vLLM extension that performs a **one-step, seeded, read-only diffusion pass** and returns exact log probabilities for caller-specified token IDs. The experimental server in [`ggml-org/llama.cpp#24427`](https://github.com/ggml-org/llama.cpp/pull/24427) currently implements normal block-diffusion *generation* over HTTP, not that structured-read protocol.

The fork's `llama-diffusion-gemma-server` has been proven working on one RTX 3090 with the Unsloth Q5_K_M GGUF. It provides `/v1/chat/completions`, `/v1/completions`, `/health`, `/props`, `/metrics`, and `/slots`; it serializes generation behind a single mutex/slot. It does **not** currently expose:

- `diffusion_seed_canvas`, a supplied canvas, compact requested canvas width, or read-only mode;
- exact label-token log probabilities (or token-ID-based logprob responses);
- the structured one-denoising-step path on which `djev/engine.py` relies;
- native image/message-part handling in this server implementation.

Therefore the migration must begin by adding a compatible structured-read capability to the PR branch. Replacing the Python URL alone would silently change probability semantics, lose image support, and turn sub-100-ms decision reads into complete 12–48-step generations.

## Target scope

### Phase 0 — make capability explicit

1. Introduce backend selection: `DJEV_BACKEND=vllm|llamacpp`, defaulting to `vllm` until parity tests pass.
2. Add `djev/backends.py` protocol/interface so the typed compiler remains backend-neutral.
3. Add `/backend` or enrich `/config` with a truthful capability matrix:
   - exact label probabilities;
   - seeded read-only canvas;
   - text input;
   - native images;
   - concurrency/slots;
   - model quantization and commit ID.
4. If a request contains images and llama.cpp lacks vision transport, return a precise 422 capability error; do not caption images or silently discard them.

**Exit criterion:** selecting llama.cpp cannot falsely advertise Djev's existing probability or image guarantees.

## Phase 1 — extend PR #24427 with the structured-read endpoint

Work in a pinned fork/commit of `lnigam/llama.cpp:nvidia-diffusion-gemma`; do not build from a moving PR ref in production.

### 1.1 Endpoint and request contract

Add a private endpoint, e.g. `POST /v1/diffusion/reads`, rather than overloading OpenAI generation semantics. Request fields:

```json
{
  "prompt": ["token IDs, or messages once template parity exists"],
  "seed_canvas": ["exact token IDs"],
  "canvas_length": 16,
  "max_steps": 1,
  "read_only": true,
  "logprob_token_ids": [123, 456],
  "return_tokens_as_token_ids": true
}
```

Validation rules:

- Accept only flat valid token IDs within the model vocabulary.
- Require a canvas length supported by the diffusion graph (Djev currently rounds to a multiple of 16 and permits up to 256).
- Require `seed_canvas.length == canvas_length`.
- Bound requested label IDs (match `MAX_LABEL_IDS`) and request body size.
- Reject, rather than ignore, unsupported sampling, image, batching, or context options.

### 1.2 Decoder/read execution

Add a `generate_read()` path derived from `diffusion_server::generate()`:

1. causal-prefill the supplied prompt;
2. load the supplied canvas verbatim (no server RNG); 
3. run **exactly one** bidirectional decoder pass with the same graph settings as the structured-read reference;
4. read logits at every canvas position;
5. compute stable log-softmax only for requested `logprob_token_ids` for every position;
6. return no natural-language completion and do **not** commit the canvas to the KV cache.

The current server's fused GPU sampling/device denoise loop is ideal for full generation but is not the decision path. The read implementation must retain logits long enough to score arbitrary requested IDs. It may need a dedicated CUDA gather + logsumexp kernel to avoid copying the full `256 × 262,144` logit tensor to host.

### 1.3 Response contract

Return a versioned, explicit response; do not pretend it is standard OpenAI `logprobs` if it is not:

```json
{
  "object": "diffusion.read",
  "model": "diffusiongemma-26B-A4B-it-Q5_K_M",
  "logprobs": {
    "positions": [
      {"123": -1.2, "456": -2.1}
    ]
  },
  "usage": {"prompt_tokens": 42, "completion_tokens": 16, "total_tokens": 58},
  "timings": {"prompt_ms": 0, "read_ms": 0}
}
```

Include server commit, GGUF quantization, CUDA path flags, and model hash in `/props` and process logs for reproducibility.

**Exit criterion:** a deterministic text-only read returns every requested token ID's finite/-infinity logprob at every requested canvas position, without full text generation.

## Phase 2 — Djev llama.cpp adapter

1. Preserve `CompiledSchema`, canvas construction, label-slot mapping, request admission, and typed result normalization in `djev/engine.py`.
2. Implement `LlamaCppDiffusionEngine` that uses the Phase 1 endpoint and translates its per-position token-ID scores into Djev's `ReadResult`.
3. Reuse the existing `_read` validation rules: reject missing labels, malformed IDs, NaN/+inf scores, duplicate/conflicting scores, and censored all-label evidence.
4. Set diagnostics honestly:
   - `engine: "diffusiongemma-llamacpp-experimental"`;
   - quantization and server commit;
   - `steps: 1` only when the Phase 1 path actually executed one read;
   - `probability_basis: "relative_to_allowed_labels"`.
5. Use `DJEV_UPSTREAM=http://127.0.0.1:18081` and discover capabilities from `/props` at startup. Fail closed if the server commit/capabilities mismatch.
6. Initial 3090 limits: one active read/generation (`max_active_reads=1`, `max_active_requests=1`), Q5_K_M, `n_ctx=8096`. Do not claim vLLM's batching/prefix-cache behavior.

**Exit criterion:** text Noul, Choice, Score, independent mode, score-level mode, seeds, cancellation, and capacity behavior pass against a live llama.cpp server.

## Phase 3 — vision, only after text parity

Djev's current native image contract requires the model's vision encoder and complete image-span scheduling. `#24427` can convert mmproj weights, but the experimental HTTP server currently parses textual chat messages and does not implement Djev-compatible image data-URL/message-part transport.

Required work:

1. Add explicit `image_url`/data-URL decoding and size/type validation at the server boundary.
2. Wire `mtmd`/mmproj preprocessing into the server prompt path and preserve image token spans during the causal encoder prefill.
3. Support state images plus question/option images, matching the application's six-image limit and ordering exactly.
4. Add cross-runtime fixture tests using fixed images and tokenized prompt/vision spans.

Until then, ship **text-only** llama.cpp mode; expose `images: false` in `/config` and hide/disable playground image and camera controls for this backend.

## Phase 4 — runtime/containerization

Replace the vLLM-specific runtime only after Phase 1/2 work exists:

1. Build a CUDA Ubuntu image pinned to the llama.cpp fork commit, CUDA base image digest, and source checkout.
2. Compile `llama-diffusion-gemma-server` with `-DGGML_CUDA=ON`.
3. Download/cache the licensed Unsloth `diffusiongemma-26B-A4B-it-Q5_K_M.gguf` separately from image layers; record SHA256.
4. Launch the model server on loopback `:18081`, then run Djev's FastAPI API on `:8000` in the same pod/container set or a private Docker network.
5. Keep the current tested server flags as the **generation** profile:

```bash
-m /models/diffusiongemma-26B-A4B-it-Q5_K_M.gguf \
-c 8096 -ngl 999 --diffusion-steps 48 \
--diffusion-cuda-mmq-max-x 64 --metrics --slots
```

The structured-read profile may differ after Phase 1; benchmark it independently rather than assuming generation flags determine decision latency.
6. Add a health gate: Djev `/ready` requires both `/health` and a capability/version check, not merely an HTTP listener.

## Test and acceptance matrix

### Unit tests

- Extract a backend-independent conformance suite from `tests/test_engine.py`.
- Mock valid and invalid Phase 1 responses: exact labels, missing labels, duplicate IDs, NaN, +inf, censored evidence, invalid usage, and HTTP errors.
- Verify seeded canvases are sent unchanged and no answer cache exists.
- Verify unsupported images fail before an upstream request in text-only mode.

### Integration tests (RTX 3090)

- Server starts Q5_K_M fully GPU-offloaded and `/props` reports the expected commit/capabilities.
- Compare Djev's normalized Noul/Choice/Score distributions with captured vLLM reference fixtures, using a documented tolerance. Quantization means bitwise identity is not an acceptable goal.
- Verify `read_only` performs one decoder pass and returns no normal generated answer.
- Measure p50/p95 text decision latency, GPU memory, and one-slot queue behavior under 1/2/4 clients.
- Run 100 fixed text requests across seeds; record exact API schema validity, no missing labels, and semantic agreement against baseline fixtures.
- Separate generation benchmarks (the current 100–143 final tok/s 3090 observation) from decision-read benchmarks; they measure different work.

## Non-goals / guardrails

- Do not replace Djev's exact-probability decision engine with parsing `"0: yes"` from a generated response under the same API/version. That is a different, lower-integrity product and needs explicit opt-in (`DJEV_BACKEND=llamacpp-generated-experimental`) plus no probability claims.
- Do not expose the experimental server directly to the public internet; it permits untrusted prompt bodies and has one serialized slot. Bind loopback/private network and put the Djev API/auth gateway in front.
- Do not promise native image support until Phase 3 passes.
- Do not assume 64GB host RAM solves VRAM capacity/performance. The chosen Q5 GGUF fits the 24GB RTX 3090; BF16/vLLM does not.

## Delivery sequence

1. Commit this plan and a backend capability skeleton.
2. Implement/review the private structured-read endpoint in the llama.cpp fork.
3. Add the text-only adapter and its conformance tests.
4. Deploy to AISERVER as an experimental one-slot service; benchmark and compare.
5. Decide whether vision parity merits Phase 3, or maintain this as a text-only fast local decision backend.
