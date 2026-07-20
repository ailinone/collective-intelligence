#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Tool-calling evaluation.

Tests a model's ability to:
1. Generate syntactically correct function calls (JSON schema conformance).
2. Choose the correct tool for a given query.
3. Provide accurate arguments.
4. Handle multi-tool scenarios (sequential / parallel calls).

Reports precision, recall, and schema conformance rate.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from typing import Any

import jsonschema

logger = logging.getLogger("tool_calling_eval")


# ---------------------------------------------------------------------------
# Built-in test suite
# ---------------------------------------------------------------------------

TOOL_DEFINITIONS: list[dict] = [
    {
        "name": "get_weather",
        "description": "Get the current weather for a location.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City and state"},
                "unit": {"type": "string", "enum": ["celsius", "fahrenheit"]},
            },
            "required": ["location"],
        },
    },
    {
        "name": "search_web",
        "description": "Search the web for information.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "num_results": {"type": "integer", "minimum": 1, "maximum": 20},
            },
            "required": ["query"],
        },
    },
    {
        "name": "send_email",
        "description": "Send an email message.",
        "parameters": {
            "type": "object",
            "properties": {
                "to": {"type": "string", "format": "email"},
                "subject": {"type": "string"},
                "body": {"type": "string"},
            },
            "required": ["to", "subject", "body"],
        },
    },
    {
        "name": "create_calendar_event",
        "description": "Create a new calendar event.",
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "date": {"type": "string", "description": "ISO 8601 date"},
                "time": {"type": "string", "description": "HH:MM in 24h format"},
                "duration_minutes": {"type": "integer"},
            },
            "required": ["title", "date"],
        },
    },
    {
        "name": "calculate",
        "description": "Evaluate a mathematical expression.",
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {"type": "string"},
            },
            "required": ["expression"],
        },
    },
]

# Each test case has: user_query, expected_tools (list of tool names), expected_args (partial match)
TEST_CASES: list[dict[str, Any]] = [
    {
        "query": "What's the weather in San Francisco?",
        "expected_tools": ["get_weather"],
        "expected_args": [{"location": "San Francisco"}],
    },
    {
        "query": "Search for the latest news about AI regulation",
        "expected_tools": ["search_web"],
        "expected_args": [{"query": "AI regulation"}],
    },
    {
        "query": "Send an email to alice@example.com with subject 'Meeting' and body 'See you at 3pm'",
        "expected_tools": ["send_email"],
        "expected_args": [{"to": "alice@example.com", "subject": "Meeting"}],
    },
    {
        "query": "What is 1523 * 47?",
        "expected_tools": ["calculate"],
        "expected_args": [{}],
    },
    {
        "query": "Create a calendar event titled 'Team Standup' on 2026-04-01 at 09:00 for 30 minutes",
        "expected_tools": ["create_calendar_event"],
        "expected_args": [{"title": "Team Standup", "date": "2026-04-01"}],
    },
    # Multi-tool scenario
    {
        "query": "Check the weather in Tokyo and then search for flights from NYC to Tokyo",
        "expected_tools": ["get_weather", "search_web"],
        "expected_args": [{"location": "Tokyo"}, {}],
    },
    {
        "query": "What's 25% of 840, and also what's the weather in London in celsius?",
        "expected_tools": ["calculate", "get_weather"],
        "expected_args": [{}, {"location": "London", "unit": "celsius"}],
    },
]


# ---------------------------------------------------------------------------
# Parsing & validation
# ---------------------------------------------------------------------------

def build_tool_prompt(query: str, tools: list[dict]) -> str:
    tools_json = json.dumps(tools, indent=2)
    return (
        "You are a helpful assistant with access to the following tools:\n\n"
        f"{tools_json}\n\n"
        "When you need to use a tool, respond with a JSON array of tool calls. "
        "Each tool call should be an object with 'name' and 'arguments' keys. "
        "Example: [{\"name\": \"tool_name\", \"arguments\": {\"arg1\": \"value1\"}}]\n\n"
        "If multiple tools are needed, include them all in the array.\n\n"
        f"User: {query}\n\n"
        "Tool calls:"
    )


def parse_tool_calls(text: str) -> list[dict]:
    """Try to extract a JSON array of tool calls from model output."""
    text = text.strip()
    # Find JSON array
    start = text.find("[")
    if start < 0:
        # Try single object
        start = text.find("{")
        if start < 0:
            return []
        end = text.rfind("}") + 1
        try:
            obj = json.loads(text[start:end])
            return [obj] if isinstance(obj, dict) else []
        except json.JSONDecodeError:
            return []

    end = text.rfind("]") + 1
    try:
        calls = json.loads(text[start:end])
        if isinstance(calls, list):
            return calls
        return []
    except json.JSONDecodeError:
        return []


