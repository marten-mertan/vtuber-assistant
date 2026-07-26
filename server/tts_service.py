# tts_service.py — синтез речи (Silero TTS, русский).
#
# Silero — лёгкая CPU-модель, GPU ей не нужен (в отличие от RVC/Whisper
# в этом же процессе).

import io
import os
import re
import time
from pathlib import Path

import soundfile as sf
import torch
from flask import Blueprint, request, send_file, jsonify

MODEL_DIR = Path(__file__).resolve().parent.parent / "models" / "tts"
MODEL_DIR.mkdir(parents=True, exist_ok=True)
MODEL_PATH = MODEL_DIR / "v4_ru.pt"
MODEL_URL = "https://models.silero.ai/models/tts/ru/v4_ru.pt"

SAMPLE_RATE = 48000
DEFAULT_SPEAKER = os.environ.get("TTS_SPEAKER", "kseniya")
# Доступные голоса v4_ru: aidar, baya, kseniya, xenia, eugene, random

_device = torch.device("cpu")


# --- Грубая транслитерация английских слов в кириллицу -------------------
# Silero v4_ru не умеет читать латиницу. Это не фонетически точное
# произношение, а приближение "по буквам", но лучше, чем полное молчание
# или случайный набор звуков на английских словах.

_DIGRAPHS = [
    ("sh", "ш"), ("ch", "ч"), ("ck", "к"), ("ph", "ф"), ("th", "з"),
    ("wh", "в"), ("qu", "кв"), ("oo", "у"), ("ee", "и"), ("ea", "и"),
    ("oi", "ой"), ("oy", "ой"), ("ou", "ау"), ("ow", "ау"), ("ay", "эй"),
    ("ai", "эй"), ("ey", "эй"), ("ng", "нг"),
]
_LETTERS = {
    "a": "а", "b": "б", "c": "к", "d": "д", "e": "е", "f": "ф", "g": "г",
    "h": "х", "i": "и", "j": "дж", "k": "к", "l": "л", "m": "м", "n": "н",
    "o": "о", "p": "п", "q": "к", "r": "р", "s": "с", "t": "т", "u": "а",
    "v": "в", "w": "в", "x": "кс", "y": "и", "z": "з",
}
# Точечные исключения — частые слова, где алгоритмическая транслитерация
# даёт неверный или неудачный по звучанию результат.
_OVERRIDES = {
    "python": "пайтон", "javascript": "джаваскрипт", "typescript": "тайпскрипт",
    "java": "джава", "node": "ноуд", "react": "риэкт", "api": "апи",
    "sql": "эскьюэль", "html": "эйчтиэмэль", "css": "сиэсэс",
    "github": "гитхаб", "git": "гит", "windows": "виндовс", "linux": "линукс",
    "ok": "окей", "okay": "окей", "hello": "хэллоу", "electron": "электрон",
}


def _transliterate_word(word: str) -> str:
    override = _OVERRIDES.get(word.lower())
    if override:
        return override.capitalize() if word[:1].isupper() else override

    lower = word.lower()
    for latin, cyr in _DIGRAPHS:
        lower = lower.replace(latin, cyr)
    result = "".join(_LETTERS.get(ch, ch) for ch in lower)
    if word[:1].isupper() and result:
        result = result[0].upper() + result[1:]
    return result


_LATIN_WORD_RE = re.compile(r"[A-Za-z]+")


def transliterate_english(text: str) -> str:
    return _LATIN_WORD_RE.sub(lambda m: _transliterate_word(m.group(0)), text)


def _ensure_model():
    if not MODEL_PATH.exists():
        print(f"Скачиваю модель Silero TTS в {MODEL_PATH} (один раз)...")
        torch.hub.download_url_to_file(MODEL_URL, str(MODEL_PATH))


def _load_model():
    _ensure_model()
    m = torch.package.PackageImporter(str(MODEL_PATH)).load_pickle("tts_models", "model")
    m.to(_device)
    return m


print("Загружаю Silero TTS...")
_model = _load_model()
print(f"Silero TTS загружен. Голос по умолчанию: {DEFAULT_SPEAKER}")

bp = Blueprint("tts", __name__)


@bp.route("/tts", methods=["POST"])
def tts_route():
    data = request.get_json(force=True) or {}
    text = data.get("text", "").strip()
    speaker = data.get("speaker", DEFAULT_SPEAKER)

    if not text:
        return jsonify({"error": "empty text"}), 400

    text = transliterate_english(text)

    t0 = time.time()
    try:
        audio = _model.apply_tts(
            text=text,
            speaker=speaker,
            sample_rate=SAMPLE_RATE,
            put_accent=True,
            put_yo=True,
        )
    except Exception as e:
        return jsonify({"error": str(e)}), 500
    dt = time.time() - t0

    buf = io.BytesIO()
    sf.write(buf, audio.numpy(), SAMPLE_RATE, format="WAV")
    buf.seek(0)

    resp = send_file(buf, mimetype="audio/wav")
    resp.headers["X-Gen-Time"] = f"{dt:.2f}"
    resp.headers["X-Speaker-Used"] = speaker
    return resp


def status():
    return {"speaker": DEFAULT_SPEAKER, "sample_rate": SAMPLE_RATE}
