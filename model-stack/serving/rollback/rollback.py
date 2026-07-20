#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Rollback to a previous model serving version.

Reads the rollout log to find the last successfully deployed version,
restores it, verifies health, and records the rollback in the log.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import click
import httpx
import yaml

logger = logging.getLogger("rollback")

ROLLOUT_LOG_PATH = Path(__file__).resolve().parents[1] / "rollout" / "rollout_log.json"
DEFAULT_REGISTRY_PATH = Path(__file__).resolve().parents[2] / "registry" / "models" / "registry.yaml"


# ---------------------------------------------------------------------------
# Helpers (shared with deploy.py, duplicated for standalone use)
# ---------------------------------------------------------------------------

def load_rollout_log() -> list[dict]:
    if not ROLLOUT_LOG_PATH.exists():
        return []
    return json.loads(ROLLOUT_LOG_PATH.read_text())


def append_rollout_log(entry: dict) -> None:
    log = load_rollout_log()
    log.append(entry)
    ROLLOUT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    ROLLOUT_LOG_PATH.write_text(json.dumps(log, indent=2))


def find_previous_healthy(current_version: str | None = None) -> dict | None:
    """Return the most recent healthy deployment that is not *current_version*."""
    log = load_rollout_log()
    for entry in reversed(log):
        if entry.get("status") != "healthy":
            continue
        if current_version and entry.get("model_version") == current_version:
            continue
        return entry
    return None


def find_current_deployment() -> dict | None:
    """Return the most recent healthy deployment (i.e., what is running now)."""
    log = load_rollout_log()
    for entry in reversed(log):
        if entry.get("status") == "healthy":
            return entry
    return None


def start_serving_instance(model_path: str, port: int, tensor_parallel: int = 1) -> subprocess.Popen:
    serve_script = Path(__file__).resolve().parents[1] / "runtime" / "serve.py"
    cmd = [
        sys.executable,
        str(serve_script),
        "--model-path", model_path,
        "--port", str(port),
        "--tensor-parallel", str(tensor_parallel),
    ]
    logger.info("Starting serving instance: %s", " ".join(cmd))
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def wait_for_health(url: str, timeout: int = 300, interval: int = 5) -> bool:
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
    logger.error("Health check timed out: %s", url)
    return False


def stop_serving_instance(port: int) -> None:
    """Best-effort stop of the serving instance listening on *port*."""
    try:
        httpx.post(f"http://localhost:{port}/shutdown", timeout=5)
    except httpx.RequestError:
        pass


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
# CLI
# ---------------------------------------------------------------------------

@click.group()
def cli():
    """Model rollback toolkit."""
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )


@cli.command()
@click.option("--target-version", default=None, help="Specific version to roll back to (default: previous healthy)")
@click.option("--port", type=int, default=8000, help="Port for the restored instance")
@click.option("--tensor-parallel", type=int, default=1)
@click.option("--health-timeout", type=int, default=300)
@click.option("--registry-path", type=click.Path(), default=str(DEFAULT_REGISTRY_PATH))
def rollback(
    target_version: str | None,
    port: int,
    tensor_parallel: int,
    health_timeout: int,
    registry_path: str,
):
    """Roll back to a previous model version."""
    current = find_current_deployment()
    current_version = current["model_version"] if current else None

    if target_version:
        # Look up the target in the registry
        reg = load_registry(Path(registry_path))
        entry = None
        for m in reg.get("models", []):
            if m.get("version") == target_version:
                entry = m
                break
        if entry is None:
            # Fall back to rollout log
            for log_entry in reversed(load_rollout_log()):
                if log_entry.get("model_version") == target_version and log_entry.get("status") == "healthy":
                    entry = log_entry
                    break
        if entry is None:
            raise click.ClickException(f"Version {target_version} not found in registry or rollout log")
        checkpoint_path = entry.get("checkpoint_path")
        model_name = entry.get("model_name", entry.get("name", "unknown"))
    else:
        prev = find_previous_healthy(current_version)
        if prev is None:
            raise click.ClickException("No previous healthy version found in rollout log")
        target_version = prev["model_version"]
        checkpoint_path = prev["checkpoint_path"]
        model_name = prev["model_name"]

    click.echo(f"Rolling back from {current_version or '(none)'} to {target_version}")
    click.echo(f"Checkpoint: {checkpoint_path}")

    # Stop current instance
    if current:
        current_port = current.get("green_port", port)
        click.echo(f"Stopping current instance on port {current_port} ...")
        stop_serving_instance(current_port)
        time.sleep(2)

    # Start restored version
    click.echo(f"Starting version {target_version} on port {port} ...")
    proc = start_serving_instance(checkpoint_path, port, tensor_parallel)

    if not wait_for_health(f"http://localhost:{port}/health", timeout=health_timeout):
        rollback_entry = {
            "model_name": model_name,
            "model_version": target_version,
            "checkpoint_path": checkpoint_path,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "finished_at": datetime.now(timezone.utc).isoformat(),
            "status": "failed",
            "errors": ["Restored instance failed health check"],
            "green_port": port,
            "green_pid": proc.pid,
        }
        append_rollout_log(rollback_entry)
        proc.terminate()
        raise click.ClickException("Restored instance failed health check")

    rollback_entry = {
        "model_name": model_name,
        "model_version": target_version,
        "checkpoint_path": checkpoint_path,
        "started_at": datetime.now(timezone.utc).isoformat(),
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "status": "healthy",
        "errors": [],
        "green_port": port,
        "green_pid": proc.pid,
        "rollback_from": current_version,
    }
    append_rollout_log(rollback_entry)
    click.echo(f"Rollback complete: {model_name}@{target_version} on port {port} (pid {proc.pid})")


@cli.command()
def history():
    """Print recent rollout / rollback history."""
    log = load_rollout_log()
    if not log:
        click.echo("No rollout history.")
        return
    for entry in log[-20:]:
        rb = f" (rollback from {entry['rollback_from']})" if entry.get("rollback_from") else ""
        click.echo(
            f"{entry.get('started_at', '?')} | "
            f"{entry.get('model_name', '?')}@{entry.get('model_version', '?')} | "
            f"{entry.get('status', '?')}{rb}"
        )


if __name__ == "__main__":
    cli()
