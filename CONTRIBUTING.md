# Contributing

Useful contributions improve the decision path and come with evidence. Start with a small issue describing the workload, expected behavior, actual behavior, and a sanitized reproduction.

Run the CPU tests and playground build before proposing a change:

```bash
pip install -e '.[test]'
pytest
cd playground
npm ci
npm test
npm run build
```

GPU behavior needs separate verification. Include the model revision, runtime pins, precision, accelerator, warmup, concurrency, prompt sizes, image sizes, complete-response timing, errors, and semantic checks. Report all trials rather than only the fastest result. Compare modes using the same examples and intended answers.

Please do not put credentials, real customer data, private photos, signed URLs, or production logs into issues or fixtures. Use synthetic reproductions. This repository intentionally excludes hosted account and payment systems.

Areas where external work would be especially valuable:

- Held-out text and native image-choice evaluations.
- Repeated Score requests under mixed text/image batches.
- Probability calibration and abstention thresholds.
- Matched precision and workload comparisons against a named baseline.
- Throughput at a fixed p95 latency budget, including overloaded behavior.
- New upstream vLLM versions with verified patch compatibility.

Contributions are licensed under Apache-2.0. Preserve upstream notices and identify modifications to third-party code.
