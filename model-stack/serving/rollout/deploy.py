#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Blue-green deployment for model serving instances.

Workflow:
1. Load target model version from the registry.
2. Validate checkpoint integrity (file hash check).
3. Spin up a *new* serving instance (green) on a staging port.
4. Run health and smoke-test checks against the green instance.
5. Switch traffic from the current (blue) instance to green.
6. Drain and stop the blue instance.
7. Record deployment status in the rollout log.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import click
import httpx
import yaml

logger = logging.getLogger("deploy")

DEFAULT_REGISTRY_PATH = Path(__file__).resolve().parents[2] / "registry" / "models" / "registry.yaml"
ROLLOUT_LOG_PATH = Path(__file__).resolve().parent / "rollout_log.json"


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class DeploymentStatus:
    model_name: str
    model_version: str
    checkpoint_path: str
    started_at: str = ""
    finished_at: str = ""
    status: str = "pending"  # pending | deploying | healthy | failed | rolled_back
    green_pid: int = 0
    blue_pid: int = 0
    green_port: int = 0
    blue_port: int = 0
    errors: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Checkpoint integrity
# ---------------------------------------------------------------------------

def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def validate_checkpoint(checkpoint_dir: str) -> bool:
    """Verify that required checkpoint artefacts exist and match manifest hashes."""
    cp = Path(checkpoint_dir)
    if not cp.is_dir():
        logger.error("Checkpoint directory does not exist: %s", cp)
        return False

    manifest = cp / "checksums.sha256"
    if not manifest.exists():
        # If no manifest, just check that essential files are present.
        required = {"config.json", "tokenizer.json"}
        present = {p.name for p in cp.iterdir()}
        # Need config.json at minimum, weight files may vary.
        if "config.json" not in present:
            logger.error("config.json missing from %s", cp)
            return False
        weight_files = [p for p in cp.iterdir() if p.suffix in (".bin", ".safetensors")]
        if not weight_files:
            logger.error("No weight files found in %s", cp)
            return False
        logger.info("Checkpoint integrity OK (no manifest, heuristic check)")
        return True

    # Verify hashes from manifest
    for line in manifest.read_text().strip().splitlines():
        expected_hash, fname = line.split(maxsplit=1)
        fpath = cp / fname
        if not fpath.exists():
            logger.error("Missing file from manifest: %s", fname)
            return False
        actual = sha256_file(fpath)
        if actual != expected_hash:
            logger.error("Hash mismatch for %s: expected %s, got %s", fname, expected_hash, actual)
            return False

    logger.info("Checkpoint integrity verified against manifest")
    return True


# ---------------------------------------------------------------------------
# Instance management
# ---------------------------------------------------------------------------

def start_serving_instance(
    model_path: str,
    port: int,
    tensor_parallel: int = 1,
    gpu_memory_utilization: float = 0.90,
    extra_args: list[str] | None = None,
) -> subprocess.Popen:
    """Launch a serving process in the background."""
    serve_script = Path(__file__).resolve().parents[1] / "runtime" / "serve.py"
    cmd = [
        sys.executable,
        str(serve_script),
        "--model-path", model_path,
        "--port", str(port),
        "--tensor-parallel", str(tensor_parallel),
        "--gpu-memory-utilization", str(gpu_memory_utilization),
    ]
    if extra_args:
        cmd.extend(extra_args)

    logger.info("Starting serving instance: %s", " ".join(cmd))
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    return proc


def wait_for_health(url: str, timeout: int = 300, interval: int = 5) -> bool:
    """Poll the health endpoint until it returns 200 or timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = httpx.get(url, timeout=5)
            if resp.status_code == 200:
                logger.info("Health check passed: %s", url)
                return True
        except httpx.RequestError:
            pass
        time.sleep(interval)
    logger.error("Health check timed out after %ds: %s", timeout, url)
    return False


def smoke_test(base_url: str) -> bool:
    """Send a trivial completion request and verify a non-empty response."""
    try:
        resp = httpx.post(
            f"{base_url}/v1/completions",
            json={
                "prompt": "Hello,",
                "max_tokens": 8,
                "temperature": 0.0,
            },
            timeout=30,
        )
        if resp.status_code != 200:
            logger.error("Smoke test HTTP %d: %s", resp.status_code, resp.text[:200])
            return False
        data = resp.json()
        text = data.get("choices", [{}])[0].get("text", "")
        if not text.strip():
            logger.error("Smoke test returned empty text")
            return False
        logger.info("Smoke test passed (got %d chars)", len(text))
        return True
    except Exception as exc:
        logger.exception("Smoke test failed: %s", exc)
        return False


def stop_process(proc: subprocess.Popen, timeout: int = 30) -> None:
    """Gracefully stop a subprocess."""
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        logger.warning("Process %d did not terminate, killing", proc.pid)
        proc.kill()
        proc.wait(timeout=10)


# ---------------------------------------------------------------------------
# Registry helpers
# ---------------------------------------------------------------------------

def load_registry(registry_path: Path) -> dict:
    if not registry_path.exists():
        return {"models": []}
    return yaml.safe_load(registry_path.read_text()) or {"models": []}


def find_model_version(registry: dict, name: str, version: str) -> dict | None:
    for entry in registry.get("models", []):
        if entry.get("name") == name and entry.get("version") == version:
            return entry
    return None


# ---------------------------------------------------------------------------
# Rollout log persistence
# ---------------------------------------------------------------------------

def append_rollout_log(status: DeploymentStatus) -> None:
    log: list[dict] = []
    if ROLLOUT_LOG_PATH.exists():
        log = json.loads(ROLLOUT_LOG_PATH.read_text())
    log.append(asdict(status))
    ROLLOUT_LOG_PATH.write_text(json.dumps(log, indent=2))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.group()
def cli():
    """Model deployment toolkit (blue-green)."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )


