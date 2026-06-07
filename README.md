# Pterodactyl Panel Bot — Cpanel by Alfa

Bot Telegram untuk pembuatan & manajemen panel Pterodactyl.

## Struktur Folder

```
cpanel-bot/
├── index.js               # Entry point bot
├── config.js              # Konfigurasi utama
├── package.json
├── ecosystem.config.js    # Konfigurasi PM2
├── setup-pm2.sh           # Script setup PM2
├── core/                  # Modul inti
│   ├── database.js        # Penyimpanan data (JSON)
│   ├── pterodactyl.js     # Wrapper API Pterodactyl
│   └── monitor.js         # Panel monitor (deteksi manual)
└── utils/                 # Modul pendukung
    ├── logger.js          # Logger
    ├── i18n.js            # Multi-bahasa
    └── features.js        # Helper fitur lain
```

## Perubahan Pada Versi Ini

1. **Bug fix**: Crash `EADDRNOTAVAIL` saat startup (host HTTP API yang di-hardcode ke IP yang tidak tersedia) — fitur HTTP API dihapus seluruhnya.
2. **Bug fix**: `monitor.startMonitor(bot)` sebelumnya hanya jalan kalau HTTP API aktif — sekarang dipanggil tanpa syarat sehingga panel monitor tetap berjalan.
3. **Penghapusan fitur**: modul `webhook.js` (Discord/Slack outbound), `httpapi.js` (REST API), command `/webhook`, `/apikey`, dan tombol menu V3 terkait dihapus karena tidak digunakan.
4. **Refactor**: file dipindah ke dalam grup folder `core/` dan `utils/` agar lebih rapih.

## Menjalankan Bot

```bash
npm install
node index.js
# atau dengan PM2:
bash setup-pm2.sh
```

## Konfigurasi

Edit `config.js`:
- `BOT_TOKEN` — token bot Telegram
- `PTLA`, `PTLC`, `PANEL_URL` — kredensial Pterodactyl
- `OWNER_IDS` — Telegram ID owner
- dst.
