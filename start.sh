#!/bin/bash
# start.sh
# Startup script for serving production Express server in DigitalOcean App Platform.

echo "[Start] Launching production Express server on port ${PORT:-8080}..."
node server.js
