const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: () => ipcRenderer.invoke('select-file'),
  parseResume: (filePath) => ipcRenderer.invoke('parse-resume', filePath),
  registerWebview: (sessionId, webContentsId) =>
    ipcRenderer.send('register-webview', { sessionId, webContentsId }),
  unregisterWebview: (sessionId) =>
    ipcRenderer.send('unregister-webview', { sessionId }),
  fetchJobs: () => ipcRenderer.invoke('fetch-jobs'),
  getJobs: (search, category) => ipcRenderer.invoke('get-jobs', { search, category }),
});
