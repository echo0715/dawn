// ─── State ────────────────────────────────────────────────────────────────────
let sessions = {};
let activeSessionId = null;
let ws = null;
let reconnectTimer = null;

// ─── DOM Elements ─────────────────────────────────────────────────────────────
const setupPanel = document.getElementById('setup-panel');
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

// ─── Page Navigation ─────────────────────────────────────────────────────────

const navTabs = document.querySelectorAll('.nav-tab');
const pages = document.querySelectorAll('.page');

function switchToPage(pageName) {
  navTabs.forEach(t => t.classList.remove('active'));
  const targetTab = document.querySelector(`.nav-tab[data-page="${pageName}"]`);
  if (targetTab) targetTab.classList.add('active');
  pages.forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${pageName}`).classList.add('active');
}

navTabs.forEach(tab => {
  tab.addEventListener('click', () => switchToPage(tab.dataset.page));
});

// ─── Stats Updates ───────────────────────────────────────────────────────────

function updateStats() {
  // Jobs loaded
  const jobCards = document.querySelectorAll('.job-card');
  document.getElementById('stat-jobs-loaded').textContent = jobCards.length;

  // URLs queued
  const urls = getUrls();
  document.getElementById('stat-urls-queued').textContent = urls.length;

  // Profile status
  const profileStatus = document.getElementById('stat-profile-status');
  if (currentProfile.name) {
    profileStatus.textContent = 'Ready';
    profileStatus.style.color = 'var(--success)';
  } else {
    profileStatus.textContent = '--';
    profileStatus.style.color = '';
  }
}

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
      populateUserForm(currentProfile);
      resumeStatus.textContent = 'Profile extracted';
      resumeStatus.className = 'resume-status done';
      saveAllProfileData();
      updateStats();
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

function populateUserForm(profile) {
  if (profile.name) document.getElementById('user-name').value = profile.name;
  if (profile.email) document.getElementById('user-email').value = profile.email;
  if (profile.phone) document.getElementById('user-phone').value = profile.phone;
  if (profile.location) document.getElementById('user-location').value = profile.location;
  if (profile.linkedin) document.getElementById('user-linkedin').value = profile.linkedin;
  if (profile.github) document.getElementById('user-github').value = profile.github;
  if (profile.portfolio) document.getElementById('user-portfolio').value = profile.portfolio;
  if (profile.visa) document.getElementById('user-visa').value = profile.visa;
  if (profile.summary) document.getElementById('user-summary').value = profile.summary;
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

// ─── User Profile Form ──────────────────────────────────────────────────────

function getUserFormData() {
  return {
    name: document.getElementById('user-name').value.trim(),
    email: document.getElementById('user-email').value.trim(),
    phone: document.getElementById('user-phone').value.trim(),
    location: document.getElementById('user-location').value.trim(),
    linkedin: document.getElementById('user-linkedin').value.trim(),
    github: document.getElementById('user-github').value.trim(),
    portfolio: document.getElementById('user-portfolio').value.trim(),
    visa: document.getElementById('user-visa').value,
    summary: document.getElementById('user-summary').value.trim(),
  };
}

function saveAllProfileData() {
  const formData = getUserFormData();
  const merged = { ...currentProfile, ...formData, resume: resumePath };
  localStorage.setItem('userProfile', JSON.stringify(merged));
}

document.getElementById('btn-save-profile').addEventListener('click', () => {
  const formData = getUserFormData();
  currentProfile = { ...currentProfile, ...formData };
  saveAllProfileData();
  updateStats();

  const btn = document.getElementById('btn-save-profile');
  const originalHTML = btn.innerHTML;
  btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Saved!`;
  btn.style.borderColor = 'var(--success)';
  btn.style.color = 'var(--success)';
  setTimeout(() => {
    btn.innerHTML = originalHTML;
    btn.style.borderColor = '';
    btn.style.color = '';
  }, 2000);
});

// ─── URL List Management ─────────────────────────────────────────────────────

function addUrlRow(shouldFocus = true) {
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
  if (shouldFocus) row.querySelector('.url-input').focus();
}

