const { app, BrowserWindow, ipcMain, dialog, webContents } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let mainWindow;
let pythonProcess;

// Track webview webContents IDs for CDP automation
const webviewRegistry = {}; // sessionId -> webContentsId

// ─── CDP: Expose remote debugging for browser-use ───────────────────────────
app.commandLine.appendSwitch('remote-debugging-port', '9222');

// ─── Anti-Detection: Chromium flags ──────────────────────────────────────────
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
app.commandLine.appendSwitch('disable-features', 'IsolateOrigins,site-per-process');
app.commandLine.appendSwitch('enable-features', 'NetworkService,NetworkServiceInProcess');

// Strip "Electron" and app name from user agent to look like regular Chrome
app.on('ready', () => {
  const defaultUA = app.userAgentFallback;
  app.userAgentFallback = defaultUA
    .replace(/\s*Electron\/[\d.]+/, '')
    .replace(/\s*job_application_agent\/[\d.]+/i, '')
    .replace(/\s*job-application-agent\/[\d.]+/i, '');
});

// ─── Stealth injection script ────────────────────────────────────────────────
// Injected into every webview to mask automation signals
const STEALTH_SCRIPT = `
  // 1. Hide navigator.webdriver
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });

  // 2. Mock chrome.runtime to look like a normal Chrome browser
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: function() {},
      sendMessage: function() {},
      id: undefined,
    };
  }

  // 3. Mock navigator.plugins (headless/automation often has empty plugins)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      return plugins;
    },
    configurable: true,
  });

  // 4. Mock navigator.languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });

  // 5. Fix permissions API (automation often leaks "denied" for notifications)
  const originalQuery = window.navigator.permissions?.query?.bind(window.navigator.permissions);
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission });
      }
      return originalQuery(parameters);
    };
  }

  // 6. Prevent iframe contentWindow detection
  const originalAttachShadow = Element.prototype.attachShadow;
  if (originalAttachShadow) {
    Element.prototype.attachShadow = function() {
      return originalAttachShadow.apply(this, arguments);
    };
  }

  // 7. Fix window dimensions (missing outerWidth/outerHeight is a headless tell)
  if (window.outerWidth === 0) {
    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
  }
  if (window.outerHeight === 0) {
    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
  }

  // 8. Hardware concurrency (some bots report 0 or 1)
  if (navigator.hardwareConcurrency < 2) {
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 4 });
  }

  // 9. WebGL vendor/renderer spoofing (headless shows "Google" vendor)
  const getParameterOrig = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    // UNMASKED_VENDOR_WEBGL
    if (param === 37445) return 'Intel Inc.';
    // UNMASKED_RENDERER_WEBGL
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameterOrig.call(this, param);
  };
  const getParameterOrig2 = WebGL2RenderingContext.prototype.getParameter;
  WebGL2RenderingContext.prototype.getParameter = function(param) {
    if (param === 37445) return 'Intel Inc.';
    if (param === 37446) return 'Intel Iris OpenGL Engine';
    return getParameterOrig2.call(this, param);
  };
`;

function loadEnv() {
  const env = { ...process.env };
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
          if (key === 'browser-use-api-key') env['BROWSER_USE_API_KEY'] = value;
          else if (key === 'openai-api-key') env['OPENAI_API_KEY'] = value;
          else env[key] = value;
        }
      }
    }
  } catch (e) {
    console.error('Could not read .env:', e.message);
  }
  return env;
}

function startPythonBackend() {
  const env = loadEnv();
  const browserUsePath = path.join(__dirname, 'browser-use');
  env.PYTHONPATH = browserUsePath + (env.PYTHONPATH ? ':' + env.PYTHONPATH : '');

  const fs = require('fs');
  const venvPython = path.join(browserUsePath, '.venv', 'bin', 'python');
  const pythonCmd = fs.existsSync(venvPython) ? venvPython : 'python3';

  pythonProcess = spawn(pythonCmd, [path.join(__dirname, 'backend', 'server.py')], {
    env,
    cwd: __dirname,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  pythonProcess.stdout.on('data', (data) => console.log(`[Backend] ${data.toString().trim()}`));
  pythonProcess.stderr.on('data', (data) => console.error(`[Backend] ${data.toString().trim()}`));
  pythonProcess.on('close', (code) => console.log(`Backend exited: ${code}`));
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
      webviewTag: true,  // Enable <webview> tags
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f5f6fa',
  });

  mainWindow.loadFile('index.html');

  // When renderer creates a webview, inject stealth scripts & register it
  ipcMain.on('register-webview', (event, { sessionId, webContentsId }) => {
    webviewRegistry[sessionId] = webContentsId;
    console.log(`Registered webview for session ${sessionId}, wcId=${webContentsId}`);

    // Inject stealth script into the webview
    const wc = webContents.fromId(webContentsId);
    if (wc) {
      // Inject on every new page load (including navigations)
      wc.on('dom-ready', () => {
        wc.executeJavaScript(STEALTH_SCRIPT).catch(() => {});
      });
      // Also inject immediately if already loaded
      wc.executeJavaScript(STEALTH_SCRIPT).catch(() => {});

      // Override user agent on webview to remove Electron mentions
      const cleanUA = app.userAgentFallback;
      wc.setUserAgent(cleanUA);
    }
  });

  ipcMain.on('unregister-webview', (event, { sessionId }) => {
    delete webviewRegistry[sessionId];
  });
}

// ─── Helper ─────────────────────────────────────────────────────────────────

function getWebviewContents(sessionId) {
  const wcId = webviewRegistry[sessionId];
  if (!wcId) return null;
  return webContents.fromId(wcId);
}

ipcMain.handle('select-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle('fetch-jobs', async () => {
  try {
    const { net } = require('electron');
    const response = await net.fetch('http://localhost:8765/fetch-jobs', { method: 'POST' });
    return await response.json();
  } catch (e) {
    console.error('fetch-jobs error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-jobs', async (event, { search, category }) => {
  try {
    const { net } = require('electron');
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (category) params.set('category', category);
    const response = await net.fetch(`http://localhost:8765/jobs?${params.toString()}`);
    return await response.json();
  } catch (e) {
    console.error('get-jobs error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('parse-resume', async (event, filePath) => {
  try {
    const fs = require('fs');
    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    // Call the backend's parse-resume endpoint
    const { net } = require('electron');
    const fetch = net.fetch;
    const response = await fetch('http://localhost:8765/parse-resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_base64: base64Data, filename: path.basename(filePath) }),
    });
    const data = await response.json();
    return data;
  } catch (e) {
    console.error('parse-resume error:', e.message);
    return { success: false, error: e.message };
  }
});

app.whenReady().then(() => {
  startPythonBackend();
  setTimeout(createWindow, 1500);
});

app.on('window-all-closed', () => {
  if (pythonProcess) pythonProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (pythonProcess) pythonProcess.kill();
});
