// Electron bootstrap for studio:grid web.
// - launches the existing Node server (server/index.js)
// - opens a BrowserWindow pointed at the local app

import { app, BrowserWindow, dialog, screen, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import http from "node:http";
import net from "node:net";
// prevent server auto-start on import
process.env.ELECTRON_RUN_AS_NODE = "1";
import { startServer } from "../server/index.js";

let chosenPort = 3000;
let httpServer = null;
const BASE_WIDTH = 1080;
const BASE_HEIGHT = 690;

function clampWindowSize(scale = 1, widthOverride = null, heightOverride = null) {
  const { width: maxW, height: maxH } = screen.getPrimaryDisplay().workAreaSize;
  const targetW = widthOverride ? Math.round(widthOverride) : Math.round(BASE_WIDTH * scale);
  const targetH = heightOverride ? Math.round(heightOverride) : Math.round(BASE_HEIGHT * scale);
  return {
    width: Math.min(targetW, maxW),
    height: Math.min(targetH, maxH)
  };
}

function findFreePort(start = 3000, maxAttempts = 20) {
  return new Promise((resolve) => {
    const tryPort = (p, attempts) => {
      const server = net.createServer();
      server.unref();
      server.on("error", () => {
        if (attempts <= 0) resolve(start); // fallback
        else tryPort(p + 1, attempts - 1);
      });
      server.listen(p, () => {
        const { port } = server.address();
        server.close(() => resolve(port));
      });
    };
    tryPort(start, maxAttempts);
  });
}

async function ensureServer() {
  chosenPort = await findFreePort(3000);
  process.env.PORT = String(chosenPort);
  httpServer = await startServer(chosenPort);
}

function createWindow() {
  const win = new BrowserWindow({
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    show: false,
    useContentSize: true,
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

  // Resize to fit rendered content so no scrollbars are needed on first paint.
  const resizeToContent = async () => {
    try {
      const { width, height } = await win.webContents.executeJavaScript(
        `(() => {
          const uiScale = Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
          return { width: Math.ceil(1080 * uiScale), height: Math.ceil(690 * uiScale) };
        })();`
      );

      const { width: boundedWidth, height: boundedHeight } = clampWindowSize(1, width, height);

      win.setContentSize(boundedWidth, boundedHeight);
      win.center();
    } catch (e) {
      // ignore measurement failures and show the window at default size
    } finally {
      if (!win.isVisible()) win.show();
    }
  };

  win.on("close", (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Cancel", "Quit"],
      defaultId: 1,
      cancelId: 0,
      title: "Quit",
      message: "Are you sure you want to quit?",
      detail: "Unsaved changes may be lost."
    });
    if (choice === 0) {
      e.preventDefault();
    }
  });

  win.webContents.once("did-finish-load", resizeToContent);
  win.loadURL(`http://localhost:${chosenPort}`);
}

app.whenReady().then(async () => {
  await ensureServer();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on("ui-scale-changed", (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  let scale = 1;
  let width = null;
  let height = null;
  if (payload && typeof payload === "object") {
    scale = Number(payload.scale) || 1;
    width = Number(payload.width) || null;
    height = Number(payload.height) || null;
  } else {
    scale = Number(payload) || 1;
  }
  const { width: targetW, height: targetH } = clampWindowSize(scale, width, height);
  win.setContentSize(targetW, targetH);
  win.center();
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    if (httpServer) {
      try {
        httpServer.close();
      } catch (e) {}
    }
    // clear LEDs on exit
    try {
      const mod = await import("../server/index.js");
      mod?.serial?.clearAll?.();
    } catch (e) {}
    app.quit();
  }
});
