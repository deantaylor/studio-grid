// Electron entrypoint (CommonJS) to avoid ESM loader surprises in packaged apps.
// - finds a free port
// - starts the existing Node server (server/index.js)
// - opens the BrowserWindow pointed at the local server
// - on quit, closes the server and clears the monome LEDs

const { app, BrowserWindow, dialog, screen, ipcMain } = require("electron");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let chosenPort = 3000;
let httpServer = null;
let serialRef = null;
let startServerFn = null;
let isQuitting = false;
let cleaningUp = false;
let pauseLedOutput = () => {};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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

function findFreePort(start = 3000, maxAttempts = 30) {
  return new Promise((resolve) => {
    const tryPort = (p, attemptsLeft) => {
      const srv = net.createServer();
      srv.unref();
      srv.once("error", () => {
        if (attemptsLeft <= 0) resolve(start);
        else tryPort(p + 1, attemptsLeft - 1);
      });
      srv.listen(p, () => {
        const { port } = srv.address();
        srv.close(() => resolve(port));
      });
    };
    tryPort(start, maxAttempts);
  });
}

async function ensureServer() {
  if (startServerFn && httpServer) return;
  // Import the ESM server module from CommonJS.
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "server", "index.js")));
  startServerFn = mod.startServer;
  serialRef = mod.serial;
  pauseLedOutput = mod.pauseLEDOutput || (() => {});

  chosenPort = await findFreePort(3000);
  process.env.PORT = String(chosenPort);
  httpServer = await startServerFn(chosenPort);
}

function createWindow() {
  const win = new BrowserWindow({
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    show: false,
    useContentSize: true,
    resizable: false,
    //  titleBarStyle: 'hidden',
 // titleBarOverlay: true, //
    webPreferences: {
      backgroundThrottling: false,
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, "preload.cjs")
    }
  });

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
      // ignore measurement issues and fall back to default sizing
    } finally {
      if (!win.isVisible()) win.show();
    }
  };

  win.on("close", (e) => {
    if (isQuitting) return;
    e.preventDefault();
    dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Cancel", "Quit"],
      defaultId: 1,
      cancelId: 0,
      title: "Quit",
      message: "Are you sure you want to quit?",
      detail: "Unsaved changes may be lost."
    }).then(({ response }) => {
      if (response === 1) {
        isQuitting = true;
        cleanupAndQuit();
      }
    }).catch(() => {});
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

async function cleanupAndQuit() {
  if (cleaningUp) return;
  cleaningUp = true;
  try {
    pauseLedOutput(true);
    serialRef?.clearAll?.();
  } catch (e) {
    // ignore
  }
  if (httpServer) {
    try {
      httpServer.close();
    } catch (e) {
      // ignore
    }
  }
  try {
    serialRef?.clearAll?.();
  } catch (e) {
    // ignore
  }
  app.quit();
}

app.on("window-all-closed", async () => {
  await cleanupAndQuit();
});
