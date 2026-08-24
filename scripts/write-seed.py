#!/usr/bin/env python3
"""Write a URL-only connection seed without shell interpolation."""

import argparse
import json
from pathlib import Path
from urllib.parse import urlparse


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("url")
    args = parser.parse_args()

    parsed = urlparse(args.url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.username or parsed.password:
        raise SystemExit("HERMES_GATEWAY_URL must be an absolute http(s) URL without embedded credentials")

    args.path.parent.mkdir(parents=True, exist_ok=True)
    args.path.write_text(
        json.dumps({"mode": "remote", "baseUrl": args.url}, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
