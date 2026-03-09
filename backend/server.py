#!/usr/bin/env python3
"""
Backend server for Job Application Agent.
Manages browser-use agents via WebSocket communication with the Electron frontend.
"""

import asyncio
import base64
import json
import logging
import sys
import os
import traceback
from pathlib import Path

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

# Add browser-use to path
sys.path.insert(0, str(Path(__file__).parent.parent / 'browser-use'))

from browser_use import Agent, Browser, BrowserSession
from browser_use.llm import ChatOpenAI

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
logger = logging.getLogger('job-agent')

app = FastAPI()

# Store active WebSocket connections and agents
active_connections: list[WebSocket] = []
active_agents: dict[str, dict] = {}


async def broadcast(message: dict):
	"""Send a message to all connected WebSocket clients."""
	data = json.dumps(message)
	for conn in active_connections[:]:
		try:
			await conn.send_text(data)
		except Exception:
			active_connections.remove(conn)


async def send_to(ws: WebSocket, message: dict):
	"""Send a message to a specific WebSocket client."""
	try:
		await ws.send_text(json.dumps(message))
	except Exception:
		pass


def build_task_prompt(url: str, profile: dict) -> str:
	"""Build the task prompt for the browser-use agent."""
	profile_info = []
	if profile.get('name'):
		profile_info.append(f"Full Name: {profile['name']}")
	if profile.get('email'):
		profile_info.append(f"Email: {profile['email']}")
	if profile.get('phone'):
		profile_info.append(f"Phone: {profile['phone']}")
	if profile.get('linkedin'):
		profile_info.append(f"LinkedIn: {profile['linkedin']}")
	if profile.get('location'):
		profile_info.append(f"Location: {profile['location']}")

	profile_str = '\n'.join(profile_info) if profile_info else 'No profile information provided.'
	resume_note = f"\nResume file path: {profile['resume']}" if profile.get('resume') else ''

	return f"""You are a job application assistant. Your task is to complete a job application on the following page:

URL: {url}

Navigate to this URL and fill out the job application form using the following applicant information:

{profile_str}{resume_note}

Instructions:
1. First, navigate to the provided URL.
2. Look for the job application form on the page.
3. Fill in all required fields using the applicant information above.
4. If there is a resume upload field and a resume path is provided, upload the resume.
5. For any fields not covered by the profile info (like "Why do you want to work here?"), write a brief, professional response.
6. For dropdown menus, select the most appropriate option.
7. Review the form before submitting.
8. Submit the application.
9. Confirm that the application was submitted successfully.

If the page requires you to create an account or log in first, try to proceed as a guest or create a minimal account using the provided email.
If you encounter a CAPTCHA you cannot solve, report that the application could not be completed due to CAPTCHA.
"""


