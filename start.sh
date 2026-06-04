#!/bin/bash
# start.sh
# Startup script for serving Vite preview in DigitalOcean App Platform.

echo "[Start] Launching Vite preview server on port ${PORT:-8080}..."
npx vite preview --port ${PORT:-8080} --host 0.0.0.0
