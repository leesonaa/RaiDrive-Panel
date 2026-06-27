#!/bin/bash
set -e

echo "[entrypoint] Starting raidrived daemon..."

# Start the raidrive daemon in background
# It registers itself as a systemd service in normal installs,
# but inside Docker we run it directly.
if command -v raidrived &>/dev/null; then
    raidrived &
    sleep 2
    echo "[entrypoint] raidrived started (PID $!)"
else
    echo "[entrypoint] WARNING: raidrived not found, CLI commands may fail"
fi

echo "[entrypoint] Starting RaiDrive Panel on port ${PORT:-3030}..."
exec node /app/server.js