@cli.command()
@click.option("--model-name", required=True, help="Model name in registry")
@click.option("--model-version", required=True, help="Model version to deploy")
@click.option("--registry-path", type=click.Path(), default=str(DEFAULT_REGISTRY_PATH))
@click.option("--blue-port", type=int, default=8000, help="Port of the current (blue) instance")
@click.option("--green-port", type=int, default=8001, help="Port for the new (green) instance")
@click.option("--tensor-parallel", type=int, default=1)
@click.option("--health-timeout", type=int, default=300, help="Seconds to wait for health")
@click.option("--gpu-memory-utilization", type=float, default=0.90)
def deploy(
    model_name: str,
    model_version: str,
    registry_path: str,
    blue_port: int,
    green_port: int,
    tensor_parallel: int,
    health_timeout: int,
    gpu_memory_utilization: float,
):
    """Deploy a model version using blue-green strategy."""
    reg = load_registry(Path(registry_path))
    entry = find_model_version(reg, model_name, model_version)
    if entry is None:
        raise click.ClickException(f"Model {model_name}@{model_version} not found in registry")

    checkpoint_path = entry["checkpoint_path"]
    status = DeploymentStatus(
        model_name=model_name,
        model_version=model_version,
        checkpoint_path=checkpoint_path,
        started_at=datetime.now(timezone.utc).isoformat(),
        blue_port=blue_port,
        green_port=green_port,
    )

    # --- step 1: validate checkpoint ---
    click.echo(f"Validating checkpoint at {checkpoint_path} ...")
    if not validate_checkpoint(checkpoint_path):
        status.status = "failed"
        status.errors.append("Checkpoint integrity validation failed")
        status.finished_at = datetime.now(timezone.utc).isoformat()
        append_rollout_log(status)
        raise click.ClickException("Checkpoint validation failed")

    # --- step 2: check blue health (if running) ---
    blue_healthy = False
    try:
        resp = httpx.get(f"http://localhost:{blue_port}/health", timeout=5)
        blue_healthy = resp.status_code == 200
    except httpx.RequestError:
        pass

    if blue_healthy:
        click.echo(f"Current (blue) instance on port {blue_port} is healthy")
    else:
        click.echo(f"No healthy blue instance on port {blue_port} (fresh deploy)")

    # --- step 3: start green instance ---
    status.status = "deploying"
    click.echo(f"Starting green instance on port {green_port} ...")
    green_proc = start_serving_instance(
        model_path=checkpoint_path,
        port=green_port,
        tensor_parallel=tensor_parallel,
        gpu_memory_utilization=gpu_memory_utilization,
    )
    status.green_pid = green_proc.pid

    # --- step 4: wait for green health ---
    green_url = f"http://localhost:{green_port}"
    if not wait_for_health(f"{green_url}/health", timeout=health_timeout):
        status.status = "failed"
        status.errors.append("Green instance failed health check")
        stop_process(green_proc)
        status.finished_at = datetime.now(timezone.utc).isoformat()
        append_rollout_log(status)
        raise click.ClickException("Green instance failed health check")

    # --- step 5: smoke test green ---
    if not smoke_test(green_url):
        status.status = "failed"
        status.errors.append("Green instance failed smoke test")
        stop_process(green_proc)
        status.finished_at = datetime.now(timezone.utc).isoformat()
        append_rollout_log(status)
        raise click.ClickException("Green instance failed smoke test")

    # --- step 6: switch traffic (in production this would update a load
    #     balancer; here we record the port swap and stop blue) ---
    click.echo("Green instance verified. Switching traffic ...")
    if blue_healthy:
        click.echo(f"Stopping blue instance on port {blue_port} ...")
        # In a real setup we'd look up the PID; here we try a graceful HTTP shutdown
        try:
            httpx.post(f"http://localhost:{blue_port}/shutdown", timeout=5)
        except httpx.RequestError:
            pass

    status.status = "healthy"
    status.finished_at = datetime.now(timezone.utc).isoformat()
    append_rollout_log(status)

    click.echo(
        f"Deployment complete: {model_name}@{model_version} "
        f"serving on port {green_port} (pid {green_proc.pid})"
    )


@cli.command()
def status():
    """Show rollout log."""
    if not ROLLOUT_LOG_PATH.exists():
        click.echo("No rollout log found.")
        return
    log = json.loads(ROLLOUT_LOG_PATH.read_text())
    for entry in log[-10:]:
        click.echo(
            f"{entry['started_at']} | {entry['model_name']}@{entry['model_version']} | "
            f"{entry['status']}"
        )


if __name__ == "__main__":
    cli()
