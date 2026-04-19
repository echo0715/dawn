# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

**Dawn** is a desktop job application automation agent. It uses an Electron shell to display a UI and expose a Chrome DevTools Protocol (CDP) endpoint, a FastAPI Python backend to orchestrate AI agents, and the `browser-use` library to drive form-filling inside Electron webviews. Users upload a resume, browse a job board, queue URLs, and the agent fills and submits applications autonomously.

## Running the Project

```bash
./start.sh        # Recommended: installs deps if needed, kills port 9222, then launches
npm start         # Direct Electron launch (assumes deps already installed)
npm run dev       # Development mode with --dev flag
```

`start.sh` will:
1. Find the venv Python at `browser-use/.venv/bin/python` (or fall back to `python3`)
2. Install `backend/requirements.txt` into that venv
3. Run `npm install` if `node_modules` is missing
4. Kill any process on port 9222
5. Run `npm start`

The backend server starts as a child process of the Electron main process (spawned in `main.js`).

## Architecture

### Startup Sequence

1. Electron (`main.js`) launches with `--remote-debugging-port=9222` and anti-detection flags
2. Electron spawns `python3 backend/server.py` as a child process
3. After a 1.5s delay, Electron loads `index.html` into the `BrowserWindow`
4. Backend FastAPI runs on port **8765**; WebSocket at `ws://localhost:8765/ws`
5. User uploads resume → parsed by OpenAI → profile stored in frontend
6. User queues job URLs → backend creates `browser-use` Agent sessions
7. Agents connect to CDP (`http://localhost:9222`), control webviews, and stream logs back via WebSocket

### Key Files

| File | Role |
|---|---|
| `main.js` | Electron main process. Exposes CDP on 9222, injects stealth scripts into webviews, spawns Python backend, handles IPC (`select-file`, `fetch-jobs`, `get-jobs`, `parse-resume`) |
| `backend/server.py` | FastAPI server. Monkey-patches `browser-use` for Electron compatibility, defines REST and WebSocket endpoints, orchestrates Agent execution |
| `backend/job_scraper.py` | Fetches job listings from the `speedyapply/2026-SWE-College-Jobs` GitHub repo (markdown tables), parses into SQLite (`backend/jobs.db`) |
| `renderer.js` | Frontend logic for the three-page SPA (Jobs, Agent, Profile) |
| `index.html` + `styles.css` | UI markup and styling |
| `browser-use/` | Vendored open-source browser automation library. Has its own `CLAUDE.md` with development rules |

### CDP / Electron Integration

The `browser-use` library normally targets a standalone Chromium. Here it targets the Electron process:

- **`server.py` monkey-patches** `browser-use` at import time:
  - **SecurityWatchdog**: allows `file://` URLs (Electron loads its UI as `file://`)
  - **DOMWatchdog**: remaps Electron `<webview>` targets (`type="webview"`) → `type="page"` so the DOM service monitors them
- **Electron webviews** (not iframes) are used per job URL; each gets its own CDP target
- CDP connection: `CDP_HTTP_URL = "http://localhost:9222"`

### Anti-Detection

`main.js` injects JS into every webview on `did-attach-webview` and `dom-ready`:
- Removes `navigator.webdriver`
- Mocks `chrome.runtime`
- Spoofs `navigator.plugins` (PDF Viewer, Chrome PDF Plugin)
- Fixes `permissions.query` for notifications
- Spoof WebGL vendor/renderer to "Intel Inc." / "Intel Iris OpenGL Engine"
- Normalizes `window.outerWidth/outerHeight`
- Strips "Electron" from User-Agent

### Data Flow

1. **Resume parsing**: PDF → PyMuPDF text extraction → OpenAI `gpt-4o-mini` vision fallback → JSON `{name, email, phone, linkedin, location}`
2. **Job board**: `job_scraper.py` parses two GitHub markdown files (internships, new grad) → SQLite with categories: `FAANG+`, `quant`, `internship`, `new_grad`, `other`
3. **Agent task**: profile JSON + URL → `browser-use` Agent with OpenAI → screenshots DOM → LLM picks actions (click/type/scroll/submit) → repeat until done
4. **Real-time logs**: each Agent session streams events over the single WebSocket connection; frontend shows per-session log tabs

## Backend API Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/fetch-jobs` | Scrapes GitHub job repos and stores in SQLite |
| `GET` | `/jobs` | Returns jobs with optional search/filter query params |
| `POST` | `/parse-resume` | Accepts PDF (base64), returns parsed profile JSON |
| `WebSocket` | `/ws` | Bidirectional; receives session commands, streams logs |

## Python Environment

The browser-use library uses `uv`. For linting/testing that library:

```bash
cd browser-use
uv sync                             # Install all deps
uv run pytest -vxs tests/ci         # Run CI test suite
uv run pytest -vxs tests/ci/test_foo.py  # Single test file
uv run ruff check --fix             # Lint with auto-fix
uv run ruff format                  # Format
uv run pyright                      # Type check
```

The backend itself has no test suite — `test_urls.py` at the root is a standalone URL validation utility.

## Environment Variables

The backend and browser-use agents require API keys in a `.env` file (not committed):

```
OPENAI_API_KEY=...       # Required: resume parsing + agent LLM
ANTHROPIC_API_KEY=...    # Optional: alternative LLM for agents
GOOGLE_API_KEY=...       # Optional: alternative LLM for agents
```

## Code Style (browser-use library)

- Async Python throughout (`async def`, `await`)
- **Tabs** for indentation (not spaces)
- Modern union types: `str | None` not `Optional[str]`
- Single quotes for strings
- Line length: 130

The `backend/` code follows standard Python conventions (spaces, double quotes).
