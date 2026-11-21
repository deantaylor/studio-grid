// Electron entrypoint (CommonJS) to avoid ESM loader surprises in packaged apps.
// - finds a free port
// - starts the existing Node server (server/index.js)
// - opens the BrowserWindow pointed at the local server
// - on quit, closes the server and clears the monome LEDs

const { app, BrowserWindow, dialog, screen, ipcMain, Menu, powerSaveBlocker } = require("electron");
const fs = require("node:fs/promises");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createNiSettings } = require("./ni-settings.cjs");

// The renderer owns Web MIDI and the internal clock, even when its window is hidden.
app.commandLine.appendSwitch("disable-renderer-backgrounding");

let chosenPort = 3000;
let httpServer = null;
let serialRef = null;
let startServerFn = null;
let isQuitting = false;
let allowQuit = false;
let rendererDirty = false;
let cleaningUp = false;
const niSettings = createNiSettings(app);
const niServerUrl = () => `ws://127.0.0.1:${chosenPort}`;
let playbackBlocker = null;
let pauseLedOutput = () => {};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BASE_WIDTH = 1080;
const BASE_HEIGHT = 690;
const SETS_DIR_PARTS = ["studio-grid", "sets"];

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    }] : []),
    {
      label: "File",
      submenu: [
        {
          label: "New Project",
          accelerator: "CommandOrControl+N",
          click: (_item, win) => win?.webContents.send("app-menu-action", { action: "new-project" })
        },
        {
          label: "Open Project...",
          accelerator: "CommandOrControl+O",
          click: (_item, win) => win?.webContents.send("app-menu-action", { action: "load-project" })
        },
        {
          label: "Save Project...",
          accelerator: "CommandOrControl+S",
          click: (_item, win) => win?.webContents.send("app-menu-action", { action: "save-project" })
        },
        {
          label: "Save New Project As...",
          accelerator: "CommandOrControl+Shift+S",
          click: (_item, win) => win?.webContents.send("app-menu-action", { action: "save-project-as" })
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CommandOrControl+,",
          click: (_item, win) => win?.webContents.send("app-menu-action", { action: "settings" })
        }
      ]
    },
    {
      label: "Edit",
      submenu: [
        {
          label: "Undo",
          accelerator: "CommandOrControl+Z",
          click: (_item, win) => win?.webContents.send("app-undo-redo", { action: "undo" })
        },
        {
          label: "Redo",
          accelerator: isMac ? "Shift+CommandOrControl+Z" : "CommandOrControl+Y",
          click: (_item, win) => win?.webContents.send("app-undo-redo", { action: "redo" })
        },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac ? [{ role: "pasteAndMatchStyle" }] : []),
        { role: "delete" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [
          { type: "separator" },
          { role: "front" },
          { type: "separator" },
          { role: "window" }
        ] : [{ role: "close" }])
      ]
    }
  ];
  return Menu.buildFromTemplate(template);
}

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

async function ensureSetsDir() {
  const docsDir = app.getPath("documents");
  const setsDir = path.join(docsDir, ...SETS_DIR_PARTS);
  await fs.mkdir(setsDir, { recursive: true });
  return setsDir;
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (e) {
    return false;
  }
}

async function uniqueFilename(dir, desired) {
  const clean = path.basename(desired || "Untitled.studiogrid");
  const parsed = path.parse(clean);
  const ext = parsed.ext || ".studiogrid";
  const base = parsed.name || "Untitled";
  let candidate = `${base}${ext}`;
  let idx = 1;
  while (await fileExists(path.join(dir, candidate))) {
    idx += 1;
    candidate = `${base} (${idx})${ext}`;
  }
  return candidate;
}

