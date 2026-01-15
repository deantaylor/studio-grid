const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  resizeForScale: (scale) => ipcRenderer.send("ui-scale-changed", scale),
  saveSet: (payload) => ipcRenderer.invoke("save-set", payload),
  setDirty: (dirty) => ipcRenderer.send("dirty-changed", { dirty: !!dirty }),
  onSaveBeforeQuit: (handler) => ipcRenderer.on("save-before-quit", handler),
  respondSaveBeforeQuit: (ok) => ipcRenderer.send("save-before-quit-result", { ok: !!ok })
});
