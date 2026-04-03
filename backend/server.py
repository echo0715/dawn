#!/usr/bin/env python3
"""
Backend server for Job Application Agent.
Uses browser-use Agent with native CDP connection to Electron's webviews.
The Electron app exposes --remote-debugging-port=9222, and browser-use
connects directly via CDP — getting full DOM snapshots, AX tree,
paint-order filtering, clickable element detection, multi-act, and watchdogs.
"""

import asyncio
import base64
import json
import logging
import os
import re
import sys
import traceback
from pathlib import Path
from urllib.parse import urlparse

import httpx
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Query
from pydantic import BaseModel

import openai

from job_scraper import fetch_and_store_jobs, get_all_jobs, get_job_stats, init_db

# ─── Monkey-patches for Electron CDP compatibility ───────────────────────────
# These must run BEFORE any BrowserSession is created.
#
# Problem 1: Electron's main window uses file:// URL which has no hostname.
#   browser-use's SecurityWatchdog rejects URLs with no hostname → closes
#   the main Electron window → kills the entire app.
# Fix: Allow file:// URLs in the security check.
#
# Problem 2: Electron <webview> tags appear as type="webview" in CDP.
#   browser-use's SessionManager only tracks type="page"/"tab", so the
#   webview target is invisible — no DOM monitoring, no page lifecycle.
# Fix: Remap "webview" → "page" in the target attach handler so
#   browser-use treats webviews as regular pages.

from browser_use.browser.watchdogs.security_watchdog import SecurityWatchdog
from browser_use.browser.session_manager import SessionManager

_orig_is_url_allowed = SecurityWatchdog._is_url_allowed

def _patched_is_url_allowed(self, url: str) -> bool:
	"""Allow file:// URLs (Electron's main window) through the security check."""
	if url.startswith('file://'):
		return True
	return _orig_is_url_allowed(self, url)

SecurityWatchdog._is_url_allowed = _patched_is_url_allowed

_orig_handle_target_attached = SessionManager._handle_target_attached

async def _patched_handle_target_attached(self, event) -> None:
	"""Remap 'webview' target type to 'page' so browser-use enables full
	page monitoring (DOM, lifecycle, screenshots) for Electron webviews."""
	target_info = event.get('targetInfo', {})
	if target_info.get('type') == 'webview':
		target_info['type'] = 'page'
	return await _orig_handle_target_attached(self, event)

SessionManager._handle_target_attached = _patched_handle_target_attached

# ─── Now import browser-use components ───────────────────────────────────────

from browser_use.agent.service import Agent
from browser_use.browser import BrowserProfile, BrowserSession
from browser_use.llm.openai.chat import ChatOpenAI

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(name)s] %(levelname)s %(message)s')
logger = logging.getLogger('job-agent')

app = FastAPI()

# Initialize job database on startup
init_db()


# ─── Job Gathering Endpoints ─────────────────────────────────────────────────

@app.post('/fetch-jobs')
async def fetch_jobs_endpoint():
    """Fetch latest jobs from GitHub and store in database."""
    try:
        stats = await fetch_and_store_jobs()
        return {'success': True, **stats}
    except Exception as e:
        logger.error(f'Fetch jobs error: {traceback.format_exc()}')
        return {'success': False, 'error': str(e)}


@app.get('/jobs')
async def get_jobs_endpoint(search: str = Query('', description='Search term'), category: str = Query('', description='Filter by category')):
    """Get all jobs from the database."""
    try:
        jobs = get_all_jobs(search=search, category=category)
        stats = get_job_stats()
        return {'success': True, 'jobs': jobs, 'stats': stats}
    except Exception as e:
        logger.error(f'Get jobs error: {traceback.format_exc()}')
        return {'success': False, 'error': str(e)}


# ─── Resume Parsing ──────────────────────────────────────────────────────────

class ResumeRequest(BaseModel):
	file_base64: str
	filename: str


@app.post('/parse-resume')
async def parse_resume(req: ResumeRequest):
	"""Extract profile info from a resume PDF using the LLM."""
	try:
		pdf_data = base64.b64decode(req.file_base64)

		# Try to extract text from PDF
		text = ''
		try:
			import fitz  # PyMuPDF
			doc = fitz.open(stream=pdf_data, filetype='pdf')
			for page in doc:
				text += page.get_text()
			doc.close()
		except ImportError:
			try:
				import pdfplumber
				import io
				with pdfplumber.open(io.BytesIO(pdf_data)) as pdf:
					for page in pdf.pages:
						text += (page.extract_text() or '')
			except ImportError:
				pass

		if not text.strip():
			response = await get_openai_client().chat.completions.create(
				model='gpt-5.4-mini',
				messages=[
					{'role': 'system', 'content': 'Extract the following fields from this resume image. Return ONLY a JSON object with keys: name, email, phone, linkedin, location. Use empty string for missing fields.'},
					{'role': 'user', 'content': [
						{'type': 'image_url', 'image_url': {'url': f'data:application/pdf;base64,{req.file_base64}', 'detail': 'high'}},
						{'type': 'text', 'text': 'Extract profile info from this resume.'},
					]},
				],
				max_tokens=512,
				temperature=0,
			)
		else:
			response = await get_openai_client().chat.completions.create(
				model='gpt-5.4-mini',
				messages=[
					{'role': 'system', 'content': 'Extract the following fields from this resume text. Return ONLY a JSON object with keys: name, email, phone, linkedin, location. Use empty string for missing fields. No markdown fences.'},
					{'role': 'user', 'content': f'Resume text:\n\n{text[:4000]}'},
				],
				max_tokens=512,
				temperature=0,
			)

		result_text = response.choices[0].message.content.strip()
		if result_text.startswith('```'):
			result_text = result_text.split('\n', 1)[1] if '\n' in result_text else result_text[3:]
			if result_text.endswith('```'):
				result_text = result_text[:-3]
			result_text = result_text.strip()

		profile = json.loads(result_text)
		return {'success': True, 'profile': profile}

	except Exception as e:
		logger.error(f'Resume parse error: {traceback.format_exc()}')
		return {'success': False, 'error': str(e)}


