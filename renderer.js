// ─── State ────────────────────────────────────────────────────────────────────
let sessions = {};
let activeSessionId = null;
let ws = null;
let reconnectTimer = null;

// ─── DOM Elements ─────────────────────────────────────────────────────────────
const setupPanel = document.getElementById('setup-panel');
const mainApp = document.getElementById('main-app');
const sessionTabs = document.getElementById('session-tabs');
const webviewContainer = document.getElementById('webview-container');
const logArea = document.getElementById('log-area');
const logBarStatus = document.getElementById('log-bar-status');
const btnStart = document.getElementById('btn-start');
const btnBack = document.getElementById('btn-back');
const urlList = document.getElementById('url-list');
const btnAddUrl = document.getElementById('btn-add-url');
const resumeDropzone = document.getElementById('resume-dropzone');
const dropzoneContent = document.getElementById('dropzone-content');
const dropzoneLoaded = document.getElementById('dropzone-loaded');
const resumeFilename = document.getElementById('resume-filename');
const resumeStatus = document.getElementById('resume-status');
const profileCard = document.getElementById('profile-card');
const btnChangeResume = document.getElementById('btn-change-resume');

let currentProfile = {};
let resumePath = '';

// ─── Resume Upload & Profile Extraction ──────────────────────────────────────

async function selectAndParseResume() {
  const filePath = await window.electronAPI.selectFile();
  if (!filePath) return;

  resumePath = filePath;
  const filename = filePath.split('/').pop().split('\\').pop();

  // Show loaded state
  dropzoneContent.classList.add('hidden');
  dropzoneLoaded.classList.remove('hidden');
  resumeFilename.textContent = filename;
  resumeStatus.textContent = 'Extracting profile...';
  resumeStatus.className = 'resume-status';

  try {
    const result = await window.electronAPI.parseResume(filePath);
    if (result && result.success) {
      currentProfile = result.profile;
      currentProfile.resume = filePath;
      displayProfile(currentProfile);
      resumeStatus.textContent = 'Profile extracted';
      resumeStatus.className = 'resume-status done';
      localStorage.setItem('userProfile', JSON.stringify(currentProfile));
    } else {
      resumeStatus.textContent = result?.error || 'Could not extract profile';
      resumeStatus.className = 'resume-status error';
    }
  } catch (e) {
    resumeStatus.textContent = 'Error parsing resume';
    resumeStatus.className = 'resume-status error';
  }
}

function displayProfile(profile) {
  document.getElementById('profile-name').textContent = profile.name || '--';
  document.getElementById('profile-email').textContent = profile.email || '--';
  document.getElementById('profile-phone').textContent = profile.phone || '--';
  document.getElementById('profile-linkedin').textContent = profile.linkedin || '--';
  document.getElementById('profile-location').textContent = profile.location || '--';
  profileCard.classList.remove('hidden');
}

resumeDropzone.addEventListener('click', (e) => {
  if (e.target.closest('#btn-change-resume')) return;
  selectAndParseResume();
});

btnChangeResume.addEventListener('click', (e) => {
  e.stopPropagation();
  dropzoneContent.classList.remove('hidden');
  dropzoneLoaded.classList.add('hidden');
  profileCard.classList.add('hidden');
  resumePath = '';
  currentProfile = {};
  selectAndParseResume();
});

// ─── URL List Management ─────────────────────────────────────────────────────