function removeUrlRow(btn) {
  const row = btn.closest('.url-row');
  const rows = urlList.querySelectorAll('.url-row');
  if (rows.length <= 1) return;
  const removedUrl = row.querySelector('.url-input').value.trim();
  row.remove();
  updateUrlNumbers();
  updateRemoveButtons();
  updateStats();
  if (removedUrl) syncAddedUrls();
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
  updateStats();
  syncAddedUrls();
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
      populateUserForm(currentProfile);
      updateStats();
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
      sessions[msg.session_id].reviewReason = null;
      addLog(msg.session_id, msg.message || (msg.success ? 'Done!' : 'Failed.'), msg.success ? 'success' : 'error');
      renderTabs();
      if (activeSessionId === msg.session_id) renderLogs();
      break;

    case 'session_needs_review':
      if (!sessions[msg.session_id]) break;
      sessions[msg.session_id].status = 'needs_review';
      sessions[msg.session_id].reviewReason = msg.reason || 'Needs your attention';
      addLog(msg.session_id, `Needs review: ${msg.reason || ''}`, 'action');
      renderTabs();
      if (activeSessionId === msg.session_id) {
        renderLogs();
        selectSession(msg.session_id);
      }
      break;

    case 'session_resumed':
      if (!sessions[msg.session_id]) break;
      sessions[msg.session_id].status = 'running';
      sessions[msg.session_id].reviewReason = null;
      renderTabs();
      if (activeSessionId === msg.session_id) renderLogs();
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

// ─── Webview management ───────────────────────────────────────────────────────
function createWebview(sessionId, url) {
  const webview = document.createElement('webview');
  webview.id = `webview-${sessionId}`;
  webview.setAttribute('src', url);
  webview.setAttribute('partition', `persist:${sessionId}`);
  webview.setAttribute('allowpopups', '');

  webview.addEventListener('dom-ready', () => {
    const wcId = webview.getWebContentsId();
    window.electronAPI.registerWebview(sessionId, wcId);
    console.log(`Webview ready: ${sessionId} wcId=${wcId}`);
    sendMessage({ type: 'webview_ready', session_id: sessionId, url: webview.getURL() });
  });

  webview.addEventListener('did-navigate', (e) => {
    addLog(sessionId, `Navigated to ${e.url}`, 'info');
    if (activeSessionId === sessionId) renderLogs();
  });

  webviewContainer.appendChild(webview);
}

function showWebview(sessionId) {
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

  if (!resumePath) { alert('Please upload your resume first (go to Profile tab)'); return; }

  // Merge form data into profile before sending
  const formData = getUserFormData();
  const profile = { ...currentProfile, ...formData, resume: resumePath };

  // Switch to Agent tab
  switchToPage('agent');

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
  switchToPage('home');
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
    const needsReview = session.status === 'needs_review';
    tab.className = `session-tab${session.id === activeSessionId ? ' active' : ''}${needsReview ? ' needs-review' : ''}`;
    tab.onclick = (e) => {
      if (e.target.closest('.btn-resume-session')) return;
      selectSession(session.id);
    };

    let domain;
    try { domain = new URL(session.url).hostname; }
    catch { domain = session.url.substring(0, 30); }

    const statusLabel = needsReview ? 'Needs review' : capitalize(session.status);
    const reviewBadge = needsReview ? `<span class="review-badge">Review</span>` : '';
    const reasonLine = needsReview && session.reviewReason
      ? `<div class="tab-reason" title="${escapeHtml(session.reviewReason)}">${escapeHtml(session.reviewReason)}</div>`
      : '';
    const resumeBtn = needsReview
      ? `<button class="btn-resume-session" data-session-id="${session.id}" title="I've completed the human step — let the agent continue">Resume</button>`
      : '';

    tab.innerHTML = `
      <div class="status-dot ${session.status}"></div>
      <div class="tab-info">
        <div class="tab-title">${domain} ${reviewBadge}</div>
        <div class="tab-status">${statusLabel}</div>
        ${reasonLine}
        ${resumeBtn}
      </div>
    `;
    sessionTabs.appendChild(tab);
  }
}

sessionTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-resume-session');
  if (!btn) return;
  e.stopPropagation();
  const sid = btn.dataset.sessionId;
  if (!sid || !sessions[sid]) return;
  sessions[sid].status = 'running';
  sessions[sid].reviewReason = null;
  addLog(sid, 'Resumed by user', 'info');
  sendMessage({ type: 'resume_session', session_id: sid });
  renderTabs();
  if (activeSessionId === sid) renderLogs();
});

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

  logBarStatus.textContent = session.status === 'needs_review' ? 'Needs review' : capitalize(session.status);
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

// ─── Job Board ───────────────────────────────────────────────────────────────

const btnFetchJobs = document.getElementById('btn-fetch-jobs');
const btnFetchLabel = document.getElementById('btn-fetch-label');
const jobCardsContainer = document.getElementById('job-cards-container');
const addedUrls = new Set();