def validate_schema(call: dict, tool_defs: list[dict]) -> tuple[bool, str]:
    """Check that a tool call conforms to its declared JSON schema."""
    name = call.get("name", "")
    args = call.get("arguments", {})

    tool_def = next((t for t in tool_defs if t["name"] == name), None)
    if tool_def is None:
        return False, f"Unknown tool: {name}"

    schema = tool_def.get("parameters", {})
    try:
        jsonschema.validate(args, schema)
        return True, ""
    except jsonschema.ValidationError as exc:
        return False, str(exc.message)[:200]


def check_args_match(actual: dict, expected: dict) -> bool:
    """Check that all expected key-value pairs appear in the actual args.

    Uses case-insensitive substring matching for string values.
    """
    for key, expected_val in expected.items():
        actual_val = actual.get(key)
        if actual_val is None:
            return False
        if isinstance(expected_val, str):
            if expected_val.lower() not in str(actual_val).lower():
                return False
        elif actual_val != expected_val:
            return False
    return True


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

@dataclass
class ToolCallResult:
    query: str
    expected_tools: list[str]
    predicted_tools: list[str]
    schema_valid: list[bool]
    args_correct: list[bool]
    tool_selection_correct: bool
    raw_output: str


def run(client, num_samples: int | None = None, **_kwargs) -> tuple[dict[str, float], list[dict]]:
    """Entry point for the eval runner."""
    cases = TEST_CASES
    if num_samples:
        cases = cases[:num_samples]

    results: list[ToolCallResult] = []

    for case in cases:
        query = case["query"]
        expected_tools = case["expected_tools"]
        expected_args = case["expected_args"]

        prompt = build_tool_prompt(query, TOOL_DEFINITIONS)
        try:
            output = client.generate(prompt, max_tokens=512, temperature=0.0)
        except Exception as exc:
            logger.warning("Generation failed: %s", exc)
            output = ""

        calls = parse_tool_calls(output)
        predicted_tools = [c.get("name", "") for c in calls]

        # Schema validation
        schema_valid = []
        for c in calls:
            ok, _ = validate_schema(c, TOOL_DEFINITIONS)
            schema_valid.append(ok)

        # Argument accuracy
        args_correct = []
        for i, expected_tool in enumerate(expected_tools):
            matching_call = next((c for c in calls if c.get("name") == expected_tool), None)
            if matching_call is None:
                args_correct.append(False)
                continue
            exp_args = expected_args[i] if i < len(expected_args) else {}
            args_correct.append(check_args_match(matching_call.get("arguments", {}), exp_args))

        # Tool selection: did we get the right set of tools?
        tool_selection_correct = set(predicted_tools) == set(expected_tools)

        results.append(
            ToolCallResult(
                query=query,
                expected_tools=expected_tools,
                predicted_tools=predicted_tools,
                schema_valid=schema_valid,
                args_correct=args_correct,
                tool_selection_correct=tool_selection_correct,
                raw_output=output[:500],
            )
        )

    # Metrics
    total = len(results)
    tool_select_acc = sum(1 for r in results if r.tool_selection_correct) / max(total, 1)

    all_schema = [v for r in results for v in r.schema_valid]
    schema_rate = sum(all_schema) / max(len(all_schema), 1)

    all_args = [v for r in results for v in r.args_correct]
    arg_accuracy = sum(all_args) / max(len(all_args), 1)

    # Precision/recall on tool names
    all_expected = [t for r in results for t in r.expected_tools]
    all_predicted = [t for r in results for t in r.predicted_tools]
    tp = sum(1 for r in results for t in r.expected_tools if t in r.predicted_tools)
    precision = tp / max(len(all_predicted), 1)
    recall = tp / max(len(all_expected), 1)
    f1 = 2 * precision * recall / max(precision + recall, 1e-9)

    # Multi-tool accuracy (only on cases with >1 expected tool)
    multi_cases = [r for r in results if len(r.expected_tools) > 1]
    multi_acc = sum(1 for r in multi_cases if r.tool_selection_correct) / max(len(multi_cases), 1)

    metrics = {
        "tool_selection_accuracy": round(tool_select_acc, 4),
        "schema_conformance": round(schema_rate, 4),
        "argument_accuracy": round(arg_accuracy, 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "multi_tool_accuracy": round(multi_acc, 4),
        "total_cases": total,
    }

    details = [
        {
            "query": r.query,
            "expected": r.expected_tools,
            "predicted": r.predicted_tools,
            "tool_correct": r.tool_selection_correct,
            "schema_valid": r.schema_valid,
            "args_correct": r.args_correct,
        }
        for r in results
    ]

    logger.info(
        "Tool calling: selection=%.4f  schema=%.4f  args=%.4f  F1=%.4f",
        tool_select_acc, schema_rate, arg_accuracy, f1,
    )
    return metrics, details
