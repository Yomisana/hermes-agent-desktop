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
    parser.add_argument(
        "--allow-empty",
        action="store_true",
        help="Write an empty seed when no URL is configured (public generic build)",
    )
    args = parser.parse_args()

    if not args.url and args.allow_empty:
        args.path.parent.mkdir(parents=True, exist_ok=True)
        args.path.write_text("{}\n", encoding="utf-8")
        print("HERMES_GATEWAY_URL is unset; building without a preconfigured server URL")
        return

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