async function fetchJobs() {
  btnFetchJobs.classList.add('loading');
  btnFetchJobs.disabled = true;
  btnFetchLabel.textContent = 'Fetching...';

  jobCardsContainer.innerHTML = `
    <div class="job-loading-state">
      <div class="spinner"></div>
      <span>Fetching jobs from GitHub...</span>
    </div>
  `;

  try {
    const result = await window.electronAPI.fetchJobs();
    if (result && result.success) {
      await loadJobs();
    } else {
      jobCardsContainer.innerHTML = `
        <div class="job-empty-state">
          <p>Failed to fetch jobs</p>
          <p class="hint">${escapeHtml(result?.error || 'Check that the backend is running')}</p>
        </div>
      `;
    }
  } catch (e) {
    jobCardsContainer.innerHTML = `
      <div class="job-empty-state">
        <p>Failed to fetch jobs</p>
        <p class="hint">${escapeHtml(e.message)}</p>
      </div>
    `;
  } finally {
    btnFetchJobs.classList.remove('loading');
    btnFetchJobs.disabled = false;
    btnFetchLabel.textContent = 'Fetch Jobs';
  }
}

async function loadJobs() {
  try {
    const result = await window.electronAPI.getJobs('', '');
    if (result && result.success && result.jobs.length > 0) {
      renderJobCards(result.jobs);
      updateStats();
    }
  } catch (e) {
    console.error('loadJobs error:', e);
  }
}

function renderJobCards(jobs) {
  if (jobs.length === 0) return;

  const empty = jobCardsContainer.querySelector('.job-empty-state');
  if (empty) empty.remove();

  jobCardsContainer.innerHTML = jobs.filter(j => j.apply_url).map((job, i) => {
    const initial = (job.company || '?')[0].toUpperCase();
    const isAdded = addedUrls.has(job.apply_url);
    return `
      <div class="job-card${isAdded ? ' added' : ''}" data-index="${i}">
        <div class="job-card-icon">${escapeHtml(initial)}</div>
        <div class="job-card-body">
          <div class="job-card-company">${escapeHtml(job.company)}</div>
          <div class="job-card-title" title="${escapeHtml(job.position)}">${escapeHtml(job.position)}</div>
          <div class="job-card-meta">
            ${job.location ? `<span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
              ${escapeHtml(job.location)}
            </span>` : ''}
            ${job.salary ? `<span class="salary">${escapeHtml(job.salary)}</span>` : ''}
            ${job.age ? `<span>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
              ${escapeHtml(job.age)}
            </span>` : ''}
            ${job.category ? `<span class="category-tag">${escapeHtml(job.category)}</span>` : ''}
          </div>
        </div>
        <div class="job-card-actions">
          <button class="btn-add-job${isAdded ? ' added' : ''}" data-url="${escapeHtml(job.apply_url)}">${isAdded ? 'Added' : 'Add'}</button>
        </div>
      </div>
    `;
  }).join('');
}

// Sync addedUrls set with current URL list and update job card styles
function syncAddedUrls() {
  const currentUrls = new Set(
    Array.from(urlList.querySelectorAll('.url-input'))
      .map(input => input.value.trim())
      .filter(Boolean)
  );
  addedUrls.clear();
  currentUrls.forEach(url => addedUrls.add(url));

  // Update all job card buttons to reflect current state
  jobCardsContainer.querySelectorAll('.btn-add-job').forEach(btn => {
    const url = btn.dataset.url;
    if (currentUrls.has(url)) {
      btn.textContent = 'Added';
      btn.classList.add('added');
      btn.closest('.job-card').classList.add('added');
    } else {
      btn.textContent = 'Add';
      btn.classList.remove('added');
      btn.closest('.job-card').classList.remove('added');
    }
  });
}

// "Add" button: add the job URL to the application URL list
jobCardsContainer.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-add-job');
  if (!btn || btn.classList.contains('added')) return;
  const url = btn.dataset.url;
  if (!url) return;

  const inputs = urlList.querySelectorAll('.url-input');
  let filled = false;
  for (const input of inputs) {
    if (!input.value.trim()) {
      input.value = url;
      filled = true;
      break;
    }
  }
  if (!filled && inputs.length < 10) {
    addUrlRow(false);
    const newInputs = urlList.querySelectorAll('.url-input');
    const lastInput = newInputs[newInputs.length - 1];
    lastInput.value = url;
  }

  addedUrls.add(url);
  btn.textContent = 'Added';
  btn.classList.add('added');
  btn.closest('.job-card').classList.add('added');
  updateStats();
});

btnFetchJobs.addEventListener('click', fetchJobs);

// ─── Init ─────────────────────────────────────────────────────────────────────
loadProfile();
loadJobs();
connectWS();
updateStats();
