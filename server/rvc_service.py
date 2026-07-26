# rvc_service.py — перекраска тембра голоса (RVC), поверх результата TTS.
# Опционален: если RVC_MODEL_PATH не задан в .env, /rvc/convert отвечает
# понятной ошибкой вместо падения при импорте.
#
# ВАЖНО: patches.apply() (см. patches.py) должен быть вызван ДО импорта
# этого модуля — здесь ниже идёт импорт rvc_python, который тянет за
# собой загрузку HuBERT-чекпоинта через torch.load.

import gc
import io
import os
import tempfile
import traceback
from pathlib import Path

import torch
from flask import Blueprint, request, send_file, jsonify
from rvc_python.infer import RVCInference

MODEL_PATH = os.environ.get("RVC_MODEL_PATH")
INDEX_PATH = os.environ.get("RVC_INDEX_PATH")
DEVICE = os.environ.get("RVC_DEVICE", "cuda:0")
ENABLED = bool(MODEL_PATH)

_rvc = None

if ENABLED:
    if not Path(MODEL_PATH).exists():
        raise RuntimeError(f"Файл RVC-модели не найден: {MODEL_PATH}")

    print(f"Загружаю RVC-модель {MODEL_PATH} на {DEVICE}...")
    _rvc = RVCInference(device=DEVICE)

    _index_arg = ""
    if INDEX_PATH:
        if not Path(INDEX_PATH).exists():
            print(f"ПРЕДУПРЕЖДЕНИЕ: index-файл не найден: {INDEX_PATH}, продолжаю без него")
        else:
            _index_arg = INDEX_PATH

    _version = os.environ.get("RVC_VERSION", "v2")
    _rvc.load_model(MODEL_PATH, index_path=_index_arg, version=_version)

    # protect: библиотечный дефолт (0.33), если явно не переопределено —
    # раньше тут стоял хак protect=0.5 как "обход бага", но настоящей
    # причиной той ошибки была проблема с загрузкой HuBERT (см. patches.py),
    # а не эта ветка, так что дефолт можно оставить как есть.
    if "RVC_PROTECT" in os.environ:
        _rvc.protect = float(os.environ["RVC_PROTECT"])
    _rvc.f0up_key = int(os.environ.get("RVC_PITCH", 0))
    _rvc.f0method = os.environ.get("RVC_F0_METHOD", "rmvpe")
    _rvc.index_rate = float(os.environ.get("RVC_INDEX_RATE", 0.75))

    print(
        f"RVC-модель загружена. version={_version}, pitch={_rvc.f0up_key}, "
        f"f0method={_rvc.f0method}, protect={_rvc.protect}, index_rate={_rvc.index_rate}"
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

    # Временное переопределение параметров для ЭТОГО запроса — удобно для
    # сравнения разных питчей/настроек без перезапуска сервера.
    original = (_rvc.f0up_key, _rvc.f0method, _rvc.index_rate, _rvc.protect)
    try:
        if "pitch" in request.args:
            _rvc.f0up_key = int(request.args["pitch"])
        if "f0method" in request.args:
            _rvc.f0method = request.args["f0method"]
        if "index_rate" in request.args:
            _rvc.index_rate = float(request.args["index_rate"])
        if "protect" in request.args:
            _rvc.protect = float(request.args["protect"])

        with tempfile.TemporaryDirectory() as tmp:
            in_path = Path(tmp) / "in.wav"
            out_path = Path(tmp) / "out.wav"
            in_path.write_bytes(request.data)

            try:
                _rvc.infer_file(str(in_path), str(out_path))
            except Exception as e:
                print("=== Ошибка при RVC-конверсии ===")
                traceback.print_exc()
                print("================================")
                return jsonify({"error": str(e)}), 500

            if not out_path.exists():
                return jsonify({"error": "RVC не создал выходной файл"}), 500

            # Читаем в память ДО выхода из блока with — на Windows временную
            # папку нельзя удалить, пока файл в ней ещё открыт.
            audio_bytes = out_path.read_bytes()
    finally:
        _rvc.f0up_key, _rvc.f0method, _rvc.index_rate, _rvc.protect = original
        # PyTorch держит кэш выделенной памяти про запас — на системах с
        # небольшим запасом ОЗУ/VRAM это накапливается по мере запросов.
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
        gc.collect()

    return send_file(io.BytesIO(audio_bytes), mimetype="audio/wav")


def status():
    return {"enabled": ENABLED, "model": MODEL_PATH if ENABLED else None}
