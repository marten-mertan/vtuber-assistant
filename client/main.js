// main.js — Electron main process.
// Окно поверх экрана с Live2D-моделью + вся оркестрация голосового
// пайплайна (STT -> LLM -> TTS -> RVC). Результат уходит в renderer
// через IPC — там модель проигрывает звук (Web Audio API, нужен для
// lip-sync) и реагирует на emotion.
//
// Автозапускает server/server.py (наш voice-сервис) как дочерний процесс.
// KoboldCPP (или любой другой OpenAI-совместимый LLM) НЕ запускается
// отсюда намеренно — KOBOLD_URL может указывать куда угодно, не обязан
// быть именно локальным KoboldCPP, это осознанный выбор гибкости.

const { app, BrowserWindow, globalShortcut, screen, ipcMain, desktopCapturer } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

// appRoot — папка, где лежат server/, models/, live2d-core/, .env.
// В разработке (npm start) это корень репозитория (на уровень выше client/).
// В упакованном exe __dirname указывает ВНУТРЬ asar-архива — это не
// реальный путь на диске, поэтому там используем папку рядом с самим exe
// (process.execPath). Так и в dev, и в собранном виде эти внешние ресурсы
// резолвятся одинаково правильно.
const appRoot = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, "..");

// Единый .env — в appRoot (в dev это корень репозитория, в exe — рядом с ним).
require("dotenv").config({ path: path.join(appRoot, ".env") });

const { LLMClient } = require("./main/llmClient.js");
const { TTSClient } = require("./main/ttsClient.js");
const { RVCClient } = require("./main/rvcClient.js");
const { STTClient } = require("./main/sttClient.js");

let win;
let clickThrough = false;
let isRecording = false;
let isBusy = false; // защита от повторного запуска пайплайна, пока предыдущий не закончился
let pendingScreenshot = null; // скриншот, захваченный перед началом записи (Ctrl+Alt+S) — прикладывается к следующему сообщению

// --- Конфигурация из .env (та же логика, что была в консольном chat.js) ---
const koboldUrl = process.env.KOBOLD_URL || "http://localhost:5001";
const temperature = Number(process.env.LLM_TEMPERATURE ?? 0.8);
const maxTokens = Number(process.env.LLM_MAX_TOKENS ?? 150);

// TTS/RVC/STT теперь один процесс (server/server.py) — один порт вместо
// трёх (см. Этап "слияние сервисов" в README).
const voiceUrl = process.env.VOICE_URL || "http://localhost:5100";
const ttsSpeaker = process.env.TTS_SPEAKER || "kseniya";
const voiceEnabled = (process.env.VOICE_ENABLED ?? "true") !== "false";
const rvcEnabled = (process.env.RVC_ENABLED ?? "false") === "true";

// Автозапуск server/server.py как дочернего процесса. Отключи (false),
// если хочешь запускать сервис вручную сам (например, при отладке).
const autoStartVoiceServer = (process.env.AUTO_START_VOICE_SERVER ?? "true") !== "false";

const llm = new LLMClient({ baseUrl: koboldUrl, temperature, maxTokens });
const tts = new TTSClient({ baseUrl: voiceUrl, speaker: ttsSpeaker });
const rvc = new RVCClient({ baseUrl: voiceUrl });
const stt = new STTClient({ baseUrl: voiceUrl });

let voiceServerProcess = null;
let backendReady = !autoStartVoiceServer; // если автозапуск выключен — считаем сразу готовым

// Renderer не может сам вычислить appRoot так же надёжно (там другой
// __dirname внутри asar) — просто спрашивает его у main синхронно при
// старте, до загрузки Cubism Core и модели.
ipcMain.on("get-app-root", (event) => {
  event.returnValue = appRoot;
});

// Единственное место, где снимается isBusy — renderer сам знает, когда
// реально доиграл последний чанк звука (main этого напрямую не видит,
// у него только сетевые вызовы TTS/RVC, не факт воспроизведения).
ipcMain.on("renderer-idle", () => {
  isBusy = false;
  console.log("[pipeline] busy снят (renderer подтвердил, что всё доиграно)");
});

// --- Автозапуск server/server.py как дочернего процесса -------------------

