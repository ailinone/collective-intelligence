# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
PII detection and redaction pipeline.

Detects common PII patterns (email, phone, SSN, credit card, IP address, etc.)
using regex patterns, and optionally redacts, removes, or flags affected records.
"""

from __future__ import annotations

import json
import logging
import re
import time
from collections import Counter
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

import click
import jsonlines
from tqdm import tqdm

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# PII pattern definitions
# ---------------------------------------------------------------------------

class PIIType(str, Enum):
    EMAIL = "EMAIL"
    PHONE_US = "PHONE_US"
    PHONE_INTL = "PHONE_INTL"
    SSN = "SSN"
    CREDIT_CARD = "CREDIT_CARD"
    IP_ADDRESS = "IP_ADDRESS"
    DATE_OF_BIRTH = "DATE_OF_BIRTH"
    US_PASSPORT = "US_PASSPORT"
    DRIVERS_LICENSE = "DRIVERS_LICENSE"
    IBAN = "IBAN"
    URL_WITH_AUTH = "URL_WITH_AUTH"


@dataclass
class PIIMatch:
    pii_type: PIIType
    start: int
    end: int
    text: str


# Compiled regex patterns for each PII type
PII_PATTERNS: dict[PIIType, re.Pattern[str]] = {
    PIIType.EMAIL: re.compile(
        r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"
    ),
    PIIType.PHONE_US: re.compile(
        r"(?<!\d)"
        r"(?:\+?1[\s\-.]?)?"
        r"(?:\(?\d{3}\)?[\s\-.]?)"
        r"\d{3}[\s\-.]?\d{4}"
        r"(?!\d)"
    ),
    PIIType.PHONE_INTL: re.compile(
        r"\+\d{1,3}[\s\-.]?\(?\d{1,4}\)?[\s\-.]?\d{2,4}[\s\-.]?\d{2,4}(?:[\s\-.]?\d{2,4})?"
    ),
    PIIType.SSN: re.compile(
        r"\b\d{3}[\-\s]?\d{2}[\-\s]?\d{4}\b"
    ),
    PIIType.CREDIT_CARD: re.compile(
        r"\b(?:"
        r"4\d{3}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}"  # Visa
        r"|5[1-5]\d{2}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}"  # Mastercard
        r"|3[47]\d{1}[\s\-]?\d{6}[\s\-]?\d{5}"  # Amex
        r"|6(?:011|5\d{2})[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}"  # Discover
        r")\b"
    ),
    PIIType.IP_ADDRESS: re.compile(
        r"\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b"
    ),
    PIIType.DATE_OF_BIRTH: re.compile(
        r"\b(?:0[1-9]|1[0-2])[/\-](?:0[1-9]|[12]\d|3[01])[/\-](?:19|20)\d{2}\b"
    ),
    PIIType.US_PASSPORT: re.compile(
        r"\b[A-Z]\d{8}\b"
    ),
    PIIType.IBAN: re.compile(
        r"\b[A-Z]{2}\d{2}[\s]?[\dA-Z]{4}[\s]?(?:[\dA-Z]{4}[\s]?){1,7}[\dA-Z]{1,4}\b"
    ),
    PIIType.URL_WITH_AUTH: re.compile(
        r"https?://[^\s:]+:[^\s@]+@[^\s]+"
    ),
}

# Replacement tokens per PII type
REDACTION_TOKENS: dict[PIIType, str] = {
    PIIType.EMAIL: "[EMAIL_REDACTED]",
    PIIType.PHONE_US: "[PHONE_REDACTED]",
    PIIType.PHONE_INTL: "[PHONE_REDACTED]",
    PIIType.SSN: "[SSN_REDACTED]",
    PIIType.CREDIT_CARD: "[CC_REDACTED]",
    PIIType.IP_ADDRESS: "[IP_REDACTED]",
    PIIType.DATE_OF_BIRTH: "[DOB_REDACTED]",
    PIIType.US_PASSPORT: "[PASSPORT_REDACTED]",
    PIIType.DRIVERS_LICENSE: "[DL_REDACTED]",
    PIIType.IBAN: "[IBAN_REDACTED]",
    PIIType.URL_WITH_AUTH: "[URL_AUTH_REDACTED]",
}


# ---------------------------------------------------------------------------
# PII detection
# ---------------------------------------------------------------------------

def _luhn_check(number: str) -> bool:
    """Validate a credit card number with the Luhn algorithm."""
    digits = [int(d) for d in number if d.isdigit()]
    if len(digits) < 13 or len(digits) > 19:
        return False
    checksum = 0
    reverse = digits[::-1]
    for i, d in enumerate(reverse):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


def detect_pii(text: str, enabled_types: set[PIIType] | None = None) -> list[PIIMatch]:
    """Detect all PII matches in text."""
    matches: list[PIIMatch] = []

    for pii_type, pattern in PII_PATTERNS.items():
        if enabled_types is not None and pii_type not in enabled_types:
            continue

        for m in pattern.finditer(text):
            matched_text = m.group()

            # Additional validation for credit cards (Luhn check)
            if pii_type == PIIType.CREDIT_CARD:
                clean_num = re.sub(r"[\s\-]", "", matched_text)
                if not _luhn_check(clean_num):
                    continue

            # Additional validation for SSN: reject obvious non-SSN patterns
            if pii_type == PIIType.SSN:
                clean_ssn = re.sub(r"[\s\-]", "", matched_text)
                # SSN cannot start with 000, 666, or 9xx; middle cannot be 00; last cannot be 0000
                if (clean_ssn[:3] in ("000", "666") or clean_ssn[0] == "9"
                        or clean_ssn[3:5] == "00" or clean_ssn[5:] == "0000"):
                    continue

            matches.append(PIIMatch(
                pii_type=pii_type,
                start=m.start(),
                end=m.end(),
                text=matched_text,
            ))

    # Sort by position and remove overlaps (keep longer match)
    matches.sort(key=lambda m: (m.start, -(m.end - m.start)))
    deduped: list[PIIMatch] = []
    last_end = -1
    for m in matches:
        if m.start >= last_end:
            deduped.append(m)
            last_end = m.end

    return deduped


def redact_text(text: str, matches: list[PIIMatch]) -> str:
    """Replace PII matches in text with redaction tokens."""
    if not matches:
        return text

    # Process from end to start to preserve offsets
    result = text
    for m in sorted(matches, key=lambda x: x.start, reverse=True):
        token = REDACTION_TOKENS.get(m.pii_type, "[PII_REDACTED]")
        result = result[: m.start] + token + result[m.end :]

    return result


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

class PIIAction(str, Enum):
    REDACT = "redact"
    REMOVE = "remove"
    FLAG = "flag"


@dataclass
class PIIStats:
    total_records: int = 0
    records_with_pii: int = 0
    records_clean: int = 0
    records_removed: int = 0
    records_redacted: int = 0
    records_flagged: int = 0
    pii_type_counts: dict[str, int] = field(default_factory=lambda: Counter())
    total_pii_matches: int = 0


def run_pii_filter(
    input_path: Path,
    output_path: Path,
    report_path: Path,
    action: PIIAction = PIIAction.REDACT,
    text_field: str = "text",
    enabled_types: set[PIIType] | None = None,
) -> dict[str, Any]:
    """Run PII detection and filtering pipeline."""
    start_time = time.time()
    stats = PIIStats()

    with jsonlines.open(input_path, mode="r") as reader, \
         jsonlines.open(output_path, mode="w") as writer:

        for record in tqdm(reader, desc="PII filtering", unit=" docs"):
            stats.total_records += 1
            text = record.get(text_field, "")

            matches = detect_pii(text, enabled_types=enabled_types)

            if not matches:
                stats.records_clean += 1
                writer.write(record)
                continue

            stats.records_with_pii += 1
            stats.total_pii_matches += len(matches)

            for m in matches:
                stats.pii_type_counts[m.pii_type.value] += 1

            if action == PIIAction.REMOVE:
                stats.records_removed += 1
                # Skip writing this record
                continue

            elif action == PIIAction.REDACT:
                record[text_field] = redact_text(text, matches)
                record.setdefault("metadata", {})["pii_redacted"] = True
                record["metadata"]["pii_types_found"] = list({m.pii_type.value for m in matches})
                stats.records_redacted += 1
                writer.write(record)

            elif action == PIIAction.FLAG:
                record.setdefault("metadata", {})["has_pii"] = True
                record["metadata"]["pii_types_found"] = list({m.pii_type.value for m in matches})
                record["metadata"]["pii_match_count"] = len(matches)
                stats.records_flagged += 1
                writer.write(record)

    elapsed = time.time() - start_time

    report = {
        "input_file": str(input_path),
        "output_file": str(output_path),
        "action": action.value,
        "total_records": stats.total_records,
        "records_clean": stats.records_clean,
        "records_with_pii": stats.records_with_pii,
        "records_removed": stats.records_removed,
        "records_redacted": stats.records_redacted,
        "records_flagged": stats.records_flagged,
        "total_pii_matches": stats.total_pii_matches,
        "pii_type_counts": dict(stats.pii_type_counts),
        "pii_rate_percent": round(
            100.0 * stats.records_with_pii / max(stats.total_records, 1), 2
        ),
        "elapsed_seconds": round(elapsed, 2),
    }

    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)

    logger.info(
        "PII filter complete: total=%d with_pii=%d (%.1f%%) action=%s",
        stats.total_records,
        stats.records_with_pii,
        report["pii_rate_percent"],
        action.value,
    )
    return report


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

@click.command("pii-filter")
@click.option("--input", "input_path", required=True, type=click.Path(exists=True), help="Input JSONL file")
@click.option("--output", "output_path", required=True, type=click.Path(), help="Output JSONL file")
@click.option("--report", "report_path", default=None, type=click.Path(), help="Output report JSON path")
@click.option(
    "--action",
    type=click.Choice(["redact", "remove", "flag"]),
    default="redact",
    help="Action for records with PII",
)
@click.option("--text-field", default="text", help="Field name containing document text")
@click.option(
    "--pii-types",
    default=None,
    help="Comma-separated PII types to detect (default: all). "
         "Options: EMAIL, PHONE_US, PHONE_INTL, SSN, CREDIT_CARD, IP_ADDRESS, "
         "DATE_OF_BIRTH, US_PASSPORT, IBAN, URL_WITH_AUTH",
)
@click.option("--log-level", default="INFO", type=click.Choice(["DEBUG", "INFO", "WARNING", "ERROR"]))
def cli(
    input_path: str,
    output_path: str,
    report_path: str | None,
    action: str,
    text_field: str,
    pii_types: str | None,
    log_level: str,
) -> None:
    """Detect and handle PII in a JSONL dataset."""
    logging.basicConfig(
        level=getattr(logging, log_level),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    output_p = Path(output_path)
    output_p.parent.mkdir(parents=True, exist_ok=True)

    if report_path is None:
        report_p = output_p.with_suffix(".pii_report.json")
    else:
        report_p = Path(report_path)

    enabled_types: set[PIIType] | None = None
    if pii_types is not None:
        enabled_types = set()
        for t in pii_types.split(","):
            t = t.strip().upper()
            try:
                enabled_types.add(PIIType(t))
            except ValueError:
                logger.warning("Unknown PII type: %s (skipping)", t)

    pii_action = PIIAction(action)

    report = run_pii_filter(
        input_path=Path(input_path),
        output_path=output_p,
        report_path=report_p,
        action=pii_action,
        text_field=text_field,
        enabled_types=enabled_types,
    )

    click.echo(f"\n--- PII Filter Report ---")
    click.echo(f"Total records:      {report['total_records']:>10,}")
    click.echo(f"Records clean:      {report['records_clean']:>10,}")
    click.echo(f"Records with PII:   {report['records_with_pii']:>10,}")
    click.echo(f"PII rate:           {report['pii_rate_percent']:>9.1f}%")
    click.echo(f"Action taken:       {report['action']}")
    if report["pii_type_counts"]:
        click.echo(f"\nPII types found:")
        for pii_type, count in sorted(report["pii_type_counts"].items(), key=lambda x: -x[1]):
            click.echo(f"  {pii_type:25s} {count:>8,}")
    click.echo(f"\nElapsed time: {report['elapsed_seconds']:.1f}s")
    click.echo(f"Report: {report_p}")


if __name__ == "__main__":
    cli()
