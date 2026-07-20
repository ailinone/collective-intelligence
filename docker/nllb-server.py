# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""NLLB-200 Translation Server — PyTorch CPU with greedy decoding."""
import os, time, torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="NLLB-200 Translation Server")
MODEL_ID = os.environ.get("NLLB_MODEL", "facebook/nllb-200-distilled-600M")
tokenizer_obj = None
model_obj = None

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
}

def load_model():
    global tokenizer_obj, model_obj
    if model_obj is not None:
        return
    from transformers import AutoModelForSeq2SeqLM, AutoTokenizer
    print(f"Loading {MODEL_ID}...")
    tokenizer_obj = AutoTokenizer.from_pretrained(MODEL_ID)
    model_obj = AutoModelForSeq2SeqLM.from_pretrained(MODEL_ID, torch_dtype=torch.float32)
    model_obj.eval()
    num_threads = int(os.environ.get("NLLB_THREADS", "4"))
    torch.set_num_threads(num_threads)
    torch.set_num_interop_threads(2)
    print(f"NLLB model loaded: {MODEL_ID} (threads={num_threads})")

def resolve_lang(code):
    code = code.lower().strip()
    if code in LANG_MAP: return LANG_MAP[code]
    if "_" in code and len(code) >= 7: return code
    raise ValueError(f"Unsupported language: {code}")

def translate(text, source_lang, target_lang):
    load_model()
    src_code = resolve_lang(source_lang)
    tgt_code = resolve_lang(target_lang)
    tokenizer_obj.src_lang = src_code
    inputs = tokenizer_obj(text, return_tensors="pt", max_length=256, truncation=True)
    with torch.no_grad():
        generated = model_obj.generate(
            **inputs,
            forced_bos_token_id=tokenizer_obj.convert_tokens_to_ids(tgt_code),
            max_new_tokens=256,
            num_beams=1,
            do_sample=False,
        )
    return tokenizer_obj.decode(generated[0], skip_special_tokens=True)

@app.get("/health")
async def health():
    return {"status": "healthy", "model": MODEL_ID}

@app.get("/v1/models")
async def list_models():
    return {"object": "list", "data": [{"id": "nllb-200-distilled-600M", "object": "model", "created": int(time.time()), "owned_by": "meta", "capabilities": ["translation"]}]}

@app.post("/v1/translations")
async def translate_text(request: Request):
    body = await request.json()
    text, src, tgt = body.get("text", ""), body.get("source_lang", "en"), body.get("target_lang", "pt")
    if not text.strip(): return JSONResponse({"error": "Empty text"}, status_code=400)
    start = time.perf_counter()
    try: translated = translate(text, src, tgt)
    except ValueError as e: return JSONResponse({"error": str(e)}, status_code=400)
    except Exception as e: return JSONResponse({"error": f"Translation failed: {e}"}, status_code=500)
    latency_ms = round((time.perf_counter() - start) * 1000, 1)
    return {"translated_text": translated, "source_lang": src, "target_lang": tgt, "model": "nllb-200-distilled-600M", "latency_ms": latency_ms}

@app.post("/v1/translations/batch")
async def translate_batch(request: Request):
    body = await request.json()
    texts, src, tgt = body.get("texts", []), body.get("source_lang", "en"), body.get("target_lang", "pt")
    if not texts: return JSONResponse({"error": "Empty texts"}, status_code=400)
    start = time.perf_counter()
    results = [{"text": t, "translated_text": translate(t, src, tgt)} for t in texts]
    return {"results": results, "latency_ms": round((time.perf_counter() - start) * 1000, 1)}

@app.get("/v1/translations/languages")
async def list_languages():
    return {"languages": [{"code": iso, "flores_code": flores, "name": LANG_NAMES.get(iso, iso)} for iso, flores in LANG_MAP.items()], "total": len(LANG_MAP)}

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", "8087"))
    print(f"Starting NLLB-200 Translation Server on port {port}")
    load_model()
    uvicorn.run(app, host="0.0.0.0", port=port)
