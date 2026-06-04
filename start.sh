#!/bin/bash
# start.sh

# Find Python executable with cobra and websockets installed
PYTHON_EXEC="python3"

if [ -f "/workspace/.heroku/python/bin/python" ]; then
  PYTHON_EXEC="/workspace/.heroku/python/bin/python"
elif [ -f "/workspace/.venv/bin/python" ]; then
  PYTHON_EXEC="/workspace/.venv/bin/python"
elif [ -f "./venv/bin/python" ]; then
  PYTHON_EXEC="./venv/bin/python"
elif [ -f ".venv/bin/python" ]; then
  PYTHON_EXEC=".venv/bin/python"
fi

echo "[Start Script] Using Python executable: $PYTHON_EXEC"
$PYTHON_EXEC server.py &
npx vite preview
