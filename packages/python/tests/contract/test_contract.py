"""Cross-language contract tests: Python SDK as the Backend, the real gateway
in the middle, and the TypeScript ``@zclaudia/gateway-client`` as the remote
peer (via ``tests/harness/peer-client.mjs``).

These are the release gate: they verify the Python implementation against the
actual server behavior and the reference peer, not against a stand-in.
"""

from __future__ import annotations

import asyncio
import json
import urllib.request

from helpers import (
    NAMESPACE,
    list_credentials,
    parse_peer_result,
    peer_command,
    run_peer_async,
    until,
)

from zclaudia_gateway import HttpServeRequest, HttpServeResponse


def peer_args(gateway, enrollment, *extra: str) -> tuple[str, ...]:
    return ("--url", gateway["httpUrl"], "--token", enrollment["token"], "--namespace", NAMESPACE, *extra)


async def test_registry_visibility_and_identity(gateway, enrollment, backend):
    backend_id, epoch = await backend.connect()

    result = await run_peer_async("registry", *peer_args(gateway, enrollment, "--backend-id", backend_id))
    assert result.returncode == 0, result.stderr
    payload = parse_peer_result(result.stdout)

    assert payload["backendId"] == backend_id
    assert payload["name"] == "contract-backend"
    assert payload["namespace"] == NAMESPACE
    assert payload["epoch"] == epoch
    assert payload["gatewayProtocolVersion"] == 4


async def test_channel_echo_text_and_binary(gateway, enrollment, backend):
    async def echo(channel, info):
        async for data in channel:
            await channel.send(data)

    backend.on_channel("echo", echo)
    backend_id, _ = await backend.connect()

    result = await run_peer_async(
        "channel-echo",
        *peer_args(gateway, enrollment, "--backend-id", backend_id, "--kind", "echo"),
    )
    assert result.returncode == 0, result.stderr
    payload = parse_peer_result(result.stdout)

    assert payload["text"] == "hello"
    assert payload["binaryFlag"] is True
    assert payload["binary"] == [0, 1, 254, 255, 128]


async def test_topic_retained_snapshot_reaches_new_subscriber(gateway, enrollment, backend):
    backend_id, _ = await backend.connect()
    await backend.publish_topic("resources", {"rev": 7}, retain=True)

    result = await run_peer_async(
        "topic",
        *peer_args(gateway, enrollment, "--backend-id", backend_id, "--topic", "resources", "--count", "1"),
    )
    assert result.returncode == 0, result.stderr
    assert parse_peer_result(result.stdout)["messages"] == [{"rev": 7}]


async def test_topic_live_publish_after_subscribe(gateway, enrollment, backend):
    backend_id, _ = await backend.connect()

    proc = await asyncio.create_subprocess_exec(
        *peer_command(
            "topic",
            *peer_args(gateway, enrollment, "--backend-id", backend_id, "--topic", "live", "--count", "1"),
        ),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    assert proc.stdout is not None and proc.stderr is not None

    # Wait until the peer has actually subscribed, then publish.
    first_line = b""
    while not first_line.startswith(b"subscribed"):
        first_line = await asyncio.wait_for(proc.stdout.readline(), 15)
        assert first_line, "peer exited before subscribing"
    await backend.publish_topic("live", {"n": 1})

    remaining, stderr = await asyncio.wait_for(proc.communicate(), 15)
    assert proc.returncode == 0, stderr.decode()
    output = first_line.decode() + remaining.decode()
    assert parse_peer_result(output)["messages"] == [{"n": 1}]


async def test_http_proxy_round_trip(gateway, enrollment, backend):
    def handler(request: HttpServeRequest) -> HttpServeResponse:
        if request.method == "POST":
            return HttpServeResponse(
                status=200,
                headers={"Content-Type": "application/json"},
                body=json.dumps({"echo": json.loads(request.body), "path": request.path}),
            )
        return HttpServeResponse(status=200, body=f"GET {request.path}")

    backend.serve_http(handler)
    backend_id, _ = await backend.connect()

    def call(method: str, path: str, body: bytes | None = None) -> tuple[int, bytes]:
        request = urllib.request.Request(
            f"{gateway['httpUrl']}/api/proxy/{backend_id}{path}",
            data=body,
            method=method,
            headers={"Authorization": f"Bearer {enrollment['token']}", "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read()

    status, body = await asyncio.to_thread(call, "POST", "/sum?verbose=1", json.dumps([1, 2, 3]).encode())
    assert status == 200
    assert json.loads(body) == {"echo": [1, 2, 3], "path": "/sum?verbose=1"}

    status, body = await asyncio.to_thread(call, "GET", "/hello")
    assert status == 200
    assert body == b"GET /hello"


async def test_reconnect_fresh_epoch_stable_id_and_channels_work(gateway, enrollment, backend):
    async def echo(channel, info):
        async for data in channel:
            await channel.send(data)

    backend.on_channel("echo", echo)
    backend_id, epoch1 = await backend.connect()

    # Simulate a network drop on the SDK's own control socket (same technique
    # as the TypeScript contract test).
    await backend._ws.close(4000)  # noqa: SLF001
    await until(lambda: backend.state == "connected" and backend.epoch > epoch1, timeout=15)
    assert backend.backend_id == backend_id

    result = await run_peer_async("registry", *peer_args(gateway, enrollment, "--backend-id", backend_id))
    assert result.returncode == 0, result.stderr
    assert parse_peer_result(result.stdout)["epoch"] > epoch1

    result = await run_peer_async(
        "channel-echo",
        *peer_args(gateway, enrollment, "--backend-id", backend_id, "--kind", "echo"),
    )
    assert result.returncode == 0, result.stderr
    assert parse_peer_result(result.stdout)["text"] == "hello"


async def test_enrollment_exchange_creates_access_credential(gateway, enrollment, backend):
    await backend.connect()

    credentials = await asyncio.to_thread(list_credentials, gateway["httpUrl"])
    children = [
        credential
        for credential in credentials
        if credential.get("type") == "backend-access" and credential.get("parentId") == enrollment["id"]
    ]
    assert children, "expected an exchanged backend-access credential"
    assert children[0]["lastUsedAt"] is not None


async def test_start_reports_a_refused_credential_against_the_real_gateway(gateway, enrollment):
    from zclaudia_gateway import GatewayBackend

    bad = "zgb_" + "0" * 48
    client = GatewayBackend(
        url=gateway["httpUrl"],
        credential=bad,
        namespace=NAMESPACE,
        identity={"device_id": "contract-dev", "instance_id": "contract-bad", "name": "bad-credential"},
        reconnect_min_ms=50,
        reconnect_max_ms=100,
    )
    try:
        await client.start()  # returns normally although the gateway refuses us
        await until(lambda: client.last_error is not None)
        assert client.state == "connecting"
        assert client.last_error.code == "AUTH_FAILED"
        assert bad not in repr(client.last_error)
    finally:
        await client.close()


async def test_start_reports_an_unreachable_gateway_then_clears_on_connect(gateway, enrollment):
    import socket

    from zclaudia_gateway import GatewayBackend

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        dead_url = f"http://127.0.0.1:{sock.getsockname()[1]}"
    client = GatewayBackend(
        url=dead_url,
        credential=enrollment["token"],
        namespace=NAMESPACE,
        identity={"device_id": "contract-dev", "instance_id": "contract-dead"},
        reconnect_min_ms=50,
        reconnect_max_ms=100,
    )
    try:
        await client.start()
        await until(lambda: client.last_error is not None)
        assert client.last_error.code == "GATEWAY_UNREACHABLE"
    finally:
        await client.close()
