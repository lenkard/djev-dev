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


def data_url(color: str) -> str:
    output = BytesIO()
    Image.new("RGB", (64, 64), color).save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()


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
        for name, path, body in cases:
            receipt = {"kind": "case", "name": name, **request(client, endpoint, path, body)}
            response = receipt.get("response", {})
            receipt["valid"] = receipt["status"] == 200 and isinstance(response.get("answers"), dict)
            failed = failed or not receipt["valid"]
            stream.write(json.dumps(receipt, separators=(",", ":")) + "\n")
    return int(failed)


if __name__ == "__main__":
    raise SystemExit(main())
