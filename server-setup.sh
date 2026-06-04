#!/bin/bash
# Run this ONCE on your VPS to set up the server
# Usage: bash server-setup.sh

set -e

DEPLOY_PATH="/var/www/retell-dashboard"
GITHUB_REPO="https://github.com/deepmoga/retell-dashboard.git"

echo "=== Installing Node.js 22 ==="
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

echo "=== Installing PM2 (process manager) ==="
sudo npm install -g pm2
pm2 startup systemd -u $USER --hp $HOME | tail -1 | bash

echo "=== Cloning repository ==="
sudo mkdir -p /var/www
sudo chown $USER:$USER /var/www
git clone "$GITHUB_REPO" "$DEPLOY_PATH"
cd "$DEPLOY_PATH"

echo "=== Installing dependencies ==="
npm install --omit=dev

echo "=== Creating .env file ==="
cp .env.example .env
echo ""
echo ">>> IMPORTANT: Edit your .env file now:"
echo "    nano $DEPLOY_PATH/.env"
echo ""
echo ">>> Then start the app:"
echo "    cd $DEPLOY_PATH"
echo "    pm2 start \"node --experimental-sqlite server.js\" --name retell-dashboard"
echo "    pm2 save"
echo ""
echo "=== Setup complete! ==="
