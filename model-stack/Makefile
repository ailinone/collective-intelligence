# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

.PHONY: install lint typecheck test data-validate eval serve quantize help

PYTHON ?= python
PIP ?= pip

# ===========================================================================
# Setup
# ===========================================================================

install:  ## Install all dependencies
	$(PIP) install -e ".[dev]"

# ===========================================================================
# Code quality
# ===========================================================================

lint:  ## Run linter
	ruff check .
	ruff format --check .

format:  ## Auto-format code
	ruff format .
	ruff check --fix .

typecheck:  ## Run type checker
	mypy --ignore-missing-imports data/ tokenizer/ model/ pretraining/ alignment/ serving/ registry/ evals/ flywheel/ experiments/

# ===========================================================================
# Tests
# ===========================================================================

test:  ## Run unit tests
	pytest tests/ -v --tb=short -x -k "not slow and not gpu"

test-all:  ## Run all tests including slow
	pytest tests/ -v --tb=short

# ===========================================================================
# Data pipeline
# ===========================================================================

data-validate:  ## Validate dataset manifests and configs
	$(PYTHON) -c "from data.schemas.dataset_manifest import DatasetRegistry; import glob; [DatasetRegistry.load(f) for f in glob.glob('datasets/manifests/*.yaml')]; print('All manifests valid')"

data-ingest:  ## Ingest raw data (SOURCE=path FORMAT=jsonl)
	$(PYTHON) data/ingestion/ingest.py --source $(SOURCE) --format $(FORMAT) --output ./processed

data-dedup:  ## Deduplicate (INPUT=path)
	$(PYTHON) data/dedup/lexical_dedup.py --input $(INPUT) --output ./deduped/lexical
	$(PYTHON) data/dedup/semantic_dedup.py --input ./deduped/lexical/data.jsonl --output ./deduped/semantic

data-filter:  ## Quality filter (INPUT=path)
	$(PYTHON) data/curation/quality_filter.py --input $(INPUT) --output ./filtered

data-contamination:  ## Check benchmark contamination
	$(PYTHON) data/contamination/detect_contamination.py --training-data $(INPUT)

data-mix:  ## Mix datasets (CONFIG=path)
	$(PYTHON) data/mixing/mix_datasets.py --config $(CONFIG) --output ./mixed

data-pipeline: data-ingest data-dedup data-filter data-contamination data-mix  ## Run full data pipeline

# ===========================================================================
# Tokenizer
# ===========================================================================

tokenizer-train:  ## Train tokenizer (CORPUS=path)
	$(PYTHON) tokenizer/training/train_tokenizer.py --config tokenizer/configs/bpe_32k.yaml --corpus $(CORPUS) --output ./tokenizer/output

tokenizer-eval:  ## Evaluate tokenizer
	$(PYTHON) tokenizer/evaluation/eval_tokenizer.py --tokenizer ./tokenizer/output --corpus $(CORPUS)

# ===========================================================================
# Training
# ===========================================================================

pretrain:  ## Launch pretraining (CONFIG=path, default pretrain_1b.yaml)
	accelerate launch --config_file pretraining/distributed/deepspeed_config.json \
		pretraining/launcher/train.py --config $(or $(CONFIG),pretraining/configs/pretrain_1b.yaml)

pretrain-resume:  ## Resume pretraining from latest checkpoint
	$(PYTHON) pretraining/resume/resume.py --checkpoint-dir ./checkpoints

checkpoint-list:  ## List checkpoints
	$(PYTHON) pretraining/checkpoints/manager.py list --checkpoint-dir ./checkpoints

checkpoint-prune:  ## Prune old checkpoints
	$(PYTHON) pretraining/checkpoints/manager.py prune --checkpoint-dir ./checkpoints --keep-last 5 --keep-best 3

# ===========================================================================
# Alignment
# ===========================================================================

sft:  ## Run SFT (CONFIG=path)
	$(PYTHON) alignment/sft/train_sft.py --config $(or $(CONFIG),alignment/sft/sft_config.yaml)

dpo:  ## Run DPO (CONFIG=path)
	$(PYTHON) alignment/dpo/train_dpo.py --config $(or $(CONFIG),alignment/dpo/dpo_config.yaml)

reward-model:  ## Train reward model
	$(PYTHON) alignment/reward_model/train_reward.py --base-model $(MODEL) --dataset $(DATASET)

safety-tune:  ## Safety tuning
	$(PYTHON) alignment/safety/safety_tuning.py --config alignment/safety/safety_config.yaml

tool-use-tune:  ## Tool-use tuning
	$(PYTHON) alignment/tool_use/tool_use_tuning.py --model $(MODEL) --dataset $(DATASET)

context-extend:  ## Extend context window
	$(PYTHON) alignment/long_context/extend_context.py --model $(MODEL) --method yarn --target-length 32768