function spawnVoiceServer() {
  const serverDir = path.join(appRoot, "server");
  const isWin = process.platform === "win32";
  const pythonExe = path.join(
    serverDir,
    "venv",
    isWin ? "Scripts" : "bin",
    isWin ? "python.exe" : "python"
  );

  console.log(`[voice-server] Запускаю: ${pythonExe} server.py (cwd=${serverDir})`);

  voiceServerProcess = spawn(pythonExe, ["server.py"], {
    cwd: serverDir,
    // Свой env для дочернего процесса (наследует process.env + PYTHONUNBUFFERED,
    // чтобы print() из Python сразу попадал в консоль, не буферизуясь)
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
  });

  voiceServerProcess.stdout.on("data", (data) => {
    process.stdout.write(`[voice-server] ${data}`);
  });
  voiceServerProcess.stderr.on("data", (data) => {
    process.stderr.write(`[voice-server] ${data}`);
  });
  voiceServerProcess.on("error", (err) => {
    console.error(`[voice-server] Не удалось запустить процесс: ${err.message}`);
    console.error(`[voice-server] Проверь, что venv создан: ${pythonExe}`);
  });
  voiceServerProcess.on("exit", (code) => {
    console.log(`[voice-server] Процесс завершился с кодом ${code}`);
    voiceServerProcess = null;
    if (!app.isQuitting) {
      backendReady = false;
      win?.webContents.send("assistant-status", {
        state: "error",
        message: "voice-сервер неожиданно остановился",
      });
    }
  });
}

function killVoiceServer() {
  if (voiceServerProcess) {
    console.log("[voice-server] Останавливаю процесс...");
    voiceServerProcess.kill();
    voiceServerProcess = null;
  }
}

/** Опрашивает /health, пока сервис не станет доступен или не выйдет время */
async function waitForBackend(timeoutMs = 180000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await tts.health().catch(() => ({ ok: false }));
    if (status.ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

// Пресет-промпт для хоткея "скриншот без голоса" (Ctrl+Alt+D).
const SCREENSHOT_PROMPT =
  process.env.SCREENSHOT_PROMPT ||
  "Вот что сейчас у меня на экране. Прокомментируй коротко, как будто заметила это мельком.";

/**
 * Захватывает основной экран целиком, отдаёт PNG в base64.
 * ПОКА без выбора конкретного окна/области — просто берём весь primaryDisplay.
 */
async function captureScreenshot() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.size;
  try {
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width, height },
    });
    if (!sources.length) {
      console.error("[screenshot] desktopCapturer не вернул ни одного источника экрана");
      return null;
    }
    const png = sources[0].thumbnail.toPNG();
    console.log(`[screenshot] Захвачено: ${(png.length / 1024).toFixed(0)} КБ`);
    return png.toString("base64");
  } catch (err) {
    console.error(`[screenshot] Ошибка захвата: ${err.message}`);
    return null;
  }
}

function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: screenW,
    height: screenH,
    x: 0,
    y: 0,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    webPreferences: {
      // Упрощение для локального личного приложения (не грузит удалённый
      // непроверенный контент) — в renderer можно напрямую require() npm-пакеты.
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(path.join(__dirname, "renderer", "index.html"));

  // Окно на весь экран — по умолчанию click-through ВКЛЮЧЁН, чтобы не
  // блокировать клики по остальным окнам/рабочему столу. Взгляд модели
  // при этом всё равно следит за курсором глобально (см. renderer.js).
  clickThrough = true;
  win.setIgnoreMouseEvents(true, { forward: true });
}

// --- Голосовой пайплайн: STT -> LLM -> TTS -> (RVC) -> в renderer ---

async function startRecording() {
  if (isBusy || isRecording) return;
  if (!backendReady) {
    win.webContents.send("assistant-status", {
      state: "error",
      message: "voice-сервер ещё запускается, подожди немного",
    });
    return;
  }
  try {
    await stt.start();
    isRecording = true;
    isBusy = true; // единый флаг "занято" держится теперь до подтверждения от renderer, что звук доиграл (см. ipcMain.on("renderer-idle"))
    win.webContents.send("assistant-status", { state: "listening" });
    console.log("[pipeline] recording started");
  } catch (err) {
    console.error(`[pipeline] STT start error: ${err.message}`);
    win.webContents.send("assistant-status", { state: "error", message: err.message });
  }
}

// Совпадает с диапазонами эмодзи, которые чистит server/tts_service.py —
// если после их удаления в чанке не осталось ни одной буквы/цифры,
// озвучивать нечего, TTS вообще не дёргаем.
const HAS_SPEAKABLE_CHARS = /[\p{L}\p{N}]/u;

