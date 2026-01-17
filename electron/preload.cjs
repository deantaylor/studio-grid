const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  resizeForScale: (scale) => ipcRenderer.send("ui-scale-changed", scale),
  saveSet: (payload) => ipcRenderer.invoke("save-set", payload),
  setDirty: (dirty) => ipcRenderer.send("dirty-changed", { dirty: !!dirty }),
  onSaveBeforeQuit: (handler) => ipcRenderer.on("save-before-quit", handler),
  respondSaveBeforeQuit: (ok) => ipcRenderer.send("save-before-quit-result", { ok: !!ok }),
  onAppUndoRedo: (handler) => ipcRenderer.on("app-undo-redo", (_event, payload) => handler(payload)),
  onAppMenuAction: (handler) => ipcRenderer.on("app-menu-action", (_event, payload) => handler(payload))
});
