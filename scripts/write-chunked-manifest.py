#!/usr/bin/env python3
"""Chunk a single .dsk into the manifest format BasiliskII WASM consumes.

This is a near-verbatim port of `write_chunked_image()` from
mihaip/infinite-mac@30112da0db5d04ff5764d77ae757e73111a6ef12,
`scripts/import-disks.py`. Same constants (256 KiB chunks, blake2b-16 with
salt b"raw") so the output is bit-compatible with what their worker
(`src/emulator/worker/chunked-disk.ts`) expects.

We isolate just the chunker (not the full Infinite Mac build harness)
because:
  - their script is wired into a much larger pipeline (CD-ROM imports,
    placeholder stickies, library JSON, etc.) we don't need;
  - extracting only this bit keeps our CI dependency-free except for
    python3 stdlib;
  - the chunking algorithm is small enough that maintaining a copy is
    cheaper than vendoring the upstream tree.

Output (in --out-dir):
  <name>.json     EmulatorChunkedFileSpec-shaped JSON manifest
  <signature>.chunk   one file per unique non-zero chunk

Usage:
  python3 write-chunked-manifest.py --image PATH --name NAME --out-dir DIR
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

CHUNK_SIZE = 256 * 1024
SALT = b"raw"
ZERO_CHUNK = b"\0" * CHUNK_SIZE


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--image", required=True, help="path to .dsk to chunk")
    p.add_argument("--name", required=True,
                   help="logical disk name (becomes <name>.json filename)")
    p.add_argument("--out-dir", required=True,
                   help="destination dir for chunks + manifest")
    args = p.parse_args()

    if not os.path.isfile(args.image):
        print(f"error: image not found: {args.image}", file=sys.stderr)
        return 1
    os.makedirs(args.out_dir, exist_ok=True)

    with open(args.image, "rb") as f:
        image_bytes = f.read()
    disk_size = len(image_bytes)

    chunks: list[str] = []
    seen_signatures: set[str] = set()
    zero_chunk_count = 0
    total_size = 0

    for i in range(0, disk_size, CHUNK_SIZE):
        chunk = image_bytes[i : i + CHUNK_SIZE]
        total_size += len(chunk)
        # Empty chunk shortcut: the worker reads the empty string in the
        # `chunks` array as "synthesize an all-zeros chunk in memory" and
        # never makes an HTTP request for it. Saves bandwidth + storage.
        if chunk == ZERO_CHUNK:
            chunks.append("")
            zero_chunk_count += 1
            continue
        # Pad the trailing chunk so the signature is computed over a
        # full-size buffer (matches upstream behaviour: see chunked-disk.ts
        # which pads short chunks with zeros after fetching).
        if len(chunk) < CHUNK_SIZE:
            chunk = chunk + b"\0" * (CHUNK_SIZE - len(chunk))
        sig = hashlib.blake2b(chunk, digest_size=16, salt=SALT).hexdigest()
        chunks.append(sig)
        if sig in seen_signatures:
            continue
        seen_signatures.add(sig)
        chunk_path = os.path.join(args.out_dir, f"{sig}.chunk")
        if not os.path.exists(chunk_path):
            with open(chunk_path, "wb") as out:
                out.write(chunk)

    if chunks:
        unique_pct = round(len(seen_signatures) / len(chunks) * 100)
        zero_pct = round(zero_chunk_count / len(chunks) * 100)
        print(
            f"chunked {args.name}: {len(chunks)} chunks, "
            f"{unique_pct}% unique, {zero_pct}% zero",
            file=sys.stderr,
        )
    else:
        print(f"chunked {args.name}: 0 chunks", file=sys.stderr)

    manifest_path = os.path.join(args.out_dir, f"{args.name}.json")
    with open(manifest_path, "w") as out:
        # Field names match common.ts EmulatorChunkedFileSpec exactly.
        # `name` excludes any extension to match Infinite Mac's
        # write_chunked_image() output (where they json.dump
        # `os.path.splitext(image.name)[0]`). prefetchChunks defaults to
        # the first chunk so the worker can boot the catalog quickly;
        # bigger prefetch sets are built up empirically by upstream.
        json.dump(
            {
                "name": os.path.splitext(args.name)[0],
                "totalSize": total_size,
                "chunks": chunks,
                "chunkSize": CHUNK_SIZE,
                "prefetchChunks": [0] if chunks else [],
            },
            out,
            indent=4,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
