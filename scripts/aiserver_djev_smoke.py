#!/usr/bin/env python3
"""Run private end-to-end Djev text/image protocol smoke checks and save JSONL receipts."""
from __future__ import annotations

import argparse
import base64
from datetime import UTC, datetime
from io import BytesIO
import json
import os
from pathlib import Path
import time

import httpx
from PIL import Image


def data_url(color: str, *, format: str = "PNG", mime: str = "image/png", size=(64, 64)) -> str:
    output = BytesIO()
    Image.new("RGB", size, color).save(output, format=format)
    return f"data:{mime};base64," + base64.b64encode(output.getvalue()).decode()


def request(client: httpx.Client, endpoint: str, path: str, body: dict) -> dict:
    started = time.perf_counter()
    response = client.post(endpoint + path, json=body)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    receipt = {"path": path, "status": response.status_code, "elapsed_ms": elapsed_ms}
    try:
        receipt["response"] = response.json()
    except ValueError:
        receipt["response_text"] = response.text[:1000]
    return receipt


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint", default=os.environ.get("DJEV_ENDPOINT", "http://172.25.0.5:8000"))
    parser.add_argument("--api-key", default=os.environ.get("DJEV_API_KEY"))
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not args.api_key:
        parser.error("--api-key or DJEV_API_KEY is required")
    endpoint = args.endpoint.rstrip("/")
    headers = {"Authorization": "Bearer " + args.api_key}
    red = data_url("red")
    blue = data_url("blue")
    jpeg = data_url("red", format="JPEG", mime="image/jpeg")
    webp = data_url("blue", format="WEBP", mime="image/webp")
    corrupt = "data:image/png;base64," + base64.b64encode(b"not-an-image").decode()
    too_wide = data_url("red", size=(2049, 1))
    image_question = lambda image: {"type": "noul", "instructions": {"image": image, "text": "Is red present?"}}
    cases = [
        ("text", "/v1/request", {"model": "djev-latest", "state": "Please cancel my subscription.",
         "questions": {"cancel": {"type": "noul", "instructions": "Does the customer want cancellation?"}},
         "options": {"seed": 0}}),
        ("state_image", "/v1/request", {"model": "djev-latest", "state": "Use the supplied image as evidence.",
         "images": [red], "questions": {"red": {"type": "noul", "instructions": "Is the dominant color red?"}},
         "options": {"seed": 0}}),
        ("question_image", "/v1/request", {"model": "djev-latest", "state": "Classify the image attachment.",
         "questions": {"blue": {"type": "noul", "instructions": {"image": blue, "text": "Is this image blue?"}}},
         "options": {"seed": 0}}),
        ("jpeg_state_image", "/v1/request", {"model": "djev-latest", "state": "Use the supplied image as evidence.",
         "images": [jpeg], "questions": {"red": {"type": "noul", "instructions": "Is the dominant color red?"}}, "options": {"seed": 0}}),
        ("webp_question_image", "/v1/request", {"model": "djev-latest", "state": "Classify the image attachment.",
         "questions": {"blue": {"type": "noul", "instructions": {"image": webp, "text": "Is this image blue?"}}}, "options": {"seed": 0}}),
        ("corrupt_image", "/v1/request", {"state": "x", "images": [corrupt], "questions": {}}, 422),
        ("mime_mismatch", "/v1/request", {"state": "x", "images": [data_url("red", mime="image/jpeg")], "questions": {}}, 422),
        ("dimension_limit", "/v1/request", {"state": "x", "images": [too_wide], "questions": {}}, 422),
        ("attachment_limit", "/v1/request", {"state": "x", "questions": {str(i): image_question(red) for i in range(7)}}, 422),
        ("choice", "/v1/request", {"state": "My card was charged twice.",
         "questions": {"team": {"type": "choice", "instructions": "Which team should handle this?",
                                 "criteria": {"billing": "Payments and charges", "technical": "Bugs and outages"}}},
         "options": {"seed": 17}}),
        ("score", "/v1/request", {"state": "The production service is unavailable for every customer.",
         "questions": {"severity": {"type": "score", "instructions": "Rate incident severity.",
                                      "criteria": ["Low", "High", "Critical"]}}, "options": {"seed": 17}}),
        ("mixed_samples_diagnostics", "/v1/request", {"state": "Help! Payouts have failed for three days.",
         "questions": {"urgent": {"type": "noul", "instructions": "Is this urgent?"},
                       "team": {"type": "choice", "instructions": "Route the issue.",
                                "criteria": {"billing": "Payments", "technical": "Bugs"}},
                       "frustration": {"type": "score", "instructions": "Rate customer frustration.",
                                       "criteria": ["Calm", "Frustrated", "Very angry"]}},
         "options": {"samples": 2, "seed": -7919, "diagnostics": True}}),
        ("typesafe", "/v1/systemone", {"model": "djev-latest", "state": "The service is down and a customer is waiting.",
         "questions": {"urgent": {"type": "noul", "instructions": "Does this require an immediate response?"}}}),
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with httpx.Client(headers=headers, timeout=180) as client, args.output.open("w", encoding="utf-8") as stream:
        config = client.get(endpoint + "/config").json()
        stream.write(json.dumps({"kind": "manifest", "timestamp": datetime.now(UTC).isoformat(),
                                 "endpoint": endpoint, "config": config}, separators=(",", ":")) + "\n")
        unauth = httpx.post(endpoint + "/v1/request", json={"state": "x", "questions": {}})
        stream.write(json.dumps({"kind": "auth_rejection", "status": unauth.status_code}, separators=(",", ":")) + "\n")
        failed = unauth.status_code != 401
        for case in cases:
            name, path, body, *expected = case
            expected_status = expected[0] if expected else 200
            receipt = {"kind": "case", "name": name, "expected_status": expected_status,
                       **request(client, endpoint, path, body)}
            response = receipt.get("response", {})
            receipt["valid"] = (receipt["status"] == expected_status and
                                (expected_status != 200 or isinstance(response.get("answers"), dict)))
            failed = failed or not receipt["valid"]
            stream.write(json.dumps(receipt, separators=(",", ":")) + "\n")

        # Fixed seed is a reproducibility contract, not a cache claim: each call
        # must independently produce the same typed evidence.
        seeded = {"state": "Please cancel my subscription.",
                  "questions": {"cancel": {"type": "noul", "instructions": "Does the customer want cancellation?"}},
                  "options": {"seed": 2026}}
        first, second = request(client, endpoint, "/v1/request", seeded), request(client, endpoint, "/v1/request", seeded)
        deterministic = (first["status"] == second["status"] == 200 and
                         first.get("response", {}).get("answers") == second.get("response", {}).get("answers"))
        receipt = {"kind": "case", "name": "fixed_seed_repeat", "valid": deterministic,
                   "first": first, "second": second}
        failed = failed or not deterministic
        stream.write(json.dumps(receipt, separators=(",", ":")) + "\n")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
