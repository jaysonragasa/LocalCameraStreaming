#!/usr/bin/env bash
# ==============================================================================
# AuraCam — macOS & Linux Startup Script (Browser-as-Server Station)
# ==============================================================================

set -e

cd "$(dirname "$0")"

echo "==================================================="
echo "  AuraCam: Browser Camera Streaming Station"
echo "==================================================="
echo ""

if command -v node &>/dev/null; then
    NODE_CMD="node"
elif command -v nodejs &>/dev/null; then
    NODE_CMD="nodejs"
else
    echo "Error: Node.js is not installed or not in PATH."
    exit 1
fi

echo "Using Node.js: $($NODE_CMD --version)"

# Install dependencies if node_modules is missing
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies (express, ws)..."
    npm install --production
fi

echo "Starting AuraCam server..."
$NODE_CMD server.js "$@"
