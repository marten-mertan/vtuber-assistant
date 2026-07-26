# VTuber Assistant

Локальный AI-ассистент в виде вьюбера на рабочем столе — аналог Neuro-sama,
полностью на локальных моделях, бесплатно, с поддержкой русского языка.

Live2D-аватар поверх всех окон реагирует эмоциями на диалог, слушает голосом
(push-to-talk), отвечает через локальную LLM и озвучивает ответ — опционально
кастомным голосом через RVC.

> **Статус:** рабочий прототип. Основной пайплайн (голос → LLM → голос →
> визуал) полностью функционален. Шеринг файлов/экрана с LLM — пока не
> реализовано.

## Возможности

- **Голосовой ввод** — push-to-talk (`Ctrl+Alt+Space`), распознавание речи локально (Whisper)
- **Локальная LLM** — любой OpenAI-совместимый бэкенд (по умолчанию KoboldCPP), с гарантированным структурированным ответом (текст + эмоция) через grammar-constrained генерацию
- **Озвучка на русском** — Silero TTS, с фиксами ударений и транслитерацией английских слов
- **Кастомный голос** — опциональная перекраска тембра через RVC (собственная модель или готовая из открытых источников)
- **Прозрачный оверлей** — Live2D-модель поверх всех окон, always-on-top, click-through, взгляд следует за курсором по всему экрану
- **Эмоции** — выражения модели переключаются по эмоции из ответа LLM, маппинг настраивается конфигом под любую модель, без правки кода
- **Lip-sync** — движение рта в реальном времени по громкости озвучки
- **Сборка в exe** — весь клиент упаковывается в один `.exe` (electron-builder)

## Архитектура

`client/` — Electron-приложение: окно-оверлей с моделью (renderer) +
оркестрация голосового пайплайна STT→LLM→TTS→RVC (main process).

`server/` — единый Python/Flask-процесс с TTS, RVC и STT.

LLM-бэкенд (KoboldCPP или архитектурно схожий) запускается **отдельно**

## Требования

