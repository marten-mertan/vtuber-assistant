// renderer.js — загружает и рисует Live2D-модель в прозрачном окне,
// принимает по IPC результаты голосового пайплайна из main-процесса.

const fs = require("fs");
const path = require("path");
const { ipcRenderer } = require("electron");

// appRoot — папка с server/, models/, live2d-core/, .env. Спрашиваем
// синхронно у main (там правильно посчитан и для dev, и для упакованного
// exe — см. main.js) до того, как грузить что-либо из этих папок.
const appRoot = ipcRenderer.sendSync("get-app-root");

// Cubism Core — НЕ npm-пакет (лицензия Live2D), лежит в live2d-core/ в
// appRoot. Грузим синхронно через fs+eval в глобальную область видимости
// ДО require pixi-live2d-display, т.к. та библиотека ожидает готовый
// window.Live2DCubismCore уже на момент своей инициализации. Раньше это
// делал статический <script> в index.html — но в упакованном exe его
// относительный путь ("../live2d-core/...") не резолвился бы верно.
const cubismCorePath = path.join(appRoot, "live2d-core", "live2dcubismcore.min.js");
if (!fs.existsSync(cubismCorePath)) {
  document.body.innerHTML =
    '<div style="color:red;font-family:sans-serif;padding:20px;background:white">' +
    `Не найден Cubism Core: ${cubismCorePath} — см. README (шаг про live2d-core).` +
    "</div>";
  throw new Error(`Cubism Core не найден: ${cubismCorePath}`);
}
// eslint-disable-next-line no-eval
(0, eval)(fs.readFileSync(cubismCorePath, "utf-8")); // (0, eval) = eval в глобальной, а не локальной области

const PIXI = require("pixi.js");
window.PIXI = PIXI; // pixi-live2d-display ожидает глобальный PIXI

const { Live2DModel, config } = require("pixi-live2d-display/cubism4");

// Модели с большим числом clipping-масок (частая история для сложных
// моделей с Booth) могут падать в doDrawModel с "Cannot read properties
// of undefined (reading '0')" без этого флага — библиотека по умолчанию
// не поддерживает больше 4 mask-делений на модель.
config.cubism4.supportMoreMaskDivisions = true;

// Карта emotion -> код(ы) выражения модели грузится ИЗ ФАЙЛА рядом с
// самой моделью (emotions.json в той же папке, что model3.json) — НЕ
// хардкодится тут, чтобы смена модели не требовала правки кода.
// См. models/live2d/emotions.example.json как образец формата.
let emotionMap = {};

function loadEmotionMap(modelPath) {
  const emotionsPath = path.join(path.dirname(modelPath), "emotions.json");
  if (!fs.existsSync(emotionsPath)) {
    console.warn(`emotions.json не найден рядом с моделью (${emotionsPath}) — эмоции не будут отображаться визуально.`);
    return {};
  }
  try {
    const raw = JSON.parse(fs.readFileSync(emotionsPath, "utf-8"));
    delete raw._comment;
    return raw;
  } catch (err) {
    console.error(`Ошибка чтения emotions.json: ${err.message}`);
    return {};
  }
}

// Если положишь несколько моделей в models/ — укажи явно нужный файл здесь.
// Оставь null для автопоиска первого найденного *.model3.json.
const MODEL_PATH_OVERRIDE = null;

// Подбери под свою модель после первого запуска (модели бывают разного
// "внутреннего" размера — эта цифра просто масштаб отображения).
// --- Настройки позиционирования и поведения модели ---
// Подобраны опытным путём под конкретную модель/экран. Когда дойдём до
// сборки приложения — вынести в конфиг-файл или UI-настройки, чтобы не
// редактировать код на каждую новую модель/монитор.
const MODEL_SCALE = 0.15;
const MARGIN_RIGHT = 200;
const MARGIN_BOTTOM = -940;
const HEAD_REGION_FRACTION = 0.45;

function findModelFile(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findModelFile(fullPath);
      if (found) return found;
    } else if (entry.name.endsWith(".model3.json")) {
      return fullPath;
    }
  }
  return null;
}

let currentModel = null; // доступ из IPC-обработчиков (см. ниже main())
let pixiApp = null; // доступ к PIXI-тикеру для lip-sync (см. ниже main())
let lipSyncParamIds = []; // ID параметров рта модели (из model3.json Groups)
let expressionNames = []; // список имён Expressions из model3.json (см. main())
let expressionIndex = -1; // текущий индекс при переборе (-1 = дефолт/сброшено)

