const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  resizeForScale: (scale) => ipcRenderer.send("ui-scale-changed", scale)
});
