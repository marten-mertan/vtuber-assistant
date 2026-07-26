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

const { app, BrowserWindow, globalShortcut, screen, ipcMain } = require("electron");
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
    win.webContents.send("assistant-status", { state: "listening" });
    console.log("[pipeline] recording started");
  } catch (err) {
    console.error(`[pipeline] STT start error: ${err.message}`);
    win.webContents.send("assistant-status", { state: "error", message: err.message });
  }
}

async function stopRecordingAndRespond() {
  if (!isRecording) return;
  isRecording = false;
  isBusy = true;
  win.webContents.send("assistant-status", { state: "thinking" });

  try {
    const { text, warning, duration, process_time } = await stt.stop();
    console.log(
      `[pipeline] STT: "${text}" (record ${duration?.toFixed?.(1)}s, process ${process_time?.toFixed?.(1)}s)`
    );

    if (warning || !text) {
      win.webContents.send("assistant-status", { state: "idle" });
      isBusy = false;
      return;
    }

    const { reply, emotion } = await llm.send(text);
    console.log(`[pipeline] LLM [${emotion}]: ${reply}`);

    let audioData = null;
    if (voiceEnabled) {
      try {
        const { buffer: sileroBuffer } = await tts.synthesize(reply);
        let finalBuffer = sileroBuffer;
        if (rvcEnabled) {
          try {
            finalBuffer = await rvc.convert(sileroBuffer);
          } catch (rvcErr) {
            console.warn(`[pipeline] RVC failed, using Silero audio: ${rvcErr.message}`);
          }
        }
        // Передаём как Uint8Array напрямую (structured clone) — НЕ через
        // base64: конвертация base64 -> бинарные данные на стороне
        // renderer (atob + побайтовый цикл) синхронно блокирует поток
        // рендеринга модели на заметное время, вызывая подвисания.
        audioData = new Uint8Array(finalBuffer);
      } catch (ttsErr) {
        console.warn(`[pipeline] TTS failed: ${ttsErr.message}`);
      }
    }

    win.webContents.send("assistant-reply", {
      userText: text,
      reply,
      emotion,
      audio: audioData,
    });
  } catch (err) {
    console.error(`[pipeline] error: ${err.message}`);
    win.webContents.send("assistant-status", { state: "error", message: err.message });
  } finally {
    isBusy = false;
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
      win.webContents.send("assistant-status", { state: "idle" });
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