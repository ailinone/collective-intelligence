# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""
NLLB-200 Translation Server — CTranslate2 int8, greedy decoding.

3.5-7x faster than PyTorch on CPU. Target: <200ms per sentence.

Key differences from PyTorch version:
- Uses ctranslate2.Translator (NOT torch model.generate())
- Uses NllbTokenizer (NOT NllbTokenizerFast) — Fast version has prefix bug
- Sets tokenizer.src_lang BEFORE encoding
- Passes target_prefix to translate_batch() (NOT forced_bos_token_id)
- beam_size=1 for minimum latency
"""
import os
import time
import ctranslate2
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="NLLB-200 Translation Server (CTranslate2)")

# Model path: pre-converted int8 from HuggingFace or local mount
MODEL_DIR = os.environ.get("CT2_MODEL_DIR", "/models/nllb-200-distilled-600M-ct2-int8")
THREADS_INTER = int(os.environ.get("CT2_INTER_THREADS", "4"))
THREADS_INTRA = int(os.environ.get("CT2_INTRA_THREADS", "4"))

translator_obj = None
tokenizer_obj = None

LANG_MAP = {
    "en": "eng_Latn", "pt": "por_Latn", "es": "spa_Latn", "fr": "fra_Latn",
    "de": "deu_Latn", "it": "ita_Latn", "nl": "nld_Latn", "ru": "rus_Cyrl",
    "zh": "zho_Hans", "ja": "jpn_Jpan", "ko": "kor_Hang", "ar": "arb_Arab",
    "hi": "hin_Deva", "tr": "tur_Latn", "pl": "pol_Latn", "uk": "ukr_Cyrl",
    "vi": "vie_Latn", "th": "tha_Thai", "id": "ind_Latn", "ms": "zsm_Latn",
    "sv": "swe_Latn", "da": "dan_Latn", "no": "nob_Latn", "fi": "fin_Latn",
    "el": "ell_Grek", "he": "heb_Hebr", "cs": "ces_Latn", "ro": "ron_Latn",
    "hu": "hun_Latn", "bg": "bul_Cyrl", "hr": "hrv_Latn", "sk": "slk_Latn",
}
LANG_NAMES = {
    "en": "English", "pt": "Portuguese", "es": "Spanish", "fr": "French",
    "de": "German", "it": "Italian", "nl": "Dutch", "ru": "Russian",
    "zh": "Chinese", "ja": "Japanese", "ko": "Korean", "ar": "Arabic",
    "hi": "Hindi", "tr": "Turkish", "pl": "Polish", "uk": "Ukrainian",
    "vi": "Vietnamese", "th": "Thai", "id": "Indonesian", "ms": "Malay",
    "sv": "Swedish", "da": "Danish", "no": "Norwegian", "fi": "Finnish",
    "el": "Greek", "he": "Hebrew", "cs": "Czech", "ro": "Romanian",
    "hu": "Hungarian", "bg": "Bulgarian", "hr": "Croatian", "sk": "Slovak",
}


def load_model():
    """Load CTranslate2 translator and HuggingFace tokenizer."""
    global translator_obj, tokenizer_obj
    if translator_obj is not None:
        return

    print(f"Loading CTranslate2 model from {MODEL_DIR}...")
    print(f"  inter_threads={THREADS_INTER}, intra_threads={THREADS_INTRA}")

    translator_obj = ctranslate2.Translator(
        MODEL_DIR,
        device="cpu",
        inter_threads=THREADS_INTER,
        intra_threads=THREADS_INTRA,
        compute_type="int8",
    )

    # CRITICAL: Use NllbTokenizer (slow), NOT NllbTokenizerFast
    # The fast tokenizer has a prefix ordering bug that causes repetitive output.
    # See: https://github.com/huggingface/transformers/issues/19943
    from transformers import NllbTokenizer

    # Load tokenizer from the same CT2 model dir (it includes sentencepiece + tokenizer config)
    # Falls back to HuggingFace download if files are missing
    tokenizer_dir = os.environ.get("CT2_TOKENIZER_DIR", MODEL_DIR)
    print(f"Loading tokenizer from: {tokenizer_dir}")

    tokenizer_obj = NllbTokenizer.from_pretrained(
        tokenizer_dir,
        # Force slow tokenizer even if fast is available
        use_fast=False,
    )
    print(f"NLLB CTranslate2 model loaded: int8, beam_size=1")


def resolve_lang(code: str) -> str:
    """Resolve ISO 639-1 code to NLLB Flores-200 code."""
    code = code.lower().strip()
    if code in LANG_MAP:
        return LANG_MAP[code]
    # Accept full Flores codes directly (e.g., "eng_Latn")
    if "_" in code and len(code) >= 7:
        return code
    raise ValueError(f"Unsupported language: {code}")


def translate(text: str, source_lang: str, target_lang: str) -> str:
    """Translate text using CTranslate2 with correct tokenizer configuration."""
    load_model()

    src_code = resolve_lang(source_lang)
    tgt_code = resolve_lang(target_lang)

    # CRITICAL: Set src_lang BEFORE tokenizing
    # This ensures the source language token is prepended correctly.
    tokenizer_obj.src_lang = src_code

    # Tokenize the source text
    source_tokens = tokenizer_obj(
        text,
        return_tensors=None,
        max_length=256,
        truncation=True,
    )
    # Convert token IDs to token strings for CTranslate2
    source = tokenizer_obj.convert_ids_to_tokens(source_tokens["input_ids"])

    # CRITICAL: Use target_prefix, NOT forced_bos_token_id
    # CTranslate2 uses target_prefix to set the target language.
    # Using forced_bos_token_id causes the "Hello Hello Hello" repetition bug.
    results = translator_obj.translate_batch(
        [source],
        target_prefix=[[tgt_code]],
        beam_size=1,            # Greedy decoding for minimum latency
        max_decoding_length=256,
        replace_unknowns=True,
    )

    # Decode the output tokens back to text
    target_tokens = results[0].hypotheses[0]
    translated = tokenizer_obj.decode(
        tokenizer_obj.convert_tokens_to_ids(target_tokens),
        skip_special_tokens=True,
    )
    return translated


def translate_batch_texts(texts: list, source_lang: str, target_lang: str) -> list:
    """Batch translate multiple texts efficiently."""
    load_model()

    src_code = resolve_lang(source_lang)
    tgt_code = resolve_lang(target_lang)

    tokenizer_obj.src_lang = src_code

    # Tokenize all texts
    all_sources = []
    for text in texts:
        tokens = tokenizer_obj(text, return_tensors=None, max_length=256, truncation=True)
        source = tokenizer_obj.convert_ids_to_tokens(tokens["input_ids"])
        all_sources.append(source)

    # Batch translate
    results = translator_obj.translate_batch(
        all_sources,
        target_prefix=[[tgt_code]] * len(texts),
        beam_size=1,
        max_decoding_length=256,
        replace_unknowns=True,
    )

    # Decode all results
    translated = []
    for r in results:
        target_tokens = r.hypotheses[0]
        text = tokenizer_obj.decode(
            tokenizer_obj.convert_tokens_to_ids(target_tokens),
            skip_special_tokens=True,
        )
        translated.append(text)
    return translated


# ── FastAPI Endpoints ──────────────────────────────────


@app.get("/health")
async def health():
    return {"status": "healthy", "model": "nllb-200-distilled-600M", "engine": "ctranslate2-int8"}


@app.get("/v1/models")
async def list_models():
    return {
        "object": "list",
        "data": [{
            "id": "nllb-200-distilled-600M",
            "object": "model",
            "created": int(time.time()),
            "owned_by": "meta",
            "capabilities": ["translation"],
            "engine": "ctranslate2-int8",
        }],
    }


@app.post("/v1/translations")
async def translate_text(request: Request):
    body = await request.json()
    text = body.get("text", "")
    src = body.get("source_lang", "en")
    tgt = body.get("target_lang", "pt")

    if not text.strip():
        return JSONResponse({"error": "Empty text"}, status_code=400)

    start = time.perf_counter()
    try:
        translated = translate(text, src, tgt)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": f"Translation failed: {e}"}, status_code=500)

    latency_ms = round((time.perf_counter() - start) * 1000, 1)
    return {
        "translated_text": translated,
        "source_lang": src,
        "target_lang": tgt,
        "model": "nllb-200-distilled-600M",
        "engine": "ctranslate2-int8",
        "latency_ms": latency_ms,
    }


@app.post("/v1/translations/batch")
async def translate_batch(request: Request):
    body = await request.json()
    texts = body.get("texts", [])
    src = body.get("source_lang", "en")
    tgt = body.get("target_lang", "pt")

    if not texts:
        return JSONResponse({"error": "Empty texts"}, status_code=400)

    start = time.perf_counter()
    try:
        translated = translate_batch_texts(texts, src, tgt)
    except Exception as e:
        return JSONResponse({"error": f"Batch translation failed: {e}"}, status_code=500)

    results = [{"text": t, "translated_text": tr} for t, tr in zip(texts, translated)]
    return {
        "results": results,
        "latency_ms": round((time.perf_counter() - start) * 1000, 1),
    }


@app.get("/v1/translations/languages")
async def list_languages():
    return {
        "languages": [
            {"code": iso, "flores_code": flores, "name": LANG_NAMES.get(iso, iso)}
            for iso, flores in LANG_MAP.items()
        ],
        "total": len(LANG_MAP),
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8087"))
    print(f"Starting NLLB-200 CTranslate2 Translation Server on port {port}")
    load_model()
    # Warm-up: run a short translation to prime caches
    try:
        warmup_start = time.perf_counter()
        result = translate("Hello", "en", "pt")
        warmup_ms = round((time.perf_counter() - warmup_start) * 1000, 1)
        print(f"Warm-up translation: 'Hello' -> '{result}' ({warmup_ms}ms)")
    except Exception as e:
        print(f"Warm-up failed: {e}")
    uvicorn.run(app, host="0.0.0.0", port=port)
