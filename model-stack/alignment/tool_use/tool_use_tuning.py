#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
Tool-Use / Function-Calling Fine-Tuning
=========================================
Fine-tunes an aligned model to produce structured tool/function calls
in JSON format, conforming to provided JSON schemas.

Usage
-----
    python tool_use_tuning.py \
        --base-model ./models/ailin-1b-safety \
        --dataset ./data/tool-use/tool_calls.jsonl \
        --output-dir ./models/ailin-1b-tool-use

    accelerate launch tool_use_tuning.py \
        --base-model ./models/ailin-1b-safety \
        --dataset ./data/tool-use/tool_calls.jsonl
"""
from __future__ import annotations

import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

import click
import jsonschema
import torch
from datasets import Dataset, load_dataset, load_from_disk
from peft import LoraConfig, PeftModel, TaskType, get_peft_model
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    GenerationConfig,
)
from trl import SFTConfig, SFTTrainer

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")


# ── Tool call format ─────────────────────────────────────────
TOOL_CALL_START = "<tool_call>"
TOOL_CALL_END = "</tool_call>"
TOOL_RESULT_START = "<tool_result>"
TOOL_RESULT_END = "</tool_result>"


def format_tool_schemas(tools: List[Dict]) -> str:
    """Format a list of tool schemas into a system prompt section."""
    lines = ["You have access to the following tools:\n"]
    for tool in tools:
        name = tool.get("name", tool.get("function", {}).get("name", "unknown"))
        desc = tool.get("description", tool.get("function", {}).get("description", ""))
        params = tool.get("parameters", tool.get("function", {}).get("parameters", {}))
        lines.append(f"### {name}")
        lines.append(f"Description: {desc}")
        lines.append(f"Parameters: {json.dumps(params, indent=2)}")
        lines.append("")
    lines.append(
        "To use a tool, respond with a JSON object wrapped in "
        f"{TOOL_CALL_START} and {TOOL_CALL_END} tags. "
        'The JSON must have "name" and "arguments" keys.'
    )
    return "\n".join(lines)


def format_tool_use_example(example: Dict) -> str:
    """
    Format a tool-use training example.

    Expected input format:
    {
        "tools": [...],             # list of tool schemas
        "messages": [
            {"role": "user", "content": "..."},
            {"role": "assistant", "tool_calls": [{"name": "...", "arguments": {...}}]},
            {"role": "tool", "name": "...", "content": "..."},
            {"role": "assistant", "content": "..."}
        ]
    }
    """
    tools = example.get("tools", [])
    messages = example.get("messages", [])

    parts = []

    # System prompt with tool definitions
    if tools:
        tool_section = format_tool_schemas(tools)
        parts.append(f"<|system|>\n{tool_section}\n")

    for msg in messages:
        role = msg.get("role", "")

        if role == "user":
            parts.append(f"<|user|>\n{msg['content']}\n")

        elif role == "assistant":
            if "tool_calls" in msg and msg["tool_calls"]:
                # Format tool calls
                tc_parts = []
                for tc in msg["tool_calls"]:
                    call_json = json.dumps({
                        "name": tc.get("name", ""),
                        "arguments": tc.get("arguments", {}),
                    }, indent=2)
                    tc_parts.append(f"{TOOL_CALL_START}\n{call_json}\n{TOOL_CALL_END}")
                parts.append(f"<|assistant|>\n{''.join(tc_parts)}\n")
            elif msg.get("content"):
                parts.append(f"<|assistant|>\n{msg['content']}\n")

        elif role == "tool":
            tool_name = msg.get("name", "")
            content = msg.get("content", "")
            parts.append(f"{TOOL_RESULT_START}\n{json.dumps({'name': tool_name, 'result': content})}\n{TOOL_RESULT_END}\n")

    return "".join(parts)


# ── Dataset loading ──────────────────────────────────────────
def load_tool_use_dataset(
    dataset_path: str,
    eval_split: float = 0.05,
    seed: int = 42,
) -> dict:
    """Load and format tool-use dataset."""
    path = Path(dataset_path)

    if path.exists():
        if path.suffix in (".json", ".jsonl"):
            dataset = load_dataset("json", data_files=str(path), split="train")
        elif path.is_dir():
            try:
                dataset = load_from_disk(str(path))
                if hasattr(dataset, "keys") and "train" in dataset:
                    dataset = dataset["train"]
            except Exception:
                dataset = load_dataset(str(path), split="train")
        else:
            dataset = load_dataset(str(path), split="train")
    else:
        dataset = load_dataset(dataset_path, split="train")

    logger.info("Loaded %d tool-use examples", len(dataset))

    # Format
    dataset = dataset.map(
        lambda ex: {"text": format_tool_use_example(ex)},
        num_proc=4,
        desc="Formatting tool-use data",
    )

    split = dataset.train_test_split(test_size=eval_split, seed=seed)
    logger.info("Train: %d, Eval: %d", len(split["train"]), len(split["test"]))
    return split


# ── Tool call evaluation ────────────────────────────────────
def extract_tool_calls(text: str) -> List[Dict]:
    """Extract tool calls from model output."""
    pattern = re.compile(
        rf"{re.escape(TOOL_CALL_START)}\s*(.*?)\s*{re.escape(TOOL_CALL_END)}",
        re.DOTALL,
    )
    calls = []
    for match in pattern.finditer(text):
        try:
            call = json.loads(match.group(1))
            calls.append(call)
        except json.JSONDecodeError:
            calls.append({"_parse_error": True, "raw": match.group(1)})
    return calls


def validate_tool_call(call: Dict, available_tools: List[Dict]) -> Dict[str, bool]:
    """Validate a tool call against available tool schemas."""
    results = {
        "valid_json": True,
        "has_name": "name" in call,
        "has_arguments": "arguments" in call,
        "name_exists": False,
        "schema_valid": False,
    }

    if call.get("_parse_error"):
        results["valid_json"] = False
        return results

    call_name = call.get("name", "")

    # Find matching tool
    matching_tool = None
    for tool in available_tools:
        tool_name = tool.get("name", tool.get("function", {}).get("name", ""))
        if tool_name == call_name:
            matching_tool = tool
            results["name_exists"] = True
            break

    if matching_tool and results["has_arguments"]:
        # Validate arguments against JSON schema
        params_schema = matching_tool.get(
            "parameters",
            matching_tool.get("function", {}).get("parameters", {}),
        )
        if params_schema:
            try:
                jsonschema.validate(instance=call["arguments"], schema=params_schema)
                results["schema_valid"] = True
            except jsonschema.ValidationError:
                results["schema_valid"] = False
        else:
            results["schema_valid"] = True  # no schema to validate against

    return results


@torch.no_grad()
def evaluate_tool_use(
    model: AutoModelForCausalLM,
    tokenizer: AutoTokenizer,
    eval_dataset: Dataset,
    max_examples: int = 100,
    max_new_tokens: int = 512,
    device: str = "cuda",
) -> Dict[str, float]:
    """Evaluate tool-call accuracy on held-out examples."""
    model.eval()

    total = 0
    json_valid = 0
    name_correct = 0
    schema_correct = 0
    full_correct = 0

    gen_config = GenerationConfig(
        max_new_tokens=max_new_tokens,
        do_sample=False,
        pad_token_id=tokenizer.pad_token_id,
        eos_token_id=tokenizer.eos_token_id,
    )

    for idx, example in enumerate(eval_dataset):
        if idx >= max_examples:
            break

        tools = example.get("tools", [])
        messages = example.get("messages", [])

        # Build prompt up to the first assistant tool call
        prompt_messages = []
        expected_calls = []
        for msg in messages:
            if msg.get("role") == "assistant" and msg.get("tool_calls"):
                expected_calls = msg["tool_calls"]
                break
            prompt_messages.append(msg)

        if not expected_calls:
            continue

        # Format prompt
        prompt_text = ""
        if tools:
            prompt_text += f"<|system|>\n{format_tool_schemas(tools)}\n"
        for msg in prompt_messages:
            prompt_text += f"<|{msg['role']}|>\n{msg['content']}\n"
        prompt_text += "<|assistant|>\n"

        inputs = tokenizer(prompt_text, return_tensors="pt", truncation=True, max_length=3584).to(device)
        output = model.generate(**inputs, generation_config=gen_config)
        response = tokenizer.decode(output[0][inputs["input_ids"].shape[1]:], skip_special_tokens=True)

        # Extract and validate
        predicted_calls = extract_tool_calls(response)
        total += 1

        if predicted_calls:
            call = predicted_calls[0]
            validation = validate_tool_call(call, tools)

            if validation["valid_json"]:
                json_valid += 1
            if validation["name_exists"]:
                name_correct += 1
            if validation["schema_valid"]:
                schema_correct += 1
            if validation["valid_json"] and validation["name_exists"] and validation["schema_valid"]:
                # Also check if the name matches expected
                if expected_calls and call.get("name") == expected_calls[0].get("name"):
                    full_correct += 1

    return {
        "total_examples": total,
        "json_parse_rate": json_valid / max(total, 1),
        "name_accuracy": name_correct / max(total, 1),
        "schema_conformance": schema_correct / max(total, 1),
        "full_accuracy": full_correct / max(total, 1),
    }


# ── Main ─────────────────────────────────────────────────────
@click.command()
@click.option("--base-model", required=True, type=str, help="Path to aligned base model.")
@click.option("--dataset", required=True, type=str, help="Path to tool-use dataset.")
@click.option("--output-dir", default="./models/ailin-1b-tool-use", type=str, help="Output directory.")
@click.option("--epochs", default=3, type=int, help="Number of training epochs.")
@click.option("--lr", default=2e-5, type=float, help="Learning rate.")
@click.option("--batch-size", default=4, type=int, help="Per-device batch size.")
@click.option("--grad-accum", default=4, type=int, help="Gradient accumulation steps.")
@click.option("--max-length", default=4096, type=int, help="Max sequence length.")
@click.option("--lora-r", default=32, type=int, help="LoRA rank.")
@click.option("--lora-alpha", default=64, type=int, help="LoRA alpha.")
@click.option("--no-lora", is_flag=True, help="Disable LoRA (full fine-tuning).")
@click.option("--eval-only", is_flag=True, help="Only run evaluation.")
@click.option("--wandb-project", default="ailin-tool-use", type=str)
@click.option("--seed", default=42, type=int)
@click.option("--resume-from", default=None, type=str)
def main(
    base_model: str,
    dataset: str,
    output_dir: str,
    epochs: int,
    lr: float,
    batch_size: int,
    grad_accum: int,
    max_length: int,
    lora_r: int,
    lora_alpha: int,
    no_lora: bool,
    eval_only: bool,
    wandb_project: str,
    seed: int,
    resume_from: Optional[str],
):
    """Train model on tool-use / function-calling data."""
    torch.manual_seed(seed)

    # Load model
    logger.info("Loading model from %s", base_model)
    model = AutoModelForCausalLM.from_pretrained(
        base_model,
        torch_dtype=torch.bfloat16,
        attn_implementation="sdpa",
        trust_remote_code=True,
    )

    tokenizer = AutoTokenizer.from_pretrained(
        base_model, trust_remote_code=True, padding_side="right",
    )
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
        model.config.pad_token_id = tokenizer.eos_token_id

    # Add special tokens for tool calls if not present
    special_tokens = [TOOL_CALL_START, TOOL_CALL_END, TOOL_RESULT_START, TOOL_RESULT_END]
    tokens_to_add = [t for t in special_tokens if t not in tokenizer.get_vocab()]
    if tokens_to_add:
        tokenizer.add_special_tokens({"additional_special_tokens": tokens_to_add})
        model.resize_token_embeddings(len(tokenizer))
        logger.info("Added %d special tokens for tool-use", len(tokens_to_add))

    # LoRA
    if not no_lora:
        lora_config = LoraConfig(
            r=lora_r,
            lora_alpha=lora_alpha,
            lora_dropout=0.05,
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            bias="none",
            task_type=TaskType.CAUSAL_LM,
        )
        model = get_peft_model(model, lora_config)
        model.print_trainable_parameters()

    # Load dataset
    logger.info("Loading tool-use dataset from %s", dataset)
    data_splits = load_tool_use_dataset(dataset, seed=seed)

    if not eval_only:
        # W&B
        os.environ.setdefault("WANDB_PROJECT", wandb_project)

        training_args = SFTConfig(
            output_dir=output_dir,
            run_name="ailin-tool-use",
            num_train_epochs=epochs,
            per_device_train_batch_size=batch_size,
            per_device_eval_batch_size=batch_size,
            gradient_accumulation_steps=grad_accum,
            learning_rate=lr,
            weight_decay=0.01,
            warmup_ratio=0.03,
            lr_scheduler_type="cosine",
            max_grad_norm=1.0,
            bf16=True,
            tf32=True,
            gradient_checkpointing=True,
            max_seq_length=max_length,
            dataset_text_field="text",
            packing=False,  # tool-use examples should not be packed
            save_strategy="steps",
            save_steps=100,
            save_total_limit=3,
            load_best_model_at_end=True,
            metric_for_best_model="eval_loss",
            eval_strategy="steps",
            eval_steps=50,
            logging_steps=10,
            report_to="wandb",
            seed=seed,
            remove_unused_columns=False,
        )

        trainer = SFTTrainer(
            model=model,
            args=training_args,
            train_dataset=data_splits["train"],
            eval_dataset=data_splits["test"],
            processing_class=tokenizer,
        )

        logger.info("Starting tool-use fine-tuning...")
        if resume_from:
            trainer.train(resume_from_checkpoint=resume_from)
        else:
            trainer.train()

        # Save
        logger.info("Saving model to %s", output_dir)
        if not no_lora and isinstance(model, PeftModel):
            merged = model.merge_and_unload()
            merged.save_pretrained(output_dir)
        else:
            trainer.save_model(output_dir)
        tokenizer.save_pretrained(output_dir)

    # Evaluate tool-call accuracy
    logger.info("Evaluating tool-call accuracy...")
    device = "cuda" if torch.cuda.is_available() else "cpu"

    if eval_only:
        model = model.to(device)

    # Need raw examples for eval (with tools and messages fields)
    raw_eval = _load_raw_eval(dataset, seed)
    eval_results = evaluate_tool_use(model, tokenizer, raw_eval, device=device)

    logger.info("Tool-use evaluation results:")
    for k, v in eval_results.items():
        if isinstance(v, float):
            logger.info("  %s: %.2f%%", k, v * 100)
        else:
            logger.info("  %s: %s", k, v)

    # Save results
    results_path = Path(output_dir) / "tool_use_eval_results.json"
    results_path.parent.mkdir(parents=True, exist_ok=True)
    with open(results_path, "w") as f:
        json.dump(eval_results, f, indent=2)

    logger.info("Tool-use tuning complete.")


def _load_raw_eval(dataset_path: str, seed: int = 42) -> Dataset:
    """Load raw eval examples (with tools and messages fields intact)."""
    path = Path(dataset_path)
    if path.exists():
        if path.suffix in (".json", ".jsonl"):
            ds = load_dataset("json", data_files=str(path), split="train")
        elif path.is_dir():
            try:
                ds = load_from_disk(str(path))
                if hasattr(ds, "keys") and "train" in ds:
                    ds = ds["train"]
            except Exception:
                ds = load_dataset(str(path), split="train")
        else:
            ds = load_dataset(str(path), split="train")
    else:
        ds = load_dataset(dataset_path, split="train")

    split = ds.train_test_split(test_size=0.05, seed=seed)
    return split["test"]


if __name__ == "__main__":
    main()