# ─── State ────────────────────────────────────────────────────────────────────

ws_connection: WebSocket | None = None
webview_ready_events: dict[str, asyncio.Event] = {}
webview_urls: dict[str, str] = {}


# ─── Communication with Electron (UI only — no browser control) ──────────────

async def send(msg: dict):
	if ws_connection:
		await ws_connection.send_text(json.dumps(msg))


async def log_to_frontend(session_id: str, message: str, log_type: str = 'info'):
	await send({
		'type': 'session_log',
		'session_id': session_id,
		'message': message,
		'log_type': log_type,
	})


# ─── LLM (for resume parsing only) ────────────────────────────────────────────

_openai_client = None

def get_openai_client():
	global _openai_client
	if _openai_client is None:
		_openai_client = openai.AsyncOpenAI()
	return _openai_client


# ─── CDP ─────────────────────────────────────────────────────────────────────

CDP_HTTP_URL = 'http://localhost:9222'


# ─── Job-specific instructions for browser-use Agent ──────────────────────────

JOB_APPLICATION_INSTRUCTIONS = """
You are filling out a job application form. Additional rules:
- Fill fields with the applicant's real information from the task description.
- For open-ended questions (cover letter, "why do you want to work here", etc.), write brief professional responses.
- For file uploads (resume), click the file input element to trigger the upload dialog.
- If you see a CAPTCHA you cannot bypass, report done with success=false.
- After submitting, verify the confirmation page and report done with success=true.
- If a page has "Apply", "Submit", or "Next" buttons, click them to proceed.
- Do not navigate away from the application site.
"""


# ─── Agent loop ───────────────────────────────────────────────────────────────

