# Evaluating Djev / Jev-like models on AISERVER

**Target:** experimental `djev` text-only adapter → experimental llama.cpp DiffusionGemma structured-read server → RTX 3090 24GB + Q5_K_M GGUF.

## Recommendation

Use a **three-layer evaluation**, in this order:

1. **Protocol/correctness:** prove the local endpoint returns a valid typed probability distribution and preserves Djev's contract.
2. **Quality + calibration:** run JevBench's public tasks through a dedicated local adapter; report accuracy relative to chance, Brier score, ECE, ordinal MAE, and paraphrase consistency.
3. **Serving behavior:** serial p50/p95 latency, cold/warm start, failure rate, and one-slot queue behavior on the actual 3090.

Do not claim a JevBench leaderboard result until the JevBench maintainers run their complete frozen suite/held-out portion under their rules. A self-run public subset is a local regression/baseline report, not a ranked result.

## Relevant public work

### JevBench is the strongest fit

[JevBench](https://github.com/fstandhartinger/jevbench) is specifically a benchmark for typed decision models. Its current methodology evaluates:

- **Intelligence:** argmax accuracy over the exact provided labels, reported against chance/base-rate floors.
- **Calibration:** multiclass Brier score, 10-bin ECE, and fidelity to exact gold distributions where available.
- **Score questions:** ordinal MAE of the probability-weighted level, in addition to argmax accuracy.
- **Reliability:** schema validity, paraphrase same-answer rate, and paraphrase both-correct rate.
- **Speed:** caller wall-clock p50/p95, serial requests, network included; cold request separately.
- **Cost:** per 1,000 *decisions*, not per token.

The benchmark has 534 v1.2 decisions. It includes a public subset and a held-out hard set. It explicitly warns about option-order sensitivity and records public/held-out provenance. Its standard CLI is:

```bash
python -m unittest discover -s tests -v
python -m jevbench.cli run --tasks datasets/public/original.jsonl \
  --adapter <adapter> --endpoint <endpoint> --model <model> \
  --cost-basis self_hosted --reserve-usd 0 \
  --results RUN/results.jsonl --raw-dir RUN/raw \
  --ledger RUN/ledger.jsonl --manifest RUN/manifest.json
python -m jevbench.cli summarize --tasks datasets/public/original.jsonl \
  --results RUN/results.jsonl --public-export RUN/summary.json
```

Important limitation: the published JevBench README says token-level logprobs are not presently used by any of its adapters. Our adapter exposes direct token-logit probabilities, so a custom adapter must explicitly map Djev's returned distributions into the benchmark's native typed-answer format and document that mapping.

### Existing smaller harnesses are useful smoke tests, not sufficient quality evidence

- [`souvikr/jev-test`](https://github.com/souvikr/jev-test): 17 cases / 23 checks, covering Noul/Choice/Score, latency and cost; ideal initial compatibility smoke suite.
- [`alperenerol/jev-1.13-mini-benchmark`](https://github.com/alperenerol/jev-1.13-mini-benchmark): 34 labelled support-triage cases; useful to verify confusion matrix, Noul threshold sweep, score MAE and repeatability.
- [`githubnext/localjev`](https://github.com/githubnext/localjev): its bake-off design compares labelled AG News, BoolQ and SST-5, reports quality/calibration/retries/latency at two input lengths. Its ordinary Chat Completions path has *self-reported* probabilities, so use its methodology, not that generation backend, as the reference for direct-logit Djev.
- [`mmastrac/djev`](https://github.com/mmastrac/djev) documents the seeded-canvas, one-step, read-only DiffusionGemma method that this adapter mirrors.

## AISERVER evaluation configuration

Record these facts in every result manifest:

```text
Host: AISERVER
GPU: NVIDIA RTX 3090, 24GB, sm_86
RAM: 62GB
Weights: unsloth/diffusiongemma-26B-A4B-it-Q5_K_M.gguf
Server: lenkard/llama.cpp djev-structured-read @ <commit>
Djev: lenkard/djev-dev @ <commit>
Canvas: 16, 32, 64, 128 (separate arms)
Read mode: max_steps=1, read_only=true
Concurrency: 1 (the server is one serialized slot)
Images: unsupported in this initial backend
```

Q5 GGUF and the experimental llama.cpp graph are not equivalent to Djev's published BF16/vLLM path. Compare these results only with other runs using the same model artifact and runtime unless separately validating cross-runtime agreement.

## Acceptance gates

### Gate A — endpoint/contract tests

Run before every benchmark:

1. `/props` advertises `structured_read.read_only`, `decoder_passes=1`, `exact_requested_logprobs`, and `token_id_input`.
2. Valid requests return exactly one score for every requested label ID at every canvas position; scores are finite and <= 0.
3. Each output distribution covers exactly the caller's labels, has each value in [0,1], and sums to 1 within 1e-6.
4. Invalid/missing label evidence must fail; never fabricate a uniform answer.
5. Fixed seed + fixed server/model build produces repeatable requests; measure outcome variance rather than asserting GPU bitwise equality.
6. Current Djev unit suite must pass (`pytest -q`).

### Gate B — smoke cases

Port the 23 checks from `jev-test` to the local Djev request shape. Run each case with seeds `{7, 17, 29, 43}` and samples `{1, 4}`.

Report: pass count, per-case distribution, expected label probability, p50/p95 model latency, and failures. Do not tune prompts or thresholds on the same test cases without recording it as development-set tuning.

### Gate C — JevBench public subset

Implement `jevbench/adapters/djev_llamacpp.py` outside JevBench first (or as a clean local fork) that:

1. converts each JevBench state/question verbatim to Djev `/v1/request`;
2. maps Noul, Choice, and Score distributions without rounding;
3. stores raw HTTP response + timing + model/server commit per task;
4. marks model as `djev-llamacpp-q5-3090-experimental`;
5. runs serially (parallelism 1) with no retry after a model error.

Run the public easy/standard/hard sets first. Publish a manifest and raw responses. Compute:

- exact-label argmax accuracy and chance-corrected accuracy;
- multiclass Brier and ECE-10;
- score ordinal MAE;
- validity rate;
- paraphrase same-answer / both-correct;
- p50/p95 end-to-end latency and server-only `model_ms`;
- all error/OOM/timeout counts.

Only after adapter review and frozen settings should the whole 534-task suite be run. The held-out tasks are valid for a self-hosted local server, but do not inspect them manually or use their outcomes to tune canvas, prompt wording, or samples.

### Gate D — robustness and deployment performance

Use the same frozen task set/configuration, then sweep **one variable at a time**:

| Arm | Purpose |
| --- | --- |
| canvas 16 / samples 1 | fastest practical local decision |
| canvas 32 / samples 1 | baseline candidate |
| canvas 64 / samples 1 | context for more multi-question schemas |
| canvas 32 / samples 4 | quality/calibration vs latency tradeoff |
| concurrency 1, 2, 4, 8 | confirm queue behavior; the C++ server remains one slot |
| option order original/reversed | option-order bias diagnostic |
| paraphrase pairs | wording stability |

For production, choose a confidence policy after measuring calibration: examples are auto-act high confidence, confirm middle confidence, escalate low confidence. Refit thresholds only on a development split and report test-set calibration separately.

## Immediate next implementation

1. Build the `djev-structured-read` llama.cpp branch into the AISERVER runtime image and expose it privately on loopback.
2. Start Djev with `DJEV_BACKEND=llamacpp`, `DJEV_UPSTREAM=http://127.0.0.1:18081`, and one active request/read.
3. Add a small local runner that writes JSONL raw receipts and a manifest before touching JevBench.
4. Run Gates A/B, review every failed case, freeze the config, then run Gate C.

## Sources

- JevBench methodology and reproduction: https://github.com/fstandhartinger/jevbench
- Djev structured-read reference: https://github.com/mmastrac/djev
- Small typed-decision smoke harness: https://github.com/souvikr/jev-test
- LocalJev evaluation methodology: https://github.com/githubnext/localjev
- DiffusionGemma structured-generation vLLM PR: https://github.com/vllm-project/vllm/pull/57250
