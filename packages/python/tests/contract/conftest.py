"""Contract-suite fixtures: a real gateway process and issued credentials."""

from __future__ import annotations

import json
import subprocess

import pytest
from helpers import (
    ADMIN_TOKEN,
    NAMESPACE,
    REPO_ROOT,
    SERVER_DIST,
    START_GATEWAY,
    issue_credential,
    node_binary,
    repo_needs_build,
)

from zclaudia_gateway import GatewayBackend


@pytest.fixture(scope="session")
def gateway():
    """Boot the real gateway (built dist) on a random port; yield its URLs."""
    node = node_binary()
    if node is None:
        pytest.skip("node is required for contract tests")
    if repo_needs_build():
        build = subprocess.run(["pnpm", "build"], cwd=REPO_ROOT, capture_output=True, text=True)
        if build.returncode != 0:
            pytest.fail(f"pnpm build failed:\n{build.stdout}\n{build.stderr}")

    proc = subprocess.Popen(
        [node, str(START_GATEWAY), str(SERVER_DIST), ADMIN_TOKEN],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        cwd=str(REPO_ROOT),
    )
    assert proc.stdout is not None and proc.stderr is not None
    line = proc.stdout.readline()
    if not line:
        stderr = proc.stderr.read()
        proc.kill()
        pytest.fail(f"gateway failed to start:\n{stderr}")
    info = json.loads(line)
    try:
        yield info
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


@pytest.fixture(scope="session")
def enrollment(gateway):
    """A zgb_ enrollment credential for the contract namespace."""
    return issue_credential(gateway["httpUrl"], type="backend", name="contract-backend")


@pytest.fixture(scope="session")
def device(gateway):
    """A zgd_ device credential: what a phone presents to /api/proxy."""
    return issue_credential(gateway["httpUrl"], type="device", name="contract-device")


@pytest.fixture
async def backend(gateway, enrollment):
    """A Python backend bound to the contract namespace (not yet connected)."""
    client = GatewayBackend(
        url=gateway["httpUrl"],
        credential=enrollment["token"],
        namespace=NAMESPACE,
        identity={"device_id": "contract-dev", "instance_id": "contract-inst", "name": "contract-backend"},
    )
    try:
        yield client
    finally:
        await client.close()
