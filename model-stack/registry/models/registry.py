#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""YAML-backed model registry.

Stores model entries with full metadata (name, version, architecture,
param_count, checkpoint_path, metrics, status, tags, lineage).
Supports register, promote, deprecate, list, and version comparison.
"""

from __future__ import annotations

import logging
import re
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import Any, Optional

import click
import yaml
from pydantic import BaseModel, Field, field_validator

logger = logging.getLogger("registry")

DEFAULT_REGISTRY_FILE = Path(__file__).resolve().parent / "registry.yaml"


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

class ModelStatus(str, Enum):
    REGISTERED = "registered"
    STAGING = "staging"
    CHAMPION = "champion"
    DEPRECATED = "deprecated"
    ARCHIVED = "archived"


class ModelEntry(BaseModel):
    """A single model version in the registry."""

    name: str = Field(..., min_length=1)
    version: str = Field(..., pattern=r"^\d+\.\d+\.\d+$")
    architecture: str = ""
    param_count: int = 0
    checkpoint_path: str = ""
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    metrics: dict[str, float] = Field(default_factory=dict)
    status: ModelStatus = ModelStatus.REGISTERED
    promoted_from: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    training_run_id: Optional[str] = None
    description: str = ""

    @field_validator("version")
    @classmethod
    def validate_semver(cls, v: str) -> str:
        if not re.match(r"^\d+\.\d+\.\d+$", v):
            raise ValueError(f"Version must be semver (x.y.z), got '{v}'")
        return v


# ---------------------------------------------------------------------------
# Version comparison
# ---------------------------------------------------------------------------

def _parse_version(v: str) -> tuple[int, ...]:
    return tuple(int(x) for x in v.split("."))


def compare_versions(a: str, b: str) -> int:
    """Return -1 if a < b, 0 if a == b, 1 if a > b (semver comparison)."""
    va, vb = _parse_version(a), _parse_version(b)
    if va < vb:
        return -1
    if va > vb:
        return 1
    return 0


# ---------------------------------------------------------------------------
# Registry I/O
# ---------------------------------------------------------------------------

class ModelRegistry:
    """YAML-backed model registry."""

    def __init__(self, path: Path | str = DEFAULT_REGISTRY_FILE) -> None:
        self.path = Path(path)
        self._entries: list[ModelEntry] = []
        self._load()

    # --- persistence ---

    def _load(self) -> None:
        if not self.path.exists():
            self._entries = []
            return
        raw = yaml.safe_load(self.path.read_text()) or {}
        self._entries = [ModelEntry(**e) for e in raw.get("models", [])]

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"models": [e.model_dump(mode="json") for e in self._entries]}
        self.path.write_text(yaml.dump(payload, default_flow_style=False, sort_keys=False))

    # --- core operations ---

    def register(self, entry: ModelEntry) -> ModelEntry:
        """Add a new model version.  Raises if (name, version) already exists."""
        existing = self._find(entry.name, entry.version)
        if existing is not None:
            raise ValueError(f"{entry.name}@{entry.version} already registered")
        self._entries.append(entry)
        self._save()
        logger.info("Registered %s@%s", entry.name, entry.version)
        return entry

    def promote(self, name: str, version: str, to_status: ModelStatus = ModelStatus.CHAMPION) -> ModelEntry:
        """Promote a model version to a higher status.

        If promoting to CHAMPION, the current champion (if any) is
        automatically moved to DEPRECATED.
        """
        entry = self._find(name, version)
        if entry is None:
            raise KeyError(f"{name}@{version} not found")

        if to_status == ModelStatus.CHAMPION:
            # Demote current champion(s)
            for e in self._entries:
                if e.name == name and e.status == ModelStatus.CHAMPION and e.version != version:
                    e.status = ModelStatus.DEPRECATED
                    logger.info("Demoted previous champion %s@%s", e.name, e.version)

        old_status = entry.status
        entry.status = to_status
        entry.promoted_from = old_status.value
        self._save()
        logger.info("Promoted %s@%s -> %s", name, version, to_status.value)
        return entry

    def deprecate(self, name: str, version: str) -> ModelEntry:
        entry = self._find(name, version)
        if entry is None:
            raise KeyError(f"{name}@{version} not found")
        entry.status = ModelStatus.DEPRECATED
        self._save()
        logger.info("Deprecated %s@%s", name, version)
        return entry

    def archive(self, name: str, version: str) -> ModelEntry:
        entry = self._find(name, version)
        if entry is None:
            raise KeyError(f"{name}@{version} not found")
        entry.status = ModelStatus.ARCHIVED
        self._save()
        logger.info("Archived %s@%s", name, version)
        return entry

    def list_models(
        self,
        name: str | None = None,
        status: ModelStatus | None = None,
        tag: str | None = None,
    ) -> list[ModelEntry]:
        results = self._entries
        if name:
            results = [e for e in results if e.name == name]
        if status:
            results = [e for e in results if e.status == status]
        if tag:
            results = [e for e in results if tag in e.tags]
        return sorted(results, key=lambda e: _parse_version(e.version), reverse=True)

    def get(self, name: str, version: str) -> ModelEntry | None:
        return self._find(name, version)

    def get_champion(self, name: str) -> ModelEntry | None:
        for e in self._entries:
            if e.name == name and e.status == ModelStatus.CHAMPION:
                return e
        return None

    def latest(self, name: str) -> ModelEntry | None:
        candidates = [e for e in self._entries if e.name == name]
        if not candidates:
            return None
        return max(candidates, key=lambda e: _parse_version(e.version))

    # --- internals ---

    def _find(self, name: str, version: str) -> ModelEntry | None:
        for e in self._entries:
            if e.name == name and e.version == version:
                return e
        return None


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.group()
@click.option("--registry", type=click.Path(), default=str(DEFAULT_REGISTRY_FILE), help="Registry YAML path")
@click.pass_context
def cli(ctx: click.Context, registry: str):
    """Model registry management."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    ctx.ensure_object(dict)
    ctx.obj["registry"] = ModelRegistry(registry)


