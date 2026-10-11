"""Shared helpers for the contract suite (real gateway + TS peer)."""

from __future__ import annotations

import asyncio
import inspect
import json
import shutil
import subprocess
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

TESTS_DIR = Path(__file__).resolve().parents[1]  # packages/python/tests
PYTHON_PKG = TESTS_DIR.parent  # packages/python
REPO_ROOT = PYTHON_PKG.parents[1]  # repo root

HARNESS_DIR = TESTS_DIR / "harness"
START_GATEWAY = HARNESS_DIR / "start-gateway.mjs"
PEER_CLIENT = HARNESS_DIR / "peer-client.mjs"
CLIENT_DIST = REPO_ROOT / "packages" / "client" / "dist" / "index.js"
SERVER_DIST = REPO_ROOT / "dist" / "server.js"

ADMIN_TOKEN = "contract-admin-token"
NAMESPACE = "contract-test"


def node_binary() -> str | None:
    return shutil.which("node")


def repo_needs_build() -> bool:
    """True when the built dist is missing or older than any workspace source."""
    if not SERVER_DIST.exists() or not CLIENT_DIST.exists():
        return True
    dist_mtime = min(SERVER_DIST.stat().st_mtime, CLIENT_DIST.stat().st_mtime)
    for pattern in ("src/**/*.ts", "packages/*/src/**/*.ts"):
        for path in REPO_ROOT.glob(pattern):
            if path.stat().st_mtime > dist_mtime:
                return True
    return False


def issue_credential(
    http_url: str,
    *,
    type: str,
    name: str,
    namespace: str = NAMESPACE,
) -> dict[str, Any]:
    """Issue a credential through the Admin API; returns the data object."""
    payload = json.dumps({"type": type, "namespace": namespace, "name": name}).encode("utf-8")
    request = urllib.request.Request(
        f"{http_url}/api/admin/credentials",
        data=payload,
        method="POST",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        body = json.loads(response.read().decode("utf-8"))
    return body["data"]


def list_credentials(http_url: str) -> list[dict[str, Any]]:
    request = urllib.request.Request(
        f"{http_url}/api/admin/credentials",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        body = json.loads(response.read().decode("utf-8"))
    return body["data"]


def peer_command(*args: str) -> list[str]:
    node = node_binary()
    assert node is not None
    return [node, str(PEER_CLIENT), str(CLIENT_DIST), *args]


def run_peer(*args: str, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(peer_command(*args), capture_output=True, text=True, timeout=timeout)


async def run_peer_async(*args: str, timeout: float = 30.0) -> subprocess.CompletedProcess[str]:
    return await asyncio.to_thread(run_peer, *args, timeout=timeout)


def parse_peer_result(stdout: str) -> dict[str, Any]:
    for line in reversed(stdout.splitlines()):
        if line.startswith("RESULT "):
            return json.loads(line[len("RESULT ") :])
    raise AssertionError(f"peer produced no RESULT line:\n{stdout}")


async def until(predicate: Callable[[], Any], timeout: float = 5.0, interval: float = 0.02) -> None:
    loop = asyncio.get_event_loop()
    deadline = loop.time() + timeout
    while True:
        value = predicate()
        if inspect.isawaitable(value):
            value = await value
        if value:
            return
        if loop.time() > deadline:
            raise AssertionError("condition not met in time")
        await asyncio.sleep(interval)
