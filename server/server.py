# server.py — единая точка входа: TTS (Silero) + RVC + STT (Whisper)
# в одном процессе / одном torch-CUDA-контексте.
#
# Раньше это были три отдельных процесса (python-services/tts, /rvc, /stt) —
# каждый со своим импортом torch и CUDA-контекстом (лишние сотни МБ – 1 ГБ
# ОЗУ на каждый). Сервисы при этом всё равно работают строго
# последовательно (TTS -> RVC, диалог ведёт один пользователь), так что
# отдельные процессы были не нужны. Здесь та же логика, один процесс.
#
# Сама логика TTS/RVC/STT не менялась при переносе — просто вынесена в
# отдельные модули (tts_service.py, rvc_service.py, stt_service.py).
#
# Роуты:
#   GET  /health         — статус всех трёх подсистем
#   POST /tts             — синтез речи (Silero)
#   POST /rvc/convert      — перекраска тембра (RVC), если настроен
#   POST /stt/start        — начать запись с микрофона
#   POST /stt/stop         — остановить запись, распознать текст

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

import patches  # noqa: E402

patches.apply()  # ОБЯЗАТЕЛЬНО до импорта rvc_service (тянет rvc_python)

from flask import Flask, jsonify  # noqa: E402

import tts_service  # noqa: E402
import rvc_service  # noqa: E402
import stt_service  # noqa: E402

app = Flask(__name__)
app.register_blueprint(tts_service.bp)
app.register_blueprint(rvc_service.bp)
app.register_blueprint(stt_service.bp)


@app.route("/health", methods=["GET"])
def health_route():
    return jsonify(
        {
            "status": "ok",
            "tts": tts_service.status(),
            "rvc": rvc_service.status(),
            "stt": stt_service.status(),
        }
    )


if __name__ == "__main__":
    port = int(os.environ.get("VOICE_PORT", 5100))
    print(f"Voice-сервер (TTS+RVC+STT) запущен на http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, threaded=False)