function requestRendererSave(win) {
  return new Promise((resolve) => {
    const handler = (_event, payload) => {
      ipcMain.off("save-before-quit-result", handler);
      resolve(!!payload?.ok);
    };
    ipcMain.on("save-before-quit-result", handler);
    win.webContents.send("save-before-quit");
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
  httpServer = await startServerFn(chosenPort, { onTransportChange: keepPlaybackActive });
}

function keepPlaybackActive(running) {
  if (running && playbackBlocker === null) {
    playbackBlocker = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!running && playbackBlocker !== null) {
    powerSaveBlocker.stop(playbackBlocker);
    playbackBlocker = null;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: BASE_WIDTH,
    height: BASE_HEIGHT,
    show: false,
    useContentSize: true,
    resizable: false,
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
          const scale = Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) || 1;
          const fallbackWidth = 1080;
          const fallbackHeight = 690;
          // Temporarily reset zoom to 1 for an accurate natural-size measurement.
          // All three steps (set, measure, restore) run synchronously inside the renderer
          // before any paint, so there is no visible flicker.
          document.documentElement.style.setProperty("--ui-scale", "1");
          // Only measure height — width is fixed by design and scrollWidth from body/
          // documentElement can be inflated by absolutely-positioned elements (menus, toasts).
          const appShell = document.getElementById("app-shell");
          const naturalH = appShell
            ? Math.max(appShell.scrollHeight || 0, appShell.offsetHeight || 0, fallbackHeight)
            : fallbackHeight;
          document.documentElement.style.setProperty("--ui-scale", String(scale));
          return {
            width: Math.ceil(fallbackWidth * scale),
            height: Math.ceil(naturalH * scale)
          };
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
    if (allowQuit || isQuitting) return;
    e.preventDefault();
    const hasChanges = rendererDirty;
    const buttons = hasChanges ? ["Cancel", "Save and Quit", "Quit"] : ["Cancel", "Quit"];
    const defaultId = hasChanges ? 1 : 1;
    const cancelId = 0;
    dialog.showMessageBox(win, {
      type: "question",
      buttons,
      defaultId,
      cancelId,
      title: "Quit",
      message: "Are you sure you want to quit?",
      detail: hasChanges ? "Unsaved changes may be lost." : ""
    }).then(async ({ response }) => {
      if (response === 0) return;
      if (!hasChanges) {
        allowQuit = true;
        win.close();
        return;
      }
      if (response === 2) {
        allowQuit = true;
        win.close();
        return;
      }
      if (response === 1) {
        const ok = await requestRendererSave(win);
        if (!ok) return;
        allowQuit = true;
        win.close();
      }
    }).catch(() => {});
  });

  const scheduleSecondResize = () => {
    setTimeout(() => {
      resizeToContent();
    }, 250);
  };

  const handleDidFinishLoad = () => {
    resizeToContent();
    scheduleSecondResize();
  };

  win.webContents.on("did-finish-load", handleDidFinishLoad);
  win.loadURL(`http://localhost:${chosenPort}`);
}

app.whenReady().then(async () => {
  await ensureServer();
  Menu.setApplicationMenu(buildAppMenu());
  await niSettings.start(niServerUrl());
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.on("ui-scale-changed", (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  let width = null;
  let height = null;
  const scale = (payload && typeof payload === "object")
    ? (Number(payload.scale) || 1)
    : (Number(payload) || 1);
  if (payload && typeof payload === "object") {
    width = Number(payload.width) || null;
    height = Number(payload.height) || null;
  }
  const { width: targetW, height: targetH } = clampWindowSize(scale, width, height);
  win.setContentSize(targetW, targetH);
  win.center();
});

ipcMain.on("dirty-changed", (_event, payload) => {
  rendererDirty = !!payload?.dirty;
});

ipcMain.handle("get-ni-bridge-setting", () => niSettings.status());
ipcMain.handle("set-ni-bridge-setting", (_event, enabled) =>
  cleaningUp ? niSettings.status() : niSettings.setEnabled(niServerUrl(), enabled)
);

ipcMain.handle("save-set", async (_event, payload) => {
  const data = payload?.data;
  if (!data || typeof data !== "object") {
    throw new Error("Invalid set data");
  }
  const requested = typeof payload?.name === "string" ? payload.name : "Untitled.studiogrid";
  const overwrite = !!payload?.overwrite;
  const setsDir = await ensureSetsDir();
  const name = overwrite ? path.basename(requested) : await uniqueFilename(setsDir, requested);
  const targetPath = path.join(setsDir, name);
  await fs.writeFile(targetPath, JSON.stringify(data, null, 2), "utf8");
  return { filename: name, path: targetPath };
});

async function cleanupAndQuit() {
  if (cleaningUp) return;
  cleaningUp = true;
  await niSettings.stop();
  keepPlaybackActive(false);
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