/** Синтезирует речь для одного чанка текста (TTS, затем опционально RVC) */
async function synthesizeChunk(text) {
  if (!voiceEnabled) return null;
  if (!HAS_SPEAKABLE_CHARS.test(text)) {
    console.log(`[pipeline] Чанк без произносимых символов, TTS пропущен: "${text}"`);
    return null;
  }
  try {
    const { buffer: sileroBuffer } = await tts.synthesize(text);
    let finalBuffer = sileroBuffer;
    if (rvcEnabled) {
      try {
        finalBuffer = await rvc.convert(sileroBuffer);
      } catch (rvcErr) {
        console.warn(`[pipeline] RVC failed for chunk, using Silero audio: ${rvcErr.message}`);
      }
    }
    // Uint8Array напрямую (structured clone) — НЕ base64: конвертация
    // base64 -> бинарные данные на стороне renderer синхронно блокирует
    // поток рендеринга модели на заметное время.
    return new Uint8Array(finalBuffer);
  } catch (ttsErr) {
    console.warn(`[pipeline] TTS failed for chunk: ${ttsErr.message}`);
    return null;
  }
}

/**
 * Общая логика ответа: отправляет текст (+опционально изображение) в LLM
 * потоково, чанкует по предложениям, синтезирует и шлёт в renderer.
 * Переиспользуется и голосовым пайплайном, и хоткеем "скриншот без голоса".
 */
async function respondToText(userText, { imageBase64 } = {}) {
  win.webContents.send("assistant-chunk-start", { userText });

  // Очередь предложений от LLM-стрима. onSentence вызывается синхронно
  // по мере чтения SSE — сам TTS/RVC для чанка НЕ ждём тут же (это бы
  // застопорило чтение следующих токенов), а складываем в очередь и
  // разбираем отдельным "воркером" ниже, который работает параллельно
  // с продолжающимся чтением потока от LLM.
  const sentenceQueue = [];
  let queueWake = null;
  let streamDone = false;
  let chunkIndex = 0;

  function enqueue(sentenceText) {
    sentenceQueue.push(sentenceText);
    if (queueWake) {
      queueWake();
      queueWake = null;
    }
  }

  async function drainQueue() {
    while (true) {
      if (sentenceQueue.length === 0) {
        if (streamDone) return;
        await new Promise((resolve) => {
          queueWake = resolve;
        });
        continue;
      }
      const sentenceText = sentenceQueue.shift();
      const idx = chunkIndex++;
      const audio = await synthesizeChunk(sentenceText);
      win.webContents.send("assistant-chunk", { index: idx, text: sentenceText, audio });
    }
  }

  const drainPromise = drainQueue();

  const { reply, emotion } = await llm.sendStream(userText, {
    imageBase64,
    onEmotion: (em) => {
      win.webContents.send("assistant-emotion", { emotion: em });
    },
    onSentence: (sentenceText) => enqueue(sentenceText),
  });

  streamDone = true;
  if (queueWake) {
    queueWake();
    queueWake = null;
  }
  await drainPromise;

  console.log(`[pipeline] LLM [${emotion}] (полный ответ): ${reply}`);
}

async function stopRecordingAndRespond() {
  if (!isRecording) return;
  isRecording = false;
  win.webContents.send("assistant-status", { state: "thinking" });

  const imageBase64 = pendingScreenshot;
  pendingScreenshot = null;

  try {
    const { text, warning, duration, process_time } = await stt.stop();
    console.log(
      `[pipeline] STT: "${text}" (record ${duration?.toFixed?.(1)}s, process ${process_time?.toFixed?.(1)}s)`
    );

    if (warning || !text) {
      win.webContents.send("assistant-turn-done", {});
      return;
    }

    await respondToText(text, { imageBase64 });
    win.webContents.send("assistant-turn-done", {});
  } catch (err) {
    console.error(`[pipeline] error: ${err.message}`);
    win.webContents.send("assistant-status", { state: "error", message: err.message });
    win.webContents.send("assistant-turn-done", {});
  }
}

/** Хоткей "скриншот без голоса" — сразу отправляет с готовым промптом. */
async function sendScreenshotWithPreset() {
  if (isBusy || isRecording) return;
  if (!backendReady) {
    win.webContents.send("assistant-status", {
      state: "error",
      message: "voice-сервер ещё запускается, подожди немного",
    });
    return;
  }

  isBusy = true;
  win.webContents.send("assistant-status", { state: "thinking" });

  const imageBase64 = await captureScreenshot();
  if (!imageBase64) {
    win.webContents.send("assistant-status", {
      state: "error",
      message: "не удалось захватить экран",
    });
    win.webContents.send("assistant-turn-done", {});
    return;
  }

  try {
    await respondToText(SCREENSHOT_PROMPT, { imageBase64 });
    win.webContents.send("assistant-turn-done", {});
  } catch (err) {
    console.error(`[pipeline] error: ${err.message}`);
    win.webContents.send("assistant-status", { state: "error", message: err.message });
    win.webContents.send("assistant-turn-done", {});
  }
}

