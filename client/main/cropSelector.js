// cropSelector.js — окно для выделения прямоугольной области мышью поверх
// уже захваченного превью выбранного источника. Опциональный шаг после
// sourcePicker — можно пропустить (Enter = использовать кадр целиком).

const { BrowserWindow, ipcMain } = require("electron");
const { nativeImage } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

let cropWindow = null;
let currentTmpDir = null;

function buildHtml() {
  // Картинка подключается отдельным файлом (preview.png) рядом с этим
  // HTML — НЕ через data:-URL. Крупные base64-строки в URL у Chromium
  // ненадёжны (упираются в лимиты длины), из-за чего иногда получали
  // просто белый экран вместо картинки.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html, body { margin:0; padding:0; background:#000; overflow:hidden; height:100%; }
    body { display:flex; align-items:center; justify-content:center; }
    #wrap { position:relative; display:inline-block; }
    #img { max-width:100vw; max-height:100vh; display:block; user-select:none; -webkit-user-drag:none; }
    #sel { position:absolute; border:2px dashed #4af; background:rgba(74,170,255,0.2);
           display:none; pointer-events:none; }
    #hint { position:fixed; bottom:12px; left:12px; color:#fff; font-family:sans-serif; font-size:13px;
            background:rgba(0,0,0,0.65); padding:8px 12px; border-radius:6px; }
  </style></head><body>
    <div id="wrap">
      <img id="img" src="preview.png" draggable="false" />
      <div id="sel"></div>
    </div>
    <div id="hint">Потяни мышью — выделить область. Enter — вся картинка целиком. Esc — отмена.</div>
    <script>
      const { ipcRenderer } = require("electron");
      const img = document.getElementById("img");
      const sel = document.getElementById("sel");
      let startX = 0, startY = 0, dragging = false, lastRect = null;

      img.addEventListener("mousedown", (e) => {
        dragging = true;
        const r = img.getBoundingClientRect();
        startX = e.clientX - r.left;
        startY = e.clientY - r.top;
        Object.assign(sel.style, { left: startX+"px", top: startY+"px", width:"0px", height:"0px", display:"block" });
      });
      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        const r = img.getBoundingClientRect();
        const curX = Math.min(Math.max(e.clientX - r.left, 0), r.width);
        const curY = Math.min(Math.max(e.clientY - r.top, 0), r.height);
        const x = Math.min(startX, curX), y = Math.min(startY, curY);
        const w = Math.abs(curX - startX), h = Math.abs(curY - startY);
        Object.assign(sel.style, { left:x+"px", top:y+"px", width:w+"px", height:h+"px" });
        lastRect = { x, y, w, h, dispW: r.width, dispH: r.height };
      });
      window.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        if (lastRect && lastRect.w > 5 && lastRect.h > 5) {
          ipcRenderer.send("crop-selector:select", {
            x: lastRect.x / lastRect.dispW,
            y: lastRect.y / lastRect.dispH,
            width: lastRect.w / lastRect.dispW,
            height: lastRect.h / lastRect.dispH,
          });
        }
      });
      window.addEventListener("keydown", (e) => {
        if (e.key === "Enter") ipcRenderer.send("crop-selector:select", null);
        else if (e.key === "Escape") ipcRenderer.send("crop-selector:cancel");
      });
    </script>
  </body></html>`;
}

function cleanupTmpDir() {
  if (currentTmpDir) {
    fs.rm(currentTmpDir, { recursive: true, force: true }, () => {});
    currentTmpDir = null;
  }
}

/**
 * Открывает окно выделения области поверх уже готового превью источника.
 * imageBase64 — PNG источника целиком, БЕЗ обрезки.
 * onDone(cropRect) — cropRect это {x,y,width,height} в долях 0..1, либо
 * null (выбрано "весь кадр" через Enter), либо undefined (полная отмена
 * через Esc/закрытие окна — в этом случае обрезка не меняется вообще).
 */
function open(imageBase64, onDone) {
  if (cropWindow) {
    cropWindow.focus();
    return;
  }

  const image = nativeImage.createFromBuffer(Buffer.from(imageBase64, "base64"));
  const { width, height } = image.getSize();
  const winW = Math.min(width, 1280) || 900;
  const winH = Math.min(height, 800) || 700;

  currentTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vtuber-crop-"));
  fs.writeFileSync(path.join(currentTmpDir, "preview.png"), Buffer.from(imageBase64, "base64"));
  const htmlPath = path.join(currentTmpDir, "index.html");
  fs.writeFileSync(htmlPath, buildHtml());

  cropWindow = new BrowserWindow({
    width: winW,
    height: winH,
    resizable: true,
    alwaysOnTop: true,
    title: "Выделение области",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  cropWindow.setMenuBarVisibility(false);
  cropWindow.loadFile(htmlPath);

  let settled = false;

  const handleSelect = (_event, cropRect) => {
    if (settled) return;
    settled = true;
    cleanup();
    onDone(cropRect);
  };
  const handleCancel = () => {
    if (settled) return;
    settled = true;
    cleanup();
    onDone(undefined);
  };

  function cleanup() {
    ipcMain.removeListener("crop-selector:select", handleSelect);
    ipcMain.removeListener("crop-selector:cancel", handleCancel);
    const w = cropWindow;
    cropWindow = null;
    // Окно могло уже быть уничтожено к этому моменту, если cleanup()
    // вызван ИЗ обработчика события "closed" (закрытие крестиком) —
    // повторный close() на уничтоженном окне бросает исключение.
    if (w && !w.isDestroyed()) {
      w.close();
    }
    cleanupTmpDir();
  }

  ipcMain.on("crop-selector:select", handleSelect);
  ipcMain.on("crop-selector:cancel", handleCancel);
  cropWindow.on("closed", handleCancel);
}

module.exports = { open };