- **Windows** (проект разрабатывался и тестировался на Windows; часть фиксов в коде — Windows-специфичные)
- **NVIDIA GPU с CUDA** — настоятельно рекомендуется (STT и RVC на CPU заметно медленнее). Для GPU 50-серии (Blackwell) нужен PyTorch со сборкой под CUDA 12.8+
- **16+ ГБ ОЗУ** — при 8-16 ГБ возможна нехватка памяти при одновременной работе LLM + STT (см. [Известные проблемы](#известные-проблемы))
- **Node.js** 18+ и npm
- **Python** 3.10+
- **KoboldCPP** (или другой OpenAI-совместимый LLM-сервер) + GGUF-модель — устанавливается и запускается отдельно
- **Live2D Cubism SDK for Web** (Core-файл) — скачивается отдельно, не входит в репозиторий по лицензии
- **Live2D-модель** (формат Cubism 3/4: `.model3.json` + `.moc3` + текстуры)

## Установка

### 1. LLM-бэкенд

Поставь [KoboldCPP](https://github.com/LostRuins/koboldcpp), скачай любую
GGUF-модель, убедись что сервер поднимается и отвечает на
`http://localhost:5001` (или другой порт по твоему выбору).

Внешний url также поддерживается, настраивается в env

### 2. Голосовой сервис (`server/`)

```powershell
cd server
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
pip install -r requirements-gpu.txt --force-reinstall
```

Порядок важен: `requirements-gpu.txt` (torch+torchaudio под CUDA 12.8)
ставится **последним**, с `--force-reinstall` — гарантирует совместимую
пару вместо той, что мог подтянуть `rvc-python` как побочную зависимость.

### 3. Клиент (`client/`)

```powershell
cd client
npm install
```

### 4. Cubism Core

Файл `live2dcubismcore.min.js` не включён в репозиторий из-за условий лицензии Live2D.

1. [Скачай Cubism Core for Web](https://www.live2d.com/en/sdk/download/web/) (нужна регистрация, бесплатно)
1.1 Тестировалось на live2d моделях версии v3. Для них рабочий пакет: Cubism 5.2 (Legacy URL)
2. Положи в `live2d-core/live2dcubismcore.min.js` (в корне репозитория)

### 5. Live2D-модель

Распакуй модель в `models/live2d/<имя_модели>/` (рендерер сам найдёт
`*.model3.json` рекурсивно). Создай там же `emotions.json` — карта
"эмоция → выражение модели" (см. `models/live2d/emotions.example.json`
как образец формата).

### 6. Конфиг

```powershell
copy .env.example .env
```

Заполни под себя — адреса сервисов, голос TTS, путь к RVC-модели (если
используешь), размер модели Whisper и т.д. Все переменные с комментариями
прямо в `.env.example`.

## Запуск

1. Запусти KoboldCPP (или свой LLM-бэкенд) отдельно. Убедись, что в `.env` указан корректный url на api
2. ```powershell
   cd client
   npm start
   ```

Клиент сам поднимет `server/server.py` как дочерний процесс (это можно
отключить через `AUTO_START_VOICE_SERVER=false` в `.env` и запускать
`server/` вручную для отладки).

### Горячие клавиши

| Комбинация | Действие |
|---|---|
| `Ctrl+Alt+Space` | Голосовой ввод (push-to-talk, повторное нажатие останавливает запись) |
| `Ctrl+Alt+L` | Переключить click-through (по умолчанию включён) |
| `Ctrl+Alt+Q` | Выход |
| `Ctrl+Alt+Left` / `Right` | Перебор выражений модели (для настройки `emotions.json`) |
| `Ctrl+Alt+F` | Сброс выражения в нейтральное |
| `Ctrl+Alt+T` | Проиграть motion |

Если какой-то хоткей не срабатывает — вероятно, комбинация уже занята
другим приложением/системой; в консоли при старте будет явное сообщение
об этом, смени сочетание в `client/main.js`.

## Сборка в exe

```powershell
cd client
npm run dist
```

Результат — `dist/win-unpacked/VTuberAssistant.exe`. Это **не**
самодостаточный дистрибутив — рядом с exe нужно вручную положить:

```
dist/win-unpacked/
├── VTuberAssistant.exe
├── resources/            (создаётся сборкой)
├── .env
├── server/                (включая venv)
├── models/
└── live2d-core/
```

После этого папку `win-unpacked/` можно переносить/раздавать целиком —
Node.js/npm на целевой машине не нужны (Electron-рантайм зашит в exe).
Python и его зависимости для `server/` всё ещё нужны на целевой машине.

**Если сборка падает с `Cannot create symbolic link`** — включи Windows
Developer Mode (Параметры → Для разработчиков → Режим разработчика) или
запусти сборку от имени администратора (см. раздел "Известные проблемы").

## Известные проблемы

**`electron-builder` падает с `Cannot create symbolic link` при сборке**
— инструмент пытается подготовить macOS-тулы для подписи кода, даже при
сборке только под Windows. Включи Windows Developer Mode (Параметры →
Для разработчиков → Режим разработчика) или запусти сборку от имени
администратора.

**`torch`/`torchaudio` version mismatch (`OSError`/`WinError 127` при
импорте)** — эти два пакета обязаны быть из одной сборки. Ставь их
всегда последним шагом через `requirements-gpu.txt --force-reinstall`,
не смешивай с обычным `pip install -r requirements.txt`.

**GPU 50-серии (Blackwell) не находит CUDA** — нужен индекс `cu128`
(`--extra-index-url https://download.pytorch.org/whl/cu128`), более
старые сборки (`cu118`/`cu121`) архитектуру не поддерживают.

**Кракозябры в консоли** — Windows-терминал по умолчанию не в UTF-8.
`npm start` уже переключает кодировку (`chcp 65001`) автоматически.

**Нехватка ОЗУ при 16 ГБ и меньше** — LLM + STT одновременно на GPU/CPU
могут упереться в память и уйти в подкачку (заметные подвисания).
Попробуй меньшую модель Whisper (`STT_MODEL_SIZE=small` или `base`) и
следи за загрузкой GPU-оффлоада LLM.

**RVC-модель падает с `'tuple' object has no attribute 'dtype'`** — на
практике это следствие сбоя загрузки HuBERT-чекпоинта из-за
`weights_only=True` по умолчанию в PyTorch 2.6+ (см. патч в
`server/patches.py` — уже применён, но если ловишь это на своей модели,
проверь, что патч действительно импортируется раньше `rvc_python`).

**Голос после RVC звучит "мультяшно"/роботизированно** — обычно
несовпадение диапазона высоты исходного голоса (TTS) и голоса, на
котором обучена RVC-модель. Используй параметры `RVC_PITCH` /
`RVC_F0_METHOD` / `RVC_INDEX_RATE` в `.env` — под каждую пару
TTS-голос/RVC-модель питч обычно нужно подбирать заново.

## Структура проекта

```
vtuber-assistant/
├── client/              Electron-приложение (визуал + оркестрация)
│   ├── main.js            main process: пайплайн, хоткеи, IPC
│   ├── main/               клиенты для LLM/TTS/RVC/STT, консольный fallback
│   └── renderer/           рендер Live2D-модели, звук, эмоции, lip-sync
├── server/              Voice-сервис (TTS + RVC + STT, один процесс)
├── models/
│   ├── live2d/             Live2D-модели + emotions.json на каждую
│   ├── tts/                кэш весов Silero (скачивается автоматически)
│   └── rvc/                веса RVC-моделей (опционально)
├── live2d-core/          Cubism Core (скачивается отдельно, не в репо)
└── .env                  конфиг (не в репо, см. .env.example)
```

## Технологии

[Electron](https://electronjs.org) · [PixiJS](https://pixijs.com) +
[pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) ·
[KoboldCPP](https://github.com/LostRuins/koboldcpp) ·
[Silero TTS](https://github.com/snakers4/silero-models) ·
[RVC](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI)
(через [rvc-python](https://pypi.org/project/rvc-python/)) ·
[OpenAI Whisper](https://github.com/openai/whisper) ·
[Live2D Cubism SDK](https://www.live2d.com/en/sdk/about/)

## Лицензия

Код этого проекта распространяется по лицензии MIT.

Обратите внимание, что сторонние компоненты лицензируются отдельно:

- Live2D Cubism SDK / Cubism Core распространяются по лицензии Live2D и не входят в этот репозиторий.
- RVC- и Live2D-модели, полученные из сторонних источников, имеют собственные условия использования, установленные их авторами.