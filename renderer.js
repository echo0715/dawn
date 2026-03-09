// State
let sessions = {};
let activeSessionId = null;
let ws = null;
let reconnectTimer = null;

// DOM elements
const setupPanel = document.getElementById('setup-panel');
const mainApp = document.getElementById('main-app');
const sessionTabs = document.getElementById('session-tabs');
const sessionView = document.getElementById('session-view');
const btnStart = document.getElementById('btn-start');
const btnBack = document.getElementById('btn-back');
const btnSelectResume = document.getElementById('btn-select-resume');
const urlsInput = document.getElementById('urls-input');

// Profile fields
const profileFields = {
  name: document.getElementById('profile-name'),
  email: document.getElementById('profile-email'),
  phone: document.getElementById('profile-phone'),
  linkedin: document.getElementById('profile-linkedin'),
  location: document.getElementById('profile-location'),
  resume: document.getElementById('profile-resume'),
};

// Load saved profile from localStorage
function loadProfile() {
  try {
    const saved = localStorage.getItem('userProfile');
    if (saved) {
      const profile = JSON.parse(saved);
      for (const [key, el] of Object.entries(profileFields)) {
        if (profile[key]) el.value = profile[key];
      }
    }
  } catch (e) { /* ignore */ }
}

function saveProfile() {
  const profile = {};
  for (const [key, el] of Object.entries(profileFields)) {
    profile[key] = el.value.trim();
  }
  localStorage.setItem('userProfile', JSON.stringify(profile));
  return profile;
}

// Resume file picker
btnSelectResume.addEventListener('click', async () => {
  const filePath = await window.electronAPI.selectFile();
  if (filePath) {
    profileFields.resume.value = filePath;
  }
});

// WebSocket connection
function connectWS() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket('ws://localhost:8765/ws');

  ws.onopen = () => {
    console.log('Connected to backend');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  };

  ws.onclose = () => {
    console.log('WebSocket closed, reconnecting...');
    reconnectTimer = setTimeout(connectWS, 2000);
  };

  ws.onerror = (err) => {
    console.error('WebSocket error:', err);
  };
}

