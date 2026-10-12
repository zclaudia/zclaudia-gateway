"""Shared helpers for the contract suite (real gateway + TS peer)."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import json
import shutil
import subprocess
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

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


@dataclass
class HttpResponse:
    status: int
    headers: dict[str, str]
    body: bytes


class ProxyHttpStream:
    """One in-flight HTTP/1.1 request against the gateway (stdlib only).

    The dev extras ship no HTTP client, and the streaming tests need to read a
    response before it ends and then drop the connection — which is what the
    gateway sees as a client abort. ``next_body_chunk`` decodes chunked
    transfer encoding, where each gateway ``res.write`` arrives as one chunk.
    """

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, *, timeout: float = 15.0) -> None:
        self._reader = reader
        self._writer = writer
        self._timeout = timeout
        self._chunked = False
        self._length: int | None = None
        self._received = 0
        self._eof = False
        self.status = 0
        self.headers: dict[str, str] = {}

    async def _wait(self, awaitable: Any) -> Any:
        return await asyncio.wait_for(awaitable, self._timeout)

    async def read_head(self) -> None:
        line = await self._wait(self._reader.readline())
        if not line:
            raise AssertionError("gateway closed the connection before the response line")
        self.status = int(line.decode("latin-1").split(" ", 2)[1])
        while True:
            line = await self._wait(self._reader.readline())
            if line in (b"\r\n", b"\n", b""):
                break
            name, _, value = line.decode("latin-1").partition(":")
            self.headers[name.strip().lower()] = value.strip()
        self._chunked = "chunked" in self.headers.get("transfer-encoding", "").lower()
        if not self._chunked and "content-length" in self.headers:
            self._length = int(self.headers["content-length"])

    async def next_body_chunk(self) -> bytes:
        """Next slice of the response body; empty bytes once the body ended."""
        if self._eof:
            return b""
        if self._chunked:
            return await self._read_chunked()
        if self._length is not None:
            return await self._read_sized()
        data = await self._wait(self._reader.read(65536))
        if not data:
            self._eof = True
        return data

    async def _read_chunked(self) -> bytes:
        line = await self._wait(self._reader.readline())
        size_text = line.split(b";", 1)[0].strip()
        size = int(size_text, 16) if size_text else 0
        if size == 0:
            self._eof = True
            return b""
        data = await self._wait(self._reader.readexactly(size))
        await self._wait(self._reader.readexactly(2))  # the chunk's trailing CRLF
        return data

    async def _read_sized(self) -> bytes:
        remaining = (self._length or 0) - self._received
        if remaining <= 0:
            self._eof = True
            return b""
        data = await self._wait(self._reader.readexactly(min(remaining, 65536)))
        self._received += len(data)
        return data

    async def read_body(self) -> bytes:
        chunks: list[bytes] = []
        while (chunk := await self.next_body_chunk()):
            chunks.append(chunk)
        return b"".join(chunks)

    async def close(self) -> None:
        self._writer.close()
        with contextlib.suppress(Exception):
            await self._writer.wait_closed()


async def open_proxy_request(
    base_url: str,
    method: str,
    path: str,
    *,
    headers: Mapping[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 15.0,
) -> ProxyHttpStream:
    """Send a request to the gateway and return the stream once its head is in.

    ``path`` is appended to the base URL's own path, so a proxy base of
    ``http://host/api/proxy/<backendId>`` plus ``/stream`` reaches the right
    place.
    """
    parts = urlsplit(base_url)
    host = parts.hostname or "127.0.0.1"
    port = parts.port or 80
    target = f"{parts.path.rstrip('/')}{path}" if path.startswith("/") else f"{parts.path.rstrip('/')}/{path}"
    reader, writer = await asyncio.open_connection(host, port)
    stream = ProxyHttpStream(reader, writer, timeout=timeout)
    try:
        lines = [f"{method} {target} HTTP/1.1", f"Host: {host}:{port}", "Connection: close"]
        for name, value in (headers or {}).items():
            lines.append(f"{name}: {value}")
        if body is not None:
            lines.append(f"Content-Length: {len(body)}")
        writer.write(("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + (body or b""))
        await writer.drain()
        await stream.read_head()
    except BaseException:
        await stream.close()
        raise
    return stream


async def proxy_request(
    base_url: str,
    method: str,
    path: str,
    *,
    headers: Mapping[str, str] | None = None,
    body: bytes | None = None,
    timeout: float = 15.0,
) -> HttpResponse:
    """Complete one proxied request and return ``(status, headers, body)``."""
    stream = await open_proxy_request(base_url, method, path, headers=headers, body=body, timeout=timeout)
    try:
        payload = await stream.read_body()
        return HttpResponse(stream.status, stream.headers, payload)
    finally:
        await stream.close()
