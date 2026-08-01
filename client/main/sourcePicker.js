// sourcePicker.js — окно со списком источников (экраны + окна) для выбора
// цели захвата скриншота. Превью — через временные файлы, не data:-URL
// (та же причина белого экрана/лагов, что и в cropSelector.js).

const { BrowserWindow, desktopCapturer, ipcMain } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");

let pickerWindow = null;
let currentTmpDir = null;

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtml(sources, tmpDir) {
  const items = sources
    .map((s, i) => {
      const fileName = `thumb_${i}.png`;
      fs.writeFileSync(path.join(tmpDir, fileName), s.thumbnail.toPNG());
      return `
      <div class="item" onclick="select(${i})">
        <img src="${fileName}" />
        <div class="label">${escapeHtml(s.name)}</div>
      </div>`;
    })
    .join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: sans-serif; background:#1e1e1e; color:#eee; margin:0; padding:16px; }
    h2 { margin-top:0; font-size:15px; font-weight:normal; color:#aaa; }
    .grid { display:flex; flex-wrap:wrap; gap:12px; }
    .item { width:160px; cursor:pointer; border:2px solid transparent; padding:6px; border-radius:8px; }
    .item:hover { border-color:#4af; background:#2a2a2a; }
    .item img { width:100%; height:100px; object-fit:contain; background:#000; border-radius:4px; }
    .label { font-size:12px; margin-top:6px; word-break:break-word; text-align:center; }
  </style></head><body>
    <h2>Выбери, чем делиться — экран целиком или конкретное окно (Esc — отмена)</h2>
    <div class="grid">${items}</div>
    <script>
      const { ipcRenderer } = require("electron");
      function select(i) { ipcRenderer.send("source-picker:select", i); }
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape") ipcRenderer.send("source-picker:cancel");
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
 * Открывает окно выбора источника.
 * onSelected(source | null) — source это объект desktopCapturer (с .id,
 * .name), null означает отмену (Esc или закрытие окна).
 */
async function open(onSelected) {
  if (pickerWindow) {
    pickerWindow.focus();
    return;
  }

  const sources = await desktopCapturer.getSources({
    types: ["window", "screen"],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: false,
  });

  currentTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vtuber-picker-"));
  const htmlPath = path.join(currentTmpDir, "index.html");
  fs.writeFileSync(htmlPath, buildHtml(sources, currentTmpDir));

  pickerWindow = new BrowserWindow({
    width: 760,
    height: 560,
    resizable: true,
    alwaysOnTop: true,
    title: "Выбор источника для скриншота",
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  pickerWindow.setMenuBarVisibility(false);
  pickerWindow.loadFile(htmlPath);

  let settled = false;

  const handleSelect = (_event, index) => {
    if (settled) return;
    settled = true;
    cleanup();
    onSelected(sources[index] || null);
  };
  const handleCancel = () => {
    if (settled) return;
    settled = true;
    cleanup();
    onSelected(null);
  };

  function cleanup() {
    ipcMain.removeListener("source-picker:select", handleSelect);
    ipcMain.removeListener("source-picker:cancel", handleCancel);
    const w = pickerWindow;
    pickerWindow = null;
    // Уже может быть уничтожено, если cleanup() вызван из "closed"
    // (закрытие крестиком) — повторный close() бросает исключение.
    if (w && !w.isDestroyed()) {
      w.close();
    }
    cleanupTmpDir();
  }

  ipcMain.on("source-picker:select", handleSelect);
  ipcMain.on("source-picker:cancel", handleCancel);
  pickerWindow.on("closed", handleCancel);
}

module.exports = { open };