app.whenReady().then(async () => {
  createWindow();

  if (autoStartVoiceServer) {
    win.webContents.once("did-finish-load", () => {
      win.webContents.send("assistant-status", { state: "starting", message: "Запускаю voice-сервер..." });
    });
    spawnVoiceServer();
    console.log("[voice-server] Жду готовности (может занять время при первой загрузке моделей)...");
    const ok = await waitForBackend();
    if (ok) {
      backendReady = true;
      console.log("[voice-server] Готов.");
      win.webContents.send("assistant-status", { state: "ready" });
    } else {
      console.error("[voice-server] Не поднялся за отведённое время — проверь логи выше.");
      win.webContents.send("assistant-status", {
        state: "error",
        message: "voice-сервер не запустился, смотри консоль",
      });
    }
  }

  // register() возвращает false, если комбинация уже занята другим
  // приложением/системой — Electron в этом случае просто молча ничего
  // не делает при нажатии, без ошибки. Оборачиваю, чтобы такие конфликты
  // сразу было видно в консоли, а не гадать, почему хоткей "не работает".
  function registerHotkey(accelerator, handler) {
    const ok = globalShortcut.register(accelerator, handler);
    if (!ok) {
      console.error(
        `[hotkey] НЕ удалось зарегистрировать "${accelerator}" — комбинация уже занята другим приложением или системой Windows.`
      );
    }
    return ok;
  }

  registerHotkey("Control+Alt+L", () => {
    clickThrough = !clickThrough;
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
    console.log(`Click-through: ${clickThrough ? "ON (clicks pass through)" : "OFF (interactive)"}`);
  });

  registerHotkey("Control+Alt+Q", () => {
    app.quit();
  });

  // Push-to-talk: одна горячая клавиша работает как переключатель —
  // нажал первый раз — начал запись, нажал второй — остановил и
  // запустил пайплайн (STT -> LLM -> TTS -> RVC).
  registerHotkey("Control+Alt+Space", () => {
    if (isRecording) {
      stopRecordingAndRespond();
    } else {
      startRecording();
    }
  });

  // Скриншот + голос: сначала захватываем экран, затем как обычный
  // push-to-talk — говоришь, что хочешь спросить про то, что на экране.
  registerHotkey("Control+Alt+S", async () => {
    if (isBusy || isRecording) return;
    const shot = await captureScreenshot();
    if (!shot) {
      win.webContents.send("assistant-status", { state: "error", message: "не удалось захватить экран" });
      return;
    }
    pendingScreenshot = shot;
    startRecording();
  });

  // Скриншот без голоса: сразу отправляется с готовым промптом
  // (SCREENSHOT_PROMPT в .env)
  registerHotkey("Control+Alt+D", () => {
    sendScreenshotWithPreset();
  });

  // --- Дебаг-хоткеи для каталогизации выражений модели ---
  // Многие модели (особенно с booth.pm) называют Expressions в model3.json
  // непрозрачными кодами (сокращения пиньиня и т.п.) — этим удобно глазами
  // пройтись по всем и понять, что где, прежде чем маппить на emotion.
  registerHotkey("Control+Alt+Right", () => {
    win.webContents.send("debug-cycle-expression", { direction: 1 });
  });
  registerHotkey("Control+Alt+Left", () => {
    win.webContents.send("debug-cycle-expression", { direction: -1 });
  });
  registerHotkey("Control+Alt+F", () => {
    win.webContents.send("debug-reset-expression");
  });
  registerHotkey("Control+Alt+T", () => {
    win.webContents.send("debug-trigger-motion");
  });

  console.log(
    "Готово. Ctrl+Alt+Space — голосовой ввод, Ctrl+Alt+L — click-through, Ctrl+Alt+Q — выход."
  );
  console.log(
    "Скриншоты: Ctrl+Alt+S — скриншот+голос, Ctrl+Alt+D — скриншот с готовым промптом."
  );
  console.log(
    "Дебаг: Ctrl+Alt+Left/Right — перебор выражений, Ctrl+Alt+F — сброс, Ctrl+Alt+T — motion."
  );
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  killVoiceServer();
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});