@cli.command()
@click.option("--name", required=True)
@click.option("--version", required=True, help="Semver string (x.y.z)")
@click.option("--architecture", default="")
@click.option("--param-count", type=int, default=0)
@click.option("--checkpoint-path", required=True)
@click.option("--tag", multiple=True)
@click.option("--description", default="")
@click.pass_context
def register(ctx, name, version, architecture, param_count, checkpoint_path, tag, description):
    """Register a new model version."""
    reg: ModelRegistry = ctx.obj["registry"]
    entry = ModelEntry(
        name=name,
        version=version,
        architecture=architecture,
        param_count=param_count,
        checkpoint_path=checkpoint_path,
        tags=list(tag),
        description=description,
    )
    reg.register(entry)
    click.echo(f"Registered {name}@{version}")


@cli.command("list")
@click.option("--name", default=None)
@click.option("--status", type=click.Choice([s.value for s in ModelStatus]), default=None)
@click.option("--tag", default=None)
@click.pass_context
def list_cmd(ctx, name, status, tag):
    """List registered models."""
    reg: ModelRegistry = ctx.obj["registry"]
    status_enum = ModelStatus(status) if status else None
    entries = reg.list_models(name=name, status=status_enum, tag=tag)
    if not entries:
        click.echo("No models found.")
        return
    for e in entries:
        tags_str = f" [{', '.join(e.tags)}]" if e.tags else ""
        click.echo(f"  {e.name}@{e.version}  {e.status.value:12s}  params={e.param_count}{tags_str}")


@cli.command()
@click.option("--name", required=True)
@click.option("--version", required=True)
@click.option("--to-status", type=click.Choice(["staging", "champion"]), default="champion")
@click.pass_context
def promote(ctx, name, version, to_status):
    """Promote a model to staging or champion."""
    reg: ModelRegistry = ctx.obj["registry"]
    reg.promote(name, version, ModelStatus(to_status))
    click.echo(f"Promoted {name}@{version} -> {to_status}")


@cli.command()
@click.option("--name", required=True)
@click.option("--version", required=True)
@click.pass_context
def deprecate(ctx, name, version):
    """Deprecate a model version."""
    reg: ModelRegistry = ctx.obj["registry"]
    reg.deprecate(name, version)
    click.echo(f"Deprecated {name}@{version}")


@cli.command()
@click.argument("ver_a")
@click.argument("ver_b")
def compare(ver_a, ver_b):
    """Compare two semver strings."""
    result = compare_versions(ver_a, ver_b)
    labels = {-1: "older", 0: "equal", 1: "newer"}
    click.echo(f"{ver_a} is {labels[result]} than {ver_b}")


if __name__ == "__main__":
    cli()