async def run_agent(session_id: str, url: str, profile: dict):
	"""Run the browser-use Agent for one job application session via native CDP."""
	browser_session = None
	try:
		await send({
			'type': 'session_status',
			'session_id': session_id,
			'status': 'running',
			'message': 'Waiting for page to load...',
			'log_type': 'info',
		})

		# Wait for the webview to signal it's loaded
		ready_event = webview_ready_events.get(session_id)
		if ready_event:
			try:
				await asyncio.wait_for(ready_event.wait(), timeout=20)
			except asyncio.TimeoutError:
				logger.warning(f'[{session_id}] Webview ready timeout, proceeding anyway')

		# Give the page a moment to fully render after dom-ready
		await asyncio.sleep(2)

		await log_to_frontend(session_id, 'Connecting to browser via CDP...', 'info')

		# Connect to Electron's browser-level CDP endpoint.
		# The monkey-patches above ensure:
		#   - file:// URLs (main window) aren't closed by SecurityWatchdog
		#   - webview targets are treated as page targets (full monitoring)
		browser_session = BrowserSession(
			cdp_url=CDP_HTTP_URL,
			keep_alive=True,
		)

		# Retry start() in case CDP isn't fully ready
		for attempt in range(3):
			try:
				await browser_session.start()
				break
			except Exception as e:
				if attempt < 2:
					logger.warning(f'[{session_id}] CDP start attempt {attempt + 1} failed: {e}, retrying...')
					await asyncio.sleep(2)
				else:
					raise

		# Find the webview target (now remapped to type 'page') and switch focus.
		# The main Electron window has a file:// URL, webviews have http(s) URLs.
		target_domain = urlparse(url).netloc
		page_targets = browser_session.session_manager.get_all_page_targets()

		logger.info(f'[{session_id}] Page targets after start ({len(page_targets)}):')
		for t in page_targets:
			logger.info(f'  {t.target_id}: type={t.target_type} url={t.url}')

		matched_target = None
		for t in page_targets:
			t_domain = urlparse(t.url).netloc
			if t_domain == target_domain:
				matched_target = t
				break

		if not matched_target:
			# Broader fallback: skip file:// and about:blank, match by domain substring
			for t in page_targets:
				if t.url.startswith('file://') or t.url == 'about:blank':
					continue
				if target_domain in t.url:
					matched_target = t
					break

		if not matched_target:
			raise RuntimeError(
				f'Could not find CDP target for {url}. '
				f'Page targets: {[(t.target_id[:8], t.url[:60]) for t in page_targets]}'
			)

		# Switch focus from the main window to the webview
		logger.info(f'[{session_id}] Focusing on webview target: {matched_target.target_id[:8]}... url={matched_target.url}')
		await browser_session.get_or_create_cdp_session(matched_target.target_id, focus=True)
		browser_session.agent_focus_target_id = matched_target.target_id

		await log_to_frontend(session_id, 'Connected to browser via CDP', 'info')

		# Build the task description with profile info
		profile_lines = []
		for key in ['name', 'email', 'phone', 'linkedin', 'location']:
			if profile.get(key):
				profile_lines.append(f"  {key}: {profile[key]}")
		if profile.get('resume'):
			profile_lines.append(f"  resume file: {profile['resume']}")
		profile_str = '\n'.join(profile_lines) if profile_lines else '  (no profile provided)'

		task = f"""Fill out and submit the job application at {url}.

Applicant profile:
{profile_str}

Use the applicant's profile information to fill in all form fields accurately."""

		llm = ChatOpenAI(
			model='gpt-5-mini',
			temperature=0.1,
		)

		# Create browser-use Agent with full CDP features:
		# - DOM + Snapshot + AX tree fusion
		# - Paint-order filtering (removes occluded elements)
		# - ClickableElementDetector (smart interactivity heuristics)
		# - Watchdogs (DOM, popups, security, downloads, captcha)
		# - CDP Input domain (realistic clicks/typing)
		# - Multi-act with stale-DOM guards
		agent = Agent(
			task=task,
			llm=llm,
			browser_session=browser_session,
			use_vision=True,
			max_actions_per_step=3,
			extend_system_message=JOB_APPLICATION_INSTRUCTIONS,
			directly_open_url=False,
		)

		async def on_step_start(agent_inst):
			step = agent_inst.state.n_steps
			await log_to_frontend(session_id, f'Step {step}: Analyzing page...', 'step')

		async def on_step_end(agent_inst):
			output = agent_inst.state.last_model_output
			if output and hasattr(output, 'current_state') and output.current_state:
				thinking = getattr(output.current_state, 'thinking', None)
				if thinking:
					thinking = re.sub(r'</?think>', '', thinking).strip()
					if thinking:
						await log_to_frontend(session_id, f'Agent: {thinking}', 'info')

		await log_to_frontend(session_id, 'Starting browser-use agent (CDP mode)...', 'info')
		history = await agent.run(
			max_steps=50,
			on_step_start=on_step_start,
			on_step_end=on_step_end,
		)

		success = history.is_done()
		final = history.final_result()
		done_msg = final if isinstance(final, str) else ('Application submitted successfully' if success else 'Agent finished without completing')

		await log_to_frontend(session_id, done_msg, 'success' if success else 'error')
		await send({
			'type': 'session_done',
			'session_id': session_id,
			'success': success,
			'message': done_msg,
		})

	except Exception as e:
		logger.error(f'Agent error [{session_id}]: {traceback.format_exc()}')
		await log_to_frontend(session_id, f'Error: {str(e)}', 'error')
		await send({
			'type': 'session_done',
			'session_id': session_id,
			'success': False,
			'message': f'Error: {str(e)}',
		})

	finally:
		if browser_session:
			try:
				await browser_session.stop()
			except Exception:
				pass


# ─── WebSocket endpoint ──────────────────────────────────────────────────────

@app.websocket('/ws')
async def websocket_endpoint(ws: WebSocket):
	global ws_connection
	await ws.accept()
	ws_connection = ws
	logger.info('Client connected')

	try:
		while True:
			data = await ws.receive_text()
			msg = json.loads(data)

			if msg['type'] == 'start_applications':
				urls = msg.get('urls', [])[:10]
				profile = msg.get('profile', {})

				for i, url in enumerate(urls):
					session_id = f'session_{i}'
					webview_ready_events[session_id] = asyncio.Event()
					await send({
						'type': 'session_created',
						'session_id': session_id,
						'url': url,
					})

				asyncio.create_task(run_agents_parallel(urls, profile))

			elif msg['type'] == 'webview_ready':
				sid = msg.get('session_id')
				webview_urls[sid] = msg.get('url', '')
				event = webview_ready_events.get(sid)
				if event:
					event.set()
				logger.info(f'Webview ready: {sid} -> {msg.get("url", "")}')

	except WebSocketDisconnect:
		logger.info('Client disconnected')
		ws_connection = None
	except Exception as e:
		logger.error(f'WebSocket error: {e}')
		ws_connection = None


async def run_agents_parallel(urls: list[str], profile: dict):
	"""Run agents in parallel — each gets its own BrowserSession
	(separate CDP WebSocket) focused on its own webview target."""
	tasks = [
		asyncio.create_task(run_agent(f'session_{i}', url, profile))
		for i, url in enumerate(urls)
	]
	await asyncio.gather(*tasks, return_exceptions=True)


if __name__ == '__main__':
	uvicorn.run(app, host='0.0.0.0', port=8765, log_level='info')
