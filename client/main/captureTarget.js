// captureTarget.js — текущая цель захвата скриншота (весь экран, конкретное
// окно, опционально с обрезкой прямоугольной области) + сама функция
// захвата. Состояние живёт тут одним модулем, чтобы main.js, sourcePicker
// и cropSelector не тянули его друг у друга напрямую.

const { desktopCapturer, screen } = require("electron");

// Разрешение для захвата preview/скриншота. 2560x1440 с
// запасом хватает и для чёткости при выделении области мышью, и для
// самого скриншота — дальше пережимаем перед отправкой (см. ниже).
const CAPTURE_THUMBNAIL_SIZE = { width: 2560, height: 1440 };

// Финальный потолок стороны картинки перед отправкой в LLM. Чуть больше,
// чем то, до чего модель сама ужимает (1024) — небольшой запас на случай
// смены модели на менее агрессивную по ресайзу, но всё равно на порядок
// легче исходного захвата.
const MAX_SEND_DIMENSION = 1280;

function resizeForSending(image) {
  const { width, height } = image.getSize();
  if (width <= MAX_SEND_DIMENSION && height <= MAX_SEND_DIMENSION) return image;
  const scale = MAX_SEND_DIMENSION / Math.max(width, height);
  return image.resize({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  });
}

// null = весь основной экран (поведение по умолчанию, ничего не настраивали)
let target = null; // { sourceId, sourceName, crop: {x,y,width,height} | null }

function getTarget() {
  return target;
}

function setTarget(sourceId, sourceName) {
  target = { sourceId, sourceName, crop: null };
}

/** cropRect — {x,y,width,height} в долях 0..1 от размера источника, либо null (без обрезки) */
function setCrop(cropRect) {
  if (target) target.crop = cropRect;
}

function clearTarget() {
  target = null;
}

// Определяем тип по префиксу id ("screen:0:0" / "window:1234:0") — сам
// desktopCapturer формирует id именно так, отдельно хранить не нужно.
function sourceType(sourceId) {
  return sourceId.startsWith("screen:") ? "screen" : "window";
}

/** Захватывает источник по id БЕЗ обрезки — используется для превью в cropSelector. */
async function captureSourceRaw(sourceId) {
  try {
    // Запрашиваем ТОЛЬКО нужный тип — desktopCapturer иначе энумерирует
    // и делает превью вообще всех окон И экранов в системе на каждый
    // вызов, это и есть основной источник задержки (не размер превью).
    const sources = await desktopCapturer.getSources({
      types: [sourceType(sourceId)],
      thumbnailSize: CAPTURE_THUMBNAIL_SIZE,
      fetchWindowIcons: false,
    });
    const source = sources.find((s) => s.id === sourceId);
    if (!source) return null;
    return source.thumbnail.toPNG().toString("base64");
  } catch (err) {
    console.error(`[capture] Ошибка предпросмотра источника: ${err.message}`);
    return null;
  }
}

/**
 * Захватывает ТЕКУЩУЮ выбранную цель (или основной экран, если ничего не
 * настроено), применяет сохранённую обрезку, если есть. Возвращает PNG
 * в base64 или null при ошибке.
 */
async function captureScreenshot() {
  try {
    let source = null;

    if (target) {
      const sources = await desktopCapturer.getSources({
        types: [sourceType(target.sourceId)],
        thumbnailSize: CAPTURE_THUMBNAIL_SIZE,
        fetchWindowIcons: false,
      });
      source = sources.find((s) => s.id === target.sourceId);
      if (!source) {
        console.warn(
          `[capture] Цель "${target.sourceName}" не найдена (окно закрыто?) — использую основной экран.`
        );
      }
    }

    if (!source) {
      const primaryDisplay = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: primaryDisplay.size,
      });
      source = sources[0];
    }

    if (!source) {
      console.error("[capture] desktopCapturer не вернул ни одного источника");
      return null;
    }

    let image = source.thumbnail;
    if (target?.crop) {
      const { width, height } = image.getSize();
      const { x, y, width: w, height: h } = target.crop;
      image = image.crop({
        x: Math.round(x * width),
        y: Math.round(y * height),
        width: Math.round(w * width),
        height: Math.round(h * height),
      });
    }
    image = resizeForSending(image);

    const png = image.toPNG();
    console.log(
      `[capture] Захвачено (${target?.sourceName || "весь экран"}): ${(png.length / 1024).toFixed(0)} КБ`
    );
    return png.toString("base64");
  } catch (err) {
    console.error(`[capture] Ошибка захвата: ${err.message}`);
    return null;
  }
}

module.exports = { getTarget, setTarget, setCrop, clearTarget, captureSourceRaw, captureScreenshot };