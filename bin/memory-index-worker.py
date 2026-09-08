#!/usr/bin/env python3
"""Trusted stdio bridge for Portal-owned per-user memsearch indexes."""

import asyncio
import json
import re
import sys
from pathlib import Path

INDEX_ROOT = Path(sys.argv[1]).resolve()
MODEL_ID = sys.argv[2]
MODEL_REVISION = sys.argv[3]
SAFE_USER = re.compile(r"^[A-Za-z0-9-]{1,80}$")

# memsearch 0.4.19 does not expose a model revision option. Patch the Hub API
# before importing it so every model file is resolved from the reviewed commit.
import huggingface_hub  # type: ignore

_download = huggingface_hub.hf_hub_download
_snapshot = huggingface_hub.snapshot_download


def _pinned_download(*args, **kwargs):
    repo_id = kwargs.get("repo_id") or (args[0] if args else None)
    if repo_id == MODEL_ID:
        kwargs["revision"] = MODEL_REVISION
    return _download(*args, **kwargs)


def _pinned_snapshot(*args, **kwargs):
    repo_id = kwargs.get("repo_id") or (args[0] if args else None)
    if repo_id == MODEL_ID:
        kwargs["revision"] = MODEL_REVISION
    return _snapshot(*args, **kwargs)


huggingface_hub.hf_hub_download = _pinned_download
huggingface_hub.snapshot_download = _pinned_snapshot

from memsearch import MemSearch  # type: ignore  # noqa: E402

CLIENTS = {}


def client(user_id):
    if not SAFE_USER.fullmatch(user_id):
        raise ValueError("invalid user id")
    if user_id not in CLIENTS:
        root = (INDEX_ROOT / "users" / user_id).resolve()
        if INDEX_ROOT not in root.parents:
            raise ValueError("user path escaped index root")
        documents = root / "documents"
        documents.mkdir(parents=True, exist_ok=True)
        CLIENTS[user_id] = MemSearch(
            paths=[str(documents)],
            embedding_provider="onnx",
            embedding_model=MODEL_ID,
            milvus_uri=str(root / "milvus.db"),
            collection="portal_user_memories",
            max_chunk_size=1400,
            overlap_lines=0,
            exclude=[".*", "*.tmp"],
        )
    return CLIENTS[user_id]


async def dispatch(method, params):
    user_id = str(params.get("userId", ""))
    memory = client(user_id)
    if method == "index":
        return {"indexed": await memory.index()}
    if method == "search":
        query = str(params.get("query", ""))[:100000]
        top_k = max(1, min(50, int(params.get("topK", 10))))
        results = await memory.search(query, top_k=top_k)
        return {"results": results}
    raise ValueError("unknown method")


async def main():
    INDEX_ROOT.mkdir(parents=True, exist_ok=True)
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = await dispatch(request.get("method"), request.get("params") or {})
            response = {"id": request.get("id"), "result": result}
        except Exception as error:  # no memory contents are logged
            response = {"id": request.get("id") if "request" in locals() else None,
                        "error": {"code": "MEMORY_INDEX_FAILED", "message": type(error).__name__}}
        print(json.dumps(response, ensure_ascii=False), flush=True)
    for memory in CLIENTS.values():
        memory.close()


asyncio.run(main())
