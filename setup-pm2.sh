#!/bin/bash
  set -e
  echo "=== Setup PM2 Auto-Restart - Cpanel Bot ==="
  if ! command -v pm2 &> /dev/null; then npm install -g pm2; fi
  mkdir -p logs
  pm2 delete cpanel-bot 2>/dev/null || true
  pm2 start ecosystem.config.js
  pm2 save
  pm2 startup | tail -1 | bash 2>/dev/null || echo "Jalankan 'pm2 startup' manual jika error."
  echo ""
  echo "=== Bot berjalan dengan PM2 ==="
  echo "  pm2 status           - lihat status"
  echo "  pm2 logs cpanel-bot  - lihat log"
  echo "  pm2 restart cpanel-bot - restart"
  echo ""