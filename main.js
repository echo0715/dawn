const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let pythonProcess;

function startPythonBackend() {
  const backendPath = path.join(__dirname, 'backend', 'server.py');
  const browserUsePath = path.join(__dirname, 'browser-use');

  const env = {
    ...process.env,
    PYTHONPATH: browserUsePath + (process.env.PYTHONPATH ? ':' + process.env.PYTHONPATH : ''),
  };

  // Read .env file and set environment variables
  try {
    const fs = require('fs');
    const envContent = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.substring(0, eqIdx).trim();
          const value = trimmed.substring(eqIdx + 1).trim();
          // Map .env keys to expected env vars
          if (key === 'browser-use-api-key') {
            env['BROWSER_USE_API_KEY'] = value;
          } else if (key === 'openai-api-key') {
            env['OPENAI_API_KEY'] = value;
          } else {
            env[key] = value;
          }
        }
      }
    }
  } catch (e) {
    console.error('Could not read .env file:', e.message);
  }

  // Try to find Python in the browser-use venv first, then fall back to system python
  const venvPython = path.join(browserUsePath, '.venv', 'bin', 'python');
  const fs = require('fs');
  const pythonCmd = fs.existsSync(venvPython) ? venvPython : 'python3';

  pythonProcess = spawn(pythonCmd, [backendPath], {
    env,
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  pythonProcess.stdout.on('data', (data) => {
    console.log(`[Backend] ${data.toString().trim()}`);
  });

  pythonProcess.stderr.on('data', (data) => {
    console.error(`[Backend] ${data.toString().trim()}`);
  });

  pythonProcess.on('close', (code) => {
    console.log(`Backend process exited with code ${code}`);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e',
  });

  mainWindow.loadFile('index.html');
}

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

app.whenReady().then(() => {
  startPythonBackend();
  // Give backend a moment to start
  setTimeout(createWindow, 1500);
});

app.on('window-all-closed', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
  app.quit();
});

app.on('before-quit', () => {
  if (pythonProcess) {
    pythonProcess.kill();
  }
});
