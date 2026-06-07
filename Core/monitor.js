"use strict";

  /**
   * monitor.js — Panel Monitor v2
   *
   * Deteksi via Admin API Key (PTLA):
   *  1. Server dibuat manual di Pterodactyl (tidak via bot)
   *  2. User  dibuat manual di Pterodactyl (tidak via bot)
   *  3. Admin baru ditambahkan manual (root_admin = true)
   *
   * Notifikasi dikirim ke semua OWNER_IDS di Telegram.
   */

  const config = require("../config");
  const db     = require("./database");
  const ptero  = require("./pterodactyl");

  // ─── State ────────────────────────────────────────────────────────────────────
  const notifiedServers = new Set();   // "srv:N:ID" — server manual yg sdh dinotif
  const notifiedUsers   = new Set();   // "user:N:ID" — user manual yg sdh dinotif
  const knownAdmins     = new Map();   // "admin:N:ID" → {email,username} — admin yg dikenal
  let   adminBootDone   = {};          // { 1: false, 2: false } — apakah boot-scan selesai
  let   botInstance     = null;
  let   intervalHandle  = null;
  let   isRunning       = false;

  // ─── Helpers ──────────────────────────────────────────────────────────────────
  function he(s) {
    return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function fmt(mb) {
    if (!mb || mb <= 0) return "Unlimited";
    return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : mb + " MB";
  }

  function now() {
    return new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
  }

  async function notify(message) {
    if (!botInstance) return;
    for (const ownerId of (config.OWNER_IDS || [])) {
      try {
        await botInstance.telegram.sendMessage(String(ownerId), message, {
          parse_mode: "HTML",
        });
      } catch (_) {}
      // Jeda kecil antar owner agar tidak rate-limit
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // ─── 1. Deteksi Server Manual ─────────────────────────────────────────────────
  async function scanServers(serverNum) {
    const allPtero = await ptero.listServers(serverNum);
    if (!allPtero?.length) return;

    const botPanels  = db.getAllPanels();
    const botSrvIds  = new Set(botPanels.map(p => String(p.server_id)));

    for (const item of allPtero) {
      const a   = item.attributes || item;
      const sid = String(a.id);
      const key = `srv:${serverNum}:${sid}`;

      if (botSrvIds.has(sid))         continue; // sudah di DB bot → normal
      if (notifiedServers.has(key))   continue; // sudah dinotif sebelumnya

      notifiedServers.add(key);

      const lim  = a.limits || {};
      const alloc = (a.relationships?.allocations?.data?.[0]?.attributes) || {};
      const ip    = alloc.ip_alias || alloc.ip || "—";
      const port  = alloc.port || "—";

      await notify(
        `🚨 <b>SERVER MANUAL TERDETEKSI!</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `📛 <b>Nama        :</b> <code>${he(a.name)}</code>\n` +
        `🆔 <b>Server ID   :</b> <code>${he(sid)}</code>\n` +
        `🔑 <b>Identifier  :</b> <code>${he(a.identifier || "—")}</code>\n` +
        `🌐 <b>IP : Port   :</b> <code>${he(ip)}:${he(String(port))}</code>\n` +
        `👤 <b>Ptero User  :</b> <code>${he(String(a.user || "—"))}</code>\n` +
        `💾 <b>RAM         :</b> ${he(fmt(lim.memory))}\n` +
        `💿 <b>Disk        :</b> ${he(fmt(lim.disk))}\n` +
        `⚡ <b>CPU         :</b> ${lim.cpu || 0}%\n` +
        `🖥️ <b>Panel Server:</b> Server ${serverNum}\n` +
        `🕐 <b>Terdeteksi  :</b> ${now()}\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⚠️ Server ini <b>tidak dibuat melalui bot</b>.\n` +
        `Segera periksa dan tindak lanjuti!`
      );
    }
  }

  // ─── 2. Deteksi User Manual ───────────────────────────────────────────────────
  async function scanUsers(serverNum) {
    const allPtero = await ptero.getAllUsers(serverNum);
    if (!allPtero?.length) return;

    const botUsers  = db.listAllUsers();
    // Kumpulkan semua email yang terdaftar di bot
    const botEmails = new Set(
      Object.values(botUsers)
        .map(u => (u.email || "").toLowerCase().trim())
        .filter(Boolean)
    );
    // Kumpulkan juga email dari panel record (generate dari bot)
    const botPanels = db.getAllPanels();
    for (const p of botPanels) {
      if (p.email) botEmails.add(p.email.toLowerCase().trim());
      if (p.username) botEmails.add((p.username + "@" + (config.EMAIL_DOMAIN || "")).toLowerCase());
    }

    for (const item of allPtero) {
      const a     = item.attributes || item;
      const pid   = String(a.id);
      const email = (a.email || "").toLowerCase().trim();
      const key   = `user:${serverNum}:${pid}`;

      if (a.root_admin)             continue; // admin → ditangani scanAdmins
      if (notifiedUsers.has(key))   continue; // sdh dinotif

      // User tidak ada di email database bot → manual
      if (!botEmails.has(email)) {
        notifiedUsers.add(key);

        await notify(
          `🚨 <b>USER MANUAL TERDETEKSI!</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `🆔 <b>Ptero ID  :</b> <code>${he(pid)}</code>\n` +
          `📧 <b>Email     :</b> <code>${he(email || "—")}</code>\n` +
          `🔤 <b>Username  :</b> <code>${he(a.username || "—")}</code>\n` +
          `👁️ <b>Nama      :</b> ${he((a.first_name || "") + " " + (a.last_name || "")).trim() || "—"}\n` +
          `🖥️ <b>Panel     :</b> Server ${serverNum}\n` +
          `🕐 <b>Terdeteksi:</b> ${now()}\n` +
          `━━━━━━━━━━━━━━━━━━━━━━━\n` +
          `⚠️ User ini <b>tidak dibuat melalui bot</b>.\n` +
          `Segera periksa dan tindak lanjuti!`
        );
      }
    }
  }

  // ─── 3. Deteksi Admin Manual ──────────────────────────────────────────────────
  async function scanAdmins(serverNum) {
    const allPtero = await ptero.getAllUsers(serverNum);
    if (!allPtero?.length) return;

    const isFirstScan = !adminBootDone[serverNum];

    for (const item of allPtero) {
      const a   = item.attributes || item;
      if (!a.root_admin) continue;

      const pid = String(a.id);
      const key = `admin:${serverNum}:${pid}`;

      if (isFirstScan) {
        // Scan pertama = boot → simpan semua admin sebagai "sudah dikenal", jangan notif
        knownAdmins.set(key, {
          email:    a.email    || "—",
          username: a.username || "—",
        });
      } else {
        // Scan berikutnya → cek apakah admin ini sudah dikenal
        if (!knownAdmins.has(key)) {
          // Admin BARU yang tidak ada di scan pertama → notif owner!
          knownAdmins.set(key, {
            email:    a.email    || "—",
            username: a.username || "—",
          });

          await notify(
            `🚨 <b>ADMIN BARU TERDETEKSI!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🆔 <b>Ptero ID  :</b> <code>${he(pid)}</code>\n` +
            `📧 <b>Email     :</b> <code>${he(a.email || "—")}</code>\n` +
            `🔤 <b>Username  :</b> <code>${he(a.username || "—")}</code>\n` +
            `👁️ <b>Nama      :</b> ${he((a.first_name||"")+" "+(a.last_name||"")).trim()||"—"}\n` +
            `🛡️ <b>root_admin:</b> <b>YA</b>\n` +
            `🖥️ <b>Panel     :</b> Server ${serverNum}\n` +
            `🕐 <b>Terdeteksi:</b> ${now()}\n` +
            `━━━━━━━━━━━━━━━━━━━━━━━\n` +
            `🔴 <b>PERINGATAN KRITIS!</b>\n` +
            `Akun ini memiliki akses <b>ADMIN PENUH</b> ke Pterodactyl.\n` +
            `Jika bukan kamu yang menambahkan, segera hapus dan ganti API key!`
          );
        }
      }
    }

    if (isFirstScan) {
      adminBootDone[serverNum] = true;
      const adminCount = [...knownAdmins.keys()].filter(k => k.startsWith(`admin:${serverNum}:`)).length;
      console.log(`[Monitor] Server ${serverNum}: ${adminCount} admin dikenali saat boot`);
    }
  }

  // ─── Main Loop ────────────────────────────────────────────────────────────────
  async function runScan() {
    if (isRunning) return;
    isRunning = true;
    try {
      const servers = [1];
      if (config.PTLA2 && config.PANEL_URL2) servers.push(2);

      for (const srvNum of servers) {
        try { await scanAdmins(srvNum);  } catch (e) { if (config.MONITOR_DEBUG) console.error("[Monitor] scanAdmins error:", e.message); }
        await new Promise(r => setTimeout(r, 1500));
        try { await scanServers(srvNum); } catch (e) { if (config.MONITOR_DEBUG) console.error("[Monitor] scanServers error:", e.message); }
        await new Promise(r => setTimeout(r, 1500));
        try { await scanUsers(srvNum);   } catch (e) { if (config.MONITOR_DEBUG) console.error("[Monitor] scanUsers error:", e.message); }
        await new Promise(r => setTimeout(r, 1500));
      }
    } finally {
      isRunning = false;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────────
  function startMonitor(bot) {
    const cfg = config.PANEL_MONITOR || {};
    if (!cfg.enabled) {
      console.log("[Monitor] Dinonaktifkan. Set PANEL_MONITOR.enabled = true di config.js");
      return;
    }

    botInstance = bot;
    adminBootDone = {};

    const minutes = Math.max(5, cfg.interval_minutes || 10);
    const ms      = minutes * 60 * 1000;

    // Scan pertama 30 detik setelah bot ready (beri waktu koneksi stabil)
    setTimeout(async () => {
      console.log("[Monitor] Memulai scan pertama (boot scan)...");
      await runScan();
      console.log(`[Monitor] ✅ Boot scan selesai. Scan rutin setiap ${minutes} menit.`);
      intervalHandle = setInterval(runScan, ms);
    }, 30 * 1000);
  }

  function stopMonitor() {
    if (intervalHandle) { clearInterval(intervalHandle); intervalHandle = null; }
    botInstance = null;
  }

  // Reset cache — admin tetap dipertahankan agar tidak kirim ulang notif admin lama
  function resetNotified() {
    notifiedServers.clear();
    notifiedUsers.clear();
    console.log("[Monitor] Cache server & user direset. Admin cache tetap.");
  }

  // Force re-scan admin (jarang dipakai)
  function resetAdminCache() {
    knownAdmins.clear();
    adminBootDone = {};
    console.log("[Monitor] Admin cache direset. Boot scan akan jalan ulang.");
  }

  module.exports = { startMonitor, stopMonitor, resetNotified, resetAdminCache };
  