function addUrlRow() {
  const rows = urlList.querySelectorAll('.url-row');
  if (rows.length >= 10) return;

  const index = rows.length;
  const row = document.createElement('div');
  row.className = 'url-row';
  row.innerHTML = `
    <div class="url-number">${index + 1}</div>
    <input type="url" class="url-input" placeholder="Paste job application URL..." data-index="${index}">
    <button class="btn-icon btn-remove-url" title="Remove">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;
  urlList.appendChild(row);
  updateUrlNumbers();
  updateRemoveButtons();
  row.querySelector('.url-input').focus();
}

function removeUrlRow(btn) {
  const row = btn.closest('.url-row');
  const rows = urlList.querySelectorAll('.url-row');
  if (rows.length <= 1) return;
  row.remove();
  updateUrlNumbers();
  updateRemoveButtons();
}

function updateUrlNumbers() {
  urlList.querySelectorAll('.url-row').forEach((row, i) => {
    row.querySelector('.url-number').textContent = i + 1;
    row.querySelector('.url-input').setAttribute('data-index', i);
  });
}

function updateRemoveButtons() {
  const rows = urlList.querySelectorAll('.url-row');
  rows.forEach(row => {
    const btn = row.querySelector('.btn-remove-url');
    if (rows.length <= 1) btn.classList.add('hidden');
    else btn.classList.remove('hidden');
  });
}

btnAddUrl.addEventListener('click', addUrlRow);

urlList.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-remove-url');
  if (btn) removeUrlRow(btn);
});

// Auto-add row when last input gets text
urlList.addEventListener('input', (e) => {
  if (!e.target.classList.contains('url-input')) return;
  const rows = urlList.querySelectorAll('.url-row');
  const lastInput = rows[rows.length - 1].querySelector('.url-input');
  if (e.target === lastInput && e.target.value.trim() && rows.length < 10) {
    addUrlRow();
  }
});

function getUrls() {
  const inputs = urlList.querySelectorAll('.url-input');
  return Array.from(inputs)
    .map(el => el.value.trim())
    .filter(u => u && (u.startsWith('http://') || u.startsWith('https://')));
}

// ─── Profile persistence ─────────────────────────────────────────────────────
function loadProfile() {
  try {
    const saved = localStorage.getItem('userProfile');
    if (saved) {
      currentProfile = JSON.parse(saved);
      if (currentProfile.resume) {
        resumePath = currentProfile.resume;
        const filename = resumePath.split('/').pop().split('\\').pop();
        dropzoneContent.classList.add('hidden');
        dropzoneLoaded.classList.remove('hidden');
        resumeFilename.textContent = filename;
        resumeStatus.textContent = 'Profile loaded';
        resumeStatus.className = 'resume-status done';
        displayProfile(currentProfile);
      }
    }
  } catch (e) { /* ignore */ }
}

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  ws = new WebSocket('ws://localhost:8765/ws');

  ws.onopen = () => {
    console.log('Connected to backend');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  ws.onmessage = (event) => {
    try { handleMessage(JSON.parse(event.data)); }
    catch (e) { console.error('Parse error:', e); }
  };

  ws.onclose = () => {
    reconnectTimer = setTimeout(connectWS, 2000);
  };

  ws.onerror = () => {};
}

function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ─── Message handling ─────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'session_created': {
      sessions[msg.session_id] = {
        id: msg.session_id,
        url: msg.url,
        status: 'pending',
        logs: [],
      };
      createWebview(msg.session_id, msg.url);
      renderTabs();
      // Auto-select first session
      if (!activeSessionId) selectSession(msg.session_id);
      break;
    }

    case 'session_status':
      if (!sessions[msg.session_id]) break;
      sessions[msg.session_id].status = msg.status;
      if (msg.message) addLog(msg.session_id, msg.message, msg.log_type || 'info');
      renderTabs();
      if (activeSessionId === msg.session_id) renderLogs();
      break;

    case 'session_log':
      if (!sessions[msg.session_id]) break;
      addLog(msg.session_id, msg.message, msg.log_type || 'info');
      if (activeSessionId === msg.session_id) renderLogs();
      break;

    case 'session_done':
      if (!sessions[msg.session_id]) break;
      sessions[msg.session_id].status = msg.success ? 'completed' : 'failed';
      addLog(msg.session_id, msg.message || (msg.success ? 'Done!' : 'Failed.'), msg.success ? 'success' : 'error');
      renderTabs();
      if (activeSessionId === msg.session_id) renderLogs();
      break;

    // Browser control (click, type, screenshot, DOM) is now handled
    // directly by browser-use via CDP — no relay needed.
  }
}

function addLog(sessionId, message, logType) {
  if (sessions[sessionId]) {
    sessions[sessionId].logs.push({
      time: new Date().toLocaleTimeString(),
      message,
      type: logType,
    });
  }
}

// ─── Webview management ───────────────────────────────────────────────────────
function createWebview(sessionId, url) {
  const webview = document.createElement('webview');
  webview.id = `webview-${sessionId}`;
  webview.setAttribute('src', url);
  webview.setAttribute('partition', `persist:${sessionId}`);
  // Allow useful features
  webview.setAttribute('allowpopups', '');

  webview.addEventListener('dom-ready', () => {
    const wcId = webview.getWebContentsId();
    window.electronAPI.registerWebview(sessionId, wcId);
    console.log(`Webview ready: ${sessionId} wcId=${wcId}`);
    // Notify backend that the webview has loaded — it can now find the CDP target
    sendMessage({ type: 'webview_ready', session_id: sessionId, url: webview.getURL() });
  });

  webview.addEventListener('did-navigate', (e) => {
    addLog(sessionId, `Navigated to ${e.url}`, 'info');
    if (activeSessionId === sessionId) renderLogs();
  });

  webviewContainer.appendChild(webview);
}

function showWebview(sessionId) {
  // Hide all webviews, show the selected one
  const webviews = webviewContainer.querySelectorAll('webview');
  webviews.forEach(wv => wv.classList.remove('active'));

  const emptyState = webviewContainer.querySelector('.webview-empty');
  if (emptyState) emptyState.remove();

  const target = document.getElementById(`webview-${sessionId}`);
  if (target) target.classList.add('active');
}

// ─── Start ────────────────────────────────────────────────────────────────────
btnStart.addEventListener('click', () => {
  const urls = getUrls();

  if (urls.length === 0) { alert('Please enter at least one valid URL'); return; }
  if (urls.length > 10) { alert('Maximum 10 URLs allowed'); return; }

  if (!resumePath) { alert('Please upload your resume first'); return; }

  const profile = currentProfile;

  // Switch view
  setupPanel.classList.add('hidden');
  mainApp.classList.remove('hidden');

  // Reset
  sessions = {};
  activeSessionId = null;
  webviewContainer.innerHTML = '';
  renderTabs();
  renderLogs();

  // Connect and send start command
  connectWS();
  const waitAndSend = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendMessage({ type: 'start_applications', urls, profile });
    } else {
      setTimeout(waitAndSend, 300);
    }
  };
  waitAndSend();
});

btnBack.addEventListener('click', () => {
  mainApp.classList.add('hidden');
  setupPanel.classList.remove('hidden');
  // Clean up webviews
  for (const sid of Object.keys(sessions)) {
    window.electronAPI.unregisterWebview(sid);
  }
  webviewContainer.innerHTML = '';
});

// ─── Render ───────────────────────────────────────────────────────────────────
function renderTabs() {
  sessionTabs.innerHTML = '';
  for (const session of Object.values(sessions)) {
    const tab = document.createElement('div');
    tab.className = `session-tab${session.id === activeSessionId ? ' active' : ''}`;
    tab.onclick = () => selectSession(session.id);

    let domain;
    try { domain = new URL(session.url).hostname; }
    catch { domain = session.url.substring(0, 30); }

    tab.innerHTML = `
      <div class="status-dot ${session.status}"></div>
      <div class="tab-info">
        <div class="tab-title">${domain}</div>
        <div class="tab-status">${capitalize(session.status)}</div>
      </div>
    `;
    sessionTabs.appendChild(tab);
  }
}

function selectSession(id) {
  activeSessionId = id;
  showWebview(id);
  renderTabs();
  renderLogs();
}

function renderLogs() {
  const session = sessions[activeSessionId];
  if (!session) {
    logArea.innerHTML = '';
    logBarStatus.textContent = '';
    logBarStatus.className = 'log-bar-status';
    return;
  }

  logBarStatus.textContent = capitalize(session.status);
  logBarStatus.className = `log-bar-status ${session.status}`;

  logArea.innerHTML = session.logs
    .map(l => `<div class="log-entry ${l.type}"><span class="log-time">[${l.time}]</span>${escapeHtml(l.message)}</div>`)
    .join('');
  logArea.scrollTop = logArea.scrollHeight;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Init ─────────────────────────────────────────────────────────────────────
loadProfile();
connectWS();
