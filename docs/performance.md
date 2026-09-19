# Performance and the economics of a small decision

The optimization target is the complete useful decision: correct typed output, low tail latency, and enough sustained throughput to keep the accelerator occupied. Model time, HTTP response time, and throughput are different measurements.

## What has been measured

These aggregates come from internal development runs before this public extraction. They are context for the design, not fresh benchmarks of the packaged open-source release. Inputs were reused development fixtures; there is no held-out external quality evaluation in this release.

| Workload / configuration | Sample size | Model-call p50 / p95 | Full HTTP p50 / p95 | Scope |
| --- | ---: | ---: | ---: | --- |
| Typed text, original BF16 weights and KV, B200 | 12 requests | **59.10 / 86.60 ms** | **375.55 / 1098.70 ms** | Small mixed validation plan; 33/36 expected text labels |
| Warm short text, earlier quantized configuration, B200 | 1,000 requests | Not used for this comparison | **76.87 / 86.40 ms** | Concurrency 1, regional client, eight repeated development cases; 3,000/3,000 label checks |

“Model-call” includes adapter orchestration and waiting around the model request. It is not a CUDA kernel measurement. HTTP time includes the completed response. The two rows use different precision, workload, and delivery paths and must not be compared as an isolated speedup experiment. The second row's p99 was 108.62 ms; even that run was not “always under 100 ms.” Image encoding and prefill have a separate cost and are not covered by the historical short-text result.

The BF16 runtime passed all 64 response-format checks in the broader development run. It passed 57/60 typed labels and 12/12 native image-reference label checks. Repeated image-choice winners stayed stable, but repeated Score requests produced three probability profiles and two winning levels under mixed load. All 16 Score repetitions missed the authored target range; these were repetitions of one development prompt, not 16 independent accuracy cases. The public release therefore does not promise exact numerical repeatability, calibrated confidence, or generally superior accuracy.

The project has discussed a **2.5× text-speed improvement**. A publishable ratio needs a named baseline, the same workload and precision, matched concurrency, and the same timing boundary. This release does not include a matched report establishing that ratio. External reproduction and comparison are welcome.

## Where the work is removed

| Optimization | Expected effect | Boundary |
| --- | --- | --- |
| One-step structured read | Avoid repeated full text generation | Complex reasoning may need more compute |
| Small canvas | Reduce answer-position decoder work | Width must still fit the complete template |
| Exact requested-label probabilities | Avoid prose parsing and top-k omissions | A valid distribution can be semantically wrong |
| Prefix reuse and compiled schemas | Reuse repeated text work | Image requests need different cache handling |
| Native image path | Preserve visual information without a captioning round trip | Image encoding and prefill still cost time |
| Warm local model connections | Remove cold start and unnecessary network hops | Does not remove the user's network latency |
| Bounded concurrency | Keep overload explicit and memory bounded | The basic server rejects excess work; it is not a durable queue |

The [architecture guide](architecture.md) connects each mechanism to the code. These are explanations of the implementation, not independent per-optimization speedup measurements.

## Recommended measurement protocol

1. Record the model revision, runtime commit pins, precision, GPU, configuration, and API-to-GPU network layout.
2. Warm both text and image paths. Report cold-start and warmup results separately.
3. Use a fixed, versioned evaluation set with expected outcomes. Include simple and ambiguous Noul, Choice, Score, native images, and image choices.
4. Measure complete responses at concurrency 1, 4, 8, and above. Report p50, p95, p99, errors, input tokens/second, and correctness together.
5. Repeat identical requests both alone and among unrelated text/image requests. Compare full probability vectors, score spread, and winners.
6. State whether prefixes were cached. Keep inference measurements distinct from application-level answer-cache hits.
7. For a speedup, run the baseline through the same measurement boundary. Divide baseline latency by candidate latency; do not compare one system's GPU time with another system's public HTTP time.

CPU and mocked-backend tests validate contracts and control flow. They do not establish GPU speed or model quality. The public extraction also uses its own versioned seed namespace, so a numerical answer need not match a prior hosted build for the same user seed.

## Can $35 per billion input tokens work?

This repository has no billing system or enforced per-token price. **$35/B input tokens, with no output-token charge, is a target for a hosted offering**, not a guarantee about any self-hosted deployment's cost or margin.

For sustained input throughput `T` tokens/second:

```text
gross revenue per hour = T × 3,600 × $35 / 1,000,000,000
break-even tokens/second = hourly total cost × 1,000,000,000 / (3,600 × $35)
```

An **illustrative $5/hour total cost** needs about **39,683 useful input tokens/second** to break even. At 80% productive utilization, the serving system would need roughly **49,604 tokens/second while busy**. This is arithmetic using an example cost, not a provider quote or a measured Djev throughput result. Real costs also include CPU, storage, transfer, observability, and operating overhead.

Adding identical machines raises total capacity and total cost together. Unit cost improves if batching, long prefills, prefix reuse, scheduling, or purchasing terms improve useful work per dollar. An idle replica makes it worse. Multiple samples and independent question reads also increase physical model work; include that work in the accounting instead of counting only the unique user text once.

Start with the [B200 BF16 reference setup](runtime.md), measure sustained throughput under a fixed p95 budget, and use that result to size a warm pool. Record a separate capacity curve for image workloads. We welcome reproducible measurements from other hosts and accelerators.
