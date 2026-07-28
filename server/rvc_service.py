# rvc_service.py — перекраска тембра голоса (RVC), поверх результата TTS.
# Опционален: если RVC_MODEL_PATH не задан в .env, /rvc/convert отвечает
# понятной ошибкой вместо падения при импорте.
#
# Работает через infer_rvc_python (BaseLoader) вместо rvc-python — эта
# библиотека поддерживает аудио на вход/выход НАПРЯМУЮ массивами
# (array, sample_rate), без временных файлов. Раньше пробовали обойти
# это в rvc-python через передачу кортежа вместо пути — не сработало
# (в той версии этот путь оказался мёртвым кодом). Здесь это официально
# документированная возможность, а не самодельный обход.
#
# ВАЖНО: patches.apply() (см. patches.py) должен быть вызван ДО импорта
# этого модуля — ниже идёт загрузка HuBERT-чекпоинта через torch.load.
#
# Системные требования именно этой библиотеки (см. README):
#   - ffmpeg должен быть установлен в системе (не просто pip-пакет)
#   - Windows: Microsoft Visual C++ Build Tools + Windows 10/11 SDK

import gc
import io
import os
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from flask import Blueprint, request, send_file, jsonify
from infer_rvc_python import BaseLoader

MODEL_PATH = os.environ.get("RVC_MODEL_PATH")
INDEX_PATH = os.environ.get("RVC_INDEX_PATH")
DEVICE = os.environ.get("RVC_DEVICE", "cuda:0")
ENABLED = bool(MODEL_PATH)

# У infer_rvc_python вместо "модель загружена/не загружена" используется
# именованный "tag" — конфиг под этим тегом переиспользуется между вызовами
# (это и даёт preload-эффект, ради которого всё затевалось).
_TAG = "voice"

_converter = None


def _pitch_lvl():
    return int(os.environ.get("RVC_PITCH", 0))


def _pitch_algo():
    # rmvpe — тот же метод, что был дефолтным в rvc-python. У infer_rvc_python
    # есть варианты вида "rmvpe+" — если захочешь попробовать, смотри их
    # документацию на GitHub на предмет полного списка поддерживаемых имён.
    return os.environ.get("RVC_F0_METHOD", "rmvpe")


def _index_influence():
    return float(os.environ.get("RVC_INDEX_RATE", 0.75))


def _protect():
    return float(os.environ.get("RVC_PROTECT", 0.33))


if ENABLED:
    if not Path(MODEL_PATH).exists():
        raise RuntimeError(f"Файл RVC-модели не найден: {MODEL_PATH}")

    index_arg = ""
    if INDEX_PATH:
        if not Path(INDEX_PATH).exists():
            print(f"ПРЕДУПРЕЖДЕНИЕ: index-файл не найден: {INDEX_PATH}, продолжаю без него")
        else:
            index_arg = INDEX_PATH

    print(f"Загружаю RVC-модель {MODEL_PATH} (only_cpu={DEVICE == 'cpu'})...")
    _converter = BaseLoader(only_cpu=(DEVICE == "cpu"), hubert_path=None, rmvpe_path=None)
    _converter.apply_conf(
        tag=_TAG,
        file_model=MODEL_PATH,
        pitch_algo=_pitch_algo(),
        pitch_lvl=_pitch_lvl(),
        file_index=index_arg,
        index_influence=_index_influence(),
        respiration_median_filtering=3,
        envelope_ratio=0.25,
        consonant_breath_protection=_protect(),
    )
    print(
        f"RVC-модель загружена. pitch={_pitch_lvl()}, algo={_pitch_algo()}, "
        f"index_influence={_index_influence()}, protect={_protect()}"
    )
else:
    print("RVC_MODEL_PATH не задан — RVC отключен, /rvc/convert будет отвечать ошибкой.")

bp = Blueprint("rvc", __name__)


@bp.route("/rvc/convert", methods=["POST"])
def convert_route():
    if not ENABLED:
        return jsonify({"error": "RVC не настроен (нет RVC_MODEL_PATH в .env)"}), 503

    if not request.data:
        return jsonify({"error": "empty body, expected raw WAV bytes"}), 400

    # Переопределение параметров для ЭТОГО запроса (питч и т.д.) требует
    # повторного apply_conf с тем же tag — в отличие от rvc-python, тут
    # нет прямых атрибутов на объекте для точечной правки "на лету".
    if any(k in request.args for k in ("pitch", "f0method", "index_rate", "protect")):
        _converter.apply_conf(
            tag=_TAG,
            file_model=MODEL_PATH,
            pitch_algo=request.args.get("f0method", _pitch_algo()),
            pitch_lvl=int(request.args.get("pitch", _pitch_lvl())),
            file_index=INDEX_PATH or "",
            index_influence=float(request.args.get("index_rate", _index_influence())),
            respiration_median_filtering=3,
            envelope_ratio=0.25,
            consonant_breath_protection=float(request.args.get("protect", _protect())),
        )

    try:
        # Декодируем входной WAV прямо в массив (int16, как ожидает
        # библиотека) — без записи на диск.
        audio_in, sr_in = sf.read(io.BytesIO(request.data), dtype="int16")
        if audio_in.ndim > 1:
            audio_in = audio_in.mean(axis=1).astype(np.int16)

        result_array, sample_rate = _converter.generate_from_cache(
            audio_data=(audio_in, sr_in),
            tag=_TAG,
        )
    except Exception as e:
        import traceback

        print("=== Ошибка при RVC-конверсии ===")
        traceback.print_exc()
        print("================================")
        return jsonify({"error": str(e)}), 500
    finally:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        gc.collect()

    out_buf = io.BytesIO()
    sf.write(out_buf, result_array, sample_rate, format="WAV")
    out_buf.seek(0)

    return send_file(out_buf, mimetype="audio/wav")


def status():
    return {"enabled": ENABLED, "model": MODEL_PATH if ENABLED else None}