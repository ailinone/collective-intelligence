# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Pydantic models for dataset manifests and a registry for loading/saving YAML manifests.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator, model_validator

logger = logging.getLogger(__name__)


class DatasetFormat(str, Enum):
    JSONL = "jsonl"
    PARQUET = "parquet"
    CSV = "csv"
    HUGGINGFACE = "huggingface"
    ARROW = "arrow"


class PIIStatus(str, Enum):
    NOT_SCANNED = "not_scanned"
    CLEAN = "clean"
    REDACTED = "redacted"
    CONTAINS_PII = "contains_pii"


class ContaminationStatus(str, Enum):
    NOT_CHECKED = "not_checked"
    CLEAN = "clean"
    PARTIAL = "partial"
    CONTAMINATED = "contaminated"


class ExclusionPolicy(str, Enum):
    NONE = "none"
    OPT_OUT = "opt_out"
    ROBOTS_TXT = "robots_txt"
    DMCA = "dmca"
    LICENSE_RESTRICTED = "license_restricted"


class SplitInfo(BaseModel):
    """Metadata about a single dataset split."""

    name: str
    num_rows: int = Field(ge=0)
    num_bytes: int | None = Field(default=None, ge=0)
    path: str | None = None
    sha256: str | None = None


class EligibilityRule(BaseModel):
    """Rules governing dataset eligibility for training."""

    field: str
    operator: str = Field(pattern=r"^(eq|ne|gt|lt|gte|lte|in|not_in|contains|regex)$")
    value: Any


class DatasetManifest(BaseModel):
    """Complete manifest describing a dataset for the training pipeline."""

    name: str = Field(min_length=1, max_length=256)
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    source_url: str
    license: str
    format: DatasetFormat
    splits: list[SplitInfo] = Field(default_factory=list)
    sha256: str | None = None
    row_count: int = Field(ge=0)
    created_at: datetime = Field(default_factory=datetime.utcnow)
    tags: list[str] = Field(default_factory=list)
    eligibility_rules: list[EligibilityRule] = Field(default_factory=list)
    exclusion_policy: ExclusionPolicy = ExclusionPolicy.NONE
    pii_status: PIIStatus = PIIStatus.NOT_SCANNED
    contamination_status: ContaminationStatus = ContaminationStatus.NOT_CHECKED

    # Optional extended metadata
    description: str | None = None
    language: list[str] = Field(default_factory=lambda: ["en"])
    domain: str | None = None
    collection_date: datetime | None = None
    processing_steps: list[str] = Field(default_factory=list)
    sampling_weight: float = Field(default=1.0, ge=0.0, le=100.0)

    @field_validator("sha256")
    @classmethod
    def validate_sha256(cls, v: str | None) -> str | None:
        if v is not None and len(v) != 64:
            raise ValueError("sha256 must be a 64-character hex string")
        return v

    @model_validator(mode="after")
    def validate_splits_row_count(self) -> "DatasetManifest":
        if self.splits:
            split_total = sum(s.num_rows for s in self.splits)
            if split_total != self.row_count:
                logger.warning(
                    "Split row counts (%d) do not sum to total row_count (%d) for %s",
                    split_total,
                    self.row_count,
                    self.name,
                )
        return self

    def compute_file_sha256(self, file_path: Path) -> str:
        """Compute SHA-256 of a file for integrity verification."""
        h = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return h.hexdigest()

    def to_dict(self) -> dict[str, Any]:
        data = self.model_dump(mode="json")
        data["format"] = self.format.value
        data["exclusion_policy"] = self.exclusion_policy.value
        data["pii_status"] = self.pii_status.value
        data["contamination_status"] = self.contamination_status.value
        return data


