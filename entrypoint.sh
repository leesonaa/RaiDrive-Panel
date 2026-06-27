#!/bin/bash
set -e

echo "[entrypoint] Starting raidrived daemon..."

# Start the raidrive daemon in background
# It registers itself as a systemd service in normal installs,
# but inside Docker we run it directly.
if command -v raidrived &>/dev/null; then
    if raidrived --daemon & then
        daemon_pid=$!
        sleep 2
        if raidrivecli status >/dev/null 2>&1; then
            echo "[entrypoint] raidrived daemon is running (PID ${daemon_pid})"
        else
            echo "[entrypoint] WARNING: raidrived launched but status check failed"
        fi
    else
        echo "[entrypoint] WARNING: failed to start raidrived daemon"
    fi
else
    echo "[entrypoint] WARNING: raidrived not found, CLI commands may fail"
fi

echo "[entrypoint] Starting RaiDrive Panel on port ${PORT:-3030}..."
exec node /app/server.js