async function main() {
  // Единая папка models/ в appRoot (рядом с models/tts, models/rvc) —
  // через appRoot, не __dirname, чтобы верно резолвилось и в упакованном exe.
  const modelsDir = path.join(appRoot, "models", "live2d");
  const modelPath = MODEL_PATH_OVERRIDE || findModelFile(modelsDir);

  if (!modelPath) {
    document.body.innerHTML =
      '<div style="color:red;font-family:sans-serif;padding:20px;background:white">' +
      "Не найден файл *.model3.json в models/live2d/ — распакуй туда архив с моделью." +
      "</div>";
    return;
  }

  console.log(`Загружаю модель: ${modelPath}`);
  emotionMap = loadEmotionMap(modelPath);
  console.log("Карта эмоций:", emotionMap);

  const app = new PIXI.Application({
    resizeTo: window,
    backgroundAlpha: 0,
  });
  pixiApp = app;
  document.getElementById("canvas-container").appendChild(app.view);

  const model = await Live2DModel.from(modelPath);
  currentModel = model;
  app.stage.addChild(model);

  // Параметр(ы) рта для lip-sync — берём из самой модели (Groups -> LipSync
  // в model3.json), а не хардкодим "ParamMouthOpenY": не все модели
  // называют его одинаково.
  lipSyncParamIds = model.internalModel.settings.getLipSyncParameters() || [];
  if (lipSyncParamIds.length === 0) {
    console.warn("У модели не найдены LipSync-параметры в model3.json (Groups) — lip-sync работать не будет.");
  }

  // LOW-приоритет гарантирует, что наш колбэк выполнится ПОСЛЕ внутреннего
  // update() модели (физика/motion), иначе модель перезапишет наше
  // значение параметра рта до отрисовки кадра.
  app.ticker.add(setMouthFromVolume, null, PIXI.UPDATE_PRIORITY.LOW);

  model.scale.set(MODEL_SCALE);
  model.anchor.set(0.5, 1.0); // якорь снизу по центру — удобно для позиционирования у нижнего края экрана

  // Начальное положение — правый нижний угол экрана, с отступами.
  model.position.set(app.screen.width - MARGIN_RIGHT, app.screen.height - MARGIN_BOTTOM);

  // --- Взгляд модели: свой, вместо встроенного autoInteract ---
  // Встроенный focus() считает направление по ВСЕЙ высоте модели
  // (originalHeight) — для полнофигурных моделей это даёт неестественную
  // реакцию тела/ног на курсор около головы. Пересчитываем сами, используя
  // только верхнюю часть модели (голова/торс) как систему отсчёта.
  model.autoInteract = false;

  // Доля высоты модели (от верха), которая считается "зоной взгляда".
  // 1.0 — как было по умолчанию (вся модель), меньше — более чувствительно
  // к движению курсора около головы.

  const focusPoint = new PIXI.Point();
  function updateFocus(globalX, globalY) {
    focusPoint.x = globalX;
    focusPoint.y = globalY;
    model.toModelPosition(focusPoint, focusPoint, true);
    const w = model.internalModel.originalWidth;
    const h = model.internalModel.originalHeight * HEAD_REGION_FRACTION;
    const tx = (focusPoint.x / w) * 2 - 1;
    const ty = (focusPoint.y / h) * 2 - 1;
    const radian = Math.atan2(ty, tx);
    model.internalModel.focusController.focus(Math.cos(radian), -Math.sin(radian), false);
  }

  window.addEventListener("pointermove", (e) => updateFocus(e.clientX, e.clientY));

  // Простое перетаскивание модели мышью (когда click-through выключен —
  // см. Ctrl+Alt+L в main.js) — удобно для позиционирования на экране.
  model.buttonMode = true;
  model.interactive = true;
  let dragging = false;
  let dragOffset = { x: 0, y: 0 };

  model.on("pointerdown", (e) => {
    dragging = true;
    dragOffset = { x: e.data.global.x - model.x, y: e.data.global.y - model.y };
  });
  model.on("pointermove", (e) => {
    if (dragging) {
      model.position.set(e.data.global.x - dragOffset.x, e.data.global.y - dragOffset.y);
    }
  });
  model.on("pointerup", () => (dragging = false));
  model.on("pointerupoutside", () => (dragging = false));

  console.log("Модель загружена и отрисована.");
  window.__model = model; // для отладки из DevTools (Ctrl+Shift+I)

  // Список выражений модели (для дебаг-перебора, см. IPC-обработчики ниже)
  const exprManager = model.internalModel.motionManager.expressionManager;
  expressionNames = exprManager ? exprManager.definitions.map((d) => d.Name) : [];
  console.log(`Выражения модели (${expressionNames.length}):`, expressionNames);
}

main().catch((err) => {
  console.error("Ошибка загрузки модели:", err);
  document.body.innerHTML =
    '<div style="color:red;font-family:sans-serif;padding:20px;background:white">' +
    `Ошибка загрузки модели: ${err.message}` +
    "</div>";
});

// --- HUD: маленький статус-индикатор, чтобы видеть, что происходит, ---
// --- не открывая DevTools каждый раз ---

const hud = document.createElement("div");
hud.style.cssText = `
  position: fixed; left: 16px; bottom: 16px; max-width: 420px;
  font-family: sans-serif; font-size: 13px; color: #fff;
  background: rgba(0,0,0,0.55); padding: 8px 12px; border-radius: 8px;
  pointer-events: none; white-space: pre-wrap;
`;
hud.textContent = "";
document.body.appendChild(hud);