function sendMessage(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Handle incoming messages
function handleMessage(msg) {
  switch (msg.type) {
    case 'session_created':
      sessions[msg.session_id] = {
        id: msg.session_id,
        url: msg.url,
        status: 'pending',
        screenshot: null,
        logs: [],
        step: 0,
      };
      renderTabs();
      break;

    case 'session_status':
      if (sessions[msg.session_id]) {
        sessions[msg.session_id].status = msg.status;
        if (msg.message) {
          addLog(msg.session_id, msg.message, msg.log_type || 'info');
        }
        renderTabs();
        if (activeSessionId === msg.session_id) renderSessionView();
      }
      break;

    case 'session_screenshot':
      if (sessions[msg.session_id]) {
        sessions[msg.session_id].screenshot = msg.screenshot;
        sessions[msg.session_id].step = msg.step || 0;
        if (activeSessionId === msg.session_id) renderScreenshot();
      }
      break;

    case 'session_log':
      if (sessions[msg.session_id]) {
        addLog(msg.session_id, msg.message, msg.log_type || 'info');
        if (activeSessionId === msg.session_id) renderLogs();
      }
      break;

    case 'session_done':
      if (sessions[msg.session_id]) {
        sessions[msg.session_id].status = msg.success ? 'completed' : 'failed';
        addLog(msg.session_id, msg.message || (msg.success ? 'Application submitted successfully!' : 'Application failed.'), msg.success ? 'success' : 'error');
        renderTabs();
        if (activeSessionId === msg.session_id) renderSessionView();
      }
      break;

    case 'error':
      console.error('Backend error:', msg.message);
      break;
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

// Start applications
btnStart.addEventListener('click', () => {
  const urls = urlsInput.value
    .split('\n')
    .map(u => u.trim())
    .filter(u => u && (u.startsWith('http://') || u.startsWith('https://')));

  if (urls.length === 0) {
    alert('Please enter at least one valid URL');
    return;
  }

  if (urls.length > 10) {
    alert('Maximum 10 URLs allowed');
    return;
  }

  const profile = saveProfile();

  // Switch to main view
  setupPanel.classList.add('hidden');
  mainApp.classList.remove('hidden');

  // Reset state
  sessions = {};
  activeSessionId = null;
  renderTabs();
  renderSessionView();

  // Connect and send
  connectWS();

  // Wait for connection then send
  const waitAndSend = () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendMessage({
        type: 'start_applications',
        urls,
        profile,
      });
    } else {
      setTimeout(waitAndSend, 500);
    }
  };
  waitAndSend();
});

// Back button
btnBack.addEventListener('click', () => {
  mainApp.classList.add('hidden');
  setupPanel.classList.remove('hidden');
});

// Render sidebar tabs
function renderTabs() {
  sessionTabs.innerHTML = '';
  for (const session of Object.values(sessions)) {
    const tab = document.createElement('div');
    tab.className = `session-tab${session.id === activeSessionId ? ' active' : ''}`;
    tab.onclick = () => selectSession(session.id);

    let domain;
    try {
      domain = new URL(session.url).hostname;
    } catch {
      domain = session.url.substring(0, 30);
    }

    tab.innerHTML = `
      <div class="status-dot ${session.status}"></div>
      <div class="tab-info">
        <div class="tab-title">${domain}</div>
        <div class="tab-status">${capitalizeStatus(session.status)}</div>
      </div>
    `;
    sessionTabs.appendChild(tab);
  }
}

function capitalizeStatus(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function selectSession(id) {
  activeSessionId = id;
  renderTabs();
  renderSessionView();
}

// Render session detail view
function renderSessionView() {
  const session = sessions[activeSessionId];
  if (!session) {
    sessionView.innerHTML = '<div class="empty-state"><p>Select a session from the sidebar to view progress</p></div>';
    return;
  }

  sessionView.innerHTML = `
    <div class="session-detail">
      <div class="session-header">
        <span class="session-url" title="${session.url}">${session.url}</span>
        <span class="session-status-badge ${session.status}">${capitalizeStatus(session.status)}</span>
      </div>
      <div class="session-body">
        <div class="screenshot-container" id="screenshot-area">
          ${session.screenshot
            ? `<img src="data:image/png;base64,${session.screenshot}" alt="Browser screenshot">
               <div class="screenshot-step">Step ${session.step}</div>`
            : '<div class="screenshot-placeholder">Waiting for browser session to start...</div>'
          }
        </div>
        <div class="log-container" id="log-area">
          ${session.logs.map(l => `<div class="log-entry ${l.type}"><span style="color:var(--text-muted)">[${l.time}]</span> ${escapeHtml(l.message)}</div>`).join('')}
        </div>
      </div>
    </div>
  `;

  // Auto-scroll logs
  const logArea = document.getElementById('log-area');
  if (logArea) logArea.scrollTop = logArea.scrollHeight;
}

function renderScreenshot() {
  const session = sessions[activeSessionId];
  if (!session) return;
  const area = document.getElementById('screenshot-area');
  if (!area) return;

  if (session.screenshot) {
    area.innerHTML = `
      <img src="data:image/png;base64,${session.screenshot}" alt="Browser screenshot">
      <div class="screenshot-step">Step ${session.step}</div>
    `;
  }
}

function renderLogs() {
  const session = sessions[activeSessionId];
  if (!session) return;
  const logArea = document.getElementById('log-area');
  if (!logArea) return;

  logArea.innerHTML = session.logs
    .map(l => `<div class="log-entry ${l.type}"><span style="color:var(--text-muted)">[${l.time}]</span> ${escapeHtml(l.message)}</div>`)
    .join('');
  logArea.scrollTop = logArea.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Init
loadProfile();
connectWS();
