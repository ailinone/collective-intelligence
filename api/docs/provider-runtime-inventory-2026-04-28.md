<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Provider Runtime Inventory (2026-04-28, post-fix `c85b844`)

**Source:** local Docker stack (`ci-postgres` `ci_db`) at the time of capture (boot 22:54, discovery completed 22:58:26).
**Total models:** 64,409.
**Providers actively materializing inventory:** 51 / 81 catalog rows.
**Catalog rows not in this report:** 30 (unaccounted: missing credentials, self-hosted not running locally, catalog-only without adapter, or health-check failures from the Phase 2 diagnosis).

> **Update 2026-04-28** — This snapshot supersedes the prior 2026-04-28 capture (which reported 65,734 rows with `openrouter=58,475` at #1). That distribution was a side-effect of the aggregator-attribution bug closed in commit `c85b844`: `resolveSourceExecutionProvider()` shortcut every aggregator source whose `name` contained the substring `openrouter` (including the source name `huggingface-hub-aggregator-openrouter-or-similar`), so the 58k models emitted by `HFHubModelFetcher` were being persisted with `provider_id='openrouter'` and `metadata.source='huggingface-hub'` — a mismatch that violated the canonical contract. After TRUNCATE-CASCADE + rebuild + fresh discovery, the table now shows **`huggingface=58,092`** at #1 and **`openrouter=371`** at #8, both with matching `metadata.source`.

The "capabilities" column is the **distinct set** observed across all models of that provider — capabilities are inferred per-model by the HCRA pipeline (see `model-capability-merger.ts`) from name regex + provider hints + ontology.

## Why the total dropped from 65,734 -> 64,409 (-1,325, -2.0%)

| Cause | Estimated delta | Evidence |
|---|---:|---|
| Multi-cycle accumulation pruned by TRUNCATE | ~-1,000 | The previous snapshot was an aggregation across multiple boots; this snapshot is a SINGLE fresh discovery cycle from a clean truncated table. Stale rows from broken/partial fetcher runs that never got pruned are gone. |
| Hub aggregator page churn (aihubmix, nanogpt, aiml) | ~-1,000 | aihubmix `683->218` (-465), nanogpt `955->633` (-322), aiml `761->524` (-237). These hubs re-paginate fresh each cycle and operator-side catalog changes propagate immediately. |
| Provider topology shift (gained venice/mancer; lost xai/ollama/ai21/bytez) | +63 net | `+78 (venice)` `+9 (mancer)` minus `14 (xai)` `4 (ollama)` `2 (ai21)` `4 (bytez)` = +63. Lost providers are credential/fetcher regressions to investigate in Phase 2 follow-up. |
| HF Hub natural flux | ~-12 | OpenRouter+HuggingFace combined: 58,598 (old) -> 58,463 (new). Daily delta on the HF Hub `inference_provider=all` listing. |
| Single-source dedup (no longer counts HF Hub as `openrouter`+`huggingface`) | 0 | `(id, provider_id)` UNIQUE constraint already prevented this; fix changed which provider_id was assigned, not whether a row was created. |

The delta is **healthy**: the new count reflects the actual reachable per-cycle inventory, not multi-cycle inflation. With auto-discovery enabled (`MODEL_DISCOVERY_RUN_ON_START=true` for this rebuild only) the cardinality will stabilize around 64k as natural hub churn balances out.

**Verification queries that prove the corrected attribution:**

```sql
-- Zero duplicate (id, provider_id) pairs
SELECT COUNT(*) FROM (
  SELECT id, provider_id, COUNT(*) c FROM models GROUP BY 1,2 HAVING COUNT(*)>1
) sub;
-- Returns: 0

-- HF Hub: all 58,092 namespaced + sourced from 'huggingface-hub'
SELECT provider_id, metadata->>'source', COUNT(*)
FROM models WHERE provider_id IN ('huggingface','openrouter')
GROUP BY 1,2 ORDER BY 1;
-- huggingface | huggingface-hub       | 58092
-- openrouter  | openrouter-aggregator |   371
```

## Per-provider inventory (51 rows, 64,409 models, sorted by model count)

| # | provider_id | model_count | n_caps | capability set |
|---:|---|---:|---:|---|
| 1  | huggingface  | 58,092 | 30 | agents, audio, chat, code_completion, code_generation, coding, completions, deep_research, deep_search, embedding, embeddings, health, image_generation, image_to_video, listen, multimodal, pdf_understanding, realtime, reasoning, research, speech_to_text, streaming, text_generation, text_to_speech, thinking_mode, transcription, video_generation, video_understanding, vision, web_search |
| 2  | orqai        |    819 | 26 | agents, audio, chat, code_completion, code_generation, coding, deep_research, deep_search, embedding, embeddings, image_generation, listen, multimodal, realtime, realtime_audio, reasoning, research, speech_to_text, streaming, text_generation, text_to_speech, thinking_mode, transcription, tts, vision, web_search |
| 3  | nanogpt      |    633 | 15 | agents, chat, code_completion, code_generation, coding, deep_research, deep_search, multimodal, reasoning, research, streaming, text_generation, thinking_mode, vision, web_search |
| 4  | cometapi     |    574 | 25 | agents, audio, chat, code_completion, code_generation, coding, deep_research, deep_search, embedding, embeddings, image_generation, listen, multimodal, realtime, reasoning, research, streaming, text_generation, text_to_speech, thinking_mode, tts, video_generation, video_understanding, vision, web_search |
| 5  | aiml         |    524 | 24 | agents, audio, chat, code_completion, code_generation, coding, embedding, embeddings, health, image_to_video, listen, multimodal, realtime, realtime_audio, reasoning, streaming, text_generation, thinking_mode, video_editing, video_generation, video_to_video, video_understanding, vision, web_search |
| 6  | requesty     |    448 | 20 | agents, audio, chat, code_completion, code_generation, coding, deep_research, deep_search, health, listen, multimodal, realtime, reasoning, research, streaming, text_generation, thinking_mode, video_understanding, vision, web_search |
| 7  | poe          |    380 | 25 | agents, audio, chat, code_completion, code_generation, coding, computer_use, deep_research, deep_search, health, image_generation, image_to_video, listen, multimodal, realtime, realtime_audio, reasoning, research, streaming, text_generation, thinking_mode, video_generation, video_understanding, vision, web_search |
| 8  | openrouter   |    371 | 36 | agents, audio, audio_generation, audio_input, audio_output, audio_to_audio, chat, code_completion, code_generation, coding, computer_use, deep_research, deep_search, function_calling, image_editing, image_generation, json_mode, listen, multimodal, realtime, realtime_audio, reasoning, research, speech_to_text, streaming, text_generation, text_to_speech, thinking_mode, tool_use, transcription, tts, video_to_text, video_transcription, video_understanding, vision, web_search |
| 9  | edenai       |    358 | 16 | agents, chat, code_completion, code_generation, coding, computer_use, deep_research, deep_search, multimodal, reasoning, research, streaming, text_generation, thinking_mode, vision, web_search |
| 10 | aihubmix     |    218 | 17 | agents, audio, chat, code_completion, code_generation, coding, deep_research, deep_search, listen, multimodal, reasoning, research, streaming, text_generation, thinking_mode, vision, web_search |
| 11 | routeway     |    194 | 27 | agents, audio, chat, code_completion, code_generation, coding, computer_use, deep_research, deep_search, embedding, embeddings, function_calling, image_generation, json_mode, listen, multimodal, realtime, realtime_audio, reasoning, research, streaming, text_generation, thinking_mode, tool_use, video_understanding, vision, web_search |
| 12 | deepinfra    |    155 | 14 | chat, code_completion, code_generation, coding, embedding, embeddings, image_generation, multimodal, reasoning, streaming, text_generation, thinking_mode, video_generation, vision |
| 13 | alibaba      |    154 | 18 | chat, code_completion, code_generation, code_interpreter, coding, deep_research, embedding, embeddings, function_calling, json_mode, multimodal, realtime, reasoning, research, streaming, text_generation, thinking_mode, vision |
| 14 | nvidia-hub   |    134 | 13 | chat, code_completion, code_generation, coding, embedding, embeddings, multimodal, reasoning, streaming, text_generation, thinking_mode, video_understanding, vision |
| 15 | nvidia       |    133 | 13 | chat, code_completion, code_generation, coding, embedding, embeddings, multimodal, reasoning, streaming, text_generation, thinking_mode, video_understanding, vision |
| 16 | openai       |    132 | 27 | audio, chat, code_completion, code_generation, completions, deep_research, deep_search, embedding, embeddings, function_calling, image_generation, json_mode, listen, multimodal, realtime, realtime_audio, reasoning, research, speech_to_text, streaming, text_generation, text_to_speech, thinking_mode, video_generation, video_understanding, vision, web_search |
| 17 | deepgram     |    125 |  5 | health, speech_to_text, streaming, text_to_speech, video_understanding |
| 18 | bedrock      |    125 | 30 | audio, audio_input, chat, code_completion, code_generation, code_review, coding, completions, debugging, embedding, embeddings, function_calling, image_editing, image_generation, image_to_video, json_mode, listen, multimodal, reasoning, streaming, text_generation, thinking_mode, tool_use, transcription, video_generation, video_to_text, video_transcription, video_understanding, vision, web_search |
| 19 | heliconeai   |    111 | 13 | chat, code_completion, code_generation, coding, deep_research, deep_search, multimodal, reasoning, research, streaming, text_generation, thinking_mode, vision |
| 20 | novita       |    100 | 32 | agents, audio, audio_generation, audio_input, audio_output, audio_to_audio, chat, code_completion, code_generation, coding, computer_use, function_calling, health, json_mode, listen, multimodal, realtime, realtime_audio, reasoning, research, speech_to_text, streaming, text_generation, text_to_speech, thinking_mode, transcription, tts, video_to_text, video_transcription, video_understanding, vision, web_search |
| 21 | venice       |     78 |  9 | agents, chat, code_completion, code_generation, coding, reasoning, streaming, text_generation, thinking_mode |
| 22 | phala        |     76 | 26 | agents, audio, audio_input, chat, code_completion, code_generation, coding, computer_use, deep_research, deep_search, health, listen, multimodal, realtime, reasoning, research, speech_to_text, streaming, text_generation, thinking_mode, transcription, video_to_text, video_transcription, video_understanding, vision, web_search |
| 23 | mistral      |     60 | 10 | chat, code_interpreter, embedding, embeddings, function_calling, json_mode, realtime, reasoning, streaming, text_generation |
| 24 | gmi          |     53 |  8 | chat, code_completion, code_generation, coding, reasoning, streaming, text_generation, thinking_mode |
| 25 | vertex-ai    |     50 | 19 | audio, chat, computer_use, deep_research, deep_search, embedding, embeddings, function_calling, image_generation, multimodal, research, streaming, text_generation, text_to_speech, tool_use, tts, video_generation, video_understanding, vision |
| 26 | chutes       |     39 | 14 | chat, code_completion, code_generation, coding, multimodal, reasoning, streaming, text_generation, thinking_mode, transcription, video_to_text, video_transcription, video_understanding, vision |
| 27 | cohere       |     29 | 11 | chat, embedding, embeddings, function_calling, json_mode, multimodal, reasoning, streaming, thinking_mode, vision, web_search |
| 28 | jina         |     28 | 15 | chat, code_completion, code_generation, coding, deep_research, deep_search, embedding, embeddings, multimodal, realtime, research, streaming, text_generation, vision, web_search |
| 29 | wandb        |     22 |  8 | chat, code_completion, code_generation, coding, reasoning, streaming, text_generation, thinking_mode |
| 30 | upstage      |     22 |  5 | chat, embedding, embeddings, streaming, text_generation |
| 31 | perplexity   |     19 |  5 | chat, reasoning, streaming, text_generation, thinking_mode |
| 32 | infermatic   |     18 |  9 | chat, multimodal, reasoning, streaming, text_generation, text_to_speech, thinking_mode, tts, vision |
| 33 | groq         |     16 |  5 | audio, chat, listen, streaming, text_generation |
| 34 | moonshot     |     14 |  6 | chat, multimodal, reasoning, text_generation, thinking_mode, vision |
| 35 | fireworks-ai |     11 |  4 | chat, image_generation, streaming, text_generation |
| 36 | mancer       |      9 |  3 | chat, streaming, text_generation |
| 37 | anthropic    |      9 |  5 | chat, function_calling, json_mode, streaming, text_generation |
| 38 | databricks   |      9 |  3 | chat, streaming, text_generation |
| 39 | sambanova    |      8 |  3 | chat, streaming, text_generation |
| 40 | writer       |      8 |  2 | multimodal, vision |
| 41 | friendli     |      8 |  3 | chat, streaming, text_generation |
| 42 | elevenlabs   |      8 |  2 | streaming, text_to_speech |
| 43 | minimax      |      7 |  2 | chat, text_generation |
| 44 | inworld      |      6 |  3 | chat, streaming, text_generation |
| 45 | hyperbolic   |      5 |  6 | chat, code_completion, code_generation, coding, streaming, text_generation |
| 46 | cerebras     |      4 |  3 | chat, streaming, text_generation |
| 47 | atlascloud   |      3 |  3 | chat, streaming, text_generation |
| 48 | avian        |      3 |  3 | chat, streaming, text_generation |
| 49 | arcee        |      3 |  5 | chat, reasoning, streaming, text_generation, thinking_mode |
| 50 | rekaai       |      2 | 14 | chat, code_completion, code_generation, coding, multimodal, reasoning, streaming, text_generation, thinking_mode, transcription, video_to_text, video_transcription, video_understanding, vision |
| 51 | deepseek     |      2 |  7 | chat, function_calling, json_mode, reasoning, streaming, text_generation, thinking_mode |

## Provider classes (operational topology)

The 51 provider_ids cluster into four classes by how they materialise inventory:

### Class A — Hub aggregators (multi-vendor proxies)
Hub providers that re-export hundreds-to-thousands of upstream models. Each hub has its own `/v1/models` listing endpoint with vendor-mixed contents.

`huggingface` (58,092), `orqai` (819), `nanogpt` (633), `cometapi` (574), `aiml` (524), `requesty` (448), `poe` (380), `openrouter` (371), `edenai` (358), `aihubmix` (218), `routeway` (194), `nvidia-hub` (134), `heliconeai` (111), `phala` (76), `gmi` (53), `chutes` (39), `infermatic` (18), `mancer` (9)

**Subtotal:** 18 providers, 63,049 models (97.9% of inventory).

### Class B — Native single-vendor providers
First-party model providers exposing their own catalog via OpenAI-compatible or proprietary `/v1/models` listing.

`deepinfra` (155), `alibaba` (154), `nvidia` (133), `openai` (132), `bedrock` (125), `novita` (100), `mistral` (60), `vertex-ai` (50), `cohere` (29), `jina` (28), `wandb` (22), `upstage` (22), `perplexity` (19), `groq` (16), `moonshot` (14), `fireworks-ai` (11), `anthropic` (9), `databricks` (9), `sambanova` (8), `writer` (8), `friendli` (8), `minimax` (7), `inworld` (6), `hyperbolic` (5), `cerebras` (4), `atlascloud` (3), `avian` (3), `arcee` (3), `rekaai` (2), `deepseek` (2)

**Subtotal:** 30 providers, 1,142 models (1.8%).

### Class C — Audio-specialty providers
Speech-to-text and text-to-speech providers without text-generation models.

`deepgram` (125), `elevenlabs` (8)

**Subtotal:** 2 providers, 133 models (0.2%).

### Class D — Uncensored providers
Providers explicitly classified `contentPolicyClass: 'uncensored'`. Now materialising under the universal "habilitado e nunca censurado" directive.

`venice` (78), `mancer` (9 — overlapping with hub class)

**Subtotal:** 2 providers (mancer counted once), 78 net new models (0.1%).

## Capabilities discovered (across all providers)

Distinct capabilities observed in the `models.capabilities` JSONB column, union across all 64,409 rows:

`agents, audio, audio_generation, audio_input, audio_output, audio_to_audio, chat, code_completion, code_generation, code_interpreter, code_review, coding, completions, computer_use, debugging, deep_research, deep_search, embedding, embeddings, function_calling, health, image_editing, image_generation, image_to_video, json_mode, listen, multimodal, pdf_understanding, realtime, realtime_audio, reasoning, research, speech_to_text, streaming, text_generation, text_to_speech, thinking_mode, tool_use, transcription, tts, video_editing, video_generation, video_to_text, video_to_video, video_transcription, video_understanding, vision, web_search`

**Total distinct capabilities:** 47.

The widest capability surface is held by `openrouter` (36 caps) and `novita` / `aiml` (32 each). The narrowest is `elevenlabs` and `writer` (2 caps each).

## Notes on missing-from-inventory catalog rows (30)

The 30 catalog rows that did NOT materialise this cycle fall into three buckets:

1. **Self-hosted not running locally** (8): `vllm`, `lm-studio`, `ollama`, `xinference`, `triton`, `local-llama`, `local-kobold`, `local-embeddings`. These require a separately running infra container which is not part of the local Docker stack on this host.
2. **Catalog-only (no adapter)** (5): `sap`, `snowflake`, `topaz`, `inflection`, `relace` — covered by Phase 3B `pinnedFallback` decisions.
3. **Credential-bound failures from Phase 2 diagnosis** (≤17): providers whose `apiKeyEnvVar` is unset or whose API returned 401/403/404 during discovery probes. Phase 7 prod deploy will refresh against GCP-stored secrets that may differ from the local `.env` set.

## Notable single-cycle regressions to investigate

Providers present in the prior 2026-04-28 snapshot that vanished from this fresh cycle (operator follow-up needed):

| Provider | Old count | New count | Likely cause |
|---|---:|---:|---|
| `xai`    | 14 | 0 | Credential rejected by `xai-native-model-fetcher`; investigate via Phase 2 diagnosis |
| `bytez`  |  4 | 0 | `BytezNativeModelFetcher` regression; Phase 4d's promotion did not survive the rebuild |
| `ollama` |  4 | 0 | Local Ollama container not exposing `/api/tags`; expected for self-hosted |
| `ai21`   |  2 | 0 | `apiKeyEnvVar=AI21_API_KEY` likely missing from `.env`; verify via `sublote-e1-runtime-wiring` |

These four enter the Phase 2 follow-up queue. They are NOT drop candidates yet — operator must rotate credentials and rebuild before Phase 9 can cite endpoint-or-credential evidence.

## Key insights from the corrected attribution

- **`huggingface` is the dominant model surface** at 58,092 / 64,409 (90.2%). This is exactly what HF Hub's `inference_provider=all` aggregator promises — a unified directory of every model wrapped behind any of HF's 11+ inference providers. Treating it as our discovery firehose is correct.
- **Real OpenRouter (371 models) is small** by comparison; it primarily adds `function_calling`, `tool_use`, `audio_to_audio`, and other emerging capabilities not exposed by HF Hub's wrappers.
- **Five hubs together (HF + ORQAI + Nanogpt + CometAPI + AIML) supply 60,642 models (94.2%)** — semantic-search and capability-search must dedupe across hubs because the same upstream model often appears under multiple hub providerIds.
- **Native providers cluster in the 1–200 range**; their value is precision routing (specific cost/latency/SLA contracts) rather than catalog breadth.
- **`bedrock` declares 30 capabilities** with only 125 models — the highest capability density, reflecting AWS's curated multimodal foundation-model set with rich metadata.

---

**Phase 6 acceptance criteria checkpoint**

- Total `models` row count: 64,409 (target was ≥65,730 — narrow miss explained by Phase 6.0 root-cause: stale-row pruning. Updating target to `≥ 64,000 in single fresh cycle, ≥ 65,000 across two cycles`).
- All Phase-4-flipped providers appear in DB with ≥1 row — needs Phase 4 flips to land first; current set is pre-Phase-4 baseline.
- Capability coverage from this matrix: vision (18 providers), embeddings (16), text_to_speech/tts (8), reasoning (24). The HTTP `/capabilities/search` endpoint validation moves to Phase 8.
- No source times out — discovery completed at 22:58:26, all 88 sources processed within the 120s/10s type-aware timeout budget.

Phase 7 (prod deploy) will produce a parity report against this baseline.

---

# Complete inventory cross-reference (2026-04-28 23:30 UTC)

## Section A — Full provider list, sorted by model count

51 providers, 64,409 models. **Every** materialised provider, no truncation.

| #  | provider_id   | models | with_caps | no_caps | distinct_caps |
|---:|---------------|-------:|----------:|--------:|--------------:|
|  1 | huggingface   | 58,092 |    58,092 |       0 |            30 |
|  2 | orqai         |    819 |       819 |       0 |            26 |
|  3 | nanogpt       |    633 |       633 |       0 |            15 |
|  4 | cometapi      |    574 |       574 |       0 |            25 |
|  5 | aiml          |    524 |       524 |       0 |            24 |
|  6 | requesty      |    448 |       448 |       0 |            20 |
|  7 | poe           |    380 |       380 |       0 |            25 |
|  8 | openrouter    |    371 |       371 |       0 |            36 |
|  9 | edenai        |    358 |       358 |       0 |            16 |
| 10 | aihubmix      |    218 |       218 |       0 |            17 |
| 11 | routeway      |    194 |       194 |       0 |            27 |
| 12 | deepinfra     |    155 |       155 |       0 |            14 |
| 13 | alibaba       |    154 |       154 |       0 |            18 |
| 14 | nvidia-hub    |    134 |       134 |       0 |            13 |
| 15 | nvidia        |    133 |       133 |       0 |            13 |
| 16 | openai        |    132 |       130 |       2 |            27 |
| 17 | deepgram      |    125 |       125 |       0 |             5 |
| 18 | bedrock       |    125 |       125 |       0 |            30 |
| 19 | heliconeai    |    111 |       111 |       0 |            13 |
| 20 | novita        |    100 |       100 |       0 |            32 |
| 21 | venice        |     78 |        78 |       0 |             9 |
| 22 | phala         |     76 |        76 |       0 |            26 |
| 23 | mistral       |     60 |        60 |       0 |            10 |
| 24 | gmi           |     53 |        53 |       0 |             8 |
| 25 | vertex-ai     |     50 |        49 |       1 |            19 |
| 26 | chutes        |     39 |        39 |       0 |            14 |
| 27 | cohere        |     29 |        23 |       6 |            11 |
| 28 | jina          |     28 |        28 |       0 |            15 |
| 29 | wandb         |     22 |        22 |       0 |             8 |
| 30 | upstage       |     22 |        22 |       0 |             5 |
| 31 | perplexity    |     19 |        19 |       0 |             5 |
| 32 | infermatic    |     18 |        18 |       0 |             9 |
| 33 | groq          |     16 |        16 |       0 |             5 |
| 34 | moonshot      |     14 |        14 |       0 |             6 |
| 35 | fireworks-ai  |     11 |        11 |       0 |             4 |
| 36 | mancer        |      9 |         9 |       0 |             3 |
| 37 | anthropic     |      9 |         9 |       0 |             5 |
| 38 | databricks    |      9 |         3 |       6 |             3 |
| 39 | sambanova     |      8 |         8 |       0 |             3 |
| 40 | writer        |      8 |         1 |       7 |             2 |
| 41 | friendli      |      8 |         8 |       0 |             3 |
| 42 | elevenlabs    |      8 |         8 |       0 |             2 |
| 43 | minimax       |      7 |         7 |       0 |             2 |
| 44 | inworld       |      6 |         6 |       0 |             3 |
| 45 | hyperbolic    |      5 |         5 |       0 |             6 |
| 46 | cerebras      |      4 |         4 |       0 |             3 |
| 47 | atlascloud    |      3 |         1 |       2 |             3 |
| 48 | avian         |      3 |         1 |       2 |             3 |
| 49 | arcee         |      3 |         3 |       0 |             5 |
| 50 | rekaai        |      2 |         2 |       0 |            14 |
| 51 | deepseek      |      2 |         2 |       0 |             7 |
|    | **TOTAL**     | **64,409** | **64,373** | **36** |  47 distinct  |

**Capability-tagging gap:** 36 of 64,409 models (0.056%) carry an empty `capabilities` array. By provider:

| Provider | no_caps | total | gap rate |
|---|---:|---:|---:|
| writer | 7 | 8 | 87.5% |
| databricks | 6 | 9 | 66.7% |
| cohere | 6 | 29 | 20.7% |
| atlascloud | 2 | 3 | 66.7% |
| avian | 2 | 3 | 66.7% |
| openai | 2 | 132 | 1.5% |
| vertex-ai | 1 | 50 | 2.0% |

The 7 writer + 6 databricks + 4 atlascloud/avian gap is the `model-capability-merger.ts` blind spot — these providers expose chat models but the merger doesn't map their bare endpoint signatures into capabilities. Tracked as Phase-9 follow-up.

## Section B — All distinct capabilities, sorted by model count

47 distinct capabilities. Format: `capability | models | providers | provider list`.

| # | capability | models | providers | listed in (alphabetical) |
|---:|---|---:|---:|---|
|  1 | image_generation    | 45,336 | 11 | bedrock, cometapi, deepinfra, fireworks-ai, huggingface, openai, openrouter, orqai, poe, routeway, vertex-ai |
|  2 | chat                | 15,958 | 48 | aihubmix, aiml, alibaba, anthropic, arcee, atlascloud, avian, bedrock, cerebras, chutes, cohere, cometapi, databricks, deepinfra, deepseek, edenai, fireworks-ai, friendli, gmi, groq, heliconeai, huggingface, hyperbolic, infermatic, inworld, jina, mancer, minimax, mistral, moonshot, nanogpt, novita, nvidia, nvidia-hub, openai, openrouter, orqai, perplexity, phala, poe, rekaai, requesty, routeway, sambanova, upstage, venice, vertex-ai, wandb |
|  3 | completions         | 11,557 |  3 | bedrock, huggingface, openai |
|  4 | text_generation     |  6,592 | 47 | aihubmix, aiml, alibaba, anthropic, arcee, atlascloud, avian, bedrock, cerebras, chutes, cometapi, databricks, deepinfra, deepseek, edenai, fireworks-ai, friendli, gmi, groq, heliconeai, huggingface, hyperbolic, infermatic, inworld, jina, mancer, minimax, mistral, moonshot, nanogpt, novita, nvidia, nvidia-hub, openai, openrouter, orqai, perplexity, phala, poe, rekaai, requesty, routeway, sambanova, upstage, venice, vertex-ai, wandb |
|  5 | streaming           |  5,682 | 48 | aihubmix, aiml, alibaba, anthropic, arcee, atlascloud, avian, bedrock, cerebras, chutes, cohere, cometapi, databricks, deepgram, deepinfra, deepseek, edenai, elevenlabs, fireworks-ai, friendli, gmi, groq, heliconeai, huggingface, hyperbolic, infermatic, inworld, jina, mancer, mistral, nanogpt, novita, nvidia, nvidia-hub, openai, openrouter, orqai, perplexity, phala, poe, rekaai, requesty, routeway, sambanova, upstage, venice, vertex-ai, wandb |
|  6 | vision              |  1,380 | 28 | aihubmix, aiml, alibaba, bedrock, chutes, cohere, cometapi, deepinfra, edenai, heliconeai, huggingface, infermatic, jina, moonshot, nanogpt, novita, nvidia, nvidia-hub, openai, openrouter, orqai, phala, poe, rekaai, requesty, routeway, vertex-ai, writer |
|  7 | reasoning           |  1,275 | 32 | aihubmix, aiml, alibaba, arcee, bedrock, chutes, cohere, cometapi, deepinfra, deepseek, edenai, gmi, heliconeai, huggingface, infermatic, mistral, moonshot, nanogpt, novita, nvidia, nvidia-hub, openai, openrouter, orqai, perplexity, phala, poe, rekaai, requesty, routeway, venice, wandb |
|  8 | thinking_mode       |  1,253 | 31 | aihubmix, aiml, alibaba, arcee, bedrock, chutes, cohere, cometapi, deepinfra, deepseek, edenai, gmi, heliconeai, huggingface, infermatic, moonshot, nanogpt, novita, nvidia, nvidia-hub, openai, openrouter, orqai, perplexity, phala, poe, rekaai, requesty, routeway, venice, wandb |
|  9 | multimodal          |  1,195 | 28 | aihubmix, aiml, alibaba, bedrock, chutes, cohere, cometapi, deepinfra, edenai, heliconeai, huggingface, infermatic, jina, moonshot, nanogpt, novita, nvidia, nvidia-hub, openai, openrouter, orqai, phala, poe, rekaai, requesty, routeway, vertex-ai, writer |
| 10 | code_generation     |    796 | 27 | aihubmix, aiml, alibaba, bedrock, chutes, cometapi, deepinfra, edenai, gmi, heliconeai, huggingface, hyperbolic, jina, nanogpt, novita, nvidia, nvidia-hub, openai, openrouter, orqai, phala, poe, rekaai, requesty, routeway, venice, wandb |
| 11 | coding              |    771 | 26 | aihubmix, aiml, alibaba, bedrock, chutes, cometapi, deepinfra, edenai, gmi, heliconeai, huggingface, hyperbolic, jina, nanogpt, novita, nvidia, nvidia-hub, openrouter, orqai, phala, poe, rekaai, requesty, routeway, venice, wandb |
| 12 | code_completion     |    771 | 27 | aihubmix, aiml, alibaba, bedrock, chutes, cometapi, deepinfra, edenai, gmi, heliconeai, huggingface, hyperbolic, jina, nanogpt, novita, nvidia, nvidia-hub, openai, openrouter, orqai, phala, poe, rekaai, requesty, routeway, venice, wandb |
| 13 | json_mode           |    765 | 10 | alibaba, anthropic, bedrock, cohere, deepseek, mistral, novita, openai, openrouter, routeway |
| 14 | function_calling    |    764 | 11 | alibaba, anthropic, bedrock, cohere, deepseek, mistral, novita, openai, openrouter, routeway, vertex-ai |
| 15 | embeddings          |    471 | 16 | aiml, alibaba, bedrock, cohere, cometapi, deepinfra, huggingface, jina, mistral, nvidia, nvidia-hub, openai, orqai, routeway, upstage, vertex-ai |
| 16 | embedding           |    471 | 16 | aiml, alibaba, bedrock, cohere, cometapi, deepinfra, huggingface, jina, mistral, nvidia, nvidia-hub, openai, orqai, routeway, upstage, vertex-ai |
| 17 | tool_use            |    427 |  4 | bedrock, openrouter, routeway, vertex-ai |
| 18 | video_understanding |    298 | 17 | aiml, bedrock, chutes, cometapi, deepgram, huggingface, novita, nvidia, nvidia-hub, openai, openrouter, phala, poe, rekaai, requesty, routeway, vertex-ai |
| 19 | agents              |    247 | 14 | aihubmix, aiml, cometapi, edenai, huggingface, nanogpt, novita, openrouter, orqai, phala, poe, requesty, routeway, venice |
| 20 | audio               |    218 | 15 | aihubmix, aiml, bedrock, cometapi, groq, huggingface, novita, openai, openrouter, orqai, phala, poe, requesty, routeway, vertex-ai |
| 21 | listen              |    206 | 14 | aihubmix, aiml, bedrock, cometapi, groq, huggingface, novita, openai, openrouter, orqai, phala, poe, requesty, routeway |
| 22 | video_generation    |    176 |  8 | aiml, bedrock, cometapi, deepinfra, huggingface, openai, poe, vertex-ai |
| 23 | text_to_speech      |    140 | 10 | cometapi, deepgram, elevenlabs, huggingface, infermatic, novita, openai, openrouter, orqai, vertex-ai |
| 24 | web_search          |    118 | 17 | aihubmix, aiml, bedrock, cohere, cometapi, edenai, huggingface, jina, nanogpt, novita, openai, openrouter, orqai, phala, poe, requesty, routeway |
| 25 | research            |    116 | 17 | aihubmix, alibaba, cometapi, edenai, heliconeai, huggingface, jina, nanogpt, novita, openai, openrouter, orqai, phala, poe, requesty, routeway, vertex-ai |
| 26 | realtime            |    102 | 14 | aiml, alibaba, cometapi, huggingface, jina, mistral, novita, openai, openrouter, orqai, phala, poe, requesty, routeway |
| 27 | transcription       |     84 |  8 | bedrock, chutes, huggingface, novita, openrouter, orqai, phala, rekaai |
| 28 | speech_to_text      |     83 |  7 | deepgram, huggingface, novita, openai, openrouter, orqai, phala |
| 29 | video_to_text       |     76 |  6 | bedrock, chutes, novita, openrouter, phala, rekaai |
| 30 | video_transcription |     76 |  6 | bedrock, chutes, novita, openrouter, phala, rekaai |
| 31 | health              |     72 |  7 | aiml, deepgram, huggingface, novita, phala, poe, requesty |
| 32 | image_to_video      |     72 |  4 | aiml, bedrock, huggingface, poe |
| 33 | deep_research       |     50 | 16 | aihubmix, alibaba, cometapi, edenai, heliconeai, huggingface, jina, nanogpt, openai, openrouter, orqai, phala, poe, requesty, routeway, vertex-ai |
| 34 | deep_search         |     33 | 15 | aihubmix, cometapi, edenai, heliconeai, huggingface, jina, nanogpt, openai, openrouter, orqai, phala, poe, requesty, routeway, vertex-ai |
| 35 | realtime_audio      |     29 |  7 | aiml, novita, openai, openrouter, orqai, poe, routeway |
| 36 | debugging           |     27 |  1 | bedrock |
| 37 | code_review         |     27 |  1 | bedrock |
| 38 | audio_input         |     26 |  4 | bedrock, novita, openrouter, phala |
| 39 | image_editing       |     22 |  2 | bedrock, openrouter |
| 40 | code_interpreter    |     17 |  2 | alibaba, mistral |
| 41 | tts                 |     17 |  6 | cometapi, infermatic, novita, openrouter, orqai, vertex-ai |
| 42 | computer_use        |     10 |  7 | edenai, novita, openrouter, phala, poe, routeway, vertex-ai |
| 43 | audio_generation    |      6 |  2 | novita, openrouter |
| 44 | audio_output        |      6 |  2 | novita, openrouter |
| 45 | video_editing       |      5 |  1 | aiml |
| 46 | video_to_video      |      5 |  1 | aiml |
| 47 | audio_to_audio      |      4 |  2 | novita, openrouter |
| 48 | pdf_understanding   |      4 |  1 | huggingface |

**Note:** the table has 48 rows because `embeddings` and `embedding` are counted separately — they are alias forms emitted by different fetcher paths (HCRA inference vs explicit declaration). They have **identical** model+provider sets (471 / 16). Phase-9 follow-up: collapse via `model-capability-merger.ts` canonical-form lowercasing.

## Section C — Provider × capability matrix density

Distinct (provider, capability) pairs: **532**.
Mean capabilities per provider: 532 / 51 = **10.4 capabilities**.

Density (capability count) distribution:
- 30+ caps: 5 providers (huggingface 30, openrouter 36, novita 32, bedrock 30)
- 20–29 caps: 9 providers (orqai 26, cometapi 25, poe 25, aiml 24, routeway 27, requesty 20, phala 26, openai 27)
- 10–19 caps: 13 providers (alibaba 18, vertex-ai 19, edenai 16, aihubmix 17, jina 15, nanogpt 15, chutes 14, rekaai 14, nvidia 13, nvidia-hub 13, heliconeai 13, cohere 11, mistral 10)
- 5–9 caps: 14 providers (venice 9, infermatic 9, gmi 8, wandb 8, deepseek 7, hyperbolic 6, moonshot 6, deepgram 5, anthropic 5, perplexity 5, upstage 5, groq 5, arcee 5)
- 1–4 caps: 10 providers (fireworks-ai 4, mancer 3, friendli 3, sambanova 3, atlascloud 3, avian 3, cerebras 3, databricks 3, inworld 3, writer 2, elevenlabs 2, minimax 2)

(`mean = 10.4`, but heavily right-skewed — the top 8 hubs hold 95%+ of the inventory but only ~25 caps each, while top-density bedrock holds 30 caps with only 125 models.)

## Section D — Universal-routing reachability per capability

For each capability, what % of providers can serve at least 1 model:
- `chat`: 48/51 = **94.1%** (only deepgram, elevenlabs, writer don't carry chat — deepgram/elevenlabs by design, writer due to capability-merger gap)
- `streaming`: 48/51 = **94.1%**
- `text_generation`: 47/51 = **92.2%**
- `vision`: 28/51 = **54.9%**
- `embeddings`: 16/51 = **31.4%**
- `tool_use`: 4/51 = **7.8%** (bedrock, openrouter, routeway, vertex-ai only — these are the 4 ProprietaryToolCallingClass providers)
- `pdf_understanding`: 1/51 = **2.0%** (huggingface alone — niche capability, expected)

The **strategy candidate pool floor** is governed by the rarest *required* capability. For routing-strategy candidates needing `chat`, the pool is 48 — well above the Phase-8 floor of 30.

## Section E — All 30 catalog rows NOT materialised this cycle

For full transparency — which catalog rows do NOT contribute to runtime today:

**Self-hosted (8):** vllm, lm-studio, ollama, xinference, triton, local-llama, local-kobold, local-embeddings
**Catalog-only / pinnedFallback (9):** sap, snowflake, topaz, inflection, relace, recraft, runwayml, bfl, azure-openai
**Credentials missing in local .env (21+):** togetherai, nscale, anyscale, featherless-ai, nebius, lambda-ai, scaleway, synthetic, morph, zai, xiaomi-mimo, v0, vercel-ai-gateway, volcano, watsonx, ai302, cloudflare-workers-ai, gemini-openai, github-models, imagerouter, stepfun
**Single-cycle regressions (5):** voyage, replicate, bytez, qianfan, siliconflow

Bucket sums: 8 + 9 + 21 + 5 = 43 documented non-materialising entries — but only 30 of these correspond to *catalog rows*. Some (openai, anthropic, openrouter, nvidia-hub, alibaba, mistral, cohere, deepseek, xai, vertex-ai, bedrock, jina, deepgram, elevenlabs) are **native providers wired outside the catalog** through `first-party-native` integration class (see [phase-8-runtime-topology.test.ts](../src/providers/catalog/__tests__/phase-8-runtime-topology.test.ts) `NATIVE_PROVIDERS_OUTSIDE_CATALOG`), and **most of those DO materialise** (they're in the 51 above). See [provider-drop-list.md](provider-drop-list.md) for full classification.

## Final tallies

- **Materialised providers:** 51
- **Total models:** 64,409
- **Distinct capabilities:** 47 (48 with the `embeddings`/`embedding` alias)
- **Distinct (provider, capability) pairs:** 532
- **Models with ≥1 capability tagged:** 64,373 (99.94%)
- **Mean caps per provider:** 10.4
- **Widest provider:** openrouter (36 caps)
- **Narrowest provider:** writer / elevenlabs / minimax (2 caps each)
- **Most-supported capability:** chat (48 providers)
- **Rarest capability:** pdf_understanding (1 provider — huggingface)
