#!/usr/bin/env python3
"""Test script: connects via WebSocket and sends 5 job URLs to the backend."""

import asyncio
import json
import websockets

TEST_URLS = [
    "https://www.amazon.jobs/jobs/3179209/apply",
    "https://nvidia.wd5.myworkdayjobs.com/en-US/nvidiaexternalcareersite/job/US-CA-Santa-Clara/NVIDIA-2026-Internships--Software-Engineering-_JR2003206",
    "https://salesforce.wd12.myworkdayjobs.com/en-US/external_career_site/job/California---San-Francisco/Summer-2026-Intern---Software-Engineer_JR308796-1",
    "https://jobs.lever.co/palantir/030ece08-c341-4959-bdfe-314e89b691ce/apply",
    "https://careers.roblox.com/jobs/7654991?gh_jid=7654991",
]

FAKE_PROFILE = {
    "name": "John Smith",
    "email": "john.smith@example.com",
    "phone": "(555) 123-4567",
    "linkedin": "linkedin.com/in/johnsmith",
    "location": "San Francisco, CA",
    "resume": "/tmp/fake_resume.pdf",
}


async def main():
    uri = "ws://localhost:8765/ws"
    try:
        async with websockets.connect(uri) as ws:
            print(f"Connected to {uri}")

            # Send start_applications with 5 URLs
            msg = {
                "type": "start_applications",
                "urls": TEST_URLS,
                "profile": FAKE_PROFILE,
            }
            await ws.send(json.dumps(msg))
            print(f"Sent start_applications with {len(TEST_URLS)} URLs")

            # Listen for responses
            while True:
                try:
                    response = await asyncio.wait_for(ws.recv(), timeout=120)
                    data = json.loads(response)
                    msg_type = data.get("type", "unknown")
                    session_id = data.get("session_id", "")

                    if msg_type == "session_created":
                        print(f"  [{session_id}] CREATED -> {data.get('url', '')[:60]}")
                        # Simulate webview_ready (since we don't have Electron webviews)
                        await asyncio.sleep(0.5)
                        ready_msg = {
                            "type": "webview_ready",
                            "session_id": session_id,
                            "url": data.get("url", ""),
                        }
                        await ws.send(json.dumps(ready_msg))
                        print(f"  [{session_id}] Sent webview_ready")
                    elif msg_type == "session_status":
                        print(f"  [{session_id}] STATUS: {data.get('status', '')} - {data.get('message', '')}")
                    elif msg_type == "session_log":
                        log_type = data.get("log_type", "info")
                        print(f"  [{session_id}] LOG ({log_type}): {data.get('message', '')[:100]}")
                    elif msg_type == "session_done":
                        success = data.get("success", False)
                        print(f"  [{session_id}] DONE (success={success}): {data.get('message', '')[:100]}")
                    else:
                        print(f"  [{session_id}] {msg_type}: {json.dumps(data)[:100]}")

                except asyncio.TimeoutError:
                    print("Timeout waiting for messages (120s)")
                    break
                except websockets.exceptions.ConnectionClosed:
                    print("WebSocket connection closed")
                    break

    except ConnectionRefusedError:
        print("Could not connect - is the app running?")
    except Exception as e:
        print(f"Error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
