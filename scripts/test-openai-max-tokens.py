#!/usr/bin/env python3
import argparse
import json
import os
import sys
import urllib.request
from pathlib import Path


def build_url(base_url: str, endpoint: str) -> str:
    base = base_url.rstrip("/")
    if endpoint == "responses":
        return f"{base}/responses"
    if endpoint == "chat":
        return f"{base}/chat/completions"
    raise ValueError(f"Unsupported endpoint: {endpoint}")


def load_dotenv(paths: list[Path]) -> None:
    for path in paths:
        if not path.exists():
            continue
        for raw_line in path.read_text().splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export ") :]
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


def main() -> int:
    parser = argparse.ArgumentParser(description="Test OpenAI API with model-specific token limits.")
    parser.add_argument("--endpoint", choices=["responses", "chat"], default="responses")
    parser.add_argument("--model", default=os.getenv("OPENAI_MODEL", "gpt-5.1"))
    parser.add_argument("--base-url", default=os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"))
    parser.add_argument("--max-tokens", type=int, default=150, help="Token limit value (mapped to the correct parameter).")
    parser.add_argument("--input", default="Summarize this in one sentence.")
    parser.add_argument("--instructions", default="You are a concise assistant.")
    parser.add_argument("--dotenv", action="append", default=[], help="Load env vars from a .env file (can be repeated).")
    args = parser.parse_args()

    dotenv_paths = [Path(p) for p in args.dotenv] if args.dotenv else [Path(".env.local"), Path("worker/.env.local")]
    load_dotenv(dotenv_paths)

    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        print("Missing OPENAI_API_KEY in environment.", file=sys.stderr)
        return 1

    url = build_url(args.base_url, args.endpoint)

    if args.endpoint == "responses":
        payload = {
            "model": args.model,
            "instructions": args.instructions,
            "input": args.input,
            "max_output_tokens": args.max_tokens,
        }
    else:
        payload = {
            "model": args.model,
            "messages": [
                {"role": "system", "content": args.instructions},
                {"role": "user", "content": args.input},
            ],
            "max_completion_tokens": args.max_tokens,
        }

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode("utf-8")
            print(f"HTTP {resp.status} {resp.reason}")
            print(body)
            return 0
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8")
        print(f"HTTP {exc.code} {exc.reason}")
        print(body)
        return 2
    except Exception as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