rlhf:  ## Run PPO/RLHF
	$(PYTHON) alignment/rlhf_rlaif/train_ppo.py --policy-model $(MODEL) --reward-model $(REWARD_MODEL)

# ===========================================================================
# Serving
# ===========================================================================

serve:  ## Start serving (MODEL=path, PORT=8081)
	$(PYTHON) serving/runtime/serve.py --model $(MODEL) --port $(or $(PORT),8081)

quantize:  ## Quantize model (MODEL=path, METHOD=awq)
	$(PYTHON) serving/quantization/quantize.py --model $(MODEL) --method $(or $(METHOD),awq) --output ./quantized

deploy:  ## Deploy model version
	$(PYTHON) serving/rollout/deploy.py --model $(MODEL) --port $(or $(PORT),8081)

rollback:  ## Rollback to previous version
	$(PYTHON) serving/rollback/rollback.py --rollout-log ./serving/rollout/rollout.log

# ===========================================================================
# Evaluation
# ===========================================================================

eval:  ## Run full eval suite (MODEL=path)
	$(PYTHON) evals/runner.py --model $(MODEL) --suites reasoning,coding,safety,tool_calling,adversarial,factuality,needle_haystack

eval-safety:  ## Run safety eval only
	$(PYTHON) evals/safety/safety_eval.py --model $(MODEL)

eval-compare:  ## Compare candidate vs champion
	$(PYTHON) flywheel/promotion/promote.py --candidate-report $(CANDIDATE) --champion-report $(CHAMPION)

# ===========================================================================
# Research flywheel
# ===========================================================================

capture-failures:  ## Capture failures from eval report
	$(PYTHON) flywheel/failures/capture.py --report $(REPORT) --output ./flywheel/failures/captured

cluster-failures:  ## Cluster captured failures
	$(PYTHON) flywheel/clustering/cluster.py --input ./flywheel/failures/captured --output ./flywheel/clustering/clusters

build-replay:  ## Build replay training set from clusters
	$(PYTHON) flywheel/replay/build_replay_set.py --clusters ./flywheel/clustering/clusters --output ./flywheel/replay/replay.jsonl

ablation:  ## Run ablation study (BASE_CONFIG=path, ABLATIONS=path)
	$(PYTHON) experiments/ablations/ablation_runner.py --base-config $(BASE_CONFIG) --ablations $(ABLATIONS)

flywheel: capture-failures cluster-failures build-replay feedback-pipeline  ## Run full flywheel cycle

# ===========================================================================
# Feedback pipeline (ci/api → training data)
# ===========================================================================

FEEDBACK_RAW_DIR ?= ./data/feedback/raw
FEEDBACK_STAGING_DIR ?= ./data/feedback/staging
FEEDBACK_CONFIG ?= ./data/feedback/config.yaml
SKIP_STAGING ?= 0

feedback-extract:  ## Validate extracted JSONL from API export
	$(PYTHON) data/feedback/extract.py --manifest $(FEEDBACK_RAW_DIR)/extraction-manifest-*.json --output ./data/feedback/validated

feedback-transform:  ## Apply PII filter, quality gates, build SFT/DPO
	$(PYTHON) data/feedback/transform.py --input ./data/feedback/validated --config $(FEEDBACK_CONFIG) --output $(FEEDBACK_STAGING_DIR)

feedback-stage: feedback-extract feedback-transform  ## Extract + transform (staging only)

feedback-load:  ## Load approved staging data into training datasets
	$(PYTHON) data/feedback/load.py --staging-dir $(FEEDBACK_STAGING_DIR) --sft-dir ./data/sft/feedback --dpo-dir ./data/preference/feedback --manifest-dir ./datasets/manifests --lineage-dir ./datasets/lineage

approve-feedback-data: feedback-stage feedback-load  ## Full pipeline with approval

feedback-pipeline:  ## Automated pipeline (respects SKIP_STAGING)
ifeq ($(SKIP_STAGING),1)
	$(MAKE) feedback-stage feedback-load
else
	@if [ -d "$(FEEDBACK_RAW_DIR)" ] && ls $(FEEDBACK_RAW_DIR)/extraction-manifest-*.json 1>/dev/null 2>&1; then \
		$(MAKE) feedback-stage; \
		echo "Review staging at $(FEEDBACK_STAGING_DIR), then run: make feedback-load"; \
	else \
		echo "No feedback data found in $(FEEDBACK_RAW_DIR) — skipping feedback pipeline"; \
	fi
endif

# ===========================================================================
# Registry
# ===========================================================================

registry-list:  ## List registered models
	$(PYTHON) registry/models/registry.py list

registry-promote:  ## Promote a model version
	$(PYTHON) registry/models/registry.py promote --model-id $(MODEL_ID) --version $(VERSION)

# ===========================================================================
# Help
# ===========================================================================

help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'