function setHud(text) {
  hud.textContent = text;
}

// --- Воспроизведение аудио через Web Audio API + lip-sync ---
// AnalyserNode считывает громкость проигрываемого звука в реальном
// времени; значение подаётся в параметр(ы) рта модели каждый кадр.

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const analyser = audioCtx.createAnalyser();
analyser.fftSize = 256;
const analyserData = new Uint8Array(analyser.frequencyBinCount);

let isSpeaking = false;

// LIPSYNC_GAIN — во сколько раз усиливать громкость перед подачей в
// параметр рта (0..1). Тихая озвучка может не открывать рот заметно без
// усиления — подбери на слух, если рот выглядит вялым/малоподвижным.
const LIPSYNC_GAIN = 3.0;

function setMouthFromVolume() {
  if (!currentModel || lipSyncParamIds.length === 0) return;

  let value = 0;
  if (isSpeaking) {
    analyser.getByteTimeDomainData(analyserData);
    // RMS (среднеквадратичное отклонение от тишины) — более плавная и
    // репрезентативная метрика "громкости", чем просто пиковое значение.
    let sumSquares = 0;
    for (let i = 0; i < analyserData.length; i++) {
      const normalized = (analyserData[i] - 128) / 128; // -1..1
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / analyserData.length);
    value = Math.min(1, rms * LIPSYNC_GAIN);
  }

  for (const paramId of lipSyncParamIds) {
    currentModel.internalModel.coreModel.setParameterValueById(paramId, value);
  }
}

async function playAudio(uint8Array) {
  // slice(offset, offset+length) на случай, если byteOffset != 0 после IPC —
  // decodeAudioData ожидает ArrayBuffer ровно с нужными данными, без хвостов.
  const arrayBuffer = uint8Array.buffer.slice(
    uint8Array.byteOffset,
    uint8Array.byteOffset + uint8Array.byteLength
  );
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(analyser);
  analyser.connect(audioCtx.destination);
  isSpeaking = true;
  source.start();
  return new Promise((resolve) => {
    source.onended = () => {
      isSpeaking = false;
      resolve();
    };
  });
}

// --- IPC: получаем статусы и ответы из main-процесса (pipeline в main.js) ---

ipcRenderer.on("assistant-status", (_event, { state, message }) => {
  if (state === "starting") setHud(`⏳ ${message || "Запускаюсь..."}`);
  else if (state === "listening") setHud("🎤 Слушаю...");
  else if (state === "thinking") setHud("💭 Думаю...");
  else if (state === "error") setHud(`⚠️ Ошибка: ${message}`);
  else if (state === "idle") setHud("");
});

ipcRenderer.on("assistant-reply", async (_event, { userText, reply, emotion, audio }) => {
  setHud(`Ты: ${userText}\nАи [${emotion}]: ${reply}`);

  if (currentModel) {
    const options = emotionMap[emotion];
    const exprName = options && options.length > 0
      ? options[Math.floor(Math.random() * options.length)]
      : null;
    if (exprName) {
      currentModel.expression(exprName);
    } else {
      // emotion без соответствия (или пустой массив) — сброс в дефолт,
      // чтобы не оставалось "залипшее" предыдущее выражение.
      currentModel.internalModel.motionManager.expressionManager?.resetExpression();
    }
  }

  if (audio) {
    try {
      await playAudio(audio);
    } catch (err) {
      console.error("Ошибка воспроизведения аудио:", err);
    }
  }
});

// --- Дебаг: перебор выражений модели (Ctrl+Alt+Left/Right/R/M в main.js) ---
// Помогает каталогизировать, что реально означает каждое имя в Expressions
// модели (часто это непрозрачные коды типа "bbt", "yjys1" и т.п.).

ipcRenderer.on("debug-cycle-expression", (_event, { direction }) => {
  if (!currentModel || expressionNames.length === 0) {
    setHud("Нет доступных выражений у модели");
    return;
  }
  expressionIndex = (expressionIndex + direction + expressionNames.length) % expressionNames.length;
  const name = expressionNames[expressionIndex];
  currentModel.expression(name);
  setHud(`Выражение [${expressionIndex + 1}/${expressionNames.length}]: ${name}`);
  console.log(`Выражение: ${name} (индекс ${expressionIndex})`);
});

ipcRenderer.on("debug-reset-expression", () => {
  if (!currentModel) return;
  expressionIndex = -1;
  currentModel.internalModel.motionManager.expressionManager?.resetExpression();
  setHud("Выражение сброшено");
});

ipcRenderer.on("debug-trigger-motion", () => {
  if (!currentModel) return;
  // "" — имя группы motion по умолчанию (см. model3.json -> Motions),
  // без второго аргумента запустится случайная motion из этой группы.
  currentModel.motion("");
  setHud("Motion запущена");
});