class DatasetRegistry:
    """Registry that loads and saves dataset manifests from/to YAML files."""

    def __init__(self, registry_dir: Path) -> None:
        self.registry_dir = Path(registry_dir)
        self.registry_dir.mkdir(parents=True, exist_ok=True)
        self._manifests: dict[str, DatasetManifest] = {}
        self._load_all()

    def _load_all(self) -> None:
        """Load all YAML manifests from the registry directory."""
        for yaml_file in self.registry_dir.glob("*.yaml"):
            try:
                manifest = self.load(yaml_file)
                key = f"{manifest.name}@{manifest.version}"
                self._manifests[key] = manifest
                logger.info("Loaded manifest: %s", key)
            except Exception:
                logger.exception("Failed to load manifest from %s", yaml_file)

        for yaml_file in self.registry_dir.glob("*.yml"):
            try:
                manifest = self.load(yaml_file)
                key = f"{manifest.name}@{manifest.version}"
                self._manifests[key] = manifest
                logger.info("Loaded manifest: %s", key)
            except Exception:
                logger.exception("Failed to load manifest from %s", yaml_file)

        logger.info("Registry loaded %d manifests from %s", len(self._manifests), self.registry_dir)

    def load(self, path: Path) -> DatasetManifest:
        """Load a single manifest from a YAML file."""
        path = Path(path)
        if not path.exists():
            raise FileNotFoundError(f"Manifest file not found: {path}")

        with open(path, "r", encoding="utf-8") as f:
            raw = yaml.safe_load(f)

        if raw is None:
            raise ValueError(f"Empty manifest file: {path}")

        manifest = DatasetManifest(**raw)
        logger.debug("Parsed manifest: %s v%s", manifest.name, manifest.version)
        return manifest

    def save(self, manifest: DatasetManifest, filename: str | None = None) -> Path:
        """Save a manifest to a YAML file in the registry directory."""
        if filename is None:
            safe_name = manifest.name.replace("/", "_").replace(" ", "_")
            filename = f"{safe_name}_{manifest.version}.yaml"

        path = self.registry_dir / filename
        data = manifest.to_dict()

        with open(path, "w", encoding="utf-8") as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False, allow_unicode=True)

        key = f"{manifest.name}@{manifest.version}"
        self._manifests[key] = manifest
        logger.info("Saved manifest to %s", path)
        return path

    def get(self, name: str, version: str | None = None) -> DatasetManifest | None:
        """Look up a manifest by name and optional version."""
        if version:
            return self._manifests.get(f"{name}@{version}")

        # Return latest version if no version specified
        candidates = [
            (k, v) for k, v in self._manifests.items() if k.startswith(f"{name}@")
        ]
        if not candidates:
            return None

        candidates.sort(key=lambda x: x[0])
        return candidates[-1][1]

    def list_all(self) -> list[DatasetManifest]:
        """Return all registered manifests."""
        return list(self._manifests.values())

    def remove(self, name: str, version: str) -> bool:
        """Remove a manifest from the registry (deletes the YAML file)."""
        key = f"{name}@{version}"
        if key not in self._manifests:
            return False

        safe_name = name.replace("/", "_").replace(" ", "_")
        filename = f"{safe_name}_{version}.yaml"
        path = self.registry_dir / filename
        if path.exists():
            path.unlink()

        del self._manifests[key]
        logger.info("Removed manifest: %s", key)
        return True

    def validate_integrity(self, manifest: DatasetManifest, data_dir: Path) -> list[str]:
        """Validate file integrity for a manifest against actual data files."""
        errors: list[str] = []
        for split in manifest.splits:
            if split.path is None:
                continue
            split_path = data_dir / split.path
            if not split_path.exists():
                errors.append(f"Missing file for split '{split.name}': {split_path}")
                continue
            if split.sha256:
                actual = manifest.compute_file_sha256(split_path)
                if actual != split.sha256:
                    errors.append(
                        f"SHA-256 mismatch for split '{split.name}': "
                        f"expected {split.sha256}, got {actual}"
                    )
        return errors


if __name__ == "__main__":
    import json
    import sys

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    # Demo: create and serialize a manifest
    manifest = DatasetManifest(
        name="demo-dataset",
        version="1.0.0",
        source_url="https://example.com/data.jsonl",
        license="Apache-2.0",
        format=DatasetFormat.JSONL,
        splits=[
            SplitInfo(name="train", num_rows=900000, path="train.jsonl"),
            SplitInfo(name="validation", num_rows=100000, path="val.jsonl"),
        ],
        row_count=1000000,
        tags=["english", "web", "pretrain"],
        pii_status=PIIStatus.REDACTED,
    )
    print(json.dumps(manifest.to_dict(), indent=2, default=str))

    # Demo: registry round-trip
    if len(sys.argv) > 1:
        registry = DatasetRegistry(Path(sys.argv[1]))
        saved_path = registry.save(manifest)
        loaded = registry.load(saved_path)
        assert loaded.name == manifest.name
        print(f"\nRound-trip OK: saved and loaded from {saved_path}")
