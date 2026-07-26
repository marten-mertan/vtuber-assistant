# stt_service.py — распознавание речи (Whisper), push-to-talk (start/stop).
#
# Запись с микрофона и распознавание живут здесь же — вызывающая сторона
# (main.js в overlay) просто дёргает start/stop по сигналу пользователя.

import gc
import os
import threading
import time

import numpy as np
import sounddevice as sd
import torch
import whisper
from flask import Blueprint, jsonify

MODEL_SIZE = os.environ.get("STT_MODEL_SIZE", "small")
DEVICE = os.environ.get("STT_DEVICE", "cuda")
SAMPLE_RATE = 16000  # whisper ожидает 16кГц моно

# Пусто/не задано = greedy decoding (быстро). Число (напр. 5) = beam search
# (точнее, но медленнее — в основном имеет смысл на GPU).
_beam_size_env = os.environ.get("STT_BEAM_SIZE", "").strip()
BEAM_SIZE = int(_beam_size_env) if _beam_size_env else None

print(f"Загружаю Whisper ({MODEL_SIZE}, {DEVICE})...")
_model = whisper.load_model(MODEL_SIZE, device=DEVICE)
print("Whisper загружен.")

_lock = threading.Lock()
_stream = None
_frames = []


def _callback(indata, frames, time_info, status):
    if status:
        print(f"Предупреждение записи: {status}")
    _frames.append(indata.copy())


bp = Blueprint("stt", __name__)


@bp.route("/stt/start", methods=["POST"])
def start_route():
    global _stream, _frames
    with _lock:
        if _stream is not None:
            return jsonify({"error": "уже идёт запись"}), 409
        _frames = []
        try:
            _stream = sd.InputStream(
                samplerate=SAMPLE_RATE, channels=1, dtype="float32", callback=_callback
            )
            _stream.start()
        except Exception as e:
            _stream = None
            return jsonify({"error": f"не удалось открыть микрофон: {e}"}), 500
    return jsonify({"status": "recording"})


@bp.route("/stt/stop", methods=["POST"])
def stop_route():
    global _stream
    with _lock:
        if _stream is None:
            return jsonify({"error": "запись не была начата"}), 409
        _stream.stop()
        _stream.close()
        _stream = None
        frames = _frames

    if not frames:
        return jsonify({"text": "", "warning": "пустая запись"})

    audio = np.concatenate(frames, axis=0).flatten().astype(np.float32)
    duration = len(audio) / SAMPLE_RATE

    if duration < 0.3:
        return jsonify({"text": "", "warning": "слишком короткая запись", "duration": duration})

    t0 = time.time()
    result = _model.transcribe(
        audio,
        language="ru",
        fp16=(DEVICE == "cuda"),
        beam_size=BEAM_SIZE,
        # temperature=0.0 отключает temperature fallback — без этого Whisper
        # при "неуверенности" (сленг, нечёткая речь) молча повторяет
        # декодирование несколько раз с разной температурой, из-за чего
        # время сильно скачет. Для push-to-talk предсказуемая скорость
        # важнее устойчивости к сложным случаям.
        temperature=0.0,
    )
    process_time = time.time() - t0
    text = result["text"].strip()

    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    gc.collect()

    return jsonify({"text": text, "duration": duration, "process_time": process_time})


def status():
    with _lock:
        recording = _stream is not None
    return {"model": MODEL_SIZE, "device": DEVICE, "recording": recording}