async def run_agent(session_id: str, url: str, profile: dict, ws: WebSocket):
	"""Run a browser-use agent for a single job application."""
	browser = None
	try:
		# Notify: session starting
		await send_to(ws, {
			'type': 'session_status',
			'session_id': session_id,
			'status': 'running',
			'message': f'Starting browser session...',
			'log_type': 'info',
		})

		# Create browser instance in headless mode — the user sees it
		# through live screenshots streamed into the Electron UI.
		browser = Browser(
			headless=True,
		)

		# Create LLM - use OpenAI GPT-4o
		llm = ChatOpenAI(model='gpt-4o')

		# Build task
		task = build_task_prompt(url, profile)

		# Build sensitive_data to protect user info
		sensitive_data = {}
		if profile.get('email') or profile.get('phone'):
			try:
				from urllib.parse import urlparse
				domain = urlparse(url).hostname or 'default'
			except Exception:
				domain = 'default'

			domain_data = {}
			if profile.get('email'):
				domain_data['x_email'] = profile['email']
			if profile.get('phone'):
				domain_data['x_phone'] = profile['phone']
			sensitive_data[domain] = domain_data

		# Create agent
		agent = Agent(
			task=task,
			llm=llm,
			browser=browser,
			use_vision=True,
			max_steps=50,
		)

		active_agents[session_id] = {'agent': agent, 'browser': browser}

		step_count = 0

		async def send_screenshot(agent_instance, label: str = ''):
			"""Capture and send a screenshot to the frontend."""
			try:
				if agent_instance.browser_session:
					screenshot_bytes = await agent_instance.browser_session.take_screenshot()
					if screenshot_bytes:
						screenshot_b64 = base64.b64encode(screenshot_bytes).decode('utf-8')
						await send_to(ws, {
							'type': 'session_screenshot',
							'session_id': session_id,
							'screenshot': screenshot_b64,
							'step': step_count,
						})
			except Exception as e:
				logger.debug(f'Screenshot error: {e}')

		async def on_step_start(agent_instance):
			"""Capture screenshot before the agent acts — shows pre-action state."""
			await send_screenshot(agent_instance, 'pre-action')

		async def on_step_end(agent_instance):
			nonlocal step_count
			step_count += 1

			# Capture screenshot after the agent acts — shows result
			await send_screenshot(agent_instance, 'post-action')

			try:
				# Send step info
				current_url = ''
				if agent_instance.state and hasattr(agent_instance.state, 'url'):
					current_url = agent_instance.state.url or ''

				# Get last action info from history
				action_info = ''
				if agent_instance.history and agent_instance.history.history:
					last = agent_instance.history.history[-1]
					if last.model_output and hasattr(last.model_output, 'current_state'):
						state = last.model_output.current_state
						if hasattr(state, 'next_goal'):
							action_info = state.next_goal

				message = f'Step {step_count}'
				if action_info:
					message += f': {action_info}'
				elif current_url:
					message += f' - {current_url}'

				await send_to(ws, {
					'type': 'session_log',
					'session_id': session_id,
					'message': message,
					'log_type': 'step',
				})
			except Exception as e:
				logger.error(f'Error in on_step_end: {e}')

		# Run the agent
		await send_to(ws, {
			'type': 'session_log',
			'session_id': session_id,
			'message': f'Navigating to {url}',
			'log_type': 'action',
		})

		result = await agent.run(
			max_steps=50,
			on_step_start=on_step_start,
			on_step_end=on_step_end,
		)

		# Check result
		success = result.is_done()
		final_result = result.final_result() or 'No result returned'

		await send_to(ws, {
			'type': 'session_done',
			'session_id': session_id,
			'success': success,
			'message': final_result,
		})

	except Exception as e:
		logger.error(f'Agent error for session {session_id}: {traceback.format_exc()}')
		await send_to(ws, {
			'type': 'session_done',
			'session_id': session_id,
			'success': False,
			'message': f'Error: {str(e)}',
		})
	finally:
		# Clean up
		if browser:
			try:
				await browser.kill()
			except Exception:
				pass
		active_agents.pop(session_id, None)


@app.websocket('/ws')
async def websocket_endpoint(ws: WebSocket):
	await ws.accept()
	active_connections.append(ws)
	logger.info('Client connected')

	try:
		while True:
			data = await ws.receive_text()
			msg = json.loads(data)

			if msg['type'] == 'start_applications':
				urls = msg.get('urls', [])
				profile = msg.get('profile', {})

				# Limit to 10 concurrent sessions
				urls = urls[:10]

				# Create session IDs and notify frontend
				tasks = []
				for i, url in enumerate(urls):
					session_id = f'session_{i}'
					await send_to(ws, {
						'type': 'session_created',
						'session_id': session_id,
						'url': url,
					})
					tasks.append(run_agent(session_id, url, profile, ws))

				# Run all agents concurrently (fire-and-forget via create_task)
				for t in tasks:
					asyncio.create_task(t)

	except WebSocketDisconnect:
		logger.info('Client disconnected')
		active_connections.remove(ws)
	except Exception as e:
		logger.error(f'WebSocket error: {e}')
		if ws in active_connections:
			active_connections.remove(ws)


if __name__ == '__main__':
	uvicorn.run(app, host='0.0.0.0', port=8765, log_level='info')
