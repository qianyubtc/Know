#!/bin/bash
set -e

DOMAIN="know.qianyubtc.com"
APP_DIR="/var/www/trivia-game"
APP_PORT=3000

echo "===== [1/6] 更新系统 ====="
apt update -y

echo "===== [2/6] 安装 Node.js 20 ====="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

echo "===== [3/6] 安装 nginx + certbot ====="
apt install -y nginx certbot python3-certbot-nginx

echo "===== [4/6] 安装 PM2 ====="
npm install -g pm2

echo "===== [5/6] 拉取代码并安装依赖 ====="
mkdir -p $APP_DIR
cd $APP_DIR
if [ -d ".git" ]; then
  git pull
else
  git clone https://github.com/qianyubtc/Know.git .
fi
npm install --production

echo "===== [6/6] 配置 nginx ====="
cat > /etc/nginx/sites-available/trivia-game <<EOF
server {
    listen 80;
    server_name $DOMAIN;

    location / {
        proxy_pass http://localhost:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_cache_bypass \$http_upgrade;
    }
}
EOF

ln -sf /etc/nginx/sites-available/trivia-game /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "===== 启动应用 ====="
pm2 delete trivia-game 2>/dev/null || true
pm2 start $APP_DIR/server.js --name trivia-game
pm2 save
pm2 startup systemd -u root --hp /root | tail -1 | bash

echo ""
echo "======================================"
echo "  部署完成！"
echo "  下一步：申请 SSL 证书"
echo "  执行：certbot --nginx -d $DOMAIN"
echo "======================================"
