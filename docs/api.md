# API

The local API accepts `POST /v1/request` with `Content-Type: application/json`. There is no machine-start lifecycle in the request contract: start the runtime as part of your deployment and wait for `/ready` before sending work.

Interactive OpenAPI documentation is available at `/docs`. The built playground runs at `/` and copies complete cURL, Python, and TypeScript requests for the current input.

## Text and JSON

`state` can be a string, object, or array. Questions are keyed by your own names. Instructions and criteria descriptions can be text, structured JSON, or `null`.

```json
{
  "state": {"message": "Checkout is unavailable", "impact": "Customers cannot pay"},
  "questions": {
    "urgent": {"type": "noul", "instructions": "Is immediate attention needed?"},
    "team": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {"billing": "Charges and invoices", "engineering": "Outages and broken features"}
    },
    "impact": {
      "type": "score",
      "instructions": "How much does this prevent use of the product?",
      "criteria": ["No impact", "Small inconvenience", "A core task is blocked", "The entire service is unavailable"]
    }
  },
  "options": {"seed": 0, "samples": 1, "diagnostics": true}
}
```

The response has `model`, `answers`, and `usage`. A response shape with **illustrative, fabricated probabilities** is:

```json
{
  "model": "djev-0.1",
  "answers": {
    "urgent": {"type": "noul", "noul": 0.96},
    "team": {
      "type": "choice", "choice": "engineering",
      "probabilities": {"billing": 0.1, "engineering": 0.9},
      "confidence": 0.531
    }
  },
  "usage": {"input_tokens": 240, "output_tokens": 8}
}
```

This shape illustrates Noul and Choice only. An actual response includes every requested question, including Score. Score returns `score`, `legend`, `probabilities`, and `confidence`; `score` is the expected **zero-based** level index, not the most likely level. `[0.2, 0.5, 0.3]` therefore gives `1.1`. Confidence is entropy concentration, not a calibrated probability of correctness.

## Native images and images as choices

Use `images: [data_url]` for the state image. A description object of the form `{"image": data_url, "text": "optional text"}` supplies an image in question instructions or an option. The model receives the images themselves.

```python
import base64
from pathlib import Path
import httpx

def png(path):
    return "data:image/png;base64," + base64.b64encode(Path(path).read_bytes()).decode()

request = {
    "state": "Match the reference object's form.",
    "images": [png("reference.png")],
    "questions": {
        "match": {
            "type": "choice",
            "instructions": "Which option most closely matches the reference object's form?",
            "criteria": {
                "a": {"image": png("option-a.png"), "text": "Option A"},
                "b": {"image": png("option-b.png"), "text": "Option B"},
            },
        }
    },
}
with httpx.Client(timeout=120) as client:
    response = client.post("http://127.0.0.1:8000/v1/request", json=request)
    response.raise_for_status()
    print(response.json())
```

Use the real MIME type for JPEG or WebP. URLs to remote images are not fetched. The total encoded request must fit the body limit even when every individual image passes its own limit.

## Limits

| Field | Limit |
| --- | --- |
| Questions | 32 |
| Choice options | 255 per question |
| Score levels | 2–10 per question |
| State | 20,000 Unicode code points |
| Instructions | 2,000 Unicode code points per description |
| Criterion / option name | 500 Unicode code points |
| State images | 1 |
| All image attachment occurrences | 6 per request |
| Image bytes | 5 MiB decoded per image |
| Image dimensions | 2,048 pixels per side; a single frame |
| HTTP request body | 8 MiB including base64 encoding |

Structured text includes its compact JSON syntax in the character count. Model context and answer-canvas limits also apply, so a request can fit the character limit and still exceed the token limit.

## Options and timing

`seed` defaults to `0`; `null` requests fresh noise. `samples` is 1–4 and averages independent one-step reads. `steps` is fixed at 1. `isolation: "independent"` evaluates each question separately, at increased physical work. Keep the default categorical Score mode for ordinary use; `independent_levels` is an experimental alternative requiring independent isolation.

`diagnostics: true` adds the probability basis, allowed-label mass, read count, and canvas details. It does not make probabilities calibrated. Token usage counts physical reads, including repeated prompt processing across samples or independently evaluated questions.

`Server-Timing`, `X-Djev-Model-Ms`, and `X-Djev-Server-Ms` separate compilation, model-call orchestration, and API handling. Measure complete client response time separately; the model header is not end-to-end latency or isolated GPU compute.

## Readiness, access, and errors

- `GET /health`: API process liveness.
- `GET /ready`: checks the model adapter and backend; returns 503 until ready.
- `GET /config`: supported features and limits.

The local default needs no key. If the operator sets `DJEV_API_KEY`, requests require `Authorization: Bearer <your-key>`. Keep keys outside browser source; the basic playground is intended for trusted local use and does not manage credentials.

| Status | Meaning |
| --- | --- |
| 400 | Malformed JSON, duplicate keys, or non-finite numbers |
| 401 | API key missing or invalid when enabled |
| 413 | Request body too large |
| 415 | Incorrect content type |
| 422 | Invalid question, image, context, or canvas |
| 502 | Backend response missing complete valid evidence |
| 503 | Runtime unavailable or bounded capacity full; capacity errors include `Retry-After` |
| 504 | Deadline exceeded |

An error does not contain a saved job receipt. The basic API has no durable storage or automatic retries. Retry with backoff in your client when appropriate and handle duplicate computation after timeouts. Add persistence outside this service if your application requires recoverable jobs.
