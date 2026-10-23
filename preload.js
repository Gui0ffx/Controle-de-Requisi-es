'use strict';
// Única ponte entre a interface e o sistema: um canal genérico cujo conteúdo é
// validado e roteado (lista fechada de rotas) no processo principal.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rcApi', Object.freeze({
  request: (metodo, url, corpo) => ipcRenderer.invoke('rc:request', String(metodo), String(url), corpo),
}));
