#!/usr/bin/env bash
# Pull + rebuild + restart on the EC2 box.
# Assumes you've done first-time setup (see README.md "Self-host on EC2").

set -euo pipefail

PROJECT_DIR="/home/mernapp/sheets-mcp-hosted"
PM2_APP_NAME="sheets-mcp"

echo "→ git pull"
cd "$PROJECT_DIR"
git pull origin main

echo "→ npm install"
npm install --omit=dev=false

echo "→ npm run build"
npm run build

echo "→ pm2 restart"
if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_APP_NAME"
else
  pm2 start deploy/ecosystem.config.cjs
fi

pm2 save
echo "✓ deployed. tail logs: pm2 logs $PM2_APP_NAME"
