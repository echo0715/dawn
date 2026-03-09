#!/bin/bash
# Start script for Job Application Agent

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "=== Job Application Agent ==="

# Check for Python venv in browser-use
VENV_PYTHON="$DIR/browser-use/.venv/bin/python"
if [ -f "$VENV_PYTHON" ]; then
    PYTHON="$VENV_PYTHON"
    echo "Using browser-use venv Python: $PYTHON"
else
    PYTHON="python3"
    echo "Using system Python: $PYTHON"
fi

# Install backend dependencies
echo "Installing backend dependencies..."
$PYTHON -m pip install fastapi uvicorn websockets 2>/dev/null || true

# Install Electron dependencies
if [ ! -d "node_modules" ]; then
    echo "Installing Electron dependencies..."
    npm install
fi

# Start the app
echo "Starting application..."
npm start
