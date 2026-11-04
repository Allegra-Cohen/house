// Bridges the renderer to file-based persistence + link fetching (see src/storage.ts).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("locusAPI", {
  load: () => ipcRenderer.invoke("world:load"),
  save: (world) => ipcRenderer.invoke("world:save", world),
  fetchLink: (url) => ipcRenderer.invoke("link:fetch", url),
  loginGoogle: () => ipcRenderer.invoke("auth:google"),
  authStatus: () => ipcRenderer.invoke("auth:status"),
  openLink: (url) => ipcRenderer.invoke("link:open", url),
  gcThumbs: (names) => ipcRenderer.invoke("thumbs:gc", names),
  machineChat: (req) => ipcRenderer.invoke("machine:chat", req),
  // Live status ("Thinking" / "Searching the web" / "Writing") during a chat turn.
  // Returns an unsubscribe fn.
  onMachineStatus: (cb) => {
    const h = (_e, status) => cb(status);
    ipcRenderer.on("machine:status", h);
    return () => ipcRenderer.removeListener("machine:status", h);
  },
});
