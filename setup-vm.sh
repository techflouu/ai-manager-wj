#!/bin/bash
set -e

echo "=================================================="
echo "    AI Manager Bot - VM Setup Script (Debian/Ubuntu)"
echo "=================================================="

# 1. Update system packages
echo ">>> Updating system packages..."
sudo apt-get update && sudo apt-get upgrade -y

# 2. Install dependencies (curl, git, build-essential)
echo ">>> Installing dependencies..."
sudo apt-get install -y curl git build-essential

# 3. Install Node.js (v20)
echo ">>> Installing Node.js..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 4. Install PM2 globally
echo ">>> Installing PM2..."
sudo npm install -g pm2

# 5. Setup PM2 to start on boot
echo ">>> Setting up PM2 startup..."
# Run the startup command generator
sudo env PATH=$PATH:/usr/bin /usr/lib/node_modules/pm2/bin/pm2 startup systemd -u $USER --hp /home/$USER
# (Note: pm2 startup might require copying a command it outputs, but the above usually works on Debian/Ubuntu)

echo "=================================================="
echo " Setup complete! Next steps:"
echo " 1. Clone your repository: git clone <your-repo-url> ai-manager-bot"
echo " 2. cd ai-manager-bot"
echo " 3. Create your .env file: nano .env"
echo " 4. Install packages: npm install"
echo " 5. Build the project: npm run build"
echo " 6. Start the bot: pm2 start ecosystem.config.js"
echo " 7. Save PM2 list: pm2 save"
echo "=================================================="
