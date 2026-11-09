"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("busyDesktop", {
  subscriptions: {
    cancelChatGpt: () => ipcRenderer.invoke("busy:ai:chatgpt:cancel"),
    openChatGpt: (attempt) =>
      ipcRenderer.invoke("busy:ai:chatgpt:open", attempt),
    prepareChatGpt: () => ipcRenderer.invoke("busy:ai:chatgpt:prepare"),
  },
});
