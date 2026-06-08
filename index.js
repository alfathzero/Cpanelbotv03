const { Telegraf, Markup } = require("telegraf");
const { message } = require("telegraf/filters");
const axios = require("axios");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const config = require("./config");
// NOTE: webhook & httpapi modules removed (tidak dipakai lagi)
// Helper: emoji toggle (diambil dari config.TOGGLE_EMOJI, fallback ke 🟢/🔴)
const TON  = () => (config.TOGGLE_EMOJI || {}).ON  || `${tge("GREEN_DOT","🟢")}`;
const TOFF = () => (config.TOGGLE_EMOJI || {}).OFF || `${tge("RED_DOT","🔴")}`;

// Helper: premium animated emoji (tg-emoji) untuk TEKS PESAN (bukan tombol)
// Jika ID diisi di config.PREMIUM_EMOJI[key], tampilkan animated emoji via HTML.
// Jika kosong/tidak ada, fallback ke emoji Unicode biasa.
function tge(key, fallback = "") {
  const id = ((config.PREMIUM_EMOJI || {})[key] || "").trim();
  // Strip any HTML tags from fallback (prevents nested <tg-emoji> tags)
  const plain = String(fallback).replace(/<[^>]+>/g, "");
  if (!id || !/^\d{6,}$/.test(id)) return plain;
  const safe = plain.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<tg-emoji emoji-id="${id}">${safe || "·"}</tg-emoji>`;
}

// Helper: escape HTML untuk teks yang mengandung karakter khusus
function he2(s) {
  return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// Helper: buat parse mode pesan — pakai HTML jika ada PREMIUM_EMOJI yang diisi,
// pakai Markdown jika semua ID kosong (backward-compatible)
function pmode() {
  // Pesan-pesan sudah dikonversi ke HTML (dengan <b>, <tg-emoji>, dll)
  // sehingga selalu pakai HTML parse_mode.
  return "HTML";
}

// Helper: bold teks — otomatis sesuai parse_mode yang aktif
function bold(s) {
  return pmode() === "HTML" ? `<b>${he2(s)}</b>` : `*${s}*`;
}

// Helper: monospace teks
function mono(s) {
  return pmode() === "HTML" ? `<code>${he2(s)}</code>` : `\`${s}\``;
}

const db = require("./Core/database");
const ptero = require("./Core/pterodactyl");
const features = require("./Utils/features");
const monitor  = require("./Core/monitor");
const i18n = require("./Utils/i18n");

// ─── Multi-Server Helpers ─────────────────────────────────────────────────────
// Server 1 = panel utama; Server 2 = panel kedua (hanya owner secara default).
// Akses per role diatur via config.SERVER_ACCESS

// Daftar nomor server yang boleh dipakai oleh role tertentu.
function allowedServers(role) {
  const access = (config.SERVER_ACCESS || {});
  const list = Array.isArray(access[role]) ? access[role] : [1];
  // Pastikan unik dan minimal 1 entri
  const out = Array.from(new Set(list.map(n => Number(n)))).filter(n => n === 1 || n === 2);
  return out.length ? out : [1];
}

// Cek apakah role boleh memakai server tertentu
function canUseServer(role, serverNum) {
  return allowedServers(role).includes(Number(serverNum) || 1);
}

// Ambil server_num dari record panel (default 1 untuk panel lama)
function psn(panel) {
  return panel && panel.server_num ? Number(panel.server_num) : 1;
}

// Nama tampilan server
function serverLabel(n) {
  const num = Number(n) || 1;
  return ((config.SERVER_NAMES || {})[num]) || `Server ${num}`;
}

// URL panel untuk login sesuai server
function serverUrl(n) {
  return Number(n) === 2 ? (config.PANEL_URL2 || config.PANEL_URL) : config.PANEL_URL;
}

// Keyboard pemilih server untuk flow create panel
function serverPickerKeyboard(role, prefix = "pick_srv_") {
  const list = allowedServers(role);
  const rows = list.map(n => [Markup.button.callback(`🖥️ ${serverLabel(n)}`, `${prefix}${n}`)]);
  rows.push([Markup.button.callback("❌ Batal", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

// Cari nomor server dari serverId (untuk operasi by raw serverId)
// Cek record panel dulu; kalau tidak ada, fallback ke session (admin_srv) atau 1
function srvOf(serverId, sess = null) {
  try {
    const rec = db.getPanelByServerId(serverId);
    if (rec && rec.server_num) return Number(rec.server_num);
  } catch {}
  if (sess && sess.admin_srv) return Number(sess.admin_srv);
  return 1;
}

const bot = new Telegraf(config.BOT_TOKEN);
const BOT_START_TIME = Date.now();

// Cache status node untuk alert down
const nodeStatusCache = new Map();

// ─── Middleware: Maintenance Mode ─────────────────────────────────────────────

bot.use(async (ctx, next) => {
  const maint = db.getMaintenanceMode();
  if (!maint.active) return next();
  const userId = ctx.from?.id;
  if (userId && isOwner(userId)) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(`${tge("WRENCH","🔧")} ` + maint.message, { show_alert: true });
    return;
  }
  if (ctx.message) {
    return ctx.reply(`${tge("WRENCH","🔧")} <b>Maintenance</b>\n\n${maint.message}`, { parse_mode: "HTML" });
  }
});

// ─── Middleware: Whitelist Mode ────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (!db.getWhitelistMode()) return next();
  const userId = ctx.from?.id;
  if (!userId) return next();
  if (isOwner(userId) || db.isWhitelisted(userId)) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(`${tge("LOCK","🔒")} Akses terbatas. Kamu belum di-whitelist.`, { show_alert: true });
    return;
  }
  if (ctx.message) {
    return ctx.reply(`${tge("LOCK","🔒")} <b>Mode Whitelist Aktif</b>\n\nBot ini hanya bisa digunakan oleh user yang telah diizinkan owner.\nHubungi owner untuk mendapatkan akses.`, { parse_mode: "HTML" });
  }
});

// ─── Middleware: Scheduled Maintenance ────────────────────────────────────────

bot.use(async (ctx, next) => {
  const sm = db.getScheduledMaintenance();
  if (!sm.enabled) return next();
  const userId = ctx.from?.id;
  if (userId && isOwner(userId)) return next();
  const now = new Date();
  const [sh, smin] = (sm.start || "00:00").split(":").map(Number);
    const [eh, em]   = (sm.end   || "00:00").split(":").map(Number);
    const curMin   = now.getHours() * 60 + now.getMinutes();
    const startMin = sh * 60 + smin;
    const endMin   = eh * 60 + em;
    // Cek hari aktif (0=Minggu..6=Sabtu) — array kosong berarti setiap hari
    const smDays = Array.isArray(sm.days) ? sm.days : [];
    if (smDays.length > 0 && !smDays.includes(now.getDay())) return next();
    const inWindow = startMin < endMin
      ? curMin >= startMin && curMin < endMin
      : curMin >= startMin || curMin < endMin;
  if (!inWindow) return next();
  const msg = sm.message || "Bot sedang dalam pemeliharaan terjadwal. Silakan coba lagi nanti.";
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(`${tge("WRENCH","🔧")} ${msg}`, { show_alert: true });
    return;
  }
  if (ctx.message) return ctx.reply(`${tge("WRENCH","🔧")} <b>Pemeliharaan Terjadwal</b>\n\n${msg}\n\n${tge("ALARM","⏰")} Waktu: ${sm.start} – ${sm.end}`, { parse_mode: "HTML" });
});

// ─── Middleware: Required Channel Join ────────────────────────────────────────

bot.use(async (ctx, next) => {
  const channels = config.REQUIRED_CHANNELS || [];
  if (!channels.length) return next();

  const userId = ctx.from?.id;
  if (!userId) return next();

  // Owner selalu diizinkan lewat
  if (isOwner(userId)) return next();

  // Biarkan callback "check_join" lewat agar handler-nya bisa diproses
  if (ctx.callbackQuery?.data === "check_join") return next();

  // Cek keanggotaan di setiap channel
  const notJoined = [];
  for (const ch of channels) {
    try {
      const member = await ctx.telegram.getChatMember(ch.id, userId);
      const ok = ["member", "administrator", "creator"].includes(member.status);
      if (!ok) notJoined.push(ch);
    } catch {
      // Jika bot belum admin di channel atau channel tidak ditemukan → skip cek channel ini
    }
  }

  if (!notJoined.length) return next();

  // Bangun tombol join + tombol cek ulang
  const joinButtons = notJoined.map(ch => [Markup.button.url(`📢 Join ${ch.label}`, ch.url)]);
  joinButtons.push([Markup.button.callback(`${tge("SUCCESS","✅")} Sudah Join — Cek Ulang`, "check_join")]);

  const msg =
    `${tge("LOCK","🔒")} <b>Akses Terbatas!</b>\n\n` +
    `Untuk menggunakan bot ini kamu harus bergabung ke <b>${channels.length} channel</b> berikut:\n\n` +
    notJoined.map((ch, i) => `${i + 1}. 📢 <b>${he(ch.label)}</b>`).join("\n") +
    `\n\nSetelah bergabung, tekan tombol <b>✅ Sudah Join — Cek Ulang</b> di bawah.`;

  const isPrivate = ctx.chat?.type === "private";

  if (ctx.callbackQuery) {
    // Selalu jawab callback query dulu (wajib)
    await ctx.answerCbQuery(`${tge("LOCK","🔒")} Kamu belum join channel yang diperlukan!`, { show_alert: true });
  }

  if (isPrivate) {
    // Di private chat → balas langsung di sini
    return ctx.reply(msg, { parse_mode: "HTML", ...Markup.inlineKeyboard(joinButtons) });
  } else {
    // Di grup/channel → kirim HANYA ke private chat user, tidak balas di grup
    try {
      await ctx.telegram.sendMessage(userId, msg, { parse_mode: "HTML", ...Markup.inlineKeyboard(joinButtons) });
    } catch {
      // Jika private chat belum dibuka, kirim notif singkat via callback alert saja (sudah dikirim di atas)
    }
    // Diam di grup — tidak balas apapun agar tidak spam
    return;
  }
});

// ─── Middleware: Group Only ────────────────────────────────────────────────────

bot.use(async (ctx, next) => {
  if (!config.GROUP_ONLY || !config.GROUP_ID) return next();
  const chatId = ctx.chat?.id;
  const isAllowedGroup = String(chatId) === String(config.GROUP_ID);
  if (isAllowedGroup) return next();
  if (ctx.callbackQuery) {
    await ctx.answerCbQuery(`${tge("PROHIBITED","🚫")} Bot hanya aktif di grup resmi!`, { show_alert: true });
    return;
  }
  if (ctx.message) {
    return ctx.reply(
      `${tge("PROHIBITED","🚫")} <b>Bot hanya aktif di grup resmi!</b>\n\nBot ini tidak dapat digunakan di chat pribadi atau grup lain.\nSilakan gunakan bot di grup yang sudah terdaftar.`,
      { parse_mode: "HTML" }
    );
  }
});

// ─── Logger ───────────────────────────────────────────────────────────────────

const logger = require("./Utils/logger");
const botLog = (level, tag, msg, err) => logger.log(level, tag, msg, err);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generatePassword(len = 12) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let pass = "";
  for (let i = 0; i < len; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass;
}

function generateEmail(username) {
  const rand = Math.random().toString(36).slice(2, 7);
  const clean = username.toLowerCase().replace(/[^a-z0-9_]/g, "");
  return `${clean}_${rand}@${config.EMAIL_DOMAIN}`;
}

function generateVoucherCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "PTERO-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function telegramName(from) {
  let name = from.first_name || "";
  if (from.last_name) name += ` ${from.last_name}`;
  if (from.username) name += ` (@${from.username})`;
  return name;
}

function isOwner(userId) {
  return config.OWNER_IDS.map(String).includes(String(userId)) || db.getRole(userId) === "owner";
}

// Strict: hanya bot owner (config.OWNER_IDS) — TIDAK termasuk role="owner" di DB
// Dipakai untuk aksi sensitif seperti backup script bot, API key admin, dll.
function isBotOwner(userId) {
  return (config.OWNER_IDS || []).map(String).includes(String(userId));
}

// Cek apakah user boleh kelola panel (owner panel, bot owner, atau co-owner)
function canManagePanel(uid, panel) {
  if (!panel) return false;
  if (isOwner(uid)) return true;
  const ownerId = panel.userId || panel.ownerUserId || panel.tg_user_id;
  if (ownerId && String(ownerId) === String(uid)) return true;
  if (db.isCoOwner(panel.server_id, uid)) return true;
  return false;
}

// Theme pack prefix
function themePrefix(uid) {
  const pack = db.getThemePack(uid);
  return ((config.THEME_PACKS || {})[pack] || {}).prefix || "";
}

// ASCII bar chart (#11)
function asciiBar(value, max, width = 20) {
  if (max <= 0) return "─".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((value / max) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

// Build a 7-day usage chart for a server based on resource_history
function buildUsageChart(serverId) {
  const hist = db.getResourceHistory(serverId) || [];
  if (!hist.length) return "_Belum ada data resource untuk server ini._";
  // Group per day, ambil rata-rata cpu & ram
  const byDay = {};
  hist.forEach(h => {
    const day = new Date(h.ts || h.timestamp || Date.now()).toISOString().slice(0, 10);
    if (!byDay[day]) byDay[day] = { cpu: [], ram: [] };
    byDay[day].cpu.push(Number(h.cpu || 0));
    byDay[day].ram.push(Number(h.ram_mb || h.ram || 0));
  });
  const days = Object.keys(byDay).sort().slice(-7);
  if (!days.length) return "_Belum ada data 7 hari terakhir._";
  const cpuMax = Math.max(100, ...days.map(d => Math.max(...byDay[d].cpu)));
  const ramMax = Math.max(...days.map(d => Math.max(...byDay[d].ram)));
  let out = "<b>📊 Grafik 7 Hari (CPU %)</b>\n<pre>";
  days.forEach(d => {
    const avg = byDay[d].cpu.reduce((a,b)=>a+b,0) / byDay[d].cpu.length;
    out += `${d.slice(5)} ${asciiBar(avg, cpuMax, 18)} ${avg.toFixed(0)}%\n`;
  });
  out += "</pre>\n<b>📊 Grafik 7 Hari (RAM MB)</b>\n<pre>";
  days.forEach(d => {
    const avg = byDay[d].ram.reduce((a,b)=>a+b,0) / byDay[d].ram.length;
    out += `${d.slice(5)} ${asciiBar(avg, ramMax || 1, 18)} ${avg.toFixed(0)}\n`;
  });
  out += "</pre>";
  return out;
}

function roleLabel(role) {
  return {
    owner:    `${tge("CROWN","👑")} Owner`,
    partner:  `${tge("STAR2","🌟")} Partner`,
    premium:  `${tge("DIAMOND","💎")} Premium`,
    reseller: `${tge("DIAMOND_ORANGE","🔶")} Reseller`,
  }[role] || `${tge("USER","👤")} User Biasa`;
}

function he(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function planLabel(plan) {
  const ram  = plan.ram  === 0 ? "∞" : `${plan.ram} MB`;
  const disk = plan.disk === 0 ? "∞" : `${plan.disk} MB`;
  const cpu  = plan.cpu  === 0 ? "∞" : `${plan.cpu}%`;
  // Tombol callback tidak mendukung HTML — pakai emoji unicode polos.
  return `📦 ${plan.name}  •  💾 ${ram}  •  💿 ${disk}  •  ⚙️ ${cpu}`;
}

function planSummary(plan) {
  return {
    ram:  plan.ram  === 0 ? "Unlimited ∞" : `${plan.ram} MB`,
    disk: plan.disk === 0 ? "Unlimited ∞" : `${plan.disk} MB`,
    cpu:  plan.cpu  === 0 ? "Unlimited ∞" : `${plan.cpu}%`,
  };
}

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}h ${h}j ${m}m ${s}d`;
  if (h > 0) return `${h}j ${m}m ${s}d`;
  return `${m}m ${s}d`;
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576)    return `${(bytes / 1048576).toFixed(0)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}


function getDiskUsage() {
  try {
    const out = execSync("df -BM / 2>/dev/null | tail -1").toString().trim();
    const parts = out.split(/\s+/);
    const total = parseInt(parts[1]) || 0;
    const used  = parseInt(parts[2]) || 0;
    const pct   = parts[4] || "?";
    return `${used} MB / ${total} MB (${pct})`;
  } catch { return "N/A"; }
}

function getCpuModel() {
  try { return os.cpus()[0]?.model?.trim() || "N/A"; }
  catch { return "N/A"; }
}

function getBotUptime() {
  return formatUptime(Math.floor((Date.now() - BOT_START_TIME) / 1000));
}

function getVpsStats() {
  const totalRam = os.totalmem();
  const freeRam  = os.freemem();
  const usedRam  = totalRam - freeRam;
  const ramPct   = ((usedRam / totalRam) * 100).toFixed(1);
  const load     = os.loadavg();
  const cpuCount = os.cpus().length;
  return {
    vpsUptime: formatUptime(os.uptime()),
    botUptime: getBotUptime(),
    ram: `${formatBytes(usedRam)} / ${formatBytes(totalRam)} (${ramPct}%)`,
    cpu: `${getCpuModel()} (${cpuCount} core) | Load: ${load[0].toFixed(2)}, ${load[1].toFixed(2)}, ${load[2].toFixed(2)}`,
    disk: getDiskUsage(),
    platform: `${os.platform()} ${os.arch()}`,
  };
}

function formatDate(iso) {
  if (!iso) return "N/A";
  const d = new Date(iso);
  return `${d.getDate().toString().padStart(2,"0")}/${(d.getMonth()+1).toString().padStart(2,"0")}/${d.getFullYear()}`;
}

function daysLeft(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso) - new Date()) / (1000 * 60 * 60 * 24));
}

function hoursLeft(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso) - new Date()) / (1000 * 60 * 60));
}

function getPanelLimit(role) {
  const limits = config.PANEL_LIMITS || {};
  if (typeof limits[role] !== "undefined") return limits[role];
  if (role === "reseller") return config.RESELLER_LIMIT || 5;
  if (role === "premium" || role === "partner" || role === "owner") return 9999;
  return 0;
}

function getDailyLimit(role) {
  const limits = config.DAILY_PANEL_LIMIT || {};
  return typeof limits[role] !== "undefined" ? limits[role] : 9999;
}


function needsPin(userId, action) {
  const required = config.PIN_REQUIRED_ACTIONS || [];
  if (!required.includes(action)) return false;
  return !!db.getPin(userId);
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

// ─── Menu halaman (slide navigation) ─────────────────────────────────────────

function getMenuPages(role) {
  const maint  = db.getMaintenanceMode();
  const stats  = db.getStats();
  const trialActive = config.TRIAL_HOURS > 0 && db.getTrialEnabled();

  const pages = [];

  // ── Hal. 1: Panel ──────────────────────────────────────────────────────────
  const p1 = [];
  p1.push([Markup.button.callback("💎 Buat Panel", "create_panel")]);
  if (["premium", "partner", "owner"].includes(role))
    p1.push([Markup.button.callback("👑 Buat Admin Panel", "create_admin_panel")]);
  if (trialActive && !["premium", "partner", "owner"].includes(role))
    p1.push([Markup.button.callback("✨ Trial Panel Gratis", "trial_panel")]);
  p1.push([
    Markup.button.callback("🗂️ Panel Saya", "my_panels"),
    Markup.button.callback("🎟️ Redeem Voucher", "redeem_voucher"),
  ]);
  if (["premium", "partner", "reseller", "owner"].includes(role)) {
    p1.push([Markup.button.callback("🚀 Upgrade Panel", "upgrade_menu")]);
  }
  pages.push({ label: `${tge("DIAMOND","💎")} Panel`, btns: p1 });

  // ── Hal. 2: Akun & Support ─────────────────────────────────────────────────
  const p2 = [];
  p2.push([Markup.button.callback("💌 Tiket Support", "ticket_menu")]);
  p2.push([
    Markup.button.callback("🛡️ Keamanan", "security_menu"),
    Markup.button.callback("👤 Status Saya", "my_status"),
  ]);
  p2.push([Markup.button.callback("🧾 Riwayat Saya", "user_transactions")]);
  p2.push([Markup.button.callback("🏆 Poin Saya", "my_points"), Markup.button.callback("📐 Panel Template", "template_menu")]);
  p2.push([Markup.button.url(`💼 Developer — ${config.DEVELOPER_NAME}`, `https://t.me/${config.DEVELOPER_USERNAME}`)]);
  pages.push({ label: `${tge("SPARKLES","✨")} Akun & Support`, btns: p2 });

  // ── Hal. 3: Kelola Akses (premium & partner) ───────────────────────────────
  if (["premium", "partner"].includes(role)) {
    const pA = [];
    if (role === "partner") {
      pA.push([Markup.button.callback("💎 Tambah Premium", "pm_set_premium")]);
    }
    pA.push([Markup.button.callback("🔶 Tambah Reseller", "pm_set_reseller")]);
    pA.push([Markup.button.callback("📦 Set Limit Reseller", "pm_set_reseller_limit")]);
    pages.push({ label: `${tge("USERS","👥")} Kelola Akses`, btns: pA });
  }

  // ── Hal. 3/4: Admin (owner saja) ─────────────────────────────────────────────
  if (role === "owner") {
    const p3 = [];
    p3.push([
      Markup.button.callback("🗑️ Hapus Server", "delete_server"),
      Markup.button.callback("⚙️ Kelola Server", "manage_server"),
    ]);
    p3.push([
      Markup.button.callback("📑 List Server", "list_servers"),
      Markup.button.callback("🌐 Cek Node", "check_nodes"),
    ]);
    p3.push([
      Markup.button.callback("🟢 Server ON", "btn_listsrvon"),
      Markup.button.callback("🔴 Server OFF", "btn_listsrvoff"),
    ]);
    p3.push([
      Markup.button.callback("👥 Kelola User", "manage_users"),
      Markup.button.callback("📈 Statistik", "stats"),
    ]);
    p3.push([
      Markup.button.callback(`💌 Tiket (${stats.openTickets || 0})`, "kelola_tkt"),
      Markup.button.callback("🏷️ Kelola Voucher", "voucher_menu"),
    ]);
    p3.push([
      Markup.button.callback("📣 Broadcast", "broadcast_msg"),
      Markup.button.callback(maint.active ? "✅ Matikan Maint." : "🛠️ Maintenance", "maintenance_toggle"),
    ]);
    p3.push([
      Markup.button.callback("📒 Audit Log", "view_audit"),
      Markup.button.callback("📰 Lap. Harian", "daily_report_now"),
    ]);
    p3.push([
      Markup.button.callback("🧾 Riwayat Semua", "view_transactions"),
      Markup.button.callback("💹 Cek Resource", "check_resource"),
    ]);
    p3.push([
      Markup.button.callback("🌍 Status VPS", "vps_status"),
    ]);
    p3.push([
      Markup.button.callback(db.getTrialEnabled() ? `${TOFF()} Trial OFF` : `${TON()} Trial ON`, "toggle_trial"),
    ]);
    const abStatus = db.getAutoBackup();
    p3.push([
      Markup.button.callback(abStatus.enabled ? "💿 Auto Backup 🟢" : "💿 Auto Backup 🔴", "auto_backup_menu"),
    ]);
    p3.push([
      Markup.button.callback("🔐 Whitelist Mode", "whitelist_menu"),
      Markup.button.callback("📦 Export Data", "export_data_menu"),
    ]);
    p3.push([
      Markup.button.callback("🕒 Jadwal Maintenance", "scheduled_maint_menu"),
      Markup.button.callback("🔍 Cari Panel", "search_panel"),
    ]);
    p3.push([
      Markup.button.callback("📐 Kelola Template", "manage_templates"),
    ]);
    pages.push({ label: `${tge("CROWN","👑")} Admin`, btns: p3 });

    // Page Admin Lanjutan (V3 features)
    const p4 = [];
    p4.push([
      Markup.button.callback("🏆 Top Resource", "v3_topuser"),
      Markup.button.callback("📜 Laporan SLA", "v3_sla"),
    ]);
    p4.push([
      Markup.button.callback("🚨 Suspicious Log", "v3_suspicious"),
      Markup.button.callback("✨ Theme Pack", "v3_theme"),
    ]);
    pages.push({ label: `${tge("ROCKET","🚀")} V3 Tools`, btns: p4 });
  }

  return pages;
}

function mainMenuKeyboard(role, page = 0) {
  const pages = getMenuPages(role);
  const total = pages.length;
  const cur   = Math.max(0, Math.min(page, total - 1));
  const btns  = [...pages[cur].btns];

  // Baris navigasi slide
  if (total > 1) {
    const nav = [];
    if (cur > 0)
      nav.push(Markup.button.callback("◀️", `menu_pg_${cur - 1}`));
    nav.push(Markup.button.callback(`${pages[cur].label}  •  ${cur + 1}/${total}`, "menu_pg_info"));
    if (cur < total - 1)
      nav.push(Markup.button.callback("▶️", `menu_pg_${cur + 1}`));
    btns.push(nav);
  }

  return Markup.inlineKeyboard(btns);
}

function menuHeaderText(role, page) {
  const pages = getMenuPages(role);
  const total = pages.length;
  const cur   = Math.max(0, Math.min(page, total - 1));
  return `${tge("SPARKLES","✨")} <b>Menu Utama</b> — ${pages[cur].label}\n<i>Hal. ${cur + 1} dari ${total} · Geser dengan ${tge("ARROW_LEFT","◀️")} ${tge("ARROW_RIGHT","▶️")}</i>`;
}

function cancelKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("✖️ Batal", "cancel")]]);
}

function backKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_main")]]);
}

function nestsKeyboard(nests) {
  const rows = [];
  for (let i = 0; i < nests.length; i += 2) {
    const row = [Markup.button.callback(`🗂️ ${nests[i].attributes.name}`, `nest_${nests[i].attributes.id}`)];
    if (nests[i + 1]) row.push(Markup.button.callback(`🗂️ ${nests[i+1].attributes.name}`, `nest_${nests[i+1].attributes.id}`));
    rows.push(row);
  }
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function eggsKeyboard(eggs, role) {
  const whitelist = (config.EGG_WHITELIST || {})[role] || null;
  const filtered = whitelist ? eggs.filter(e => whitelist.includes(e.attributes.id)) : eggs;
  const rows = [];
  for (let i = 0; i < filtered.length; i += 2) {
    const row = [Markup.button.callback(`🥚 ${filtered[i].attributes.name}`, `egg_${filtered[i].attributes.id}`)];
    if (filtered[i + 1]) row.push(Markup.button.callback(`🥚 ${filtered[i+1].attributes.name}`, `egg_${filtered[i+1].attributes.id}`));
    rows.push(row);
  }
  if (!rows.length) rows.push([Markup.button.callback("❌ Tidak ada egg tersedia", "cancel")]);
  rows.push([Markup.button.callback("◀️ Kembali ke Nest", "back_to_nest")]);
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function plansKeyboard() {
  const rows = [];
  config.RESOURCE_PLANS.forEach((plan, i) => {
    rows.push([Markup.button.callback(planLabel(plan), `plan_${i}`)]);
  });
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function autoBackupKeyboard(ab) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(ab.enabled ? `${TOFF()} Nonaktifkan Auto Backup` : `${TON()} Aktifkan Auto Backup`, "toggle_auto_backup")],
    [Markup.button.callback(`🕒 Set Interval (${ab.interval_hours} jam)`, "set_backup_interval")],
    [Markup.button.callback("⚡ Jalankan Backup Sekarang", "run_backup_now")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function manageUsersKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔶 Set Reseller", "set_reseller"), Markup.button.callback("💎 Set Premium", "set_premium")],
    [Markup.button.callback("🌟 Set Partner", "set_partner"), Markup.button.callback("👑 Set Owner", "set_owner")],
    [Markup.button.callback("🔄 Reset Role", "reset_role")],
    [Markup.button.callback("⛔ Blacklist", "blacklist_user"), Markup.button.callback("✅ Unblacklist", "unblacklist_user")],
    [Markup.button.callback("🔍 Cari User", "search_user"), Markup.button.callback("📑 Daftar User", "list_users")],
    [Markup.button.callback("📦 Set Limit Reseller", "set_reseller_limit")],
    [Markup.button.callback("📈 Statistik User", "user_stats_lookup"), Markup.button.callback("⚡ Bulk Aksi Panel", "bulk_action_pick")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function bulkActionKeyboard(targetId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚫 Suspend Semua Panel", `bulk_sus_${targetId}`)],
    [Markup.button.callback("🔓 Unsuspend Semua Panel", `bulk_uns_${targetId}`)],
    [Markup.button.callback("🗑️ Hapus Semua Panel", `bulk_del_${targetId}`)],
    [Markup.button.callback("✖️ Batal", "cancel")],
  ]);
}

function manageServerKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🚫 Suspend Server", "suspend_server")],
    [Markup.button.callback("🔓 Unsuspend Server", "unsuspend_server")],
    [Markup.button.callback("♻️ Reinstall Server", "reinstall_server")],
    [Markup.button.callback("📅 Perpanjang Panel", "extend_panel_input")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function voucherMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎟️ Voucher Role", "create_voucher"), Markup.button.callback("🏷️ Voucher Diskon %", "create_discount_voucher")],
    [Markup.button.callback("📅 Voucher Hari +", "create_day_voucher"), Markup.button.callback("📑 List Voucher", "list_vouchers")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function voucherRoleKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔶 Reseller", "vr_reseller"), Markup.button.callback("💎 Premium", "vr_premium")],
    [Markup.button.callback("🌟 Partner", "vr_partner")],
    [Markup.button.callback("✖️ Batal", "cancel")],
  ]);
}

function myPanelsKeyboard(panels) {
  const rows = panels.map((p) => {
    const shortName = (p.name || "N/A").slice(0, 22);
    const isExpired = p.expired || (daysLeft(p.expire_date) !== null && daysLeft(p.expire_date) <= 0);
    const icon = isExpired ? `${tge("RED_DOT","🔴")}` : p.suspended ? `${tge("LOCK","🔒")}` : `${tge("GREEN_DOT","🟢")}`;
    return [Markup.button.callback(`${icon} ${shortName}`, `mng_panel_${p.server_id}`)];
  });
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

function panelManageKeyboard(panel, ownerView = false, viewerUid = null) {
  const sid = panel.server_id;
  const identifier = panel.server_identifier;
  const rows = [];
  rows.push([
    Markup.button.callback("▶️ Start", `pwr_start_${sid}`),
    Markup.button.callback("⏹️ Stop", `pwr_stop_${sid}`),
    Markup.button.callback("♻️ Restart", `pwr_rst_${sid}`),
  ]);
  rows.push([
    Markup.button.callback("🔑 Reset PW", `rst_pw_${sid}`),
    Markup.button.callback("📝 Rename", `ren_srv_${sid}`),
  ]);
  rows.push([
    Markup.button.callback("📈 Status Server", `srv_res_${sid}`),
    Markup.button.callback("🪪 Detail Panel", `dtl_srv_${sid}`),
  ]);
  if (identifier) {
    rows.push([
      Markup.button.callback("💿 Backup Server", `bkp_srv_${sid}`),
      Markup.button.callback("📑 List Backup", `lst_bkp_${sid}`),
    ]);
    rows.push([Markup.button.callback("🕒 Jadwal (Cron)", `schedules_${sid}`)]);
  }
  rows.push([
    Markup.button.callback("🚀 Upgrade Resource", `upg_sel_${sid}`),
    Markup.button.callback("🧬 Clone Panel", `cln_sel_${sid}`),
  ]);
  // V3 baris: favorit + chart + co-owner
  if (viewerUid) {
    const isFav = (db.getFavorites(viewerUid) || []).includes(String(sid));
    rows.push([
      Markup.button.callback(isFav ? "⭐ Hapus Favorit" : "⭐ Tambah Favorit", `fav_tg_${sid}`),
      Markup.button.callback("📊 Usage Chart", `chart_${sid}`),
    ]);
    rows.push([
      Markup.button.callback("👥 Co-owner", `co_mn_${sid}`),
      Markup.button.callback("🧹 Disk Cleaner", `dc_${sid}`),
    ]);
  }
  if (ownerView) {
    rows.push([
      Markup.button.callback("📅 Perpanjang (Admin)", `ext_pan_${sid}`),
      Markup.button.callback("↪️ Transfer Panel", `trn_pan_${sid}`),
    ]);
  }
  rows.push([Markup.button.callback("◀️ Kembali", "my_panels")]);
  return Markup.inlineKeyboard(rows);
}

function extendSelfPickKeyboard(panels) {
  const rows = panels.map(p => {
    const shortName = (p.name || "N/A").slice(0, 24);
    const dl = daysLeft(p.expire_date);
    const expStr = dl !== null ? ` (sisa ${dl}h)` : "";
    return [Markup.button.callback(`🗓️ ${shortName}${expStr}`, `extend_self_${p.server_id}`)];
  });
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

// ─── Keyboard: All Servers (Owner) ────────────────────────────────────────────

const SRV_PER_PAGE = 5;

function srvStatusIcon(a) {
  if (a.suspended || a.status === "suspended") return `${tge("LOCK","🔒")}`;
  if (a.status === "installing")               return `${tge("GEAR","⚙️")}`;
  if (a.status === "install_failed")           return `${tge("ERROR","❌")}`;
  return `${tge("GREEN_DOT","🟢")}`;
}

function allServersKeyboard(servers, filter = "all", page = 0) {
  let filtered;
  if (filter === "act")  filtered = servers.filter(sv => !sv.attributes.suspended && !sv.attributes.status);
  else if (filter === "sus") filtered = servers.filter(sv => sv.attributes.suspended || sv.attributes.status === "suspended");
  else filtered = servers;

  const total      = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / SRV_PER_PAGE));
  page = Math.max(0, Math.min(page, totalPages - 1));
  const slice = filtered.slice(page * SRV_PER_PAGE, (page + 1) * SRV_PER_PAGE);

  const rows = [];

  // Filter tab row
  rows.push([
    Markup.button.callback(filter === "all" ? "▶ Semua"    : "Semua",    "srv_f_all_0"),
    Markup.button.callback(filter === "act" ? "▶ Aktif"    : "Aktif",    "srv_f_act_0"),
    Markup.button.callback(filter === "sus" ? "▶ Suspended": "Suspended","srv_f_sus_0"),
  ]);

  // Server list
  for (const sv of slice) {
    const a    = sv.attributes;
    const icon = srvStatusIcon(a);
    const name = (a.name || "?").slice(0, 28);
    rows.push([Markup.button.callback(`${icon} ${name} [${a.id}]`, `srv_m_${a.id}`)]);
  }

  // Pagination
  const navRow = [];
  if (page > 0)              navRow.push(Markup.button.callback("◀ Prev", `srv_f_${filter}_${page - 1}`));
  navRow.push(Markup.button.callback(`${page + 1}/${totalPages} | ${total} server`, "srv_noop"));
  if (page < totalPages - 1) navRow.push(Markup.button.callback("Next ▶", `srv_f_${filter}_${page + 1}`));
  rows.push(navRow);

  rows.push([
    Markup.button.callback("♻️ Refresh", `srv_f_${filter}_${page}`),
    Markup.button.callback("◀️ Kembali", "back_main"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function serverMgrKeyboard(a, filter = "all", page = 0) {
  const susp = a.suspended;
  return Markup.inlineKeyboard([
    susp
      ? [Markup.button.callback("🔓 Unsuspend", `srv_do_uns_${a.id}`)]
      : [Markup.button.callback("🚫 Suspend",   `srv_do_sus_${a.id}`)],
    [
      Markup.button.callback("♻️ Reinstall", `srv_do_rei_${a.id}`),
      Markup.button.callback("🗑️ Hapus",     `srv_do_del_${a.id}`),
    ],
    [Markup.button.callback(`◀️ Kembali ke List`, `srv_f_${filter}_${page}`)],
  ]);
}

function securityMenuKeyboard(hasPin) {
  return Markup.inlineKeyboard([
    hasPin
      ? [Markup.button.callback("♻️ Ubah PIN", "change_pin"), Markup.button.callback("🗑️ Hapus PIN", "clear_pin")]
      : [Markup.button.callback("🛡️ Set PIN (2FA)", "set_pin")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}



function nodeSelectKeyboard(nodes) {
  const rows = nodes.map((n, i) => [
    Markup.button.callback(`🖥️ ${n.attributes.name}`, `node_${n.attributes.location_id || n.attributes.id}`),
  ]);
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function vpsStatusKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("♻️ Refresh", "vps_refresh")],
    [Markup.button.callback("👑 Owner Menu", "back_main")],
  ]);
}


function templatesKeyboard(templates) {
  const rows = templates.map(t => [
    Markup.button.callback(`📋 ${t.name}`, `use_tpl_${t.name.slice(0,20)}`),
  ]);
  rows.push([Markup.button.callback("✨ Buat Dari Awal", "create_panel_fresh")]);
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}

function manageTemplatesKeyboard(templates) {
  const rows = templates.map(t => [
    Markup.button.callback(`🗑️ Hapus: ${t.name}`, `del_tpl_${t.name.slice(0,20)}`),
  ]);
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

function whitelistMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("➕ Tambah ke Whitelist", "wl_add"), Markup.button.callback("➖ Hapus dari Whitelist", "wl_remove")],
    [Markup.button.callback("📑 Daftar Whitelist", "wl_list")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function pointsMenuKeyboard(pts, rate) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`💱 Tukar ${rate} Poin → 1 Hari Panel`, "points_exchange")],
    [Markup.button.callback("🏆 Leaderboard Poin", "points_leaderboard")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function scheduledMaintKeyboard(sm) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(sm.enabled ? `${TOFF()} Nonaktifkan Jadwal` : `${TON()} Aktifkan Jadwal`, "schm_toggle")],
    [Markup.button.callback(`🕒 Set Waktu (${sm.start}–${sm.end})`, "schm_set_time")],
    [Markup.button.callback(`📝 Set Pesan`, "schm_set_msg")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

function exportDataKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👥 Export User (CSV)", "export_users")],
    [Markup.button.callback("💎 Export Panel (CSV)", "export_panels")],
    [Markup.button.callback("🧾 Export Transaksi (CSV)", "export_transactions")],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
}

// ── Helper: progress bar ASCII ─────────────────────────────────────
function buildProgressBar(pct, width = 10) {
  const filled = Math.min(width, Math.round((pct / 100) * width));
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}

// ── Helper: format detik ke "Xh Yj Zm" (tanpa detik, untuk VPS status) ────────
function _fmtUptimeShort(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}h`);
  parts.push(`${h}j`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

// ── Helper: sample CPU usage 1 detik ──────────────────────────────
function getCpuUsagePct() {
  return new Promise(resolve => {
    const s1 = os.cpus();
    setTimeout(() => {
      const s2 = os.cpus();
      let idle = 0, total = 0;
      for (let i = 0; i < s1.length; i++) {
        const t1 = s1[i].times, t2 = s2[i].times;
        const di = t2.idle - t1.idle;
        const dt = Object.values(t2).reduce((a, b) => a + b, 0) -
                   Object.values(t1).reduce((a, b) => a + b, 0);
        idle  += di;
        total += dt;
      }
      resolve(total > 0 ? ((1 - idle / total) * 100) : 0);
    }, 800);
  });
}

// ── Helper: format bytes ke GB ─────────────────────────────────────
function bytesToGB(b) { return (b / 1073741824).toFixed(2); }

// ── Builder: teks STATUS VPS lengkap ──────────────────────────────
async function buildVpsText() {
  const hostname = os.hostname();
  const platform = os.platform();
  const arch     = os.arch();
  const kernel   = os.release();

  let ip = "N/A";
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === "IPv4" && !iface.internal) { ip = iface.address; break; }
    }
    if (ip !== "N/A") break;
  }

  const totalRam = os.totalmem();
  const freeRam  = os.freemem();
  const usedRam  = totalRam - freeRam;
  const ramPct   = (usedRam / totalRam * 100).toFixed(1);

  let diskTotal = 0, diskUsed = 0, diskFree = 0, diskPct = "0.0";
  try {
    const dfLines = execSync("df -k / --output=size,used,avail 2>/dev/null", { encoding: "utf8" }).trim().split("\n");
    const [sz, us, av] = dfLines[1].trim().split(/\s+/).map(Number);
    diskTotal = sz * 1024;
    diskUsed  = us * 1024;
    diskFree  = av * 1024;
    diskPct   = (diskUsed / diskTotal * 100).toFixed(1);
  } catch {}

  const cpus     = os.cpus();
  const cpuModel = (cpus[0]?.model || "Unknown").trim().replace(/\s+/g, " ");
  const cpuCores = cpus.length;
  const cpuSpeed = cpus[0]?.speed || 0;
  const cpuUsage = await getCpuUsagePct();
  const cpuPct   = cpuUsage.toFixed(1);

  const [l1, l5, l15] = os.loadavg();

  const sysUptime = _fmtUptimeShort(os.uptime());
  const botUptime = _fmtUptimeShort(process.uptime());

  const mem    = process.memoryUsage();
  const rss    = (mem.rss / 1048576).toFixed(1);
  const heap   = (mem.heapUsed / 1048576).toFixed(1);
  const nodeVer = process.version;

  const ts = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    hour12: false,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const ramBar  = buildProgressBar(parseFloat(ramPct));
  const diskBar = buildProgressBar(parseFloat(diskPct));
  const cpuBar  = buildProgressBar(parseFloat(cpuPct));

  return (
    `${tge("DESKTOP","🖥️")} <b>STATUS VPS</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${tge("BLUE_DOT","🔵")} <b>SYSTEM INFO</b>\n` +
    `├ Hostname: \`${hostname}\`\n` +
    `├ Platform: ${platform}\n` +
    `├ Arch: ${arch}\n` +
    `├ Kernel: ${kernel}\n` +
    `└ IP: ${ip}\n\n` +
    `${tge("FLOPPY","💾")} <b>MEMORY (RAM)</b>\n` +
    `├ Total: ${bytesToGB(totalRam)} GB\n` +
    `├ Used: ${bytesToGB(usedRam)} GB (${ramPct}%)\n` +
    `├ Free: ${bytesToGB(freeRam)} GB\n` +
    `└ \`${ramBar}\` ${ramPct}%\n\n` +
    `${tge("DISK","💿")} <b>DISK USAGE</b>\n` +
    `├ Total: ${bytesToGB(diskTotal)} GB\n` +
    `├ Used: ${bytesToGB(diskUsed)} GB (${diskPct}%)\n` +
    `├ Free: ${bytesToGB(diskFree)} GB\n` +
    `└ \`${diskBar}\` ${diskPct}%\n\n` +
    `${tge("LIGHTNING","⚡")} <b>CPU</b>\n` +
    `├ Model: ${cpuModel.slice(0, 35)}\n` +
    `├ Core: ${cpuCores}\n` +
    `├ Speed: ${cpuSpeed} MHz\n` +
    `├ Usage: ${cpuPct}%\n` +
    `└ \`${cpuBar}\` ${cpuPct}%\n\n` +
    `${tge("CHART_UP","📈")} <b>LOAD AVERAGE</b>\n` +
    `├ 1 min: ${l1.toFixed(2)}\n` +
    `├ 5 min: ${l5.toFixed(2)}\n` +
    `└ 15 min: ${l15.toFixed(2)}\n\n` +
    `${tge("CLOCK","⏱️")} <b>UPTIME</b>\n` +
    `├ System: ${sysUptime}\n` +
    `└ Bot: ${botUptime}\n\n` +
    `${tge("BOT","🤖")} <b>BOT PROCESS</b>\n` +
    `├ RSS: ${rss} MB\n` +
    `├ Heap: ${heap} MB\n` +
    `└ Node: ${nodeVer}\n\n` +
    `${tge("CLOCK_FACE","🕐")} ${ts} WIB`
  );
}

function upgradeSelectKeyboard(panels) {
  const active = panels.filter(p => !p.expired && !p.suspended);
  if (!active.length) return Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", "back_main")]]);
  const rows = active.map(p => [
    Markup.button.callback(`🖥️ ${(p.name || "N/A").slice(0, 25)} [${p.plan_name || "?"}]`, `upg_sel_${p.server_id}`),
  ]);
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

function upgradePlanKeyboard() {
  const rows = config.RESOURCE_PLANS.map((plan, i) => {
    const ps = planSummary(plan);
    return [Markup.button.callback(`📦 ${plan.name}  RAM:${ps.ram} CPU:${ps.cpu}`, `upg_plan_${i}`)];
  });
  rows.push([Markup.button.callback("✖️ Batal", "cancel")]);
  return Markup.inlineKeyboard(rows);
}


function ticketListKeyboard(tickets, isOwnerView) {
  const rows = tickets.slice(0, 10).map(t => [
    Markup.button.callback(
      `${t.status === "open" ? "🟢" : "🔒"} [${t.id.slice(-4)}] ${(t.subject || "").slice(0, 28)}`,
      isOwnerView ? `otkt_${t.id.slice(-8)}` : `tkt_view_${t.id.slice(-8)}`
    ),
  ]);
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
  return Markup.inlineKeyboard(rows);
}

// ─── State ────────────────────────────────────────────────────────────────────

const state = new Map();
function getState(userId) {
  if (!state.has(userId)) state.set(userId, {});
  return state.get(userId);
}
function clearState(userId) { state.delete(userId); }

async function safeEdit(ctx, text, opts = {}) {
  const msg = ctx.callbackQuery && ctx.callbackQuery.message;
  const chatId = msg && msg.chat && msg.chat.id;
  const msgId  = msg && msg.message_id;
  try {
    return await ctx.telegram.editMessageText(chatId, msgId, undefined, text, opts);
  } catch (e) {
    const desc = e.description || "";
    if (desc.includes("no text in the message") || desc.includes("there is no text")) {
      try {
        return await ctx.telegram.editMessageCaption(chatId, msgId, undefined, text, opts);
      } catch (_) { return ctx.reply(text, opts); }
    }
    return ctx.reply(text, opts);
  }
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const uname  = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "?";
  logger.sys("START", `User:${userId}(${uname}) /start`);
  if (isOwner(userId) && db.getRole(userId) !== "owner") db.setUserRole(userId, "owner");

  // Cek apakah user baru (belum pernah /start)
  const isNewUser = !db.hasStarted(userId);
  db.registerStartedUser(userId, ctx.from);
  clearState(userId);
  const role = db.getRole(userId);

  // Notif grup saat user baru pertama kali /start
  if (isNewUser && config.NEW_USER_NOTIFY_GROUP && config.GROUP_ID) {
    try {
      const nama = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
      await bot.telegram.sendMessage(config.GROUP_ID,
        `${tge("WAVE","👋")} <b>User Baru Bergabung!</b>\n\n${tge("USER","👤")} Nama: <b>${he(nama)}</b>\n${tge("NAME_BADGE","📛")} Username: @${he(ctx.from.username || "NoUsername")}\n${tge("ID_CARD","🆔")} ID: <code>${userId}</code>\n${tge("MASK","🎭")} Role: ${roleLabel(role)}\n\n<i>Selamat datang di ${he(config.BOT_NAME)}!</i>`,
        { parse_mode: "HTML" }
      );
    } catch {}
  }

  // Poin harian login (1x per hari)
  const todayKey = db.getTodayKey();
  const pointLoginKey = `login_${userId}:${todayKey}`;
  const dailyDb = db.loadDb();
  if (!dailyDb.daily_counts) dailyDb.daily_counts = {};
  if (!dailyDb.daily_counts[pointLoginKey]) {
    dailyDb.daily_counts[pointLoginKey] = 1;
    db.saveDb(dailyDb);
    const loginPts = (config.POINT_REWARDS || {}).daily_login || 1;
    if (loginPts > 0) db.addPoints(userId, loginPts);
  }


  const totalUsers = db.getAllStartedUsers().length;
  const v = getVpsStats();
  const userName = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name;

  // ── Jam WIB (UTC+7) ──
  const nowWIB = new Date().toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day:     "2-digit",
    month:   "long",
    year:    "numeric",
    hour:    "2-digit",
    minute:  "2-digit",
    second:  "2-digit",
    hour12:  false,
  });

  // ── Info reseller limit ──
  let resellerLimitHtml = "";
  if (role === "reseller") {
    const lim = db.getResellerLimit(userId);
    if (lim) {
      const exp = lim.expire_date ? new Date(lim.expire_date) : null;
      const expired = exp && exp < new Date();
      resellerLimitHtml = `\n${tge("PACKAGE","📦")} Limit Panel: <b>${lim.count} slot</b> ${expired ? `${tge("RED_DOT","🔴")} Kadaluarsa` : exp ? `(exp: ${he(formatDate(lim.expire_date))})` : "(Selamanya)"}`;
    } else {
      resellerLimitHtml = `\n${tge("PACKAGE","📦")} Limit Panel: <b>Belum diset</b> (hubungi owner)`;
    }
  }

  // Pilih pesan selamat datang sesuai role
  const roleWelcome = (config.WELCOME_BY_ROLE || {})[role] || "";
  const greetText   = roleWelcome || config.WELCOME_GREETING || "Selamat datang di bot panel!";

  const welcomeText =
    `${tge("BOT","🤖")} <b>${he(config.BOT_NAME)}</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `${tge("WAVE","👋")} <b>Halo, ${he(ctx.from.first_name)}!</b>\n` +
    `<i>${he(greetText)}</i>\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${tge("PIN","📌")} <b>Info Akun Kamu:</b>\n` +
    `<blockquote>` +
      `${tge("USER","👤")} Username: <code>${he(userName)}</code>\n` +
      `${tge("ID_CARD","🆔")} User ID: <code>${ctx.from.id}</code>\n` +
      `${tge("MASK","🎭")} Role: ${roleLabel(role)}` +
      resellerLimitHtml +
    `</blockquote>\n\n` +
    `${tge("CHART","📊")} <b>Statistik Bot:</b>\n` +
    `<blockquote>` +
      `${tge("USERS","👥")} Total User: <code>${totalUsers}</code>\n` +
      `${tge("CLOCK","⏱️")} Runtime Bot: <code>${he(v.botUptime)}</code>\n` +
      `${tge("LAPTOP","💻")} Type Modul: <code>JavaScript</code>` +
    `</blockquote>\n\n` +
    `${tge("DESKTOP","🖥️")} <b>Info VPS:</b>\n` +
    `<blockquote>` +
      `${tge("HOURGLASS","⏳")} Uptime VPS: <code>${he(v.vpsUptime)}</code>\n` +
      `${tge("GEAR","⚙️")} CPU: <code>${he(v.cpu)}</code>\n` +
      `${tge("DISK","💿")} Disk: <code>${he(v.disk)}</code>` +
    `</blockquote>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${tge("CLOCK","🕐")} <b>${he(nowWIB)} WIB</b>\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${tge("SPARKLES","✨")} <b>Pilih menu di bawah:</b>`;

  const opts = { parse_mode: "HTML", ...mainMenuKeyboard(role) };

  if (config.BANNER_FILE_ID && config.BANNER_TYPE !== "none") {
    try {
      if (config.BANNER_TYPE === "photo")
        return await ctx.replyWithPhoto(config.BANNER_FILE_ID, { caption: welcomeText, parse_mode: "HTML", ...mainMenuKeyboard(role) });
      if (config.BANNER_TYPE === "video")
        return await ctx.replyWithVideo(config.BANNER_FILE_ID, { caption: welcomeText, parse_mode: "HTML", ...mainMenuKeyboard(role) });
      if (config.BANNER_TYPE === "animation")
        return await ctx.replyWithAnimation(config.BANNER_FILE_ID, { caption: welcomeText, parse_mode: "HTML", ...mainMenuKeyboard(role) });
    } catch (err) { botLog("WARN", "BANNER", "Gagal kirim banner", err); }
  }
  ctx.reply(welcomeText, opts);
});

// ─── /getfileid ───────────────────────────────────────────────────────────────

bot.command("getfileid", (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  const s = getState(ctx.from.id);
  s.step = "waiting_banner_media";
  ctx.reply(`${tge("PAPERCLIP","📎")} Kirim <b>foto</b> atau <b>video</b> ke bot ini untuk dapatkan File ID.`, { parse_mode: "HTML", ...cancelKeyboard() });
});

bot.on(message("photo"), async (ctx) => {
  const userId = ctx.from.id;
  const role = db.getRole(userId);
  const s = getState(userId);
  const photo = ctx.message.photo;
  const fileId = photo[photo.length - 1].file_id;

  // ── Banner Media ──────────────────────────────────────────────────
  if (!isOwner(userId)) return;
  if (s.step !== "waiting_banner_media") return;
  clearState(userId);
  ctx.reply(`${tge("SUCCESS","✅")} File ID Foto:\n<code>BANNER_TYPE: "photo"</code>\n\`BANNER_FILE_ID: "${fileId}"\``, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
});

bot.on(message("video"), (ctx) => {
  const userId = ctx.from.id;
  if (!isOwner(userId)) return;
  const s = getState(userId);
  if (s.step !== "waiting_banner_media") return;
  clearState(userId);
  const fileId = ctx.message.video.file_id;
  ctx.reply(`${tge("SUCCESS","✅")} File ID Video:\n<code>BANNER_TYPE: "video"</code>\n\`BANNER_FILE_ID: "${fileId}"\``, { parse_mode: "HTML", ...mainMenuKeyboard(db.getRole(userId)) });
});

bot.on(message("animation"), (ctx) => {
  const userId = ctx.from.id;
  if (!isOwner(userId)) return;
  const s = getState(userId);
  if (s.step !== "waiting_banner_media") return;
  clearState(userId);
  const fileId = ctx.message.animation.file_id;
  ctx.reply(`${tge("SUCCESS","✅")} File ID GIF:\n<code>BANNER_TYPE: "animation"</code>\n\`BANNER_FILE_ID: "${fileId}"\``, { parse_mode: "HTML", ...mainMenuKeyboard(db.getRole(userId)) });
});

// ─── /credit ──────────────────────────────────────────────────────────────────

bot.command("credit", (ctx) => {
  logger.sys("CMD", `User:${ctx.from.id} /credit`);
  ctx.reply(
    `${tge("MAN","👨")}‍${tge("LAPTOP","💻")} <b>Credit &amp; Info Script</b>\n\n${tge("BOT","🤖")} Nama Bot: <b>${he(config.BOT_NAME)}</b>\n${tge("USER","👤")} Developer: <b>${he(config.DEVELOPER_NAME)}</b>\n${tge("PHONE","📱")} Kontak: @${he(config.DEVELOPER_USERNAME)}\n\n${he(config.CREDIT_TEXT)}`,
    {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard([
        [Markup.button.url(`💼 Hubungi Developer`, `https://t.me/${config.DEVELOPER_USERNAME}`)],
        [Markup.button.callback("◀️ Kembali", "back_main")],
      ]),
    }
  );
});

// ─── /info ────────────────────────────────────────────────────────────────────

bot.command("info", (ctx) => {
  const userId     = ctx.from.id;
  logger.sys("CMD", `User:${userId} /info`);
  const role       = db.getRole(userId);
  const count      = db.getPanelCount(userId);
  const sudahStart = db.hasStarted(userId);
  const blacklisted= db.isBlacklisted(userId);
  const dailyCount = db.getDailyCount(userId);
  const dailyLimit = getDailyLimit(role);

  const nama     = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ");
  const username = ctx.from.username ? `@${ctx.from.username}` : "Tidak ada";

  // Hirarki role: owner > partner > premium > reseller > user
  const roleRank = { owner: 5, partner: 4, premium: 3, reseller: 2, user: 1 };
  const myRank   = roleRank[role] || 1;
  const ck = (r) => myRank >= roleRank[r] ? `${tge("SUCCESS","✅")}` : `${tge("ERROR","❌")}`;

  let text =
    `${tge("LIST","📋")} <b>INFO AKUN</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `${tge("ID_CARD","🆔")} ID: "${userId}"\n` +
    `${tge("USER","👤")} Username: "${username}"\n` +
    `${tge("MEMO","📝")} Nama: "${nama}"\n`;

  if (blacklisted) text += `${tge("PROHIBITED","🚫")} Status: <b>"DIBLACKLIST"</b>\n`;

  text +=
    `\n` +
    `- Public Owner? ${ck("owner")}\n` +
    `- Public Partner? ${ck("partner")}\n` +
    `- Public Premium? ${ck("premium")}\n` +
    `- Public Reseller? ${ck("reseller")}\n` +
    `- Public User? ${ck("user")}\n`;

  // Info tambahan panel
  text += `\n${tge("DESKTOP","🖥️")} Panel Dibuat: "${count}"`;
  if (dailyLimit < 9999) {
    text += `\n${tge("CALENDAR","📅")} Buat Hari Ini: "${dailyCount}/${dailyLimit}"`;
  }
  if (role === "reseller") {
    const limObj = db.getResellerLimit(userId);
    if (limObj) {
      const exp       = limObj.expire_date ? new Date(limObj.expire_date) : null;
      const isExpired = exp && exp < new Date();
      const expStr    = isExpired ? `Kadaluarsa ${tge("RED_DOT","🔴")}` : exp ? `Exp: ${formatDate(limObj.expire_date)}` : "Selamanya";
      text += `\n${tge("PACKAGE","📦")} Limit Panel: "${limObj.count} slot (${expStr})"`;
    } else {
      text += `\n${tge("PACKAGE","📦")} Limit Panel: "Belum diset — hubungi owner"`;
    }
  }

  const botStatus = sudahStart
    ? `\n\n${tge("SUCCESS","✅")} "${nama}" sudah start bot! silahkan create.`
    : `\n\n${tge("ERROR","❌")} "${nama}" belum start bot!`;
  text += botStatus;

  ctx.reply(text, { parse_mode: "HTML" });
});

// ─── /mypanels ────────────────────────────────────────────────────────────────

bot.command("mypanels", (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /mypanels`);
  const panels = db.getUserPanels(userId);
  if (!panels.length) return ctx.reply(`${tge("EMPTY_BOX","📭")} Kamu belum memiliki panel.`, backKeyboard());
  let text = `${tge("LIST","📋")} <b>Daftar Panel Kamu (${panels.length}):</b>\n\n`;
  panels.forEach((p, i) => {
    const tipe    = p.panel_type === "admin" ? `${tge("CROWN","👑")} Admin` : `${tge("DESKTOP","🖥️")} Biasa`;
    const _psn    = Number(p.server_num) === 2 ? 2 : 1;
    const srvTag  = `[${he(serverLabel(_psn))}]`;
    const dl      = daysLeft(p.expire_date);
    const expStr  = dl !== null ? (dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : dl <= 3 ? `${tge("YELLOW_DOT","🟡")} Sisa ${dl} hari` : `${tge("GREEN_DOT","🟢")} Sisa ${dl} hari`) : "";
    const status  = p.expired ? `${tge("SKULL","💀")} Expired` : p.suspended ? `${tge("LOCK","🔒")} Suspended` : `${tge("SUCCESS","✅")} Aktif`;
    text +=
      `<b>${i+1}. ${he(p.name || "N/A")}</b> ${srvTag}\n` +
      `   ${tge("ID_CARD","🆔")} Server ID: <code>${he(p.server_id || "N/A")}</code>\n` +
      `   ${tge("MASK","🎭")} Tipe: ${tipe}\n` +
      `   ${tge("EGG","🥚")} Egg: ${he(p.egg || "N/A")}\n` +
      `   ${tge("PACKAGE","📦")} Paket: ${he(p.plan_name || "N/A")}\n` +
      `   ${tge("CALENDAR","📅")} Dibuat: ${formatDate(p.created_at)}\n` +
      `   ${tge("ALARM","⏰")} Expired: ${formatDate(p.expire_date)} ${expStr}\n` +
      `   ${tge("BRIGHT","🔆")} Status: ${status}\n\n`;
  });
  ctx.reply(text, { parse_mode: "HTML", ...myPanelsKeyboard(panels) });
});

// ─── /ping ────────────────────────────────────────────────────────────────────

bot.command("ping", (ctx) => {
  logger.sys("CMD", `User:${ctx.from.id} /ping`);
  const v = getVpsStats();
  ctx.reply(
    `${tge("PINGPONG","🏓")} <b>Pong!</b>\n\n━━━━ ${tge("BOT","🤖")} Bot ━━━━\n${tge("CLOCK","⏱️")} Bot Runtime: \`${v.botUptime}\`\n\n━━━━ ${tge("DESKTOP","🖥️")} VPS ━━━━\n${tge("CLOCK","⏱️")} VPS Uptime: \`${v.vpsUptime}\`\n${tge("FLOPPY","💾")} RAM: \`${v.ram}\`\n${tge("GEAR","⚙️")} CPU: \`${v.cpu}\`\n${tge("DISK","💿")} Disk: \`${v.disk}\`\n${tge("DESKTOP","🖥️")} OS: \`${v.platform}\``,
    { parse_mode: "HTML", ...backKeyboard() }
  );
});


// ─── /stats ───────────────────────────────────────────────────────────────────

bot.command("stats", (ctx) => {
  logger.sys("CMD", `User:${ctx.from.id} /stats`);
  if (!isOwner(ctx.from.id)) return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`);
  sendStats(ctx);
});

// ─── /nodes ───────────────────────────────────────────────────────────────────

bot.command("nodes", async (ctx) => {
  logger.sys("CMD", `User:${ctx.from.id} /nodes`);
  if (!isOwner(ctx.from.id)) return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`);
  await sendNodes(ctx);
});

// ─── /redeem ──────────────────────────────────────────────────────────────────

bot.command("redeem", (ctx) => {
  const userId = ctx.from.id;
  const args = ctx.message.text.split(" ").slice(1);
  logger.sys("CMD", `User:${userId} /redeem${args[0] ? " " + args[0] : ""}`);
  if (args.length > 0) return redeemCode(ctx, userId, args[0].toUpperCase());
  const s = getState(userId);
  s.step = "redeem_code";
  ctx.reply(`${tge("ADMISSION","🎟️")} Masukkan <b>kode voucher</b> kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
});


// ─── Callback Query Handler ───────────────────────────────────────────────────

bot.on("callback_query", async (ctx) => {
  const data   = ctx.callbackQuery.data;
  const userId = ctx.from.id;
  const uname  = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "?";
  // Log semua tombol kecuali navigasi menu biasa
  const isNav = data === "menu_pg_info" || data.startsWith("menu_pg_");
  if (!isNav) logger.action("BTN", `User:${userId}(${uname}) → "${data}"`);
  try {
    const role = db.getRole(userId);

  // ── Cek Join Channel (harus sebelum answerCbQuery agar bisa show_alert) ──
  if (data === "check_join") {
    const channels = config.REQUIRED_CHANNELS || [];
    const isPrivateCb = ctx.chat?.type === "private";
    if (!channels.length) {
      await ctx.answerCbQuery(`${tge("SUCCESS","✅")} Akses diberikan!`);
      return;
    }
    const notJoined = [];
    for (const ch of channels) {
      try {
        const member = await ctx.telegram.getChatMember(ch.id, userId);
        const ok = ["member", "administrator", "creator"].includes(member.status);
        if (!ok) notJoined.push(ch);
      } catch { /* skip channel yg tidak bisa dicek */ }
    }
    if (notJoined.length) {
      await ctx.answerCbQuery(
        `${tge("ERROR","❌")} Kamu belum join: ${notJoined.map(c => c.label).join(", ")}`,
        { show_alert: true }
      );
      const joinButtons = notJoined.map(ch => [Markup.button.url(`📢 Join ${ch.label}`, ch.url)]);
      joinButtons.push([Markup.button.callback(`${tge("SUCCESS","✅")} Sudah Join — Cek Ulang`, "check_join")]);
      const msg =
        `${tge("LOCK","🔒")} <b>Akses Terbatas!</b>\n\n` +
        `Kamu masih belum bergabung ke <b>${notJoined.length} channel</b> berikut:\n\n` +
        notJoined.map((ch, i) => `${i + 1}. 📢 <b>${he(ch.label)}</b>`).join("\n") +
        `\n\nSetelah bergabung, tekan tombol <b>✅ Sudah Join — Cek Ulang</b> di bawah.`;
      if (isPrivateCb) {
        return safeEdit(ctx, msg, { parse_mode: "HTML", ...Markup.inlineKeyboard(joinButtons) });
      } else {
        // Dari grup → kirim ke private chat, jangan edit pesan di grup
        try { await ctx.telegram.sendMessage(userId, msg, { parse_mode: "HTML", ...Markup.inlineKeyboard(joinButtons) }); } catch {}
        return;
      }
    }
    await ctx.answerCbQuery(`${tge("SUCCESS","✅")} Verifikasi berhasil! Selamat datang.`);
    if (isPrivateCb) {
      return safeEdit(ctx, menuHeaderText(role, 0), { parse_mode: "HTML", ...mainMenuKeyboard(role, 0) });
    } else {
      // Verifikasi berhasil dari grup → buka menu di private chat
      try { await ctx.telegram.sendMessage(userId, menuHeaderText(role, 0), { parse_mode: "HTML", ...mainMenuKeyboard(role, 0) }); } catch {}
      return;
    }
  }

    // ── Language selection ─────────────────────────────────────────────
    if (data.startsWith("setlang_")) {
      const code = data.replace("setlang_", "");
      const { t: tI, LANG_NAMES } = require("./Utils/i18n");
      const curLang = db.getUserLang(userId) || "id";
      db.setUserLang(userId, code);
      const newName = LANG_NAMES[code] || code;
      await ctx.answerCbQuery();
      return safeEdit(ctx, `${tI(code, "lang_changed")} ${newName} ✅`);
    }

    // ── Quick actions (start/stop/restart via inline button) ────────────
    const _qaMatch = data.match(/^qa_(start|stop|restart)_(.+)$/);
    if (_qaMatch) {
      const action = _qaMatch[1];
      const sid = _qaMatch[2];
      const panel = db.getPanelByServerId(sid);
      if (!panel) return ctx.answerCbQuery(`${tge("ERROR","❌")} Server tidak ditemukan.`, { show_alert: true });
      if (panel.ownerUserId !== String(userId) && !isOwner(userId)) return ctx.answerCbQuery(`${tge("LOCK","🔒")} Bukan punya kamu.`, { show_alert: true });
      try {
        await ptero.sendPowerAction(sid, action, psn(panel));
        return ctx.answerCbQuery(`${tge("SUCCESS","✅")} ${action.toUpperCase()} dikirim!`);
      } catch (e) {
        return ctx.answerCbQuery(`${tge("ERROR","❌")} Gagal: ${e.message}`, { show_alert: true });
      }
    }

    // ── Snapshot via inline button ──────────────────────────────────────
    const _snapMatch = data.match(/^snap_save_(.+)$/);
    if (_snapMatch) {
      const sid = _snapMatch[1];
      const panel = db.getPanelByServerId(sid);
      if (!panel || (panel.ownerUserId !== String(userId) && !isOwner(userId)))
        return ctx.answerCbQuery(`${tge("ERROR","❌")} Bukan milik kamu.`, { show_alert: true });
      try {
        const details = await ptero.getServerDetails(sid, psn(panel));
        db.saveSnapshot(sid, "", { details, savedAt: Date.now() });
        return ctx.answerCbQuery(`${tge("CAMERA","📸")} Snapshot disimpan!`);
      } catch (e) { return ctx.answerCbQuery(`${tge("ERROR","❌")} ${e.message}`, { show_alert: true }); }
    }

    // ── Backup important toggle ─────────────────────────────────────────
    const _bkimpMatch = data.match(/^bkimp_(.+)_(.+)$/);
    if (_bkimpMatch) {
      const sid = _bkimpMatch[1];
      const backupId = _bkimpMatch[2];
      const cur = db.isBackupImportant(userId, backupId);
      db.markBackupImportant(userId, backupId, !cur);
      return ctx.answerCbQuery(cur ? "🏷 Tag IMPORTANT dilepas." : "⭐ Backup ditandai IMPORTANT (tidak akan auto-hapus).");
    }

    await ctx.answerCbQuery();

  // ── Back / Cancel ──────────────────────────────────────────────────
  if (data === "back_main" || data === "cancel" || data === "main_menu") {
    clearState(userId);
    return safeEdit(ctx, menuHeaderText(role, 0), { parse_mode: "HTML", ...mainMenuKeyboard(role, 0) });
  }

  if (data.startsWith("menu_pg_")) {
    const pg = parseInt(data.replace("menu_pg_", "")) || 0;
    return safeEdit(ctx, menuHeaderText(role, pg), { parse_mode: "HTML", ...mainMenuKeyboard(role, pg) });
  }

  if (data === "menu_pg_info") {
    return ctx.answerCbQuery(`Gunakan ${tge("ARROW_LEFT","◀️")} ${tge("ARROW_RIGHT","▶️")} untuk pindah halaman`, { show_alert: false });
  }

  // ── Back to Nest ───────────────────────────────────────────────────
  if (data === "back_to_nest") {
    const s = getState(userId);
    s.step = "nest";
    const nests = await ptero.getNests(s.server_num || 1);
    if (!nests.length) return safeEdit(ctx, `${tge("ERROR","❌")} Tidak ada Nest tersedia.`, backKeyboard());
    s.nests = nests;
    return safeEdit(ctx, `${tge("CARD_INDEX","🗂️")} <b>Pilih Nest</b>\n\nPilih kategori server:`, { parse_mode: "HTML", ...nestsKeyboard(nests) });
  }

  // ── My Status ─────────────────────────────────────────────────────
  if (data === "my_status") {
    const count = db.getPanelCount(userId);
    const panels = db.getUserPanels(userId);
    const hasPin = !!db.getPin(userId);
    const trialUsed = db.hasUsedTrial(userId);

    let text = `${tge("LIST","📋")} <b>Status Akun</b>\n\n${tge("ID_CARD","🆔")} ID: \`${userId}\`\n${tge("MASK","🎭")} Role: ${roleLabel(role)}\n${tge("DESKTOP","🖥️")} Panel Dibuat: *${count}*`;
    if (role === "reseller") {
      const limObj = db.getResellerLimit(userId);
      if (limObj) {
        const exp = limObj.expire_date ? new Date(limObj.expire_date) : null;
        const isExpired = exp && exp < new Date();
        text += `\n${tge("PACKAGE","📦")} Limit: *${limObj.count} slot* ${isExpired ? `${tge("RED_DOT","🔴")} Kadaluarsa` : exp ? `(exp: ${formatDate(limObj.expire_date)})` : "(Selamanya)"}`;
      } else {
        text += `\n${tge("PACKAGE","📦")} Limit: <b>Belum diset</b> (hubungi owner)`;
      }
    }
    text += `\n${tge("LOCK_KEY","🔐")} PIN 2FA: ${hasPin ? `${tge("SUCCESS","✅")} Aktif` : `${tge("ERROR","❌")} Belum set`}`;
    text += `\n${tge("GIFT","🎁")} Trial Panel: ${trialUsed ? `${tge("SUCCESS","✅")} Sudah dipakai` : `${tge("GREEN_DOT","🟢")} Tersedia`}`;

    if (panels.length) {
      text += `\n\n${tge("OPEN_FOLDER","📂")} <b>Panel Aktif:</b>\n`;
      panels.filter(p => !p.expired && !p.suspended).slice(0, 5).forEach((p) => {
        const dl = daysLeft(p.expire_date);
        text += `• ${p.name || "N/A"} — ${dl !== null && dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : dl !== null && dl <= 3 ? `${tge("YELLOW_DOT","🟡")} ${dl}hr` : `${tge("GREEN_DOT","🟢")} ${dl}hr`}\n`;
      });
    }
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── My Panels (callback) ───────────────────────────────────────────
  if (data === "my_panels") {
    const panels = db.getUserPanels(userId);
    if (!panels.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Kamu belum memiliki panel.`, backKeyboard());
    let text = `${tge("LIST","📋")} *Daftar Panel Kamu (${panels.length}):*\n\n`;
    panels.forEach((p, i) => {
      const tipe    = p.panel_type === "admin" ? `${tge("CROWN","👑")} Admin` : `${tge("DESKTOP","🖥️")} Biasa`;
      const dl      = daysLeft(p.expire_date);
      const expStr  = dl !== null ? (dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : dl <= 3 ? `${tge("YELLOW_DOT","🟡")} Sisa ${dl} hari` : `${tge("GREEN_DOT","🟢")} Sisa ${dl} hari`) : "";
      const status  = p.expired ? `${tge("SKULL","💀")} Expired` : p.suspended ? `${tge("LOCK","🔒")} Suspended` : `${tge("SUCCESS","✅")} Aktif`;
      text +=
        `*${i+1}. ${p.name || "N/A"}*\n` +
        `   ${tge("ID_CARD","🆔")} Server ID: \`${p.server_id || "N/A"}\`\n` +
        `   ${tge("MASK","🎭")} Tipe: ${tipe}\n` +
        `   ${tge("EGG","🥚")} Egg: ${p.egg || "N/A"}\n` +
        `   ${tge("PACKAGE","📦")} Paket: ${p.plan_name || "N/A"}\n` +
        `   ${tge("CALENDAR","📅")} Dibuat: ${formatDate(p.created_at)}\n` +
        `   ${tge("ALARM","⏰")} Expired: ${formatDate(p.expire_date)} ${expStr}\n` +
        `   ${tge("BRIGHT","🔆")} Status: ${status}\n\n`;
    });
    text += `_Pilih panel di bawah untuk kelola:_`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...myPanelsKeyboard(panels) });
  }

  // ── Manage Panel (individual) ──────────────────────────────────────
  if (data.startsWith("mng_panel_")) {
    const serverId = data.slice(10);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    if (!panel) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());
    const dl = daysLeft(panel.expire_date);
    const expStr = dl !== null ? (dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : dl <= 3 ? `${tge("YELLOW_DOT","🟡")} Sisa ${dl} hari` : `${tge("GREEN_DOT","🟢")} Sisa ${dl} hari`) : "";
    const status = panel.expired ? `${tge("SKULL","💀")} Expired` : panel.suspended ? `${tge("LOCK","🔒")} Suspended` : `${tge("SUCCESS","✅")} Aktif`;
    const text =
      `${tge("WRENCH","🔧")} <b>Kelola Panel</b>\n\n` +
      `${tge("NAME_BADGE","📛")} Nama: *${panel.name || "N/A"}*\n` +
      `${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n` +
      `${tge("PACKAGE","📦")} Paket: ${panel.plan_name || "N/A"}\n` +
      `${tge("CALENDAR","📅")} Expired: ${formatDate(panel.expire_date)} ${expStr}\n` +
      `${tge("BRIGHT","🔆")} Status: ${status}\n\n` +
      `Pilih aksi:`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...panelManageKeyboard(panel, isOwner(userId), userId) });
  }

  // ── Power Control ──────────────────────────────────────────────────
  if (data.startsWith("pwr_start_") || data.startsWith("pwr_stop_") || data.startsWith("pwr_rst_")) {
    const action = data.startsWith("pwr_start_") ? "start" : data.startsWith("pwr_stop_") ? "stop" : "restart";
    const serverId = data.startsWith("pwr_start_") ? data.slice(10) : data.startsWith("pwr_stop_") ? data.slice(9) : data.slice(8);

    // PIN Check
    if (needsPin(userId, "power")) {
      const s = getState(userId);
      s.step = "verify_pin"; s.pin_action = data;
      return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Verifikasi PIN</b>\n\nMasukkan PIN kamu untuk melanjutkan:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }

    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan. Panel ini dibuat sebelum fitur power control tersedia.`, backKeyboard());

    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengirim sinyal *${action}*...`, { parse_mode: "HTML" });
    const ok = await ptero.sendPowerAction(identifier, action, psn(panel));
    const icons = { start: `${tge("ARROW_RIGHT","▶️")}`, stop: `${tge("STOP","⏹️")}`, restart: `${tge("REFRESH","🔄")}` };
    db.addAuditLog({ actorId: userId, action: `Power ${action}`, target: serverId });
    if (ok) db.touchPanelActive(serverId);
    return ctx.reply(
      ok ? `${icons[action] || `${tge("LIGHTNING","⚡")}`} Server berhasil dikirim sinyal *${action}*.` : `${tge("ERROR","❌")} Gagal mengirim sinyal *${action}*.`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── Reset Password Panel ───────────────────────────────────────────
  if (data.startsWith("rst_pw_")) {
    const serverId = data.slice(7);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    if (!panel) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());

    if (needsPin(userId, "reset_pw")) {
      const s = getState(userId);
      s.step = "verify_pin"; s.pin_action = data;
      return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Verifikasi PIN</b>\n\nMasukkan PIN kamu untuk melanjutkan:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }

    const s = getState(userId);
    s.step = "reset_pw_new";
    s.reset_pw_server_id = serverId;
    return safeEdit(ctx, `${tge("KEY","🔑")} <b>Reset Password Panel</b>\n\nPanel: *${panel.name}*\n\nMasukkan <b>password baru</b> (min. 8 karakter):`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Rename Server ──────────────────────────────────────────────────
  if (data.startsWith("ren_srv_")) {
    const serverId = data.slice(8);
    const s = getState(userId);
    s.step = "rename_srv_new";
    s.rename_srv_id = serverId;
    return safeEdit(ctx, `${tge("PENCIL","✏️")} <b>Rename Server</b>\n\nMasukkan <b>nama baru</b> untuk server \`${serverId}\`:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Server Resources ───────────────────────────────────────────────
  if (data.startsWith("srv_res_")) {
    const serverId = data.slice(8);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil status server...`, { parse_mode: "HTML" });
    const res = await ptero.getServerResources(identifier, psn(panel));
    if (!res) return ctx.reply(`${tge("ERROR","❌")} Gagal mengambil status server.`, backKeyboard());
    const st = res.current_state || "unknown";
    const rss = res.resources || {};
    const cpuPct  = (rss.cpu_absolute || 0).toFixed(1);
    const ramUsed = formatBytes(rss.memory_bytes || 0);
    const diskUsed = formatBytes(rss.disk_bytes || 0);
    const netRx   = formatBytes(rss.network_rx_bytes || 0);
    const netTx   = formatBytes(rss.network_tx_bytes || 0);
    const uptime  = rss.uptime ? formatUptime(Math.floor(rss.uptime / 1000)) : "N/A";
    return ctx.reply(
      `${tge("CHART","📊")} <b>Status Server</b>\n\n${tge("NAME_BADGE","📛")} Panel: \`${panel.name}\`\n${tge("REFRESH","🔄")} State: *${st.toUpperCase()}*\n\n` +
      `${tge("GEAR","⚙️")} CPU: *${cpuPct}%*\n${tge("FLOPPY","💾")} RAM: *${ramUsed}*\n${tge("DISK","💿")} Disk: *${diskUsed}*\n` +
      `${tge("GLOBE","🌐")} Net ↓: ${netRx}  |  ↑: ${netTx}\n${tge("CLOCK","⏱️")} Uptime: *${uptime}*`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── Detail Panel ───────────────────────────────────────────────────
  if (data.startsWith("dtl_srv_")) {
    const serverId = data.slice(8);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    if (!panel) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil detail panel...`);
    const srv = await ptero.getServerDetails(serverId, psn(panel));
    if (!srv) return ctx.reply(`${tge("ERROR","❌")} Gagal mengambil detail dari panel.`, backKeyboard());
    const allocs = srv.relationships?.allocations?.data || [];
    const alloc  = allocs[0]?.attributes;
    const ip     = alloc ? `${alloc.ip_alias || alloc.ip}:${alloc.port}` : "N/A";
    const egg    = srv.relationships?.egg?.attributes;
    const nest   = srv.relationships?.nest?.attributes;
    const dl     = daysLeft(panel.expire_date);
    const expStr = dl !== null ? (dl <= 0 ? `${tge("RED_DOT","🔴")} Expired` : `${tge("GREEN_DOT","🟢")} Sisa ${dl} hari`) : `${tge("INFINITY","♾️")} Tidak ada`;
    const status = panel.expired ? `${tge("SKULL","💀")} Expired` : panel.suspended ? `${tge("LOCK","🔒")} Suspended` : `${tge("SUCCESS","✅")} Aktif`;
    const text =
      `${tge("LIST","📋")} <b>Detail Panel</b>\n\n` +
      `${tge("NAME_BADGE","📛")} Nama: \`${srv.name}\`\n` +
      `${tge("ID_CARD","🆔")} Server ID: \`${srv.id}\`\n` +
      `${tge("KEY","🔑")} Identifier: \`${srv.identifier || "N/A"}\`\n` +
      `${tge("GLOBE","🌐")} IP:Port: \`${ip}\`\n\n` +
      `${tge("CARD_INDEX","🗂️")} Nest: *${nest?.name || "N/A"}*\n` +
      `${tge("EGG","🥚")} Egg: *${egg?.name || "N/A"}*\n\n` +
      `${tge("GEAR","⚙️")} CPU: *${srv.limits?.cpu || 0}%*\n` +
      `${tge("FLOPPY","💾")} RAM: *${srv.limits?.memory || 0} MB*\n` +
      `${tge("DISK","💿")} Disk: *${srv.limits?.disk || 0} MB*\n` +
      `${tge("FLOPPY","💾")} Backup Slot: *${srv.feature_limits?.backups || 0}*\n\n` +
      `${tge("CALENDAR","📅")} Expired: ${formatDate(panel.expire_date)} ${expStr}\n` +
      `${tge("BRIGHT","🔆")} Status: ${status}`;
    return ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Perpanjang Panel Mandiri (diblokir – hanya owner) ──────────────
  if (data.startsWith("extend_self_pick_") || (data.startsWith("extend_self_") && !data.startsWith("extend_self_pick_"))) {
    return safeEdit(ctx,
      `${tge("LOCK","🔒")} <b>Perpanjang Panel</b>\n\nPerpanjangan panel hanya bisa dilakukan oleh <b>Owner Bot</b>.\n\n${tge("CALENDAR","📅")} Jika kamu sudah redeem voucher hari, saldo harimu sudah tersimpan — hubungi owner untuk proses perpanjangannya.`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── Transfer Panel (owner) ─────────────────────────────────────────
  if (data.startsWith("trn_pan_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const serverId = data.slice(8);
    const s = getState(userId);
    s.step = "transfer_pan_uid";
    s.transfer_server_id = serverId;
    return safeEdit(ctx,
      `${tge("REFRESH","🔄")} <b>Transfer Panel</b>\n\n${tge("ID_CARD","🆔")} Server ID: \`${serverId}\`\n\nMasukkan <b>Telegram User ID</b> tujuan transfer:`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  // ── Backup Server ──────────────────────────────────────────────────
  if (data.startsWith("bkp_srv_")) {
    const serverId = data.slice(8);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan.`, backKeyboard());

    if (needsPin(userId, "backup")) {
      const s = getState(userId);
      s.step = "verify_pin"; s.pin_action = data;
      return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Verifikasi PIN</b>\n\nMasukkan PIN kamu untuk melanjutkan:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }

    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat backup server...`, { parse_mode: "HTML" });
    const backup = await ptero.createBackup(identifier, psn(panel));
    db.addAuditLog({ actorId: userId, action: "Backup Server", target: serverId });
    if (!backup) return ctx.reply(`${tge("ERROR","❌")} Gagal membuat backup. Pastikan server punya slot backup.`, backKeyboard());
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Backup Dimulai!</b>\n\n${tge("FLOPPY","💾")} Nama: \`${backup.name}\`\n${tge("ID_CARD","🆔")} UUID: \`${backup.uuid}\`\n${tge("CALENDAR","📅")} Dibuat: ${formatDate(backup.created_at || new Date().toISOString())}\n\nBackup berjalan di background. Cek list backup untuk status.`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── List Backup ────────────────────────────────────────────────────
  if (data.startsWith("lst_bkp_")) {
    const serverId = data.slice(8);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil daftar backup...`, { parse_mode: "HTML" });
    const backups = await ptero.getBackups(identifier, psn(panel));
    if (!backups.length) return ctx.reply(`${tge("EMPTY_BOX","📭")} Belum ada backup untuk server ini.`, backKeyboard());
    let text = `${tge("FLOPPY","💾")} <b>Daftar Backup</b>\n\n${tge("NAME_BADGE","📛")} Panel: \`${panel.name}\`\n\n`;
    backups.forEach((b, i) => {
      const attr = b.attributes;
      const status = attr.completed_at ? `${tge("SUCCESS","✅")} Selesai` : `${tge("HOURGLASS","⏳")} Proses`;
      const size = attr.bytes ? formatBytes(attr.bytes) : "N/A";
      text += `*${i+1}. ${attr.name}*\n   Status: ${status}  •  Size: ${size}\n   ${tge("CALENDAR","📅")} ${formatDate(attr.created_at)}\n\n`;
    });
    return ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Schedules / Cron ───────────────────────────────────────────────
  if (data.startsWith("schedules_")) {
    const serverId = data.slice(10);
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Server identifier tidak ditemukan.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil jadwal...`, { parse_mode: "HTML" });
    const schedules = await ptero.getSchedules(identifier, psn(panel));
    let text = `${tge("ALARM","⏰")} <b>Jadwal Server</b>\n\n${tge("NAME_BADGE","📛")} Panel: \`${panel.name}\`\n`;
    if (schedules.length) {
      schedules.forEach((sc, i) => {
        const a = sc.attributes;
        text += `\n*${i+1}. ${a.name}*\n   ${tge("ALARM","⏰")} Cron: \`${a.cron_minute} ${a.cron_hour} ${a.cron_day_of_month} ${a.cron_month} ${a.cron_day_of_week}\`\n   Status: ${a.is_active ? `${tge("SUCCESS","✅")} Aktif` : `${tge("PAUSE","⏸️")} Nonaktif`}\n`;
      });
    } else {
      text += `\n\n${tge("EMPTY_BOX","📭")} Belum ada jadwal.`;
    }

    const s = getState(userId);
    s.schedule_server_id = serverId;

    const rows = [];
    schedules.forEach((sc) => {
      rows.push([Markup.button.callback(`🗑️ Hapus: ${sc.attributes.name.slice(0,20)}`, `del_sched_${serverId}_${sc.attributes.id}`)]);
    });
    rows.push([Markup.button.callback("✨ Buat Jadwal Baru", `new_sched_${serverId}`)]);
    rows.push([Markup.button.callback("◀️ Kembali", "my_panels")]);
    return safeEdit(ctx, text, { parse_mode: "HTML", ...Markup.inlineKeyboard(rows) });
  }

  if (data.startsWith("del_sched_")) {
    const parts = data.slice(10).split("_");
    const serverId = parts[0];
    const scheduleId = parts[1];
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) return safeEdit(ctx, `${tge("ERROR","❌")} Identifier tidak ditemukan.`, backKeyboard());
    const ok = await ptero.deleteSchedule(identifier, scheduleId, psn(panel));
    db.addAuditLog({ actorId: userId, action: "Hapus Jadwal", target: serverId, detail: `scheduleId: ${scheduleId}` });
    return safeEdit(ctx, ok ? `${tge("SUCCESS","✅")} Jadwal berhasil dihapus.` : `${tge("ERROR","❌")} Gagal menghapus jadwal.`, backKeyboard());
  }

  if (data.startsWith("new_sched_")) {
    const serverId = data.slice(10);
    const s = getState(userId);
    s.step = "sched_name";
    s.sched_server_id = serverId;
    return safeEdit(ctx,
      `${tge("PLUS","➕")} <b>Buat Jadwal Baru</b>\n\nMasukkan <b>nama jadwal</b>:\n_(contoh: Auto Restart)_`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  // ── Extend Panel ──────────────────────────────────────────────────
  if (data.startsWith("ext_pan_")) {
    const serverId = data.slice(8);
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId);
    s.step = "extend_days";
    s.extend_server_id = serverId;
    return safeEdit(ctx, `${tge("SPIRAL_CAL","🗓️")} <b>Perpanjang Panel</b>\n\nServer ID: \`${serverId}\`\n\nMasukkan <b>jumlah hari</b> perpanjangan:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Extend Panel (owner input) ─────────────────────────────────────
  if (data === "extend_panel_input") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId);
    s.step = "extend_server_id";
    return safeEdit(ctx, `${tge("SPIRAL_CAL","🗓️")} Masukkan <b>Server ID</b> yang ingin diperpanjang:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Create Panel ──────────────────────────────────────────────────
  if (data === "create_panel" || data === "create_admin_panel") {
    const panelLimit = getPanelLimit(role);
    const panelCount = db.getPanelCount(userId);
    const dailyLimit = getDailyLimit(role);
    const dailyCount = db.getDailyCount(userId);

    if (panelLimit === 0) return safeEdit(ctx, `${tge("ERROR","❌")} Role kamu belum punya akses buat panel.\n${tge("ADMISSION","🎟️")} Redeem voucher untuk upgrade role!`, { parse_mode: "HTML", ...backKeyboard() });
    if (panelCount >= panelLimit && panelLimit !== 9999) return safeEdit(ctx, `${tge("ERROR","❌")} Kamu sudah mencapai batas *${panelLimit} panel*.\n\nHubungi owner untuk perpanjang atau hapus panel.`, { parse_mode: "HTML", ...backKeyboard() });
    if (dailyLimit < 9999 && dailyCount >= dailyLimit) return safeEdit(ctx, `${tge("ERROR","❌")} Kamu sudah membuat *${dailyCount}* panel hari ini.\nBatas harian: *${dailyLimit}* panel.\n\nCoba lagi besok!`, { parse_mode: "HTML", ...backKeyboard() });

    if (data === "create_admin_panel" && !["premium", "partner", "owner"].includes(role))
      return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Premium, Partner & Owner yang bisa buat Admin Panel.`, backKeyboard());

    // ── Batasi max 1 Admin Panel per user (kecuali bot OWNER_IDS) ────────────
    if (data === "create_admin_panel" && !config.OWNER_IDS.map(String).includes(String(userId))) {
      const myPanels = db.getUserPanels(userId);
      const adminPanels = myPanels.filter(p => p.panel_type === "admin" && !p.expired);
      if (adminPanels.length >= 1) {
        return safeEdit(ctx,
          `${tge("ERROR","❌")} <b>Batas Admin Panel Tercapai!</b>\n\n` +
          `Kamu sudah memiliki <b>${adminPanels.length} Admin Panel</b> aktif.\n` +
          `Setiap user hanya boleh memiliki <b>1 Admin Panel</b>.\n\n` +
          `Hapus admin panel yang ada terlebih dahulu sebelum membuat yang baru.`,
          { parse_mode: "HTML", ...backKeyboard() }
        );
      }
    }

    if (role === "reseller") {
      const limCheck = db.checkResellerLimit(userId);
      if (!limCheck.ok) {
        const msgs = {
          no_limit:     `${tge("ERROR","❌")} Kamu belum memiliki limit panel.\n\nHubungi owner untuk mendapatkan limit.`,
          expired:      `${tge("ERROR","❌")} Limit panel kamu sudah <b>kadaluarsa</b> (${formatDate(limCheck.expDate)}).\n\nHubungi owner untuk perpanjang.`,
          no_count:     `${tge("ERROR","❌")} Limit panel kamu <b>habis</b> (0 slot tersisa).\n\nHubungi owner untuk tambah limit.`,
          invalid_date: `${tge("ERROR","❌")} Tanggal limit tidak valid. Hubungi owner.`,
        };
        return safeEdit(ctx, msgs[limCheck.reason] || `${tge("ERROR","❌")} Limit reseller tidak valid.`, { parse_mode: "HTML", ...backKeyboard() });
      }
    }

    const s = getState(userId);
    s.panel_type = data === "create_admin_panel" ? "admin" : "biasa";
    // Simpan info pesan prompt agar bisa dihapus setelah panel selesai dibuat
    const promptMsg = ctx.callbackQuery && ctx.callbackQuery.message;
    if (promptMsg) {
      s.prompt_msg_id  = promptMsg.message_id;
      s.prompt_chat_id = promptMsg.chat.id;
    }
    // Multi-server: kalau role punya akses lebih dari 1 server, minta pilih dulu
    const allowed = allowedServers(role);
    if (allowed.length > 1) {
      s.step = "pick_server";
      const labels = allowed.map(n => `• <b>${he2(serverLabel(n))}</b>`).join("\n");
      return safeEdit(
        ctx,
        `${tge("DESKTOP","🖥️")} <b>Pilih Server Panel</b>\n\n${tge("MASK","🎭")} Tipe: <b>${s.panel_type === "admin" ? `${tge("CROWN","👑")} Admin Panel` : `${tge("DESKTOP","🖥️")} Panel Biasa`}</b>\n\nTersedia:\n${labels}\n\nPilih server tempat panel akan dibuat:`,
        { parse_mode: "HTML", ...serverPickerKeyboard(role, "pick_srv_") }
      );
    }
    // Hanya 1 server diizinkan → langsung pakai itu
    s.server_num = allowed[0] || 1;
    s.step = "username";
    return safeEdit(ctx, `${tge("DESKTOP","🖥️")} <b>Buat Panel Baru</b>\n\n${tge("MASK","🎭")} Tipe: <b>${s.panel_type === "admin" ? `${tge("CROWN","👑")} Admin Panel` : `${tge("DESKTOP","🖥️")} Panel Biasa`}</b>\n${tge("GLOBE","🌐")} Server: <b>${he2(serverLabel(s.server_num))}</b>\n\n${tge("USER","👤")} Masukkan <b>username</b> yang diinginkan (huruf kecil, angka, underscore):`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Pilih Server saat buat panel ──────────────────────────────────
  if (data.startsWith("pick_srv_")) {
    const num = parseInt(data.slice("pick_srv_".length));
    if (![1, 2].includes(num)) return safeEdit(ctx, `${tge("ERROR","❌")} Server tidak valid.`, backKeyboard());
    if (!canUseServer(role, num)) {
      return safeEdit(ctx, `${tge("LOCK","🔒")} Role <b>${he2(role)}</b> tidak punya akses ke <b>${he2(serverLabel(num))}</b>.`, { parse_mode: "HTML", ...backKeyboard() });
    }
    const s = getState(userId);
    s.server_num = num;
    s.step = "username";
    return safeEdit(ctx, `${tge("SUCCESS","✅")} Server dipilih: <b>${he2(serverLabel(num))}</b>\n\n${tge("MASK","🎭")} Tipe: <b>${s.panel_type === "admin" ? `${tge("CROWN","👑")} Admin Panel` : `${tge("DESKTOP","🖥️")} Panel Biasa`}</b>\n\n${tge("USER","👤")} Masukkan <b>username</b> yang diinginkan (huruf kecil, angka, underscore):`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Trial Panel ───────────────────────────────────────────────────
  if (data === "trial_panel") {
    if (config.TRIAL_HOURS <= 0 || !db.getTrialEnabled()) return safeEdit(ctx, `${tge("ERROR","❌")} Fitur trial sedang <b>tidak aktif</b>.\n\nHubungi owner jika ada pertanyaan.`, { parse_mode: "HTML", ...backKeyboard() });
    if (db.hasUsedTrial(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Kamu sudah pernah menggunakan trial panel.\n\nTrial hanya bisa digunakan <b>1 kali</b> per akun.`, { parse_mode: "HTML", ...backKeyboard() });

    const s = getState(userId);
    s.step = "trial_username";
    return safeEdit(ctx,
      `${tge("GIFT","🎁")} <b>Trial Panel Gratis</b>\n\n${tge("ALARM","⏰")} Durasi: *${config.TRIAL_HOURS} Jam*\n${tge("PACKAGE","📦")} Paket: *${config.TRIAL_PLAN.name}* (RAM ${config.TRIAL_PLAN.ram}MB, Disk ${config.TRIAL_PLAN.disk}MB, CPU ${config.TRIAL_PLAN.cpu}%)\n\n${tge("WARNING","⚠️")} Trial hanya sekali per akun!\n\n${tge("USER","👤")} Masukkan <b>username</b> yang diinginkan:`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  // ── Referral Menu ─────────────────────────────────────────────────

  // ── Security Menu ─────────────────────────────────────────────────
  if (data === "security_menu") {
    const hasPin = !!db.getPin(userId);
    const pinActions = (config.PIN_REQUIRED_ACTIONS || []).join(", ");
    return safeEdit(ctx,
      `${tge("LOCK_KEY","🔐")} <b>Keamanan Akun</b>\n\nPIN 2FA: ${hasPin ? `${tge("SUCCESS","✅")} <b>Aktif</b>` : `${tge("ERROR","❌")} <b>Belum diset</b>`}\n\nPIN digunakan untuk memverifikasi aksi sensitif:\n_${pinActions}_\n\nAtur PIN di bawah:`,
      { parse_mode: "HTML", ...securityMenuKeyboard(hasPin) }
    );
  }

  if (data === "set_pin" || data === "change_pin") {
    const s = getState(userId);
    s.step = "set_pin_code";
    return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Set PIN</b>\n\nMasukkan PIN baru (4-6 digit angka):`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "clear_pin") {
    db.clearPin(userId);
    db.addAuditLog({ actorId: userId, action: "Hapus PIN 2FA" });
    return safeEdit(ctx, `${tge("SUCCESS","✅")} PIN berhasil dihapus.`, backKeyboard());
  }

  // ── Audit Log ──────────────────────────────────────────────────────
  if (data === "view_audit") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const logs = db.getAuditLogs(20);
    if (!logs.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada audit log.`, backKeyboard());
    let text = `${tge("LIST","📋")} <b>Audit Log (20 terakhir):</b>\n\n`;
    logs.forEach((l) => {
      text += `• [${formatDate(l.at)}] \`${l.actorId}\` → *${l.action}*`;
      if (l.target) text += ` — \`${l.target}\``;
      if (l.detail) text += ` (${l.detail})`;
      text += "\n";
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Daily Report Now ───────────────────────────────────────────────
  if (data === "daily_report_now") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat laporan...`, { parse_mode: "HTML" });
    const reportText = buildDailyReportText();
    return ctx.reply(reportText, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Riwayat Transaksi (owner) ──────────────────────────────────────
  if (data === "view_transactions") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const txs = db.getAllTransactions(20);
    if (!txs.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada transaksi.`, backKeyboard());
    let text = `${tge("SCROLL","📜")} <b>Riwayat Transaksi (20 terakhir):</b>\n\n`;
    txs.forEach((t) => {
      text += `• [${formatDate(t.at)}] \`${t.userId}\` → *${t.type}* — ${t.name || t.detail || ""}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Riwayat Transaksi (user sendiri) ──────────────────────────────
  if (data === "user_transactions") {
    const txs = db.getUserTransactions(userId, 10);
    if (!txs.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada riwayat panel kamu.`, backKeyboard());
    let text = `${tge("SCROLL","📜")} *Riwayat Panel Kamu (${txs.length} terakhir):*\n\n`;
    txs.forEach((t) => {
      text += `• [${formatDate(t.at)}] *${t.type}* — ${t.name || t.detail || ""}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Broadcast ─────────────────────────────────────────────────────
  if (data === "broadcast_msg") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId);
    s.step = "broadcast_text";
    return safeEdit(ctx, `${tge("LOUDSPEAKER","📢")} <b>Broadcast Pesan</b>\n\nMasukkan pesan yang ingin dikirim ke semua user:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Toggle Trial Panel ────────────────────────────────────────────
  if (data === "toggle_trial") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const currentState = db.getTrialEnabled();
    db.setTrialEnabled(!currentState);
    db.addAuditLog({ actorId: userId, action: `Trial Panel ${!currentState ? "Diaktifkan" : "Dinonaktifkan"}` });
    const newState = db.getTrialEnabled();
    const _ton = tge("TOGGLE_ON", `${tge("GREEN_DOT","🟢")}`); const _toff = tge("TOGGLE_OFF", `${tge("RED_DOT","🔴")}`);
    const _ok = tge("SUCCESS", `${tge("SUCCESS","✅")}`); const _no = tge("ERROR", `${tge("ERROR","❌")}`);
    return safeEdit(ctx,
      `${newState ? _ton : _toff} <b>Fitur Trial Panel ${newState ? "Diaktifkan!" : "Dinonaktifkan!"}</b>\n\n` +
      `${newState
        ? `${_ok} User sekarang bisa menggunakan trial panel gratis.`
        : `${_no} User tidak bisa menggunakan trial panel sampai diaktifkan lagi.`}\n\n` +
      `<i>Ubah kapan saja lewat menu utama.</i>`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Auto Backup Menu ──────────────────────────────────────────────
  if (data === "auto_backup_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const ab = db.getAutoBackup();
    const lastRun = ab.last_run ? formatDate(ab.last_run) : "Belum pernah";
    return safeEdit(ctx,
      `${tge("FLOPPY","💾")} <b>Auto Backup Bot</b>\n\n` +
      `Status: *${ab.enabled ? `${tge("GREEN_DOT","🟢")} Aktif` : `${tge("RED_DOT","🔴")} Nonaktif`}*\n` +
      `${tge("CLOCK","⏱️")} Interval: *${ab.interval_hours} jam sekali*\n` +
      `${tge("CLOCK_FACE","🕐")} Terakhir berjalan: *${lastRun}*\n\n` +
      `${tge("PACKAGE","📦")} Backup berisi: semua script bot + file database\n` +
      `${tge("OUTBOX","📤")} File dikirim otomatis ke private chat semua owner.`,
      { parse_mode: "HTML", ...autoBackupKeyboard(ab) }
    );
  }

  if (data === "toggle_auto_backup") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const ab = db.getAutoBackup();
    db.setAutoBackup({ enabled: !ab.enabled });
    const newAb = db.getAutoBackup();
    db.addAuditLog({ actorId: userId, action: `Auto Backup ${newAb.enabled ? "Diaktifkan" : "Dinonaktifkan"}` });
    const lastRun = newAb.last_run ? formatDate(newAb.last_run) : "Belum pernah";
    const _ton = tge("TOGGLE_ON","🟢"); const _toff = tge("TOGGLE_OFF","🔴");
    return safeEdit(ctx,
      `${tge("FLOPPY","💾")} <b>Auto Backup Bot</b>\n\n` +
      `Status: <b>${newAb.enabled ? `${_ton} Aktif` : `${_toff} Nonaktif`}</b>\n` +
      `${tge("CLOCK","⏱️")} Interval: <b>${he2(String(newAb.interval_hours))} jam sekali</b>\n` +
      `${tge("CLOCK_FACE","🕐")} Terakhir berjalan: <b>${he2(lastRun)}</b>\n\n` +
      `${tge("PACKAGE","📦")} Backup berisi: semua script bot + file database\n` +
      `${tge("OUTBOX","📤")} File dikirim otomatis ke private chat semua owner.`,
      { parse_mode: "HTML", ...autoBackupKeyboard(newAb) }
    );
  }

  if (data === "set_backup_interval") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId);
    s.step = "auto_backup_interval";
    return safeEdit(ctx,
      `${tge("CLOCK","⏱️")} <b>Set Interval Auto Backup</b>\n\n` +
      `Masukkan interval backup dalam <b>jam</b> (angka 1–168):\n\n` +
      `Contoh: <code>6</code> = backup setiap 6 jam\nContoh: <code>24</code> = backup setiap hari`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  if (data === "run_backup_now") {
    // Manual backup HANYA boleh dipicu oleh Bot Owner (config.OWNER_IDS) — TIDAK boleh
    // role="owner" di DB. File backup berisi seluruh script & DB sehingga sensitif.
    if (!isBotOwner(userId)) return safeEdit(ctx, `${tge("LOCK","🔒")} <b>Akses Ditolak</b>\n\nManual backup hanya untuk <b>Bot Owner</b>.`, { parse_mode: "HTML", ...backKeyboard() });
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat backup bot...</b>\n\nMengemas script & database, harap tunggu.`, { parse_mode: "HTML" });
    const result = await runAutoBackup(true, userId);
    if (result.success) {
      return ctx.reply(
        `${tge("SUCCESS","✅")} <b>Backup Bot Selesai!</b>\n\n` +
        `${tge("FOLDER","📁")} File: \`${result.filename}\`\n` +
        `${tge("RULER","📏")} Ukuran: *${result.sizeKB} KB*\n` +
        `${tge("OUTBOX","📤")} Terkirim ke: *${result.sentCount}* owner (kamu saja)\n\n` +
        `_File backup hanya dikirim ke kamu — tidak di-broadcast._`,
        { parse_mode: "HTML", ...mainMenuKeyboard(role) }
      );
    } else {
      return ctx.reply(
        `${tge("ERROR","❌")} <b>Backup Gagal!</b>\n\n\`${result.error || "Error tidak diketahui"}\``,
        { parse_mode: "HTML", ...mainMenuKeyboard(role) }
      );
    }
  }

  // ── Maintenance Toggle ─────────────────────────────────────────────
  if (data === "maintenance_toggle") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const maint = db.getMaintenanceMode();
    if (maint.active) {
      db.setMaintenanceMode(false);
      db.addAuditLog({ actorId: userId, action: "Matikan Maintenance" });
      return safeEdit(ctx, `${tge("SUCCESS","✅")} <b>Maintenance Mode dimatikan.</b>\n\nBot kembali normal.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
    }
    const s = getState(userId);
    s.step = "maintenance_msg";
    return safeEdit(ctx, `${tge("WRENCH","🔧")} Masukkan <b>pesan maintenance</b> yang akan ditampilkan ke user:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Check Nodes ───────────────────────────────────────────────────
  if (data === "check_nodes") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengecek status node...`, { parse_mode: "HTML" });
    return sendNodesEdit(ctx);
  }

  // ── Stats ─────────────────────────────────────────────────────────
  if (data === "stats") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return sendStatsEdit(ctx);
  }

  // ── Manage Server ──────────────────────────────────────────────────
  if (data === "manage_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("WRENCH","🔧")} <b>Kelola Server</b>\nPilih aksi:`, { parse_mode: "HTML", ...manageServerKeyboard() });
  }

  if (data === "suspend_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "suspend_id";
    return safeEdit(ctx, `${tge("LOCK","🔒")} Masukkan <b>ID server</b> yang ingin di-suspend:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "unsuspend_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "unsuspend_id";
    return safeEdit(ctx, `${tge("UNLOCK","🔓")} Masukkan <b>ID server</b> yang ingin di-unsuspend:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "reinstall_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "reinstall_id";
    return safeEdit(ctx, `${tge("REFRESH","🔄")} Masukkan <b>ID server</b> yang ingin di-reinstall:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Delete Server ─────────────────────────────────────────────────
  if (data === "delete_server") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    if (needsPin(userId, "delete")) {
      const s = getState(userId);
      s.step = "verify_pin"; s.pin_action = "delete_server_flow";
      return safeEdit(ctx, `${tge("LOCK_KEY","🔐")} <b>Verifikasi PIN</b>\n\nMasukkan PIN kamu untuk melanjutkan:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
    const s = getState(userId); s.step = "delete_id";
    return safeEdit(ctx, `${tge("TRASH","🗑️")} Masukkan <b>ID server</b> yang ingin dihapus:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── List Servers (Owner) — Paginated per API page ────────────────
  if (data === "list_servers") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const sAdm = getState(userId);
    const srvNum = sAdm.admin_srv || 1;
    return handleLsrv(ctx, userId, srvNum, 1);
  }

  // ── lsrv_SRV_PAGE — paginated list server handler ─────────────────
  if (data.startsWith("lsrv_")) {
    if (!isOwner(userId)) return ctx.answerCbQuery(`${tge("ERROR","❌")} Hanya Owner.`);
    const parts = data.split("_");
    const srvNum = parseInt(parts[1]) || 1;
    const page   = parseInt(parts[2]) || 1;
    return handleLsrv(ctx, userId, srvNum, page);
  }

  // ── Tombol Server ON/OFF — Paginated real-time power check ────────
  if (data === "btn_listsrvon" || data === "btn_listsrvoff" || data.startsWith("lsrvpow_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    let srvNum, page, filt;
    if (data.startsWith("lsrvpow_")) {
      const p = data.split("_"); // lsrvpow_SRV_PAGE_FILT
      srvNum = parseInt(p[1]) || 1;
      page   = parseInt(p[2]) || 1;
      filt   = p[3] || "a";
    } else {
      const sAdm = getState(userId);
      srvNum = sAdm.admin_srv || 1;
      page   = 1;
      filt   = data === "btn_listsrvon" ? "n" : "f";
    }
    return handleLsrvPow(ctx, userId, srvNum, page, filt);
  }

  // ── Filter + Pagination Server List ───────────────────────────────
  if (data.startsWith("srv_f_")) {
    if (!isOwner(userId)) return ctx.answerCbQuery(`${tge("ERROR","❌")} Hanya Owner.`);
    const parts  = data.split("_"); // ["srv","f","<filter>","<page>"]
    const filter = parts[2] || "all";
    const page   = parseInt(parts[3]) || 0;
    const s = getState(userId);
    // Refresh list jika belum ada
    if (!s.srv_list || !s.srv_list.length) {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Mengambil daftar server...`, { parse_mode: "HTML" });
      s.srv_list = await ptero.listServers(s.admin_srv || 1);
    }
    s.srv_filter = filter;
    s.srv_page   = page;
    const servers = s.srv_list;
    if (!servers.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Tidak ada server.`, backKeyboard());
    const aktif = servers.filter(sv => !sv.attributes.suspended && !sv.attributes.status).length;
    const susp  = servers.filter(sv => sv.attributes.suspended).length;
    const inst  = servers.filter(sv => sv.attributes.status === "installing").length;
    const filterLabel = { all: "Semua", act: "Aktif", sus: "Suspended" }[filter] || "Semua";
    const text =
      `${tge("DESKTOP","🖥️")} <b>Semua Server Pterodactyl</b> — ${filterLabel}\n\n` +
      `${tge("CHART","📊")} Total: *${servers.length}* server\n` +
      `${tge("GREEN_DOT","🟢")} Aktif: *${aktif}*  •  ${tge("LOCK","🔒")} Suspended: *${susp}*  •  ${tge("GEAR","⚙️")} Installing: *${inst}*\n\n` +
      `_Klik server untuk kelola_`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...allServersKeyboard(servers, filter, page) });
  }

  // ── Noop (info pagination) ─────────────────────────────────────────
  if (data === "srv_noop") return ctx.answerCbQuery();

  // ── Kelola 1 Server (Owner) ────────────────────────────────────────
  if (data.startsWith("srv_m_")) {
    if (!isOwner(userId)) return ctx.answerCbQuery(`${tge("ERROR","❌")} Hanya Owner.`);
    const serverId = data.slice(6);
    const s = getState(userId);
    const filter = s.srv_filter || "all";
    const page   = s.srv_page   || 0;
    const sv = await ptero.getServerDetails(serverId, srvOf(serverId, s));
    if (!sv) return safeEdit(ctx, `${tge("ERROR","❌")} Server tidak ditemukan.`, backKeyboard());
    const a    = sv;
    const icon = srvStatusIcon(a);
    const susp = a.suspended ? `${tge("LOCK","🔒")} Suspended` : (a.status || `${tge("GREEN_DOT","🟢")} Aktif`);
    // Cari owner di db
    const dbRecord = db.getPanelByServerId(a.id);
    const ownerLine = dbRecord
      ? `${tge("USER","👤")} Pemilik (Bot): \`${dbRecord.ownerUserId}\`\n`
      : `${tge("USER","👤")} Pterodactyl User ID: \`${a.user}\`\n`;
    const alloc   = (a.relationships?.allocations?.data || [])[0]?.attributes;
    const ipStr   = alloc ? `${alloc.ip}:${alloc.port}` : "N/A";
    const text =
      `${tge("DESKTOP","🖥️")} <b>Detail Server</b>\n\n` +
      `${tge("NAME_BADGE","📛")} Nama: \`${a.name}\`\n` +
      `${tge("ID_CARD","🆔")} Server ID: \`${a.id}\`\n` +
      `${tge("KEY","🔑")} Identifier: \`${a.identifier}\`\n` +
      `${tge("GLOBE","🌐")} IP:Port: \`${ipStr}\`\n` +
      ownerLine +
      `${tge("CHART","📊")} Status: ${icon} ${susp}\n` +
      `${tge("FLOPPY","💾")} RAM: ${a.limits?.memory || 0} MB  •  ${tge("DISK","💿")} Disk: ${a.limits?.disk || 0} MB  •  ${tge("GEAR","⚙️")} CPU: ${a.limits?.cpu || 0}%\n` +
      `${tge("BRAIN","🧠")} OOM Killer: ${a.limits?.oom_killer ? `${tge("SUCCESS","✅")} Aktif` : `${tge("ERROR","❌")} Nonaktif`}\n\n` +
      `_Pilih aksi di bawah:_`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...serverMgrKeyboard(a, filter, page) });
  }

  // ── Aksi pada 1 Server (Owner) ────────────────────────────────────
  if (data.startsWith("srv_do_")) {
    if (!isOwner(userId)) return ctx.answerCbQuery(`${tge("ERROR","❌")} Hanya Owner.`);
    const parts    = data.split("_"); // ["srv","do","<act>","<id>"]
    const act      = parts[2];
    const serverId = parts[3];
    const s        = getState(userId);
    const filter   = s.srv_filter || "all";
    const page     = s.srv_page   || 0;

    logger.action("SRV_MGR", `Owner:${userId} aksi="${act}" serverId=${serverId}`);

    const backBtn = Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali ke List", `srv_f_${filter}_${page}`)]]);

    if (act === "sus") {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Menyuspend server \`${serverId}\`...`, { parse_mode: "HTML" });
      const ok = await ptero.suspendServer(serverId, srvOf(serverId, s));
      if (ok) {
        const rec = db.getPanelByServerId(serverId);
        if (rec) db.markPanelSuspended(rec.ownerUserId, serverId, true);
        s.srv_list = null;
        logger.event("SRV_MGR", `Server ${serverId} berhasil disuspend oleh Owner:${userId}`);
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Server \`${serverId}\` berhasil <b>di-suspend!</b>`, { parse_mode: "HTML", ...backBtn });
      }
      return safeEdit(ctx, `${tge("ERROR","❌")} Gagal suspend server \`${serverId}\`.`, { parse_mode: "HTML", ...backBtn });
    }

    if (act === "uns") {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Meng-unsuspend server \`${serverId}\`...`, { parse_mode: "HTML" });
      const ok = await ptero.unsuspendServer(serverId, srvOf(serverId, s));
      if (ok) {
        const rec = db.getPanelByServerId(serverId);
        if (rec) db.markPanelSuspended(rec.ownerUserId, serverId, false);
        s.srv_list = null;
        logger.event("SRV_MGR", `Server ${serverId} berhasil di-unsuspend oleh Owner:${userId}`);
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Server \`${serverId}\` berhasil <b>di-unsuspend!</b>`, { parse_mode: "HTML", ...backBtn });
      }
      return safeEdit(ctx, `${tge("ERROR","❌")} Gagal unsuspend server \`${serverId}\`.`, { parse_mode: "HTML", ...backBtn });
    }

    if (act === "rei") {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Reinstall server \`${serverId}\`...`, { parse_mode: "HTML" });
      const ok = await ptero.reinstallServer(serverId, srvOf(serverId, s));
      if (ok) {
        s.srv_list = null;
        logger.event("SRV_MGR", `Server ${serverId} berhasil di-reinstall oleh Owner:${userId}`);
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Server \`${serverId}\` berhasil <b>di-reinstall!</b>\n\n_Tunggu beberapa menit hingga proses selesai._`, { parse_mode: "HTML", ...backBtn });
      }
      return safeEdit(ctx, `${tge("ERROR","❌")} Gagal reinstall server \`${serverId}\`.`, { parse_mode: "HTML", ...backBtn });
    }

    if (act === "del") {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Menghapus server \`${serverId}\`...`, { parse_mode: "HTML" });
      const ok = await ptero.deleteServer(serverId, srvOf(serverId, s));
      if (ok) {
        const rec = db.getPanelByServerId(serverId);
        if (rec) db.deletePanelRecord(rec.ownerUserId, serverId);
        s.srv_list = null;
        logger.event("SRV_MGR", `Server ${serverId} berhasil dihapus oleh Owner:${userId}`);
        return safeEdit(ctx, `${tge("TRASH","🗑️")} Server \`${serverId}\` berhasil <b>dihapus!</b>`, { parse_mode: "HTML", ...backBtn });
      }
      return safeEdit(ctx, `${tge("ERROR","❌")} Gagal hapus server \`${serverId}\`.`, { parse_mode: "HTML", ...backBtn });
    }

    return ctx.answerCbQuery(`${tge("QUESTION","❓")} Aksi tidak dikenal.`);
  }

  // ── Manage Users ──────────────────────────────────────────────────
  if (data === "manage_users") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("USER","👤")} <b>Kelola User</b>\nPilih aksi:`, { parse_mode: "HTML", ...manageUsersKeyboard() });
  }

  if (["set_reseller","set_premium","set_partner","set_owner","reset_role","blacklist_user","unblacklist_user","search_user"].includes(data)) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const stepMap = {
      set_reseller: "set_role", set_premium: "set_role", set_partner: "set_role", set_owner: "set_role",
      reset_role: "reset_role_id", blacklist_user: "blacklist_id",
      unblacklist_user: "unblacklist_id", search_user: "search_user_id",
    };
    const roleMap = { set_reseller: "reseller", set_premium: "premium", set_partner: "partner", set_owner: "owner" };
    const promptMap = {
      set_role:       (s) => `Masukkan <b>Telegram ID</b> user untuk diberi role *${s.set_role}*:`,
      reset_role_id:  () => `Masukkan <b>Telegram ID</b> user yang ingin direset rolenya:`,
      blacklist_id:   () => `Masukkan <b>Telegram ID</b> user yang ingin di-blacklist:`,
      unblacklist_id: () => `Masukkan <b>Telegram ID</b> user yang ingin di-unblacklist:`,
      search_user_id: () => `Masukkan <b>Telegram ID</b> user yang ingin dicari:`,
    };
    const s = getState(userId);
    const step = stepMap[data];
    s.step = step;
    if (roleMap[data]) s.set_role = roleMap[data];
    return safeEdit(ctx, promptMap[step](s), { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Kelola Akses: Premium & Partner ──────────────────────────────
  if (["pm_set_reseller","pm_set_premium","pm_set_reseller_limit"].includes(data)) {
    const myRole = db.getRole(userId);
    if (!["premium","partner","owner"].includes(myRole))
      return safeEdit(ctx, `${tge("LOCK","🔒")} Akses ditolak.`, backKeyboard());
    if (data === "pm_set_premium" && myRole !== "partner" && !isOwner(userId))
      return safeEdit(ctx, `${tge("LOCK","🔒")} Hanya Partner atau Owner yang bisa set role Premium.`, backKeyboard());

    const s = getState(userId);
    if (data === "pm_set_reseller") {
      s.step = "pm_set_reseller_id";
      return safeEdit(ctx, `${tge("DIAMOND_ORANGE","🔶")} <b>Tambah Reseller</b>\n\nMasukkan <b>Telegram ID</b> user yang ingin diberi role Reseller:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
    if (data === "pm_set_premium") {
      s.step = "pm_set_premium_id";
      return safeEdit(ctx, `${tge("DIAMOND","💎")} <b>Tambah Premium</b>\n\nMasukkan <b>Telegram ID</b> user yang ingin diberi role Premium:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
    if (data === "pm_set_reseller_limit") {
      s.step = "pm_limit_id";
      return safeEdit(ctx, `${tge("PACKAGE","📦")} <b>Set Limit Reseller</b>\n\nMasukkan <b>Telegram ID</b> reseller yang ingin diset limitnya:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
  }

  if (data === "list_users") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const users = db.listAllUsers();
    const entries = Object.entries(users);
    if (!entries.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada user terdaftar.`, backKeyboard());
    let text = `${tge("USERS","👥")} <b>Daftar User:</b>\n\n`;
    entries.slice(0, 30).forEach(([uid, udata]) => {
      const bl = udata.blacklisted ? ` ${tge("PROHIBITED","🚫")}` : "";
      const lim = udata.reseller_limit ? ` ${tge("PACKAGE","📦")}${udata.reseller_limit.count}` : "";
      text += `• ID: \`${uid}\` — ${roleLabel(udata.role || "user")}${bl}${lim} — Panel: ${udata.panel_count || 0}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (data === "set_reseller_limit") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "set_limit_id";
    return safeEdit(ctx, `${tge("PACKAGE","📦")} Masukkan <b>Telegram ID</b> reseller yang ingin diset limitnya:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Statistik User (Owner) ─────────────────────────────────────────
  if (data === "user_stats_lookup") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "user_stats_id";
    return safeEdit(ctx, `${tge("CHART","📊")} Masukkan <b>Telegram ID</b> user yang ingin dilihat statistiknya:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Bulk Aksi Panel (Owner) ────────────────────────────────────────
  if (data === "bulk_action_pick") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "bulk_action_id";
    return safeEdit(ctx, `${tge("LIGHTNING","⚡")} <b>Bulk Aksi Panel</b>\n\nMasukkan <b>Telegram ID</b> user yang panelnya ingin dikelola secara bulk:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data.startsWith("bulk_sus_") || data.startsWith("bulk_uns_") || data.startsWith("bulk_del_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const actType = data.startsWith("bulk_sus_") ? "sus" : data.startsWith("bulk_uns_") ? "uns" : "del";
    const targetId = data.slice(actType === "sus" ? 9 : actType === "uns" ? 9 : 9);
    const panels = db.getUserPanels(targetId);
    if (!panels.length) return safeEdit(ctx, `${tge("ERROR","❌")} User \`${targetId}\` tidak punya panel.`, { parse_mode: "HTML", ...backKeyboard() });

    let done = 0;
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Memproses ${panels.length} panel...`, { parse_mode: "HTML" });

    for (const panel of panels) {
      try {
        if (actType === "sus") {
          const ok = await ptero.suspendServer(panel.server_id, psn(panel));
          if (ok) { db.markPanelSuspended(targetId, panel.server_id, true); done++; }
        } else if (actType === "uns") {
          const ok = await ptero.unsuspendServer(panel.server_id, psn(panel));
          if (ok) { db.markPanelSuspended(targetId, panel.server_id, false); done++; }
        } else {
          const ok = await ptero.deleteServer(panel.server_id, psn(panel));
          if (ok) { db.deletePanelRecord(targetId, panel.server_id); db.decrementPanelCount(targetId); done++; }
        }
      } catch {}
    }

    const actionWord = actType === "sus" ? "disuspend" : actType === "uns" ? "diunsuspend" : "dihapus";
    db.addAuditLog({ actorId: userId, action: `Bulk ${actType.toUpperCase()} Panel`, target: String(targetId), detail: `${done}/${panels.length} panel` });
    try {
      const userMsg = actType === "del"
        ? `${tge("TRASH","🗑️")} <b>Semua panel kamu telah dihapus oleh owner.</b>`
        : actType === "sus"
        ? `${tge("LOCK","🔒")} <b>Semua panel kamu telah disuspend oleh owner.</b>`
        : `${tge("UNLOCK","🔓")} <b>Semua panel kamu telah diunsuspend oleh owner.</b>`;
      await bot.telegram.sendMessage(targetId, userMsg, { parse_mode: "HTML" });
    } catch {}
    return ctx.reply(`${tge("SUCCESS","✅")} <b>Bulk Action Selesai!</b>\n\n${tge("USER","👤")} User: \`${targetId}\`\n${tge("LIGHTNING","⚡")} Aksi: *${actionWord}*\n${tge("SUCCESS","✅")} Berhasil: *${done}/${panels.length}* panel`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Voucher Menu ──────────────────────────────────────────────────
  if (data === "voucher_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("ADMISSION","🎟️")} <b>Kelola Voucher</b>\nPilih tipe voucher:`, { parse_mode: "HTML", ...voucherMenuKeyboard() });
  }

  if (data === "create_voucher") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("ADMISSION","🎟️")} Pilih role yang akan diberikan voucher:`, { parse_mode: "HTML", ...voucherRoleKeyboard() });
  }

  if (data === "create_discount_voucher") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "discount_pct";
    return safeEdit(ctx, `${tge("LABEL","🏷️")} <b>Voucher Diskon %</b>\n\nMasukkan besar diskon (1-100):\n_(contoh: 50 = diskon 50%)_`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "create_day_voucher") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "day_voucher_count";
    return safeEdit(ctx, `${tge("CALENDAR","📅")} <b>Voucher Hari Tambah</b>\n\nMasukkan jumlah hari yang ditambahkan:\n_(contoh: 30 = perpanjang 30 hari)_`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data.startsWith("vr_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const vRole = data.slice(3);
    const code = generateVoucherCode();
    db.createVoucher(code, vRole, userId);
    db.addAuditLog({ actorId: userId, action: "Buat Voucher Role", detail: `${vRole} | ${code}` });
    const emoji = { reseller: `${tge("DIAMOND_ORANGE","🔶")}`, premium: `${tge("DIAMOND","💎")}`, partner: `🌟`, owner: `${tge("CROWN","👑")}` }[vRole] || `${tge("USER","👤")}`;
    return safeEdit(ctx,
      `${tge("SUCCESS","✅")} <b>Voucher Dibuat!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${emoji} Role: *${vRole}*\n\n/redeem ${code}`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  if (data === "list_vouchers") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const vouchers = db.getAllVouchers();
    const entries = Object.entries(vouchers);
    if (!entries.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada voucher.`, backKeyboard());
    let text = `${tge("ADMISSION","🎟️")} <b>Daftar Voucher:</b>\n\n`;
    entries.slice(0, 20).forEach(([code, v]) => {
      let typeLabel = "";
      if (v.type === "discount") typeLabel = `${tge("LABEL","🏷️")} Diskon ${v.discount}%`;
      else if (v.type === "days") typeLabel = `${tge("CALENDAR","📅")} +${v.days} Hari`;
      else { const emoji = { reseller: `${tge("DIAMOND_ORANGE","🔶")}`, premium: `${tge("DIAMOND","💎")}`, partner: `🌟`, owner: `${tge("CROWN","👑")}` }[v.role] || `${tge("USER","👤")}`; typeLabel = `${emoji} ${v.role}`; }
      const status = v.used ? `${tge("SUCCESS","✅")} \`${v.used_by}\`` : `${tge("YELLOW_DOT","🟡")} Belum dipakai`;
      text += `• \`${code}\` — ${typeLabel} — ${status}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Redeem Voucher ────────────────────────────────────────────────
  if (data === "redeem_voucher") {
    const s = getState(userId);
    s.step = "redeem_code";
    return safeEdit(ctx, `${tge("ADMISSION","🎟️")} Masukkan <b>kode voucher</b> kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Plan Selection → Auto Create ──────────────────────────────────
  if (data.startsWith("plan_")) {
    const planIndex = parseInt(data.slice(5));
    const plan = config.RESOURCE_PLANS[planIndex];
    if (!plan) return safeEdit(ctx, `${tge("ERROR","❌")} Paket tidak ditemukan.`, cancelKeyboard());
    const s = getState(userId);
    s.plan_name = plan.name; s.ram = plan.ram; s.disk = plan.disk; s.cpu = plan.cpu;
    s.step = null;

    // Multi-node: tampilkan pilihan node jika diaktifkan
    if (config.MULTI_NODE_ENABLED) {
      const nodes = await ptero.getNodes(s.server_num || 1);
      if (nodes.length > 1) {
        s.step = "node_select";
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Paket *${plan.name}* dipilih.\n\n${tge("DESKTOP","🖥️")} <b>Pilih Node/Lokasi Server:</b>`, { parse_mode: "HTML", ...nodeSelectKeyboard(nodes) });
      }
    }
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat panel...</b>\n\nHarap tunggu, jangan tutup chat.`, { parse_mode: "HTML" });
    await executeCreatePanel(ctx, userId, role, s);
    return;
  }

  // ── Node Selection ────────────────────────────────────────────────
  if (data.startsWith("node_")) {
    const locationId = parseInt(data.slice(5));
    const s = getState(userId);
    if (!s.plan_name) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir. Mulai ulang dari menu.`, backKeyboard());
    s.location_id = locationId;
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat panel di node terpilih...</b>\n\nHarap tunggu.`, { parse_mode: "HTML" });
    await executeCreatePanel(ctx, userId, role, s);
    return;
  }

  // ── Upgrade Resource ──────────────────────────────────────────────
  if (data === "upgrade_menu") {
    const myPanels = db.getUserPanels(userId);
    if (!myPanels.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Kamu belum punya panel.`, backKeyboard());
    return safeEdit(ctx, `${tge("ARROW_UP","⬆️")} <b>Upgrade Resource</b>\n\nPilih panel yang ingin di-upgrade:`, { parse_mode: "HTML", ...upgradeSelectKeyboard(myPanels) });
  }

  if (data.startsWith("upg_sel_")) {
    const upgServerId = data.slice(8);
    const myPanelsForUpg = db.getUserPanels(userId);
    const upgPanel = myPanelsForUpg.find(p => String(p.server_id) === upgServerId);
    if (!upgPanel) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());
    if (upgPanel.expired || upgPanel.suspended) return safeEdit(ctx, `${tge("ERROR","❌")} Panel expired/suspended tidak bisa di-upgrade.`, backKeyboard());
    const s = getState(userId);
    s.step = "upg_plan";
    s.upgrade_server_id = upgServerId;
    return safeEdit(ctx,
      `${tge("ARROW_UP","⬆️")} <b>Upgrade Panel</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${upgPanel.name}\`\n${tge("PACKAGE","📦")} Paket saat ini: *${upgPanel.plan_name || "N/A"}*\n\nPilih paket baru:`,
      { parse_mode: "HTML", ...upgradePlanKeyboard() }
    );
  }

  if (data.startsWith("upg_plan_")) {
    const upgPlanIdx = parseInt(data.slice(9));
    const upgPlan = config.RESOURCE_PLANS[upgPlanIdx];
    const sUpg = getState(userId);
    if (!upgPlan || !sUpg.upgrade_server_id) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir.`, backKeyboard());
    const upgServerId2 = sUpg.upgrade_server_id;

    // Cek quota resource (#5) — total RAM/CPU/Disk user setelah upgrade tidak boleh melampaui quota role
    const userRoleU = db.getRole(userId);
    const quotaU = (config.ROLE_QUOTAS || {})[userRoleU] || {};
    const usageU = db.computeUserResourceUsage(userId);
    const curPanelU = db.getUserPanels(userId).find(p => String(p.server_id) === upgServerId2);
    const deltaRam  = upgPlan.ram  - Number(curPanelU?.ram  || 0);
    const deltaDisk = upgPlan.disk - Number(curPanelU?.disk || 0);
    const deltaCpu  = upgPlan.cpu  - Number(curPanelU?.cpu  || 0);
    if (quotaU.ram > 0 && (usageU.ram + deltaRam) > quotaU.ram)
      return ctx.reply(`${tge("ERROR","❌")} <b>Quota RAM Terlampaui</b>\n\nLimit ${quotaU.ram} MB, total setelah upgrade ${usageU.ram + deltaRam} MB.`, { parse_mode: "HTML", ...backKeyboard() });
    if (quotaU.disk > 0 && (usageU.disk + deltaDisk) > quotaU.disk)
      return ctx.reply(`${tge("ERROR","❌")} <b>Quota Disk Terlampaui</b>\n\nLimit ${quotaU.disk} MB, total setelah upgrade ${usageU.disk + deltaDisk} MB.`, { parse_mode: "HTML", ...backKeyboard() });
    if (quotaU.cpu > 0 && (usageU.cpu + deltaCpu) > quotaU.cpu)
      return ctx.reply(`${tge("ERROR","❌")} <b>Quota CPU Terlampaui</b>\n\nLimit ${quotaU.cpu}%, total setelah upgrade ${usageU.cpu + deltaCpu}%.`, { parse_mode: "HTML", ...backKeyboard() });

    // Auto-backup sebelum upgrade (#24)
    if (curPanelU?.server_identifier) {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat backup otomatis sebelum upgrade...</b>`, { parse_mode: "HTML" });
      try {
        await ptero.createBackup(curPanelU.server_identifier, srvOf(upgServerId2, sUpg));
        db.addAuditLog({ actorId: userId, action: "Auto Backup Before Upgrade", target: upgServerId2 });
      } catch (e) { /* lanjut upgrade walau backup gagal */ }
    }

    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Mengupgrade resource...</b>\n\nHarap tunggu.`, { parse_mode: "HTML" });
    const upgOk = await ptero.updateServerBuild(upgServerId2, { memory: upgPlan.ram, disk: upgPlan.disk, cpu: upgPlan.cpu }, srvOf(upgServerId2, sUpg));
    clearState(userId);
    if (!upgOk) return ctx.reply(`${tge("ERROR","❌")} Gagal upgrade resource. Pastikan ID server valid.`, backKeyboard());
    db.updatePanelPlan(userId, upgServerId2, upgPlan.name);
    db.addAuditLog({ actorId: userId, action: "Upgrade Panel", target: upgServerId2, detail: upgPlan.name });
    db.touchPanelActive(upgServerId2);
    const upgPs = planSummary(upgPlan);
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Panel Berhasil Di-upgrade!</b>\n\n${tge("ID_CARD","🆔")} Server ID: \`${upgServerId2}\`\n${tge("PACKAGE","📦")} Paket baru: *${upgPlan.name}*\n${tge("FLOPPY","💾")} RAM: ${upgPs.ram}\n${tge("DISK","💿")} Disk: ${upgPs.disk}\n${tge("GEAR","⚙️")} CPU: ${upgPs.cpu}\n\n${tge("FLOPPY","💾")} _Backup otomatis dibuat sebelum upgrade._`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  // ── Clone Panel ───────────────────────────────────────────────────

  // ── Tiket Support ─────────────────────────────────────────────────
  if (data === "ticket_menu") {
    const myTickets = db.getUserTickets(userId);
    const openTktCount = myTickets.filter(t => t.status === "open").length;
    const tktRows = [];
    tktRows.push([Markup.button.callback("✍️ Buat Tiket Baru", "tkt_new")]);
    if (myTickets.length) tktRows.push([Markup.button.callback("📑 Lihat Tiket Saya", "tkt_list")]);
    tktRows.push([Markup.button.callback("◀️ Kembali", "back_main")]);
    return safeEdit(ctx,
      `${tge("TICKET","🎫")} <b>Tiket Support</b>\n\n${openTktCount > 0 ? `${tge("GREEN_DOT","🟢")} Tiket terbuka: *${openTktCount}*` : `${tge("EMPTY_BOX","📭")} Tidak ada tiket terbuka.`}\n\nBuat tiket baru untuk minta bantuan owner:`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard(tktRows) }
    );
  }

  if (data === "tkt_new") {
    const sTkt = getState(userId);
    sTkt.step = "tkt_subject";
    return safeEdit(ctx, `${tge("TICKET","🎫")} <b>Buat Tiket Baru</b>\n\nMasukkan <b>judul/subjek</b> tiket kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "tkt_list") {
    const myTktList = db.getUserTickets(userId);
    if (!myTktList.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada tiket.`, backKeyboard());
    return safeEdit(ctx, `${tge("LIST","📋")} <b>Tiket Kamu:</b>`, { parse_mode: "HTML", ...ticketListKeyboard(myTktList, false) });
  }

  if (data.startsWith("tkt_view_")) {
    const tktShortId = data.slice(9);
    const myTkts = db.getUserTickets(userId);
    const viewTicket = myTkts.find(t => t.id.endsWith(tktShortId));
    if (!viewTicket) return safeEdit(ctx, `${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard());
    let tktText = `${tge("TICKET","🎫")} *Tiket #${viewTicket.id.slice(-6)}*\n\n`;
    tktText += `${tge("PIN","📌")} Subjek: *${viewTicket.subject}*\n`;
    tktText += `${tge("BRIGHT","🔆")} Status: ${viewTicket.status === "open" ? `${tge("GREEN_DOT","🟢")} Terbuka` : `${tge("LOCK","🔒")} Ditutup`}\n\n`;
    tktText += `${tge("MEMO","📝")} <b>Pesan:</b>\n${viewTicket.message}\n`;
    if (viewTicket.replies && viewTicket.replies.length) {
      tktText += `\n${tge("SPEECH","💬")} <b>Balasan:</b>\n`;
      viewTicket.replies.slice(-5).forEach(r => {
        tktText += `${r.isOwner ? `${tge("CROWN","👑")} Owner` : `${tge("USER","👤")} Kamu`}: ${r.message}\n`;
      });
    }
    const tktBtns = [];
    if (viewTicket.status === "open") tktBtns.push([Markup.button.callback("💬 Balas", `tkt_rep_${tktShortId}`)]);
    tktBtns.push([Markup.button.callback("◀️ Kembali", "tkt_list")]);
    return safeEdit(ctx, tktText, { parse_mode: "HTML", ...Markup.inlineKeyboard(tktBtns) });
  }

  if (data.startsWith("tkt_rep_")) {
    const tktRepId = data.slice(8);
    const sTktRep = getState(userId);
    sTktRep.step = "tkt_reply";
    sTktRep.reply_ticket_id = tktRepId;
    return safeEdit(ctx, `${tge("SPEECH","💬")} Ketik balasan kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Kelola Tiket (Owner) ──────────────────────────────────────────
  if (data === "kelola_tkt") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const openTkts = db.getOpenTickets();
    if (!openTkts.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Tidak ada tiket terbuka.`, { parse_mode: "HTML", ...backKeyboard() });
    return safeEdit(ctx, `${tge("TICKET","🎫")} *Tiket Terbuka (${openTkts.length}):*`, { parse_mode: "HTML", ...ticketListKeyboard(openTkts, true) });
  }

  if (data.startsWith("otkt_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const otktShortId = data.slice(5);
    if (otktShortId.startsWith("rep_") || otktShortId.startsWith("cls_")) {
      if (otktShortId.startsWith("rep_")) {
        const repId = otktShortId.slice(4);
        const sOtkt = getState(userId);
        sOtkt.step = "otkt_reply";
        sOtkt.reply_ticket_id = repId;
        return safeEdit(ctx, `${tge("SPEECH","💬")} Ketik balasan untuk user:`, { parse_mode: "HTML", ...cancelKeyboard() });
      }
      if (otktShortId.startsWith("cls_")) {
        const clsId = otktShortId.slice(4);
        const allTkts = db.getAllTickets(50);
        const clsTkt = allTkts.find(t => t.id.endsWith(clsId));
        if (!clsTkt) return safeEdit(ctx, `${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard());
        db.closeTicket(clsTkt.id);
        try {
          await bot.telegram.sendMessage(clsTkt.userId,
            `${tge("LOCK","🔒")} *Tiket #${clsTkt.id.slice(-6)} Ditutup*\n\nSubjek: ${clsTkt.subject}\nTiket kamu telah ditutup oleh owner.`,
            { parse_mode: "HTML" }
          );
        } catch {}
        return safeEdit(ctx, `${tge("SUCCESS","✅")} Tiket #${clsTkt.id.slice(-6)} ditutup.`, { parse_mode: "HTML", ...backKeyboard() });
      }
    }
    const allTkts2 = db.getAllTickets(50);
    const viewOTkt = allTkts2.find(t => t.id.endsWith(otktShortId));
    if (!viewOTkt) return safeEdit(ctx, `${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard());
    let otktText = `${tge("TICKET","🎫")} *Tiket #${viewOTkt.id.slice(-6)}*\n\n`;
    otktText += `${tge("USER","👤")} User: \`${viewOTkt.userId}\`\n${tge("PIN","📌")} Subjek: *${viewOTkt.subject}*\n${tge("BRIGHT","🔆")} Status: ${viewOTkt.status === "open" ? `${tge("GREEN_DOT","🟢")} Terbuka` : `${tge("LOCK","🔒")} Ditutup`}\n\n`;
    otktText += `${tge("MEMO","📝")} <b>Pesan:</b>\n${viewOTkt.message}`;
    if (viewOTkt.replies && viewOTkt.replies.length) {
      otktText += `\n\n${tge("SPEECH","💬")} <b>Balasan:</b>\n`;
      viewOTkt.replies.slice(-5).forEach(r => {
        otktText += `${r.isOwner ? `${tge("CROWN","👑")} Owner` : `${tge("USER","👤")} User`}: ${r.message}\n`;
      });
    }
    const otktBtns = [];
    if (viewOTkt.status === "open") {
      otktBtns.push([
        Markup.button.callback("💬 Balas", `otkt_rep_${otktShortId}`),
        Markup.button.callback("🔐 Tutup", `otkt_cls_${otktShortId}`),
      ]);
    }
    otktBtns.push([Markup.button.callback("◀️ Kembali", "kelola_tkt")]);
    return safeEdit(ctx, otktText, { parse_mode: "HTML", ...Markup.inlineKeyboard(otktBtns) });
  }

  if (data.startsWith("otkt_rep_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const repId2 = data.slice(9);
    const sOtkt2 = getState(userId);
    sOtkt2.step = "otkt_reply";
    sOtkt2.reply_ticket_id = repId2;
    return safeEdit(ctx, `${tge("SPEECH","💬")} Ketik balasan untuk user:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data.startsWith("otkt_cls_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const clsId2 = data.slice(9);
    const allTkts3 = db.getAllTickets(50);
    const clsTkt2 = allTkts3.find(t => t.id.endsWith(clsId2));
    if (!clsTkt2) return safeEdit(ctx, `${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard());
    db.closeTicket(clsTkt2.id);
    try {
      await bot.telegram.sendMessage(clsTkt2.userId,
        `${tge("LOCK","🔒")} *Tiket #${clsTkt2.id.slice(-6)} Ditutup*\n\nSubjek: ${clsTkt2.subject}\nTiket kamu telah ditutup oleh owner.`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return safeEdit(ctx, `${tge("SUCCESS","✅")} Tiket ditutup.`, { parse_mode: "HTML", ...backKeyboard() });
  }


  // ── Cek Resource Manual (Owner) ───────────────────────────────────
  if (data === "check_resource") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("SEARCH","🔍")} <b>Mengecek resource semua panel aktif...</b>`, { parse_mode: "HTML" });

    const allPanels = db.getAllPanels(); // returns [{ ...panelFields, userId }]
    const active = allPanels.filter(p => p.server_identifier && !p.expired && !p.suspended);

    if (!active.length) {
      return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Tidak ada panel aktif yang bisa dicek.`, { parse_mode: "HTML", ...backKeyboard() });
    }

    const cpuLimit   = config.RESOURCE_CPU_LIMIT     || 0;
    const ramLimitMB = config.RESOURCE_RAM_LIMIT_MB  || 0;
    const diskLimitMB= config.RESOURCE_DISK_LIMIT_MB || 0;

    let lines = [];
    let overCount = 0;
    for (const panel of active) {
      try {
        const stats = await ptero.getServerResources(panel.server_identifier, psn(panel));
        if (!stats) { lines.push(`${tge("WARNING","⚠️")} \`${panel.name || panel.server_id}\` — gagal ambil data`); continue; }
        const rss = stats.resources || {};
        const cpuPct   = rss.cpu_absolute || 0;
        const ramMB    = Math.round((rss.memory_bytes || 0) / 1024 / 1024);
        const diskMB   = Math.round((rss.disk_bytes   || 0) / 1024 / 1024);
        const cpuOver  = cpuLimit   > 0 && cpuPct  >= cpuLimit;
        const ramOver  = ramLimitMB > 0 && ramMB   >= ramLimitMB;
        const diskOver = diskLimitMB> 0 && diskMB  >= diskLimitMB;
        const isOver   = cpuOver || ramOver || diskOver;
        if (isOver) overCount++;
        const icon = isOver ? `${tge("RED_DOT","🔴")}` : (stats.current_state === "running" ? `${tge("GREEN_DOT","🟢")}` : `${tge("YELLOW_DOT","🟡")}`);
        lines.push(
          `${icon} *${(panel.name || "N/A").slice(0, 20)}* (\`${panel.userId}\`)\n` +
          `  ${tge("GEAR","⚙️")} CPU: ${cpuPct.toFixed(1)}%${cpuOver ? ` ${tge("RED_DOT","🔴")}` : ""}  ${tge("FLOPPY","💾")} RAM: ${ramMB}MB${ramOver ? ` ${tge("RED_DOT","🔴")}` : ""}  ${tge("DISK","💿")} Disk: ${diskMB}MB${diskOver ? ` ${tge("RED_DOT","🔴")}` : ""}`
        );
      } catch {
        lines.push(`${tge("WARNING","⚠️")} \`${panel.name || panel.server_id}\` — error`);
      }
    }

    const chunks = [];
    let chunk = `${tge("CHART","📊")} *Ringkasan Resource Panel (${active.length} aktif, ${overCount} over-limit)*\n\n`;
    for (const line of lines) {
      if ((chunk + line + "\n").length > 3800) {
        chunks.push(chunk);
        chunk = "";
      }
      chunk += line + "\n\n";
    }
    chunks.push(chunk);

    for (let i = 0; i < chunks.length; i++) {
      if (i === chunks.length - 1) {
        await ctx.reply(chunks[i], { parse_mode: "HTML", ...backKeyboard() });
      } else {
        await ctx.reply(chunks[i], { parse_mode: "HTML" });
      }
    }

    // Kirim notifikasi ke semua owner + grup jika ada panel yang melebihi batas
    if (overCount > 0) {
      const notifMsg =
        `${tge("WARNING","⚠️")} <b>Laporan Over-Resource (Cek Manual)</b>\n\n` +
        `${tge("CHART","📊")} Ditemukan <b>${overCount} panel</b> melebihi batas resource dari total ${active.length} panel aktif.\n\n` +
        `${tge("GEAR","⚙️")} Batas: CPU ${cpuLimit}% | RAM ${ramLimitMB} MB | Disk ${diskLimitMB} MB\n` +
        `${tge("CLOCK_FACE","🕐")} ${new Date().toLocaleString("id-ID")}`;

      if (config.GROUP_ID) {
        try { await bot.telegram.sendMessage(config.GROUP_ID, notifMsg, { parse_mode: "HTML" }); } catch {}
      }
      const ownerSet = new Set([
        ...config.OWNER_IDS.map(String),
        ...Object.entries(db.listAllUsers()).filter(([, u]) => u.role === "owner").map(([uid]) => uid),
      ]);
      for (const ownerId of ownerSet) {
        if (String(ownerId) === String(userId)) continue; // sudah dapat laporan lengkap di atas
        try { await bot.telegram.sendMessage(ownerId, notifMsg, { parse_mode: "HTML" }); } catch {}
      }
    }
    return;
  }

  // ── Status VPS (Owner) ────────────────────────────────────────────
  if (data === "vps_status" || data === "vps_refresh") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Mengambil data VPS...</b>`, { parse_mode: "HTML" });
    try {
      const text = await buildVpsText();
      await safeEdit(ctx, text, { parse_mode: "HTML", ...vpsStatusKeyboard() });
    } catch (e) {
      await safeEdit(ctx, `${tge("ERROR","❌")} Gagal ambil info VPS: ${e.message}`, backKeyboard());
    }
    return;
  }


  // ── Poin Saya ─────────────────────────────────────────────────────
  if (data === "my_points") {
    const pts     = db.getPoints(userId);
    const rate    = config.POINT_EXCHANGE_RATE || 50;
    const rewards = config.POINT_REWARDS || {};
    const text =
      `${tge("GAMEPAD","🎮")} <b>Poin Saya</b>\n━━━━━━━━━━━━━━━━━━━━\n\n` +
      `${tge("STAR","⭐")} Poin Kamu: *${pts} poin*\n` +
      `${tge("REFRESH","🔄")} Nilai Tukar: *${rate} poin = 1 hari panel*\n` +
      `${tge("BULB","💡")} Bisa ditukar: *${Math.floor(pts / rate)} hari*\n\n` +
      `${tge("PIN","📌")} <b>Cara Mendapat Poin:</b>\n` +
      `• Buat panel: +${rewards.create_panel || 5} poin\n` +
      `• Perpanjang panel: +${rewards.extend_panel || 2} poin\n` +
      `• Redeem voucher: +${rewards.redeem_voucher || 3} poin\n` +
      `• Login harian: +${rewards.daily_login || 1} poin`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...pointsMenuKeyboard(pts, rate) });
  }

  if (data === "points_exchange") {
    const rate = config.POINT_EXCHANGE_RATE || 50;
    const pts  = db.getPoints(userId);
    if (pts < rate) {
      return safeEdit(ctx, `${tge("ERROR","❌")} Poin tidak cukup!\n\nKamu punya *${pts} poin*, butuh *${rate} poin* untuk 1 hari.\nTerus aktif untuk kumpulkan poin!`, { parse_mode: "HTML", ...backKeyboard() });
    }
    const panels = db.getUserPanels(userId).filter(p => !p.expired && !p.suspended);
    if (!panels.length) return safeEdit(ctx, `${tge("ERROR","❌")} Tidak ada panel aktif untuk diperpanjang.`, backKeyboard());
    const ok = db.spendPoints(userId, rate);
    if (!ok) return safeEdit(ctx, `${tge("ERROR","❌")} Gagal tukar poin.`, backKeyboard());
    // Tambah ke pending days
    const cur = db.getPendingDays(userId);
    db.setPendingDays(userId, cur + 1);
    db.addTransaction(userId, { type: "Tukar Poin", detail: `${rate} poin → +1 hari pending` });
    db.addAuditLog({ actorId: userId, action: "Tukar Poin", detail: `${rate} poin → 1 hari pending` });
    return safeEdit(ctx, `${tge("SUCCESS","✅")} <b>Berhasil Tukar Poin!</b>\n\n${tge("GAMEPAD","🎮")} ${rate} poin dikurangi\n${tge("CALENDAR","📅")} +1 hari ditambah ke Pending Days\n${tge("STAR","⭐")} Sisa poin: *${pts - rate}*\n\nGunakan menu Perpanjang Panel untuk pakai hari bonus.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (data === "points_leaderboard") {
    const lb = db.getPointsLeaderboard(10);
    if (!lb.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada data poin.`, backKeyboard());
    let text = `${tge("TROPHY","🏆")} <b>Leaderboard Poin Top 10</b>\n━━━━━━━━━━━━━━━━━━━━\n\n`;
    lb.forEach((e, i) => {
      const medal = i === 0 ? `${tge("MEDAL_GOLD","🥇")}` : i === 1 ? `${tge("MEDAL_SILVER","🥈")}` : i === 2 ? `${tge("MEDAL_BRONZE","🥉")}` : `${i+1}.`;
      text += `${medal} ID \`${e.userId}\` — *${e.points} poin*\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Template Panel ────────────────────────────────────────────────
  if (data === "template_menu") {
    const templates = db.getTemplates();
    if (!templates.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada template panel.\n\nOwner bisa tambah template melalui menu Admin → Kelola Template.`, backKeyboard());
    let text = `${tge("LIST","📋")} <b>Template Panel</b>\nPilih template untuk mulai buat panel dengan konfigurasi preset:\n\n`;
    templates.forEach((t, i) => {
      text += `*${i+1}. ${t.name}*\n   ${tge("EGG","🥚")} Egg: ${t.egg_name || "?"} | ${tge("PACKAGE","📦")} Plan: ${t.plan_name || "?"}\n`;
    });
    return safeEdit(ctx, text, { parse_mode: "HTML", ...templatesKeyboard(templates) });
  }

  if (data.startsWith("use_tpl_")) {
    const tplName = data.slice(8);
    const templates = db.getTemplates();
    const tpl = templates.find(t => t.name.slice(0,20) === tplName);
    if (!tpl) return safeEdit(ctx, `${tge("ERROR","❌")} Template tidak ditemukan.`, backKeyboard());
    const s = getState(userId);
    s.template      = tpl;
    s.nest_id       = tpl.nest_id;
    s.egg_id        = tpl.egg_id;
    s.plan          = config.RESOURCE_PLANS[tpl.plan_index] || config.RESOURCE_PLANS[0];
    s.step          = "panel_username";
    s.panel_type    = tpl.panel_type || "normal";
    s.isTemplate    = true;
    return safeEdit(ctx,
      `${tge("LIST","📋")} *Template: ${tpl.name}*\n\n${tge("EGG","🥚")} Egg: ${tpl.egg_name || "?"}\n${tge("PACKAGE","📦")} Plan: ${tpl.plan_name || "?"}\n\nMasukkan <b>username</b> untuk panel baru kamu:`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  if (data === "create_panel_fresh") {
    clearState(userId);
    // Trigger ulang create_panel flow manual
    ctx.callbackQuery.data = "create_panel";
    return bot.handleUpdate({ ...ctx.update, callback_query: { ...ctx.callbackQuery, data: "create_panel" } });
  }

  // ── Simpan Template setelah buat panel ───────────────────────────
  if (data.startsWith("save_tpl_") && !data.startsWith("save_tpl_name")) {
    if (!isOwner(userId)) return ctx.answerCbQuery(`${tge("ERROR","❌")} Hanya Owner.`);
    const s2 = getState(userId);
    if (!s2.pending_tpl_payload) return safeEdit(ctx, `${tge("ERROR","❌")} Data template tidak ditemukan. Coba buat panel lagi.`, backKeyboard());
    s2.step = "save_tpl_name_input";
    return safeEdit(ctx, `${tge("FLOPPY","💾")} <b>Simpan sebagai Template</b>\n\nMasukkan nama untuk template ini:\n(contoh: "Minecraft 4GB", "NodeJS Small")`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Kelola Template (Owner) ───────────────────────────────────────
  if (data === "manage_templates") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const templates = db.getTemplates();
    let text = `${tge("LIST","📋")} <b>Kelola Template Panel</b>\n\nTotal template: *${templates.length}*\n\n`;
    if (templates.length) {
      templates.forEach((t, i) => {
        text += `*${i+1}. ${t.name}*\n   ${tge("EGG","🥚")} ${t.egg_name || "?"} | ${tge("PACKAGE","📦")} ${t.plan_name || "?"}\n`;
      });
    } else {
      text += "_Belum ada template. Buat panel dulu lalu simpan sebagai template._";
    }
    const kb = templates.length
      ? manageTemplatesKeyboard(templates)
      : backKeyboard();
    return safeEdit(ctx, text, { parse_mode: "HTML", ...kb });
  }

  if (data.startsWith("del_tpl_")) {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const tplName = data.slice(8);
    const templates = db.getTemplates();
    const tpl = templates.find(t => t.name.slice(0,20) === tplName);
    if (!tpl) return safeEdit(ctx, `${tge("ERROR","❌")} Template tidak ditemukan.`, backKeyboard());
    db.deleteTemplate(tpl.name);
    db.addAuditLog({ actorId: userId, action: "Hapus Template", detail: tpl.name });
    return safeEdit(ctx, `${tge("SUCCESS","✅")} Template *${tpl.name}* berhasil dihapus.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Whitelist Mode (Owner) ────────────────────────────────────────
  if (data === "whitelist_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const wlEnabled = db.getWhitelistMode();
    const users = db.getWhitelistUsers();
    return safeEdit(ctx,
      `${tge("LOCK","🔒")} <b>Whitelist Mode</b>\n\nStatus: ${wlEnabled ? `${tge("GREEN_DOT","🟢")} <b>AKTIF</b>` : `${tge("RED_DOT","🔴")} <b>NONAKTIF</b>`}\nUser di-whitelist: *${users.length}*\n\n${wlEnabled ? `${tge("WARNING","⚠️")} Hanya user yang di-whitelist yang bisa pakai bot.` : `${tge("INFO","ℹ️")} Semua user bisa pakai bot (whitelist off).`}`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([
        [Markup.button.callback(wlEnabled ? `${TOFF()} Nonaktifkan Whitelist` : `${TON()} Aktifkan Whitelist`, "wl_toggle")],
        [Markup.button.callback("➕ Tambah ke Whitelist", "wl_add"), Markup.button.callback("➖ Hapus dari Whitelist", "wl_remove")],
        [Markup.button.callback("📑 Daftar Whitelist", "wl_list")],
        [Markup.button.callback("◀️ Kembali", "back_main")],
      ]) }
    );
  }

  if (data === "wl_toggle") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const cur = db.getWhitelistMode();
    db.setWhitelistMode(!cur);
    db.addAuditLog({ actorId: userId, action: `Whitelist Mode ${!cur ? "ON" : "OFF"}` });
    const _ton = tge("TOGGLE_ON","🟢"); const _toff = tge("TOGGLE_OFF","🔴");
    const _ok = tge("SUCCESS","✅");
    return safeEdit(ctx,
      `${_ok} Whitelist Mode sekarang: ${!cur ? `${_ton} <b>AKTIF</b>` : `${_toff} <b>NONAKTIF</b>`}`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  if (data === "wl_add") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "wl_add_id";
    return safeEdit(ctx, `${tge("PLUS","➕")} Masukkan <b>Telegram ID</b> user yang ingin ditambah ke whitelist:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "wl_remove") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "wl_remove_id";
    return safeEdit(ctx, `${tge("MINUS","➖")} Masukkan <b>Telegram ID</b> user yang ingin dihapus dari whitelist:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "wl_list") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const users = db.getWhitelistUsers();
    if (!users.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Whitelist kosong.`, backKeyboard());
    const text = `${tge("LIST","📋")} *Daftar Whitelist (${users.length} user)*\n\n` + users.map((u, i) => `${i+1}. \`${u}\``).join("\n");
    return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Export Data (Owner) ───────────────────────────────────────────
  if (data === "export_data_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    return safeEdit(ctx, `${tge("OUTBOX","📤")} <b>Export Data</b>\nPilih data yang ingin diekspor:`, { parse_mode: "HTML", ...exportDataKeyboard() });
  }

  if (data === "export_users") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat file CSV...`, { parse_mode: "HTML" });
    const users = db.listAllUsers();
    let csv = "UserID,Role,PanelCount,Points,Blacklisted\n";
    for (const [uid, u] of Object.entries(users)) {
      csv += `${uid},${u.role || "user"},${u.panel_count || 0},${db.getPoints(uid)},${u.blacklisted ? "Ya" : "Tidak"}\n`;
    }
    const fpath = path.join(os.tmpdir(), `users_export_${Date.now()}.csv`);
    fs.writeFileSync(fpath, csv);
    try {
      await ctx.telegram.sendDocument(userId, { source: fs.createReadStream(fpath), filename: `users_${new Date().toISOString().slice(0,10)}.csv` }, { caption: `${tge("USERS","👥")} Export User\nTotal: ${Object.keys(users).length} user` });
    } finally { try { fs.unlinkSync(fpath); } catch {} }
    return ctx.reply(`${tge("SUCCESS","✅")} File export sudah dikirim!`, backKeyboard());
  }

  if (data === "export_panels") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat file CSV...`, { parse_mode: "HTML" });
    const panels = db.getAllPanels();
    let csv = "UserID,ServerID,Identifier,Name,PlanName,Egg,Status,ExpireDate,CreatedAt\n";
    for (const p of panels) {
      const status = p.suspended ? "Suspended" : p.expired ? "Expired" : "Active";
      csv += `${p.userId},${p.server_id || ""},${p.server_identifier || ""},${(p.name || "").replace(/,/g, ";")},${p.plan_name || ""},${p.egg || ""},${status},${p.expire_date || ""},${p.created_at || ""}\n`;
    }
    const fpath = path.join(os.tmpdir(), `panels_export_${Date.now()}.csv`);
    fs.writeFileSync(fpath, csv);
    try {
      await ctx.telegram.sendDocument(userId, { source: fs.createReadStream(fpath), filename: `panels_${new Date().toISOString().slice(0,10)}.csv` }, { caption: `${tge("DESKTOP","🖥️")} Export Panel\nTotal: ${panels.length} panel` });
    } finally { try { fs.unlinkSync(fpath); } catch {} }
    return ctx.reply(`${tge("SUCCESS","✅")} File export sudah dikirim!`, backKeyboard());
  }

  if (data === "export_transactions") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} Membuat file CSV...`, { parse_mode: "HTML" });
    const txs = db.getAllTransactions(500);
    let csv = "UserID,Tipe,Detail,Waktu\n";
    for (const t of txs) {
      csv += `${t.userId},"${(t.type || "").replace(/"/g, "'")}","${(t.detail || "").replace(/"/g, "'")}",${t.at || ""}\n`;
    }
    const fpath = path.join(os.tmpdir(), `transactions_export_${Date.now()}.csv`);
    fs.writeFileSync(fpath, csv);
    try {
      await ctx.telegram.sendDocument(userId, { source: fs.createReadStream(fpath), filename: `transactions_${new Date().toISOString().slice(0,10)}.csv` }, { caption: `${tge("SCROLL","📜")} Export Transaksi\nTotal: ${txs.length} transaksi` });
    } finally { try { fs.unlinkSync(fpath); } catch {} }
    return ctx.reply(`${tge("SUCCESS","✅")} File export sudah dikirim!`, backKeyboard());
  }

  // ── Jadwal Maintenance (Owner) ────────────────────────────────────
  if (data === "scheduled_maint_menu") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const sm = db.getScheduledMaintenance();
    return safeEdit(ctx,
      `${tge("ALARM","⏰")} <b>Jadwal Maintenance Otomatis</b>\n\nStatus: ${sm.enabled ? `${tge("GREEN_DOT","🟢")} <b>AKTIF</b>` : `${tge("RED_DOT","🔴")} <b>NONAKTIF</b>`}\nWaktu: *${sm.start} – ${sm.end}* WIB\nHari: ${sm.days && sm.days.length ? sm.days.join(", ") : "Setiap hari"}\n\nPesan:\n_"${sm.message}"_`,
      { parse_mode: "HTML", ...scheduledMaintKeyboard(sm) }
    );
  }

  if (data === "schm_toggle") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const sm = db.getScheduledMaintenance();
    db.setScheduledMaintenance({ enabled: !sm.enabled });
    db.addAuditLog({ actorId: userId, action: `Jadwal Maintenance ${!sm.enabled ? "ON" : "OFF"}` });
    const _ton = tge("TOGGLE_ON","🟢"); const _toff = tge("TOGGLE_OFF","🔴");
    const _ok = tge("SUCCESS","✅");
    return safeEdit(ctx,
      `${_ok} Jadwal Maintenance: ${!sm.enabled ? `${_ton} <b>AKTIF</b>` : `${_toff} <b>NONAKTIF</b>`}`,
      { parse_mode: "HTML", ...backKeyboard() }
    );
  }

  if (data === "schm_set_time") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "schm_time_input";
    return safeEdit(ctx, `${tge("ALARM","⏰")} Masukkan waktu mulai dan selesai maintenance dalam format:\n\n<code>HH:MM-HH:MM</code>\n\nContoh: <code>02:00-04:00</code>`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (data === "schm_set_msg") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "schm_msg_input";
    return safeEdit(ctx, `${tge("SPEECH","💬")} Masukkan pesan yang akan ditampilkan saat maintenance terjadwal aktif:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Cari Panel (Owner) ────────────────────────────────────────────
  if (data === "search_panel") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Hanya Owner.`, backKeyboard());
    const s = getState(userId); s.step = "search_panel_query";
    return safeEdit(ctx, `${tge("SEARCH","🔎")} <b>Cari Panel</b>\n\nMasukkan nama panel, Server ID, atau Telegram ID user:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  // ── Nest Selection ────────────────────────────────────────────────
  if (data.startsWith("nest_")) {
    const nestId = parseInt(data.slice(5));
    const s = getState(userId);
    if (!s.username) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir. Mulai ulang dari menu.`, backKeyboard());
    const nest = (s.nests || []).find(n => n.attributes.id === nestId);
    if (!nest) return safeEdit(ctx, `${tge("ERROR","❌")} Nest tidak ditemukan.`, cancelKeyboard());
    s.nest_id = nestId;
    s.nest_name = nest.attributes.name;
    s.step = "egg";
    const eggs = await ptero.getEggs(nestId, s.server_num || 1);
    if (!eggs.length) return safeEdit(ctx, `${tge("ERROR","❌")} Tidak ada Egg di Nest ini.`, cancelKeyboard());
    s.eggs = eggs;
    return safeEdit(ctx, `${tge("EGG","🥚")} <b>Pilih Egg</b>\n\nNest: *${s.nest_name}*\nPilih jenis server:`, { parse_mode: "HTML", ...eggsKeyboard(eggs, role) });
  }

  // ── Egg Selection ─────────────────────────────────────────────────
  // ── Konfirmasi buat panel dari Template ──────────────────────────
  if (data === "do_create_panel") {
    const s = getState(userId);
    if (!s.username || !s.egg_id) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir. Mulai ulang.`, backKeyboard());
    s.plan_name = s.plan?.name || (config.RESOURCE_PLANS[s.plan_index] || config.RESOURCE_PLANS[0]).name;
    s.ram  = s.plan?.ram  || (config.RESOURCE_PLANS[0]).ram;
    s.disk = s.plan?.disk || (config.RESOURCE_PLANS[0]).disk;
    s.cpu  = s.plan?.cpu  || (config.RESOURCE_PLANS[0]).cpu;
    s.environment = s.env || {};
    await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat panel dari template...</b>\n\nHarap tunggu.`, { parse_mode: "HTML" });
    await executeCreatePanel(ctx, userId, role, s, false);
    return;
  }

  if (data.startsWith("egg_")) {
    const eggId = parseInt(data.slice(4));
    const s = getState(userId);
    if (!s.username) return safeEdit(ctx, `${tge("ERROR","❌")} Sesi berakhir. Mulai ulang dari menu.`, backKeyboard());
    const egg = (s.eggs || []).find(e => e.attributes.id === eggId);
    if (!egg) return safeEdit(ctx, `${tge("ERROR","❌")} Egg tidak ditemukan.`, cancelKeyboard());
    s.egg_id = eggId;
    s.egg_name = egg.attributes.name;
    s.docker_image = egg.attributes.docker_image;
    s.startup = egg.attributes.startup;
    s.environment = buildEnvFromEgg(egg);
    s.step = "plan";

    if (s.is_trial) {
      await safeEdit(ctx, `${tge("HOURGLASS","⏳")} <b>Membuat trial panel...</b>\n\nHarap tunggu.`, { parse_mode: "HTML" });
      await executeCreatePanel(ctx, userId, role, s, true);
      return;
    }

    return safeEdit(ctx, `${tge("SUCCESS","✅")} Egg dipilih: *${s.egg_name}*\n\n${tge("PACKAGE","📦")} <b>Pilih Paket Resource:</b>`, { parse_mode: "HTML", ...plansKeyboard() });
  }

  // ═══════════ V3 Inline Callback Handlers ═══════════════════════════════════

  // Toggle Favorit
  if (data.startsWith("fav_tg_")) {
    const sid = data.slice(7);
    const myPanels = db.getUserPanels(userId);
    const p = myPanels.find(x => String(x.server_id) === String(sid));
    if (!p) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan / bukan milikmu.`, backKeyboard());
    const fav = (db.getFavorites(userId) || []).includes(String(sid));
    if (fav) db.removeFavorite(userId, sid); else db.addFavorite(userId, sid);
    try { await ctx.answerCbQuery(fav ? "Favorit dihapus" : "Ditambahkan ke favorit ⭐"); } catch {}
    return safeEdit(ctx,
      `${tge("STAR","⭐")} <b>Panel Favorit</b>\n\nPanel <code>${sid}</code> ${fav ? "dihapus dari" : "ditambah ke"} favorit.`,
      { parse_mode: "HTML", ...panelManageKeyboard(p, isOwner(userId), userId) });
  }

  // Usage Chart inline
  if (data.startsWith("chart_") && !data.startsWith("chart_bk")) {
    const sid = data.slice(6);
    const acc = findUserPanelOrAccessible(userId, sid);
    if (!acc) return safeEdit(ctx, `${tge("ERROR","❌")} Panel tidak ditemukan.`, backKeyboard());
    return safeEdit(ctx,
      `${tge("BAR_CHART","📊")} <b>Usage Chart</b> — <code>${sid}</code>\n\n${buildUsageChart(sid)}`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", `pnl_mn_${sid}`)]]) });
  }

  // Co-owner manage shortcut
  if (data.startsWith("co_mn_")) {
    const sid = data.slice(6);
    const myPanels = db.getUserPanels(userId);
    const p = myPanels.find(x => String(x.server_id) === String(sid));
    if (!p && !isOwner(userId)) return safeEdit(ctx, `${tge("ERROR","❌")} Panel bukan milikmu.`, backKeyboard());
    const cos = db.getCoOwners(sid);
    const text = `${tge("USERS","👥")} <b>Co-owner</b> — <code>${sid}</code>\n\n${cos.length ? cos.map((u,i)=>`${i+1}. <code>${u}</code>`).join("\n") : "<i>Belum ada co-owner.</i>"}\n\nGunakan command:\n• <code>/coowner add ${sid} &lt;tg_id&gt;</code>\n• <code>/coowner remove ${sid} &lt;tg_id&gt;</code>`;
    return safeEdit(ctx, text, { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", `pnl_mn_${sid}`)]]) });
  }

  // Disk cleaner shortcut
  if (data.startsWith("dc_")) {
    const sid = data.slice(3);
    return safeEdit(ctx, `${tge("BROOM","🧹")} <b>Disk Cleaner</b>\n\nGunakan command:\n<code>/diskcleaner ${sid}</code>\n\nKami akan memindai file log/cache/temp besar yang aman dihapus.`, { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("◀️ Kembali", `pnl_mn_${sid}`)]]) });
  }

  // V3 admin tools
  if (data === "v3_topuser") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("LOCK","🔒")} Hanya Owner.`, backKeyboard());
    const top = db.getResourceQuotaLeaderboard(15);
    if (!top.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada data.`, backKeyboard());
    const medals = ["🥇", "🥈", "🥉"];
    const lines = top.map((u, i) => `${medals[i] || (i+1)+"."} <code>${u.uid}</code> [${u.role}] — ${u.ram}MB / ${u.disk}MB / ${u.cpu}% / ${u.count}p`);
    return safeEdit(ctx, `${tge("TROPHY","🏆")} <b>Top Resource</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (data === "v3_sla") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("LOCK","🔒")} Hanya Owner.`, backKeyboard());
    const month = new Date().toISOString().slice(0, 7);
    const data2 = db.getSlaForMonth(month);
    const all = db.getAllPanels();
    const entries = Object.entries(data2).slice(0, 15);
    if (!entries.length) return safeEdit(ctx, `${tge("EMPTY_BOX","📭")} Belum ada SLA snapshot bulan ${month}.\n\nLaporan otomatis dibuat tanggal 1.`, backKeyboard());
    const lines = entries.sort((a,b)=>b[1]-a[1]).map(([sid, pct]) => {
      const p = all.find(x => String(x.server_id) === String(sid));
      return `<code>${sid}</code> ${he(p?.name || "-").slice(0, 18)}: <b>${pct.toFixed(2)}%</b>`;
    });
    return safeEdit(ctx, `${tge("SCROLL","📜")} <b>SLA — ${month}</b>\n\n${lines.join("\n")}`, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (data === "v3_suspicious") {
    if (!isOwner(userId)) return safeEdit(ctx, `${tge("LOCK","🔒")} Hanya Owner.`, backKeyboard());
    const list = db.getSuspiciousRecent(15);
    if (!list.length) return safeEdit(ctx, `${tge("SUCCESS","✅")} Tidak ada aktivitas mencurigakan.`, backKeyboard());
    const lines = list.map((s, i) => `${i+1}. <b>${he(s.type)}</b> · <code>${s.uid}</code> · ${formatDate(s.ts)}\n   <i>${he(s.detail || "-").slice(0, 80)}</i>`);
    return safeEdit(ctx, `${tge("SIREN","🚨")} <b>Suspicious Log</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (data === "v3_theme") {
    const role = db.getRole(userId);
    if (!["premium", "owner"].includes(role)) return safeEdit(ctx, `${tge("DIAMOND","💎")} Theme Pack hanya untuk Premium &amp; Owner.`, { parse_mode: "HTML", ...backKeyboard() });
    const packs = config.THEME_PACKS || {};
    const cur = db.getThemePack(userId);
    const list = Object.entries(packs).map(([k, v]) => `• <code>${k}</code> ${v.prefix} ${v.name}`).join("\n");
    return safeEdit(ctx, `${tge("SPARKLES","✨")} <b>Theme Pack</b>\n\nAktif: <b>${cur}</b>\n\n${list}\n\nGunakan: <code>/theme &lt;nama&gt;</code>`, { parse_mode: "HTML", ...backKeyboard() });
  }

  } catch (err) {
    botLog("ERROR", "CALLBACK", `User:${userId} | Action:${data}`, err);
    try { await ctx.reply(`${tge("ERROR","❌")} Terjadi kesalahan internal. Silakan coba lagi atau hubungi owner.`); } catch {}
  }
});

// ─── Helper: parse error Pterodactyl menjadi pesan yang mudah dipahami ────────

function parsePteroError(errObj) {
  if (!errObj) return "Error tidak diketahui dari Pterodactyl.";
  const msg  = String(errObj.msg || "").toLowerCase();
  const code = Number(errObj.code || 0);

  if (code === 403)
    return "🔑 API key tidak punya izin (403 Forbidden) — cek permission PTLA key di panel.";
  if (code === 401)
    return "🔑 API key tidak valid atau kadaluarsa (401 Unauthorized).";
  if (code === 404)
    return "❓ Egg, Nest, atau Location tidak ditemukan (404) — mungkin sudah dihapus dari panel.";
  if (code === 409)
    return "⚡ Konflik data (409) — nama server atau username mungkin sudah dipakai.";
  if (code === 500)
    return "💥 Error internal Pterodactyl (500) — cek log panel.";
  if (code === 0)
    return "🌐 Tidak bisa terhubung ke Pterodactyl — cek URL panel dan koneksi internet VPS.";

  if (code === 422) {
    if (msg.includes("no nodes") || msg.includes("satisfying") || msg.includes("automatic deployment"))
      return "🖥️ Tidak ada node yang tersedia — semua node penuh atau RAM/Disk/CPU melebihi kapasitas node.";
    if (msg.includes("no allocation") || msg.includes("allocation"))
      return "🔌 Tidak ada alokasi port tersedia di node — tambahkan alokasi di panel Pterodactyl.";
    if (msg.includes("already been taken") && (msg.includes("username") || msg.includes("email")))
      return "👤 Username atau email sudah dipakai oleh akun lain di panel ini.";
    if (msg.includes("egg") || msg.includes("docker"))
      return "🥚 Egg atau Docker image tidak valid — pastikan egg dikonfigurasi dengan benar.";
    if (msg.includes("startup") || msg.includes("variable"))
      return "⚙️ Variabel startup tidak valid — cek konfigurasi egg.";
    if (msg.includes("disk") || msg.includes("memory") || msg.includes("cpu"))
      return "📊 Nilai RAM/Disk/CPU tidak valid atau melebihi batas yang diizinkan.";
    return `⚠️ Validasi gagal (422): ${errObj.msg}`;
  }
  return `HTTP ${code || "?"}: ${errObj.msg || "unknown error"}`;
}

// ─── Helper: kirim notif error buat panel ke grup + semua owner + user ────────

async function notifyCreateError({ ctx, userId, role, s, isTrial, step, reason, rawErr }) {
  const userName = ctx?.from ? telegramName(ctx.from) : String(userId);
  const _srv = s?.server_num || 1;
  const panelTypeLbl = s?.panel_type === "admin" ? "Admin Panel" : "Panel Biasa";
  const errDetail = rawErr ? parsePteroError(rawErr) : reason;

  const errMsg =
    `🚨 <b>Gagal Buat Panel!</b>\n\n` +
    `👤 User: <b>${he(userName)}</b> (<code>${userId}</code>) — Role: <b>${role}</b>\n` +
    `🎭 Tipe: ${panelTypeLbl}${isTrial ? " (Trial)" : ""}\n` +
    `🌐 Server: <b>${he2(serverLabel(_srv))}</b>\n` +
    (s?.egg_name  ? `🥚 Egg: <code>${he(s.egg_name)}</code>\n`  : "") +
    (s?.plan_name ? `📦 Paket: <code>${he(s.plan_name)}</code>\n` : "") +
    `\n❌ <b>Langkah Gagal:</b> ${step}\n` +
    `📋 <b>Alasan:</b> ${errDetail}`;

  logger.error("CREATE_PANEL_FAIL", `User:${userId} step=${step} → ${errDetail}`);
  db.addAuditLog({ actorId: String(userId), action: `Gagal Buat Panel (${step})`, detail: errDetail });

  // Kirim ke grup
  if (config.GROUP_ID) {
    try { await bot.telegram.sendMessage(config.GROUP_ID, errMsg, { parse_mode: "HTML" }); } catch {}
  }

  // Kirim ke semua owner
  const ownerSet = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);
  for (const ownerId of ownerSet) {
    if (String(ownerId) === String(userId)) continue; // jangan double jika user adalah owner
    try { await bot.telegram.sendMessage(ownerId, errMsg, { parse_mode: "HTML" }); } catch {}
  }

  // Kirim ke user (pesan yang lebih singkat + actionable)
  const userMsg =
    `❌ <b>Gagal Membuat Panel</b>\n\n` +
    `<b>Langkah:</b> ${step}\n` +
    `<b>Alasan:</b> ${errDetail}\n\n` +
    `Hubungi owner jika masalah berlanjut.`;
  try {
    if (ctx) await ctx.reply(userMsg, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
    else await bot.telegram.sendMessage(userId, userMsg, { parse_mode: "HTML" });
  } catch {}
}

// ─── Eksekusi Buat Panel ──────────────────────────────────────────────────────

async function executeCreatePanel(ctx, userId, role, s, isTrial = false) {
  const isAdmin = s.panel_type === "admin";
  logger.event("CREATE_PANEL", `User:${userId} role=${role} egg="${s.egg_name}" plan="${s.plan_name}" trial=${isTrial} admin=${isAdmin}`);
  ptero.clearLastApiError();

  // Quota check (#5) — non-trial saja
  if (!isTrial) {
    const quota = (config.ROLE_QUOTAS || {})[role] || {};
    const usage = db.computeUserResourceUsage(userId);
    const newRam  = Number(s.ram  || 0);
    const newDisk = Number(s.disk || 0);
    const newCpu  = Number(s.cpu  || 0);
    if (quota.panels > 0 && usage.count >= quota.panels) {
      clearState(userId);
      return ctx.reply(`${tge("ERROR","❌")} <b>Quota Panel Terlampaui</b>\n\nRole <b>${role}</b> maksimal ${quota.panels} panel. Hubungi owner untuk upgrade.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
    }
    if (quota.ram > 0 && (usage.ram + newRam) > quota.ram) {
      clearState(userId);
      return ctx.reply(`${tge("ERROR","❌")} <b>Quota RAM Terlampaui</b>\n\nLimit ${quota.ram} MB, total setelah panel ini ${usage.ram + newRam} MB.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
    }
    if (quota.disk > 0 && (usage.disk + newDisk) > quota.disk) {
      clearState(userId);
      return ctx.reply(`${tge("ERROR","❌")} <b>Quota Disk Terlampaui</b>\n\nLimit ${quota.disk} MB, total setelah panel ini ${usage.disk + newDisk} MB.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
    }
    if (quota.cpu > 0 && (usage.cpu + newCpu) > quota.cpu) {
      clearState(userId);
      return ctx.reply(`${tge("ERROR","❌")} <b>Quota CPU Terlampaui</b>\n\nLimit ${quota.cpu}%, total setelah panel ini ${usage.cpu + newCpu}%.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
    }
  }

  const _srv = s.server_num || (allowedServers(db.getRole(userId))[0] || 1);

  // ── Cek / buat user Pterodactyl ──────────────────────────────────────────
  ptero.clearLastApiError();
  let pteroUser = await ptero.getUserByEmail(s.email, _srv);
  if (!pteroUser) {
    pteroUser = await ptero.createUser({
      username: s.username, email: s.email,
      firstName: s.username, lastName: "User",
      password: s.password, isAdmin,
    }, _srv);
  } else if (isAdmin) {
    await ptero.updateUserToAdmin(pteroUser.id, true, _srv);
  }

  if (!pteroUser) {
    const rawErr = ptero.getLastApiError();
    clearState(userId);
    await notifyCreateError({ ctx, userId, role, s, isTrial,
      step: "Buat Akun Pterodactyl",
      reason: "Tidak bisa membuat/menemukan akun user di panel.",
      rawErr,
    });
    return;
  }

  // ── Cek ketersediaan lokasi ───────────────────────────────────────────────
  const locations = await ptero.getLocations(_srv);
  if (!locations.length) {
    clearState(userId);
    await notifyCreateError({ ctx, userId, role, s, isTrial,
      step: "Cek Lokasi/Node",
      reason: "Tidak ada lokasi tersedia di panel. Tambahkan Location dan Node di Pterodactyl.",
      rawErr: ptero.getLastApiError(),
    });
    return;
  }
  const locationId = s.location_id || locations[0].attributes.id;

  // ── Buat server di Pterodactyl ────────────────────────────────────────────
  ptero.clearLastApiError();
  const server = await ptero.createServer({
    name: `Panel-${s.username}`,
    userId: pteroUser.id, eggId: s.egg_id,
    dockerImage: s.docker_image, startup: s.startup,
    environment: s.environment,
    ram: s.ram, disk: s.disk, cpu: s.cpu, locationId,
  }, _srv);

  if (!server) {
    const rawErr = ptero.getLastApiError();
    clearState(userId);
    await notifyCreateError({ ctx, userId, role, s, isTrial,
      step: "Buat Server Pterodactyl",
      reason: "Pterodactyl menolak pembuatan server.",
      rawErr,
    });
    return;
  }

  db.incrementPanelCount(userId);
  db.incrementDailyCount(userId);
  if (role === "reseller") {
    db.decrementResellerLimit(userId);
  }

  const expireDays = config.PANEL_EXPIRE_DAYS;

  db.addPanelRecord(userId, {
    name: server.name, server_id: server.id,
    server_identifier: server.identifier,
    username: s.username, email: s.email,
    panel_type: s.panel_type, plan_name: s.plan_name,
    nest: s.nest_name, egg: s.egg_name, is_trial: isTrial,
    server_num: _srv,
  }, isTrial ? config.TRIAL_HOURS : expireDays * 24);

  // Update description server di Pterodactyl dengan tanggal masa aktif
  const savedPanel = db.getUserPanels(userId).find(p => String(p.server_id) === String(server.id));
  if (savedPanel) {
    const expStr = formatDate(savedPanel.expire_date);
    const typeStr = isTrial ? "Trial" : (s.plan_name || "Standard");
    ptero.updateServerDescription(server.id, `Aktif hingga: ${expStr} | Paket: ${typeStr}`, _srv).catch(() => {});
  }

  if (isTrial) db.markTrialUsed(userId);

  db.addTransaction(userId, {
    type: isTrial ? "Trial Panel" : "Buat Panel",
    detail: `${server.name} | ID:${server.id} | ${s.plan_name}`,
  });

  db.addAuditLog({ actorId: userId, action: isTrial ? "Trial Panel" : "Buat Panel", target: String(server.id), detail: s.plan_name });

  // Catat aktivitas panel terakhir (untuk auto-lock)
  db.touchPanelActive(server.id);

  // Reward poin buat panel
  if (!isTrial) {
    const pts = (config.POINT_REWARDS || {}).create_panel || 5;
    if (pts > 0) db.addPoints(userId, pts);
  }

  const panelTypeLabel = isAdmin ? `${tge("CROWN","👑")} Admin Panel` : `${tge("DESKTOP","🖥️")} Panel Biasa`;
  const ps = planSummary({ ram: s.ram, disk: s.disk, cpu: s.cpu });

  let expDateStr;
  if (isTrial) {
    expDateStr = formatDate(new Date(Date.now() + config.TRIAL_HOURS * 60 * 60 * 1000).toISOString());
  } else {
    expDateStr = formatDate(new Date(Date.now() + expireDays * 24 * 60 * 60 * 1000).toISOString());
  }

  // ── Kirim data lengkap ke PRIVATE CHAT user terlebih dahulu ──────────────
  const _panelUrl = serverUrl(_srv);
  const _urlLine  = _panelUrl
    ? `${tge("LINK","🔗")} URL: <code>${he(_panelUrl)}</code>\n`
    : `${tge("LINK","🔗")} URL: <i>(Tanyakan URL panel ke owner)</i>\n`;

  const privateMsg =
    `${tge("SUCCESS","✅")} <b>Panel Berhasil Dibuat!</b>\n\n` +
    (isTrial ? `${tge("ALARM","⏰")} <b>TRIAL PANEL — ${config.TRIAL_HOURS} JAM</b>\n\n` : "") +
    `${tge("MASK","🎭")} Tipe: ${panelTypeLabel}\n` +
    `${tge("ID_CARD","🆔")} Server ID: <code>${he(String(server.id))}</code>\n` +
    `${tge("NAME_BADGE","📛")} Nama Server: <code>${he(server.name)}</code>\n` +
    `${tge("PACKAGE","📦")} Paket: <b>${he(s.plan_name)}</b>\n` +
    `${tge("CARD_INDEX","🗂️")} Nest: <code>${he(s.nest_name)}</code>\n` +
    `${tge("EGG","🥚")} Egg: <code>${he(s.egg_name)}</code>\n` +
    `${tge("FLOPPY","💾")} RAM: ${ps.ram}  •  ${tge("DISK","💿")} Disk: ${ps.disk}  •  ${tge("GEAR","⚙️")} CPU: ${ps.cpu}\n` +
    `${tge("BRAIN","🧠")} OOM Killer: <b>Aktif</b> ${tge("SUCCESS","✅")}\n` +
    `${tge("CALENDAR","📅")} Expired: <b>${he(expDateStr)}</b>\n\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `${tge("GLOBE","🌐")} <b>Login Panel:</b>\n` +
    _urlLine +
    `${tge("DESKTOP","🖥️")} Server: <b>${he2(serverLabel(_srv))}</b>\n` +
    `${tge("USER","👤")} Username: <code>${he(s.username || s.email)}</code>\n` +
    `${tge("EMAIL","📧")} Email: <code>${he(s.email)}</code>\n` +
    `${tge("KEY","🔑")} Password: <code>${he(s.password)}</code>\n` +
    `━━━━━━━━━━━━━━━━\n` +
    `${tge("WARNING","⚠️")} <b>Simpan info ini! Password tidak bisa dilihat lagi.</b>`;

  let sentToPrivate = false;
  try {
    await bot.telegram.sendMessage(userId, privateMsg, { parse_mode: "HTML" });
    sentToPrivate = true;
  } catch (err) {
    botLog("WARN", "NOTIFY", `Gagal kirim pesan ke user ${userId}`, err);
  }

  // ── Notifikasi ke semua Owner (private, dengan kredensial lengkap) ────────
  notifyOwners({ creatorId: userId, creatorFrom: ctx.from, server, panelTypeLabel, s })
    .catch(err => botLog("WARN", "NOTIFY_OWNERS", "Gagal kirim notif ke owners", err));

  // ── Notifikasi ke Grup (tanpa kredensial, hanya info panel) ──────────────
  notifyGroup({ creatorFrom: ctx.from, server, panelTypeLabel, s })
    .catch(err => botLog("WARN", "NOTIFY_GROUP", "Gagal kirim notif ke grup", err));

  // Simpan info pesan prompt sebelum clearState agar bisa dihapus
  const promptMsgId  = s.prompt_msg_id;
  const promptChatId = s.prompt_chat_id;

  clearState(userId);

  // Hapus pesan "Masukkan username" yang masih muncul di chat setelah selesai
  if (promptMsgId && promptChatId) {
    try { await ctx.telegram.deleteMessage(promptChatId, promptMsgId); } catch {}
  }

  // ── Pesan ringkas di chat saat ini ────────────────────────────────────────
  let successNote;
  if (sentToPrivate) {
    successNote = `${tge("LOCK","🔒")} <b>Detail login & kredensial sudah dikirim ke private chat kamu.</b>\n_Buka chat langsung dengan bot untuk melihatnya._`;
  } else {
    const me = await bot.telegram.getMe().catch(() => ({ username: "" }));
    successNote = `${tge("WARNING","⚠️")} <b>Gagal kirim ke private chat!</b>\n${tge("POINT_RIGHT","👉")} Kamu perlu start bot dulu di private: [Klik di sini](https://t.me/${me.username})\nLalu ulangi perintah ini atau hubungi owner.`;
  }

  // Info template tersimpan untuk tombol "Simpan Template" (khusus owner)
  const tplPayload = isOwner(userId)
    ? JSON.stringify({ nest_id: s.nest_id, egg_id: s.egg_id, egg_name: s.egg_name, nest_name: s.nest_name, plan_name: s.plan_name, plan_index: config.RESOURCE_PLANS.findIndex(p => p.name === s.plan_name), panel_type: s.panel_type || "normal" })
    : null;

  logger.event("PANEL_CREATED", `Panel "${server.name}" (ID:${server.id}) berhasil dibuat untuk userId:${userId} expired:${expDateStr} OOM=enabled`);

  const finishKb = isOwner(userId)
    ? Markup.inlineKeyboard([
        [Markup.button.callback("💿 Simpan sebagai Template", `save_tpl_${Buffer.from(tplPayload).toString("base64").slice(0,48)}`)],
        [Markup.button.callback("🏠 Menu Utama", "back_main")],
      ])
    : mainMenuKeyboard(role);

  if (isOwner(userId)) {
    // Simpan payload ke state sementara untuk callback save_tpl
    const ns = getState(userId);
    ns.pending_tpl_payload = tplPayload;
    ns.pending_tpl_server  = server.name;
  }

  return ctx.reply(
    `${tge("SUCCESS","✅")} <b>Panel berhasil dibuat!</b>\n\n` +
    `${tge("NAME_BADGE","📛")} Server: <code>${he(server.name)}</code>\n` +
    `${tge("MASK","🎭")} Tipe: ${panelTypeLabel}\n` +
    `${tge("PACKAGE","📦")} Paket: <b>${he(s.plan_name)}</b>\n` +
    `${tge("CALENDAR","📅")} Expired: <b>${he(expDateStr)}</b>\n` +
    `${tge("BRAIN","🧠")} OOM Killer: <b>Aktif</b> ${tge("SUCCESS","✅")}\n\n` +
    successNote,
    { parse_mode: "HTML", disable_web_page_preview: true, ...finishKb }
  );
}

// ─── Build Environment dari Egg ───────────────────────────────────────────────

function buildEnvFromEgg(egg) {
  const env = {};
  const variables = egg.attributes?.relationships?.variables?.data || [];
  variables.forEach((v) => {
    const attr = v.attributes;
    env[attr.env_variable] = attr.default_value || "";
  });
  return env;
}

// ─── Helpers: Stats & Nodes ───────────────────────────────────────────────────

function buildStatsText() {
  const s = db.getStats();
  const v = getVpsStats();
  return (
    `${tge("CHART","📊")} <b>Statistik Bot</b>\n\n` +
    `${tge("USERS","👥")} Total User Start: *${s.started}*\n` +
    `${tge("DIAMOND_ORANGE","🔶")} Reseller: *${s.resellers}*\n` +
    `${tge("DIAMOND","💎")} Premium: *${s.premiums}*\n` +
    `${tge("STAR2","🌟")} Partner: *${s.partners || 0}*\n` +
    `${tge("CROWN","👑")} Owner: *${s.owners}*\n` +
    `${tge("PROHIBITED","🚫")} Blacklisted: *${s.blacklisted}*\n\n` +
    `${tge("DESKTOP","🖥️")} Total Panel: *${s.totalPanels}*\n` +
    `  ${tge("SUCCESS","✅")} Aktif: *${s.activePanels}*  |  ${tge("LOCK","🔒")} Suspended: *${s.suspendedPanels}*  |  ${tge("SKULL","💀")} Expired: *${s.expiredPanels}*\n` +
    `${tge("ADMISSION","🎟️")} Voucher Total: *${s.voucherTotal}* | Terpakai: *${s.voucherUsed}*\n` +
    `${tge("SCROLL","📜")} Transaksi: *${s.transactions}*\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${tge("BOT","🤖")} <b>Runtime Bot:</b> \`${v.botUptime}\`\n\n` +
    `${tge("DESKTOP","🖥️")} <b>Info VPS:</b>\n` +
    `${tge("CLOCK","⏱️")} Uptime: \`${v.vpsUptime}\`\n` +
    `${tge("FLOPPY","💾")} RAM: \`${v.ram}\`\n` +
    `${tge("GEAR","⚙️")} CPU: \`${v.cpu}\`\n` +
    `${tge("DISK","💿")} Disk: \`${v.disk}\`\n` +
    `${tge("DESKTOP","🖥️")} OS: \`${v.platform}\``
  );
}

function buildDailyReportText() {
  const s = db.getStats();
  const today = new Date().toLocaleDateString("id-ID", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  return (
    `${tge("CHART","📊")} <b>Laporan Harian Bot</b>\n${tge("CALENDAR","📅")} ${today}\n\n` +
    `${tge("USERS","👥")} Total User: *${s.started}*\n` +
    `${tge("DIAMOND_ORANGE","🔶")} Reseller: *${s.resellers}*  •  ${tge("DIAMOND","💎")} Premium: *${s.premiums}*  •  ${tge("STAR2","🌟")} Partner: *${s.partners || 0}*  •  ${tge("CROWN","👑")} Owner: *${s.owners}*\n\n` +
    `${tge("DESKTOP","🖥️")} Total Panel: *${s.totalPanels}*\n` +
    `  ${tge("SUCCESS","✅")} Aktif: *${s.activePanels}*\n` +
    `  ${tge("LOCK","🔒")} Suspended: *${s.suspendedPanels}*\n` +
    `  ${tge("SKULL","💀")} Expired: *${s.expiredPanels}*\n\n` +
    `${tge("ADMISSION","🎟️")} Voucher: ${s.voucherTotal} total (${s.voucherUsed} terpakai)\n` +
    `${tge("SCROLL","📜")} Total Transaksi: ${s.transactions}\n\n` +
    `_Laporan otomatis dikirim setiap pukul ${config.DAILY_REPORT_HOUR}.00_`
  );
}

function sendStats(ctx) { ctx.reply(buildStatsText(), { parse_mode: "HTML", ...backKeyboard() }); }
async function sendStatsEdit(ctx) { return safeEdit(ctx, buildStatsText(), { parse_mode: "HTML", ...backKeyboard() }); }

async function buildNodesText() {
  const targets = config.PTLA2 && config.PTLC2 ? [1, 2] : [1];
  let text = "";
  let total = 0;
  for (const sn of targets) {
    const nodes = await ptero.getNodes(sn);
    text += `${tge("GLOBE","🌐")} <b>${he2(serverLabel(sn))}</b> (${nodes.length} node)\n`;
    if (!nodes.length) { text += `_kosong_\n\n`; continue; }
    for (const n of nodes) {
      const a = n.attributes;
      const ns = await ptero.getNodeStatus(a, sn);
      const status = ns.online ? `${tge("GREEN_DOT","🟢")} Hidup` : `${tge("RED_DOT","🔴")} Mati`;
      const ramUsed = a.allocated_resources?.memory || 0;
      const diskUsed = a.allocated_resources?.disk || 0;
      text += `*${a.name}*\n  Status: ${status}\n  ${tge("FLOPPY","💾")} RAM: ${ramUsed}MB / ${a.memory}MB\n  ${tge("DISK","💿")} Disk: ${diskUsed}MB / ${a.disk}MB\n\n`;
    }
    total += nodes.length;
  }
  if (!total) return `${tge("EMPTY_BOX","📭")} Tidak ada node terdaftar di panel.`;
  return `${tge("DESKTOP","🖥️")} <b>Daftar Node (${total} total):</b>\n\n` + text;
}

async function sendNodes(ctx) {
  const text = await buildNodesText();
  ctx.reply(text, { parse_mode: "HTML", ...backKeyboard() });
}

async function sendNodesEdit(ctx) {
  const text = await buildNodesText();
  return safeEdit(ctx, text, { parse_mode: "HTML", ...backKeyboard() });
}


// ─── Helper: Redeem Code ──────────────────────────────────────────────────────

async function redeemCode(ctx, userId, code) {
  const role = db.getRole(userId);
  const voucher = db.getVoucher(code);
  logger.action("REDEEM", `User:${userId} mencoba redeem kode "${code}"`);
  if (!voucher) {
    logger.warn("REDEEM", `Kode "${code}" tidak ditemukan`);
    return ctx.reply(`${tge("ERROR","❌")} Kode voucher tidak ditemukan.`, mainMenuKeyboard(role));
  }
  if (voucher.used) {
    logger.warn("REDEEM", `Kode "${code}" sudah dipakai sebelumnya`);
    return ctx.reply(`${tge("ERROR","❌")} Kode voucher sudah dipakai.`, mainMenuKeyboard(role));
  }

  db.useVoucher(code, userId);
  clearState(userId);

  if (voucher.type === "discount") {
    // Simpan diskon untuk panel berikutnya
    const s = getState(userId);
    s.discount_pct = voucher.discount;
    logger.action("REDEEM", `User:${userId} sukses redeem voucher DISKON kode="${code}" (${voucher.discount}%)`);
    db.addAuditLog({ actorId: userId, action: "Redeem Voucher Diskon", detail: `${code} | ${voucher.discount}%` });
    const rdPts = (config.POINT_REWARDS || {}).redeem_voucher || 3;
    if (rdPts > 0) db.addPoints(userId, rdPts);
    const newRole = db.getRole(userId);
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Voucher Diskon Berhasil Diaktifkan!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${tge("LABEL","🏷️")} Diskon: *${voucher.discount}%*\n\n_Diskon berlaku untuk pembuatan panel berikutnya!_`,
      { parse_mode: "HTML", ...mainMenuKeyboard(newRole) }
    );
  }

  if (voucher.type === "days") {
    const currentDays = db.getPendingDays(userId);
    db.setPendingDays(userId, currentDays + voucher.days);
    logger.action("REDEEM", `User:${userId} sukses redeem voucher HARI kode="${code}" (+${voucher.days} hari)`);
    db.addAuditLog({ actorId: userId, action: "Redeem Voucher Hari", detail: `${code} | +${voucher.days} hari` });
    const rdPtsH = (config.POINT_REWARDS || {}).redeem_voucher || 3;
    if (rdPtsH > 0) db.addPoints(userId, rdPtsH);

    // Notifikasi ke semua owner agar segera memproses perpanjangan
    const fromName = telegramName(ctx.from);
    const ownerSet = new Set([
      ...config.OWNER_IDS.map(String),
      ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
    ]);
    for (const ownerId of ownerSet) {
      try {
        await bot.telegram.sendMessage(ownerId,
          `${tge("CALENDAR","📅")} <b>Voucher Hari Diredeem!</b>\n\n` +
          `${tge("USER","👤")} User: ${he(fromName)} (\`${userId}\`)\n` +
          `${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n` +
          `${tge("CALENDAR","📅")} Hari bonus: *+${voucher.days} hari*\n` +
          `${tge("CALENDAR","📅")} Total pending days: *${currentDays + voucher.days} hari*\n\n` +
          `Gunakan menu <b>Perpanjang Panel</b> di owner panel untuk menerapkan perpanjangan.`,
          { parse_mode: "HTML" }
        );
      } catch {}
    }

    const totalDays = currentDays + voucher.days;
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Voucher Hari Berhasil Diaktifkan!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${tge("CALENDAR","📅")} Bonus: *+${voucher.days} hari*\n${tge("CALENDAR","📅")} Total tersimpan: *${totalDays} hari*\n\n${tge("HOURGLASS","⏳")} Owner bot akan segera memproses perpanjangan panelmu.\n_Hubungi owner jika belum diproses dalam 1x24 jam._`,
      { parse_mode: "HTML", ...mainMenuKeyboard(db.getRole(userId)) }
    );
  }

  // Default: role voucher
  db.setUserRole(userId, voucher.role);
  const emoji = { reseller: `${tge("DIAMOND_ORANGE","🔶")}`, premium: `${tge("STAR","⭐")}`, owner: `${tge("CROWN","👑")}` }[voucher.role] || `${tge("USER","👤")}`;
  logger.action("REDEEM", `User:${userId} sukses redeem voucher ROLE kode="${code}" → role="${voucher.role}"`);
  db.addAuditLog({ actorId: userId, action: "Redeem Voucher Role", detail: `${code} | ${voucher.role}` });
  const rdPtsR = (config.POINT_REWARDS || {}).redeem_voucher || 3;
  if (rdPtsR > 0) db.addPoints(userId, rdPtsR);
  const newRole = db.getRole(userId);
  return ctx.reply(
    `${tge("SUCCESS","✅")} <b>Voucher berhasil di-redeem!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${emoji} Role baru: *${voucher.role}*`,
    { parse_mode: "HTML", ...mainMenuKeyboard(newRole) }
  );
}

// ─── Message Handler ──────────────────────────────────────────────────────────

bot.on(message("text"), async (ctx, next) => {
  const userId = ctx.from.id;
  const uname  = ctx.from.username ? `@${ctx.from.username}` : ctx.from.first_name || "?";
  const text   = ctx.message?.text?.trim() || "";
  try {
    const role = db.getRole(userId);
    const s    = getState(userId);

    if (!s.step) return next();

    logger.step("INPUT", `User:${userId}(${uname}) step="${s.step}" input="${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);


  // ── Verifikasi PIN ────────────────────────────────────────────────
  if (s.step === "verify_pin") {
    const storedPin = db.getPin(userId);
    if (text !== storedPin) {
      // Suspicious activity tracking (#19) — PIN gagal berturut
      const cnt = db.recordLoginAttempt(`pin_${userId}`);
      if (cnt >= 5) {
        db.recordSuspicious(userId, "PIN_BRUTEFORCE", `${cnt} percobaan PIN gagal dalam 10 menit`);
        // notify owners
        for (const oid of (config.OWNER_IDS || [])) {
          try { await bot.telegram.sendMessage(oid, `${tge("SIREN","🚨")} <b>Suspicious: PIN brute-force</b>\n\nUser: <code>${userId}</code> (@${ctx.from.username || "-"})\nGagal ${cnt}x dalam 10 menit.`, { parse_mode: "HTML" }); } catch {}
        }
      }
      return ctx.reply(`${tge("ERROR","❌")} PIN salah. Coba lagi.${cnt >= 3 ? `\n\n⚠️ <i>Kegagalan ${cnt}x.</i>` : ""}`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
    const originalAction = s.pin_action;
    s.step = null;
    s.pin_action = null;

    // Lanjutkan aksi setelah verifikasi PIN berhasil
    if (originalAction === "delete_server_flow") {
      s.step = "delete_id";
      return ctx.reply(`${tge("SUCCESS","✅")} PIN terverifikasi.\n\n${tge("TRASH","🗑️")} Masukkan <b>ID server</b> yang ingin dihapus:`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
    // Untuk aksi lain (power, reset_pw, backup), ulangi callback
    return ctx.reply(`${tge("SUCCESS","✅")} PIN terverifikasi! Tekan tombol aksi lagi untuk melanjutkan.`, backKeyboard());
  }

  // ── Set PIN ───────────────────────────────────────────────────────
  if (s.step === "set_pin_code") {
    if (!/^\d{4,6}$/.test(text)) return ctx.reply(`${tge("ERROR","❌")} PIN harus 4-6 digit angka.`, cancelKeyboard());
    db.setPin(userId, text);
    db.addAuditLog({ actorId: userId, action: "Set PIN 2FA" });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} PIN berhasil diset!\n${tge("LOCK_KEY","🔐")} PIN kamu: \`${text}\`\n\n_Jangan bagikan PIN ke siapapun!_`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Schedule Cron ─────────────────────────────────────────────────
  if (s.step === "sched_name") {
    s.sched_name = text;
    s.step = "sched_cron";
    return ctx.reply(
      `${tge("CALENDAR","📅")} *Buat Jadwal: ${text}*\n\nMasukkan ekspresi cron dalam format:\n<code>menit jam hari-bulan bulan hari-minggu</code>\n\n_Contoh:_\n• <code>0 0 * * *</code> = setiap tengah malam\n• <code>0 */6 * * *</code> = setiap 6 jam\n• <code>30 8 * * 1</code> = Senin jam 08:30`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  if (s.step === "sched_cron") {
    const parts = text.split(/\s+/);
    if (parts.length !== 5) return ctx.reply(`${tge("ERROR","❌")} Format cron harus 5 bagian. Contoh: <code>0 0 * * *</code>`, { parse_mode: "HTML", ...cancelKeyboard() });
    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
    const serverId = s.sched_server_id;
    const panels = db.getUserPanels(userId);
    const panel = panels.find(p => String(p.server_id) === String(serverId));
    const identifier = panel?.server_identifier;
    if (!identifier) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Identifier tidak ditemukan.`, backKeyboard()); }

    await ctx.reply(`${tge("HOURGLASS","⏳")} Membuat jadwal...`);
    const result = await ptero.createSchedule(identifier, {
      name: s.sched_name, minute, hour, dayOfWeek, dayOfMonth, month, isActive: true,
    }, psn(panel));
    db.addAuditLog({ actorId: userId, action: "Buat Jadwal Cron", target: serverId, detail: `${s.sched_name} | ${text}` });
    clearState(userId);
    if (!result) return ctx.reply(`${tge("ERROR","❌")} Gagal membuat jadwal. Periksa format cron.`, mainMenuKeyboard(role));
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Jadwal Berhasil Dibuat!</b>\n\n${tge("NAME_BADGE","📛")} Nama: *${result.name}*\n${tge("ALARM","⏰")} Cron: \`${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}\`\n${tge("SUCCESS","✅")} Status: Aktif`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Set Role ──────────────────────────────────────────────────────
  if (s.step === "set_role") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    db.setUserRole(targetId, s.set_role);
    db.addAuditLog({ actorId: userId, action: `Set Role ${s.set_role}`, target: String(targetId) });
    const emoji = { reseller: `${tge("DIAMOND_ORANGE","🔶")}`, premium: `${tge("DIAMOND","💎")}`, partner: `🌟`, owner: `${tge("CROWN","👑")}` }[s.set_role] || `${tge("USER","👤")}`;
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil diberi role ${emoji} *${s.set_role}*.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Set Role oleh Premium/Partner ─────────────────────────────────
  if (s.step === "pm_set_reseller_id") {
    const myRole = db.getRole(userId);
    if (!["premium","partner","owner"].includes(myRole)) { clearState(userId); return ctx.reply(`${tge("LOCK","🔒")} Akses ditolak.`); }
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    const curRole = db.getRole(targetId);
    if (["owner","partner","premium"].includes(curRole)) {
      clearState(userId);
      return ctx.reply(`${tge("LOCK","🔒")} User tersebut sudah memiliki role <b>${curRole}</b>. Tidak bisa didowngrade ke reseller.`, { parse_mode: "HTML", ...mainMenuKeyboard(myRole) });
    }
    db.setUserRole(targetId, "reseller");
    db.addAuditLog({ actorId: userId, action: "Set Role reseller (by premium/partner)", target: String(targetId) });
    clearState(userId);
    try { await bot.telegram.sendMessage(targetId, `${tge("DIAMOND_ORANGE","🔶")} <b>Role Kamu Diupdate!</b>\n\nKamu telah diberi role <b>Reseller</b>.\n${tge("PACKAGE","📦")} Kamu bisa membuat panel sesuai limit yang diberikan.`, { parse_mode: "HTML" }); } catch {}
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil diberi role 🔶 <b>Reseller</b>.`, { parse_mode: "HTML", ...mainMenuKeyboard(myRole) });
  }

  if (s.step === "pm_set_premium_id") {
    const myRole = db.getRole(userId);
    if (!["partner","owner"].includes(myRole)) { clearState(userId); return ctx.reply(`${tge("LOCK","🔒")} Akses ditolak.`); }
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    const curRole = db.getRole(targetId);
    if (["owner","partner"].includes(curRole)) {
      clearState(userId);
      return ctx.reply(`${tge("LOCK","🔒")} User tersebut sudah memiliki role <b>${curRole}</b>. Tidak bisa diubah ke premium.`, { parse_mode: "HTML", ...mainMenuKeyboard(myRole) });
    }
    db.setUserRole(targetId, "premium");
    db.addAuditLog({ actorId: userId, action: "Set Role premium (by partner)", target: String(targetId) });
    clearState(userId);
    try { await bot.telegram.sendMessage(targetId, `${tge("DIAMOND","💎")} <b>Role Kamu Diupdate!</b>\n\nKamu telah diberi role <b>Premium</b>.\n${tge("STAR","⭐")} Nikmati akses buat Admin Panel dan fitur premium lainnya!`, { parse_mode: "HTML" }); } catch {}
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil diberi role 💎 <b>Premium</b>.`, { parse_mode: "HTML", ...mainMenuKeyboard(myRole) });
  }

  if (s.step === "pm_limit_id") {
    const myRole = db.getRole(userId);
    if (!["premium","partner","owner"].includes(myRole)) { clearState(userId); return ctx.reply(`${tge("LOCK","🔒")} Akses ditolak.`); }
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    const targetRole = db.getRole(targetId);
    if (targetRole !== "reseller") return ctx.reply(`${tge("ERROR","❌")} User \`${targetId}\` bukan reseller.`, { parse_mode: "HTML", ...cancelKeyboard() });
    s.pm_limit_target = targetId;
    s.step = "pm_limit_count";
    return ctx.reply(`${tge("PACKAGE","📦")} Masukkan <b>jumlah slot</b> limit panel untuk reseller \`${targetId}\`:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (s.step === "pm_limit_count") {
    const count = parseInt(text);
    if (isNaN(count) || count < 0) return ctx.reply(`${tge("ERROR","❌")} Jumlah tidak valid (harus angka ≥ 0).`, cancelKeyboard());
    s.pm_limit_count = count;
    s.step = "pm_limit_expire";
    return ctx.reply(`${tge("CALENDAR","📅")} Masukkan <b>tanggal kadaluarsa</b> limit (format: YYYY-MM-DD)\nAtau ketik <b>tidak</b> jika tanpa batas waktu:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (s.step === "pm_limit_expire") {
    const myRole = db.getRole(userId);
    const targetId = s.pm_limit_target;
    const count = s.pm_limit_count;
    let expireDate = null;
    if (text.toLowerCase() !== "tidak") {
      const d = new Date(text);
      if (isNaN(d.getTime())) return ctx.reply(`${tge("ERROR","❌")} Format tanggal tidak valid. Gunakan YYYY-MM-DD atau ketik 'tidak':`, cancelKeyboard());
      expireDate = d.toISOString();
    }
    db.setResellerLimit(targetId, count, expireDate, userId);
    db.addAuditLog({ actorId: userId, action: "Set Limit Reseller (by premium/partner)", target: String(targetId), detail: `${count} slot | exp: ${expireDate ? expireDate.slice(0,10) : "Selamanya"}` });
    clearState(userId);
    try {
      await bot.telegram.sendMessage(targetId,
        `${tge("PACKAGE","📦")} <b>Limit Panel Diupdate!</b>\n\n${tge("SUCCESS","✅")} Slot baru: *${count}*\n${tge("ALARM","⏰")} Berlaku: ${expireDate ? formatDate(expireDate) : "Selamanya"}\n\nKamu sudah bisa membuat panel sesuai limit.`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return ctx.reply(
      `${tge("SUCCESS","✅")} Limit reseller \`${targetId}\` diset:\n${tge("PACKAGE","📦")} Slot: *${count}*\n${tge("ALARM","⏰")} Exp: ${expireDate ? formatDate(expireDate) : "Selamanya"}`,
      { parse_mode: "HTML", ...mainMenuKeyboard(myRole) }
    );
  }

  // ── Reset Role ────────────────────────────────────────────────────
  if (s.step === "reset_role_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    db.resetRole(targetId);
    db.addAuditLog({ actorId: userId, action: "Reset Role", target: String(targetId) });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} Role user \`${targetId}\` direset ke <b>User Biasa</b>.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Blacklist / Unblacklist ───────────────────────────────────────
  if (s.step === "blacklist_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    db.blacklistUser(targetId);
    db.addAuditLog({ actorId: userId, action: "Blacklist User", target: String(targetId) });
    clearState(userId);
    return ctx.reply(`${tge("PROHIBITED","🚫")} User \`${targetId}\` berhasil di-blacklist.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  if (s.step === "unblacklist_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    db.unblacklistUser(targetId);
    db.addAuditLog({ actorId: userId, action: "Unblacklist User", target: String(targetId) });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil di-unblacklist.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Search User ───────────────────────────────────────────────────
  if (s.step === "search_user_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    clearState(userId);
    const targetRole = db.getRole(targetId);
    const targetCount = db.getPanelCount(targetId);
    const targetPanels = db.getUserPanels(targetId);
    const pin = db.getPin(targetId);
    let info = `${tge("SEARCH","🔎")} *Info User \`${targetId}\`*\n\n${tge("BOT","🤖")} Start Bot: ${db.hasStarted(targetId) ? `${tge("SUCCESS","✅")}` : `${tge("ERROR","❌")}`}\n${tge("MASK","🎭")} Role: ${roleLabel(targetRole)}\n${tge("PROHIBITED","🚫")} Blacklist: ${db.isBlacklisted(targetId) ? "Ya" : "Tidak"}\n${tge("DESKTOP","🖥️")} Total Panel: ${targetCount}\n${tge("LOCK_KEY","🔐")} PIN: ${pin ? `${tge("SUCCESS","✅")} Set` : `${tge("ERROR","❌")} Tidak`}`;
    if (targetRole === "reseller") {
      const limObj = db.getResellerLimit(targetId);
      if (limObj) {
        const exp = limObj.expire_date ? new Date(limObj.expire_date) : null;
        const isExpired = exp && exp < new Date();
        info += `\n${tge("PACKAGE","📦")} Limit: ${limObj.count} slot ${isExpired ? `${tge("RED_DOT","🔴")} Kadaluarsa` : exp ? `(exp: ${formatDate(limObj.expire_date)})` : "(Selamanya)"}`;
      } else {
        info += `\n${tge("PACKAGE","📦")} Limit: Belum diset`;
      }
    }
    if (targetPanels.length) {
      info += `\n\n${tge("LIST","📋")} <b>Panel:</b>\n`;
      targetPanels.forEach((p) => {
        const dl = daysLeft(p.expire_date);
        info += `• \`${p.server_id}\` — ${p.name || "N/A"}${dl !== null ? (dl <= 0 ? ` ${tge("RED_DOT","🔴")}` : ` ${tge("GREEN_DOT","🟢")}${dl}hr`) : ""}\n`;
      });
    }
    return ctx.reply(info, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Statistik User (step) ─────────────────────────────────────────
  if (s.step === "user_stats_id") {
    const targetId = text.trim();
    if (!/^\d+$/.test(targetId)) return ctx.reply(`${tge("ERROR","❌")} Format Telegram ID tidak valid (harus angka).`, cancelKeyboard());
    clearState(userId);
    const u = db.getUser(targetId);
    if (!u) return ctx.reply(`${tge("ERROR","❌")} User \`${targetId}\` belum terdaftar di bot.`, { parse_mode: "HTML", ...backKeyboard() });
    const panels = db.getUserPanels(targetId);
    const active    = panels.filter(p => !p.expired && !p.suspended && daysLeft(p.expire_date) > 0).length;
    const suspended = panels.filter(p => p.suspended).length;
    const expired   = panels.filter(p => p.expired || (daysLeft(p.expire_date) !== null && daysLeft(p.expire_date) <= 0)).length;
    const pending   = db.getPendingDays(targetId);
    const refStats  = db.getReferralStats(targetId);
    const lim       = db.getResellerLimit(targetId);
    const limText   = lim
      ? `${tge("PACKAGE","📦")} ${lim.count} slot | ${tge("ALARM","⏰")} ${lim.expire_date ? formatDate(lim.expire_date) : "Selamanya"}`
      : "—";
    const txs = db.getUserTransactions(targetId, 5);
    let txText = txs.length ? txs.map(t => `• ${t.type}: ${t.detail}`).join("\n") : "— belum ada —";
    const pts = db.getPoints(targetId);
    const info =
      `${tge("CHART","📊")} <b>Statistik User</b>\n\n` +
      `${tge("USER","👤")} ID: \`${targetId}\`\n` +
      `${tge("MASK","🎭")} Role: ${roleLabel(u.role)}\n` +
      `${tge("PROHIBITED","🚫")} Blacklisted: ${u.blacklisted ? "Ya" : "Tidak"}\n` +
      `${tge("STAR","⭐")} Poin: *${pts}*\n\n` +
      `━━━━ ${tge("DESKTOP","🖥️")} Panel ━━━━\n` +
      `${tge("PACKAGE","📦")} Total: *${panels.length}* panel\n` +
      `${tge("GREEN_DOT","🟢")} Aktif: *${active}* | ${tge("LOCK","🔒")} Suspended: *${suspended}* | ${tge("RED_DOT","🔴")} Expired: *${expired}*\n` +
      `${tge("CALENDAR","📅")} Pending days: *${pending} hari*\n\n` +
      `━━━━ ${tge("PACKAGE","📦")} Reseller Limit ━━━━\n${limText}\n\n` +
      `━━━━ ${tge("SCROLL","📜")} 5 Transaksi Terakhir ━━━━\n${txText}`;
    return ctx.reply(info, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Simpan Nama Template ─────────────────────────────────────────
  if (s.step === "save_tpl_name_input") {
    if (!isOwner(userId)) return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`);
    const tplName = text.trim().slice(0, 40);
    if (!tplName) return ctx.reply(`${tge("ERROR","❌")} Nama template tidak boleh kosong.`);
    const payload = s.pending_tpl_payload;
    if (!payload) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Data template hilang.`, backKeyboard()); }
    let cfg;
    try { cfg = JSON.parse(payload); } catch { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Data template tidak valid.`, backKeyboard()); }
    clearState(userId);
    db.saveTemplate(tplName, cfg);
    db.addAuditLog({ actorId: userId, action: "Simpan Template", detail: tplName });
    return ctx.reply(`${tge("SUCCESS","✅")} Template *${he(tplName)}* berhasil disimpan!\n\nTemplate bisa dipilih saat user buat panel baru melalui menu Template.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Whitelist Add/Remove ───────────────────────────────────────────
  if (s.step === "wl_add_id") {
    const targetId = text.trim();
    if (!/^\d+$/.test(targetId)) return ctx.reply(`${tge("ERROR","❌")} Format Telegram ID tidak valid (harus angka).`, cancelKeyboard());
    clearState(userId);
    db.addToWhitelist(targetId);
    db.addAuditLog({ actorId: userId, action: "Whitelist Add", detail: `User ${targetId}` });
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil ditambah ke whitelist.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (s.step === "wl_remove_id") {
    const targetId = text.trim();
    if (!/^\d+$/.test(targetId)) return ctx.reply(`${tge("ERROR","❌")} Format Telegram ID tidak valid (harus angka).`, cancelKeyboard());
    clearState(userId);
    db.removeFromWhitelist(targetId);
    db.addAuditLog({ actorId: userId, action: "Whitelist Remove", detail: `User ${targetId}` });
    return ctx.reply(`${tge("SUCCESS","✅")} User \`${targetId}\` berhasil dihapus dari whitelist.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Jadwal Maintenance Input ────────────────────────────────────────
  if (s.step === "schm_time_input") {
    const m = text.trim().match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!m) return ctx.reply(`${tge("ERROR","❌")} Format salah. Gunakan: <code>HH:MM-HH:MM</code>\nContoh: <code>02:00-04:00</code>`, { parse_mode: "HTML", ...cancelKeyboard() });
    clearState(userId);
    db.setScheduledMaintenance({ start: m[1], end: m[2] });
    db.addAuditLog({ actorId: userId, action: "Set Jadwal Maintenance", detail: `${m[1]}–${m[2]}` });
    return ctx.reply(`${tge("SUCCESS","✅")} Waktu maintenance diset: *${m[1]} – ${m[2]}*`, { parse_mode: "HTML", ...backKeyboard() });
  }

  if (s.step === "schm_msg_input") {
    clearState(userId);
    db.setScheduledMaintenance({ message: text.trim() });
    db.addAuditLog({ actorId: userId, action: "Set Pesan Maintenance" });
    return ctx.reply(`${tge("SUCCESS","✅")} Pesan maintenance diperbarui.`, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Cari Panel ────────────────────────────────────────────────────
  if (s.step === "search_panel_query") {
    if (!isOwner(userId)) return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`);
    clearState(userId);
    const query = text.trim().toLowerCase();
    const allPanels = db.getAllPanels();
    const results = allPanels.filter(p =>
      String(p.userId) === query ||
      String(p.server_id) === query ||
      (p.server_identifier || "").toLowerCase().includes(query) ||
      (p.name || "").toLowerCase().includes(query)
    ).slice(0, 10);
    if (!results.length) return ctx.reply(`${tge("SEARCH","🔍")} Tidak ditemukan panel dengan kata kunci: *${he(text.trim())}*`, { parse_mode: "HTML", ...backKeyboard() });
    let out = `${tge("SEARCH","🔎")} *Hasil Pencarian: "${he(text.trim())}"*\nDitemukan: *${results.length}* panel\n\n`;
    for (const p of results) {
      const status = p.suspended ? `${tge("LOCK","🔒")} Suspended` : p.expired ? `${tge("RED_DOT","🔴")} Expired` : `${tge("GREEN_DOT","🟢")} Aktif`;
      const sisa   = daysLeft(p.expire_date);
      out += `${tge("PACKAGE","📦")} *${he(p.name || "?")}*\n`;
      out += `   ${tge("USER","👤")} Owner: \`${p.userId}\`\n`;
      out += `   ${tge("ID_CARD","🆔")} Server: \`${p.server_identifier || p.server_id || "?"}\`\n`;
      out += `   ${tge("CHART","📊")} Status: ${status}\n`;
      out += `   ${tge("HOURGLASS","⏳")} Sisa: ${sisa !== null ? `${sisa} hari` : "—"}\n\n`;
    }
    return ctx.reply(out, { parse_mode: "HTML", ...backKeyboard() });
  }

  // ── Bulk Aksi Panel (step) ─────────────────────────────────────────
  if (s.step === "bulk_action_id") {
    const targetId = text.trim();
    if (!/^\d+$/.test(targetId)) return ctx.reply(`${tge("ERROR","❌")} Format Telegram ID tidak valid.`, cancelKeyboard());
    const u = db.getUser(targetId);
    if (!u) return ctx.reply(`${tge("ERROR","❌")} User \`${targetId}\` belum terdaftar di bot.`, { parse_mode: "HTML", ...cancelKeyboard() });
    const panels = db.getUserPanels(targetId);
    clearState(userId);
    if (!panels.length) return ctx.reply(`${tge("ERROR","❌")} User \`${targetId}\` tidak punya panel.`, { parse_mode: "HTML", ...backKeyboard() });
    return ctx.reply(
      `${tge("LIGHTNING","⚡")} <b>Bulk Aksi Panel</b>\n\n${tge("USER","👤")} User: \`${targetId}\`\n${tge("MASK","🎭")} Role: ${roleLabel(u.role)}\n${tge("PACKAGE","📦")} Total panel: *${panels.length}*\n\nPilih aksi yang ingin dilakukan ke <b>semua panel</b> user ini:`,
      { parse_mode: "HTML", ...bulkActionKeyboard(targetId) }
    );
  }

  // ── Set Reseller Limit ────────────────────────────────────────────
  if (s.step === "set_limit_id") {
    const targetId = parseInt(text);
    if (isNaN(targetId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    const targetRole = db.getRole(targetId);
    if (targetRole !== "reseller") return ctx.reply(`${tge("ERROR","❌")} User \`${targetId}\` bukan reseller.`, { parse_mode: "HTML", ...cancelKeyboard() });
    s.limit_target_id = targetId;
    s.step = "set_limit_count";
    return ctx.reply(`${tge("PACKAGE","📦")} Masukkan <b>jumlah slot</b> limit panel untuk reseller \`${targetId}\`:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (s.step === "set_limit_count") {
    const count = parseInt(text);
    if (isNaN(count) || count < 0) return ctx.reply(`${tge("ERROR","❌")} Jumlah tidak valid (harus angka ≥ 0).`, cancelKeyboard());
    s.limit_count = count;
    s.step = "set_limit_expire";
    return ctx.reply(
      `${tge("CALENDAR","📅")} Masukkan <b>tanggal kadaluarsa</b> limit (format: YYYY-MM-DD)\nAtau ketik <b>tidak</b> jika tanpa batas waktu:`,
      { parse_mode: "HTML", ...cancelKeyboard() }
    );
  }

  if (s.step === "set_limit_expire") {
    const targetId = s.limit_target_id;
    const count = s.limit_count;
    let expireDate = null;
    if (text.toLowerCase() !== "tidak") {
      const d = new Date(text);
      if (isNaN(d.getTime())) return ctx.reply(`${tge("ERROR","❌")} Format tanggal tidak valid. Gunakan YYYY-MM-DD atau ketik 'tidak':`, cancelKeyboard());
      expireDate = d.toISOString();
    }
    db.setResellerLimit(targetId, count, expireDate, userId);
    db.addAuditLog({ actorId: userId, action: "Set Limit Reseller", target: String(targetId), detail: `${count} slot | exp: ${expireDate ? expireDate.slice(0,10) : "Selamanya"}` });
    clearState(userId);
    try {
      await bot.telegram.sendMessage(targetId,
        `${tge("PACKAGE","📦")} <b>Limit Panel Diupdate!</b>\n\n${tge("SUCCESS","✅")} Slot baru: *${count}*\n${tge("ALARM","⏰")} Berlaku: ${expireDate ? formatDate(expireDate) : "Selamanya"}\n\nKamu sudah bisa membuat panel sesuai limit.`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return ctx.reply(
      `${tge("SUCCESS","✅")} Limit reseller \`${targetId}\` diset:\n${tge("PACKAGE","📦")} Slot: *${count}*\n${tge("ALARM","⏰")} Exp: ${expireDate ? formatDate(expireDate) : "Selamanya"}`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Discount Voucher ──────────────────────────────────────────────
  if (s.step === "discount_pct") {
    const pct = parseInt(text);
    if (isNaN(pct) || pct < 1 || pct > 100) return ctx.reply(`${tge("ERROR","❌")} Masukkan angka 1-100.`, cancelKeyboard());
    const code = generateVoucherCode();
    db.createVoucher("discount", { discount: pct, code, maxUses: 1 });
    db.addAuditLog({ actorId: userId, action: "Buat Voucher Diskon", detail: `${code} | ${pct}%` });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} <b>Voucher Diskon Dibuat!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${tge("LABEL","🏷️")} Diskon: *${pct}%*\n\n/redeem ${code}`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Day Voucher ───────────────────────────────────────────────────
  if (s.step === "day_voucher_count") {
    const days = parseInt(text);
    if (isNaN(days) || days < 1) return ctx.reply(`${tge("ERROR","❌")} Jumlah hari tidak valid.`, cancelKeyboard());
    const code = generateVoucherCode();
    db.createVoucher("days", { days, code, maxUses: 1 });
    db.addAuditLog({ actorId: userId, action: "Buat Voucher Hari", detail: `${code} | +${days} hari` });
    clearState(userId);
    return ctx.reply(`${tge("SUCCESS","✅")} <b>Voucher Hari Dibuat!</b>\n\n${tge("ADMISSION","🎟️")} Kode: \`${code}\`\n${tge("CALENDAR","📅")} Bonus: *+${days} hari*\n\n/redeem ${code}`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Redeem Code ───────────────────────────────────────────────────
  if (s.step === "redeem_code") {
    clearState(userId);
    return redeemCode(ctx, userId, text.toUpperCase());
  }

  // ── Delete Server ─────────────────────────────────────────────────
  if (s.step === "delete_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, mainMenuKeyboard(role));
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Menghapus server \`${serverId}\`...`, { parse_mode: "HTML" });
    const found = db.getPanelByServerId(serverId);
    const ok = await ptero.deleteServer(serverId, srvOf(serverId, s));
    if (ok) {
      if (found) db.deletePanelRecord(found.ownerUserId, serverId);
      db.addAuditLog({ actorId: userId, action: "Hapus Server", target: String(serverId) });
    }
    return ctx.reply(ok ? `${tge("SUCCESS","✅")} Server \`${serverId}\` berhasil dihapus.` : `${tge("ERROR","❌")} Gagal menghapus server \`${serverId}\`.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Suspend / Unsuspend / Reinstall ───────────────────────────────
  if (s.step === "suspend_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Suspend server \`${serverId}\`...`, { parse_mode: "HTML" });
    const ok = await ptero.suspendServer(serverId, srvOf(serverId, s));
    if (ok) db.addAuditLog({ actorId: userId, action: "Suspend Server", target: String(serverId) });
    return ctx.reply(ok ? `${tge("LOCK","🔒")} Server \`${serverId}\` disuspend.` : `${tge("ERROR","❌")} Gagal suspend.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  if (s.step === "unsuspend_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Unsuspend server \`${serverId}\`...`, { parse_mode: "HTML" });
    const ok = await ptero.unsuspendServer(serverId, srvOf(serverId, s));
    if (ok) db.addAuditLog({ actorId: userId, action: "Unsuspend Server", target: String(serverId) });
    return ctx.reply(ok ? `${tge("UNLOCK","🔓")} Server \`${serverId}\` di-unsuspend.` : `${tge("ERROR","❌")} Gagal unsuspend.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  if (s.step === "reinstall_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Reinstall server \`${serverId}\`...`, { parse_mode: "HTML" });
    const ok = await ptero.reinstallServer(serverId, srvOf(serverId, s));
    if (ok) db.addAuditLog({ actorId: userId, action: "Reinstall Server", target: String(serverId) });
    return ctx.reply(ok ? `${tge("REFRESH","🔄")} Server \`${serverId}\` di-reinstall.` : `${tge("ERROR","❌")} Gagal reinstall.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Reset Password Panel ──────────────────────────────────────────
  if (s.step === "reset_pw_new") {
    if (text.length < 8) return ctx.reply(`${tge("ERROR","❌")} Password minimal 8 karakter.`, cancelKeyboard());
    const serverId = s.reset_pw_server_id;
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Mereset password...`);
    const _ns = srvOf(serverId, s);
    const srv = await ptero.getServer(serverId, _ns);
    if (!srv) return ctx.reply(`${tge("ERROR","❌")} Server tidak ditemukan.`, mainMenuKeyboard(role));
    const ok = await ptero.resetUserPassword(srv.user, text, _ns);
    if (ok) db.addAuditLog({ actorId: userId, action: "Reset Password Panel", target: String(serverId) });
    return ctx.reply(
      ok ? `${tge("SUCCESS","✅")} Password panel berhasil direset!\n${tge("KEY","🔑")} Password baru: \`${text}\`\n\n${tge("WARNING","⚠️")} Simpan password ini!` : `${tge("ERROR","❌")} Gagal reset password.`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Rename Server ─────────────────────────────────────────────────
  if (s.step === "rename_srv_new") {
    if (text.length < 2) return ctx.reply(`${tge("ERROR","❌")} Nama minimal 2 karakter.`, cancelKeyboard());
    const serverId = s.rename_srv_id;
    clearState(userId);
    await ctx.reply(`${tge("HOURGLASS","⏳")} Mengganti nama server...`);
    const ok = await ptero.renameServer(serverId, text, srvOf(serverId, s));
    if (ok) {
      const found = db.getPanelByServerId(serverId);
      if (found) db.updatePanelName(found.ownerUserId, serverId, text);
      db.addAuditLog({ actorId: userId, action: "Rename Server", target: String(serverId), detail: text });
    }
    return ctx.reply(
      ok ? `${tge("SUCCESS","✅")} Server berhasil diganti nama menjadi *${text}*.` : `${tge("ERROR","❌")} Gagal mengganti nama server.`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Extend Panel ──────────────────────────────────────────────────
  if (s.step === "extend_server_id") {
    const serverId = parseInt(text);
    if (isNaN(serverId)) return ctx.reply(`${tge("ERROR","❌")} ID tidak valid.`, cancelKeyboard());
    s.extend_server_id = serverId;
    s.step = "extend_days";
    return ctx.reply(`${tge("SPIRAL_CAL","🗓️")} Server ID: \`${serverId}\`\n\nMasukkan <b>jumlah hari</b> perpanjangan:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (s.step === "extend_days") {
    const days = parseInt(text);
    if (isNaN(days) || days < 1) return ctx.reply(`${tge("ERROR","❌")} Jumlah hari tidak valid.`, cancelKeyboard());
    const serverId = s.extend_server_id;
    const found = db.getPanelByServerId(serverId);
    if (!found) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Server tidak ditemukan di database.`, mainMenuKeyboard(role)); }
    db.extendPanel(found.ownerUserId, serverId, days);
    db.addAuditLog({ actorId: userId, action: "Perpanjang Panel", target: String(serverId), detail: `+${days} hari` });
    // Reward poin ke owner panel yang diperpanjang
    const exPts = (config.POINT_REWARDS || {}).extend_panel || 2;
    if (exPts > 0) db.addPoints(found.ownerUserId, exPts);
    clearState(userId);
    const newPanel = db.getUserPanels(found.ownerUserId).find(p => String(p.server_id) === String(serverId));
    const newExpDate = newPanel ? formatDate(newPanel.expire_date) : "N/A";
    // Sync description baru ke Pterodactyl
    ptero.updateServerDescription(serverId, `Aktif hingga: ${newExpDate} | Paket: ${newPanel?.plan_name || "Standard"}`, srvOf(serverId, s)).catch(() => {});
    try {
      await bot.telegram.sendMessage(found.ownerUserId,
        `${tge("SPIRAL_CAL","🗓️")} <b>Panel Kamu Diperpanjang!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${newPanel?.name || serverId}\`\n${tge("CALENDAR","📅")} Expired baru: *${newExpDate}*\n${tge("PLUS","➕")} Diperpanjang: *${days} hari*`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return ctx.reply(`${tge("SUCCESS","✅")} Panel \`${serverId}\` diperpanjang *${days} hari*.\n${tge("CALENDAR","📅")} Expired baru: *${newExpDate}*`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Transfer Panel (owner input user ID tujuan) ───────────────────
  if (s.step === "transfer_pan_uid") {
    if (!isOwner(userId)) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`, backKeyboard()); }
    const toUserId = text.trim();
    if (!/^\d+$/.test(toUserId)) return ctx.reply(`${tge("ERROR","❌")} Format User ID tidak valid. Masukkan angka Telegram ID.`, cancelKeyboard());
    const serverId = s.transfer_server_id;
    const found = db.getPanelByServerId(serverId);
    if (!found) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Panel tidak ditemukan di database.`, mainMenuKeyboard(role)); }
    const fromUserId = found.ownerUserId;
    if (String(toUserId) === String(fromUserId)) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} User tujuan sama dengan pemilik saat ini.`, mainMenuKeyboard(role)); }
    const toUser = db.getUser(toUserId);
    if (!toUser) return ctx.reply(`${tge("ERROR","❌")} User ID \`${toUserId}\` belum terdaftar di bot.`, { parse_mode: "HTML", ...cancelKeyboard() });
    const _ts = srvOf(serverId, s);
    const srv = await ptero.getServer(serverId, _ts);
    const panelRec = db.getUserPanels(fromUserId).find(p => String(p.server_id) === String(serverId));
    if (toUser.ptero_id) {
      await ptero.changeServerUser(serverId, toUser.ptero_id, _ts);
    }
    const transferred = db.transferPanel(fromUserId, toUserId, serverId);
    if (!transferred) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Gagal memindahkan data panel.`, mainMenuKeyboard(role)); }
    db.addAuditLog({ actorId: userId, action: "Transfer Panel", target: String(serverId), detail: `${fromUserId} → ${toUserId}` });
    clearState(userId);
    try {
      await bot.telegram.sendMessage(fromUserId,
        `${tge("REFRESH","🔄")} <b>Panel Kamu Dipindahkan!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panelRec?.name || serverId}\`\n${tge("ID_CARD","🆔")} ID: \`${serverId}\`\n\nPanel telah ditransfer ke pengguna lain oleh owner.`,
        { parse_mode: "HTML" }
      );
    } catch {}
    try {
      await bot.telegram.sendMessage(toUserId,
        `${tge("GIFT","🎁")} <b>Panel Baru Diterima!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panelRec?.name || serverId}\`\n${tge("ID_CARD","🆔")} ID: \`${serverId}\`\n${tge("CALENDAR","📅")} Expired: *${formatDate(panelRec?.expire_date || "")}*\n\nPanel telah ditransfer ke akun kamu oleh owner.`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Panel Berhasil Ditransfer!</b>\n\n${tge("ID_CARD","🆔")} Server: \`${serverId}\`\n${tge("USER","👤")} Dari: \`${fromUserId}\`\n${tge("USER","👤")} Ke: \`${toUserId}\``,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Auto Backup Interval Input ────────────────────────────────────
  if (s.step === "auto_backup_interval") {
    if (!isOwner(userId)) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`, backKeyboard()); }
    const hours = parseInt(text.trim());
    if (isNaN(hours) || hours < 1 || hours > 168) {
      return ctx.reply(`${tge("ERROR","❌")} Interval tidak valid. Masukkan angka antara *1–168* jam.`, { parse_mode: "HTML", ...cancelKeyboard() });
    }
    clearState(userId);
    db.setAutoBackup({ interval_hours: hours });
    const ab = db.getAutoBackup();
    db.addAuditLog({ actorId: userId, action: "Set Auto Backup Interval", detail: `${hours} jam` });
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Interval Auto Backup Diperbarui!</b>\n\n${tge("CLOCK","⏱️")} Backup akan berjalan setiap *${hours} jam* sekali.`,
      { parse_mode: "HTML", ...autoBackupKeyboard(ab) }
    );
  }

  // ── Broadcast ─────────────────────────────────────────────────────
  if (s.step === "broadcast_text") {
    const broadcastMsg = text;
    clearState(userId);
    const users = db.getAllStartedUsers();
    await ctx.reply(`${tge("LOUDSPEAKER","📢")} Broadcast ke *${users.length}* user...`, { parse_mode: "HTML" });
    let sent = 0, failed = 0;
    for (const uid of users) {
      try {
        await bot.telegram.sendMessage(uid, `${tge("LOUDSPEAKER","📢")} <b>Pesan dari Admin</b>\n\n${broadcastMsg}`, { parse_mode: "HTML" });
        sent++;
        await new Promise(r => setTimeout(r, 50));
      } catch { failed++; }
    }
    db.addAuditLog({ actorId: userId, action: "Broadcast", detail: `${sent} terkirim, ${failed} gagal` });
    return ctx.reply(`${tge("SUCCESS","✅")} Broadcast selesai!\n${tge("ENVELOPE","✉️")} Terkirim: *${sent}*\n${tge("ERROR","❌")} Gagal: *${failed}*`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Maintenance Message ───────────────────────────────────────────
  if (s.step === "maintenance_msg") {
    const msg = text;
    clearState(userId);
    db.setMaintenanceMode(true, msg);
    db.addAuditLog({ actorId: userId, action: "Aktifkan Maintenance", detail: msg });
    return ctx.reply(`${tge("WRENCH","🔧")} <b>Maintenance Mode Diaktifkan!</b>\n\nPesan: "${msg}"`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Clone Panel Username ───────────────────────────────────────────

  // ── Tiket Subject ─────────────────────────────────────────────────
  if (s.step === "tkt_subject") {
    if (text.length < 5) return ctx.reply(`${tge("ERROR","❌")} Subjek terlalu pendek (minimal 5 karakter).`, cancelKeyboard());
    s.tkt_subject = text;
    s.step = "tkt_message";
    return ctx.reply(`${tge("TICKET","🎫")} *Tiket: ${text}*\n\nTulis <b>detail masalah/pertanyaan</b> kamu:`, { parse_mode: "HTML", ...cancelKeyboard() });
  }

  if (s.step === "tkt_message") {
    if (text.length < 10) return ctx.reply(`${tge("ERROR","❌")} Pesan terlalu pendek (minimal 10 karakter).`, cancelKeyboard());
    const tktId = db.addTicket(userId, { subject: s.tkt_subject, message: text });
    clearState(userId);
    notifyOwners2(`${tge("TICKET","🎫")} <b>Tiket Baru!</b>\n\n${tge("USER","👤")} User: \`${userId}\`\n${tge("PIN","📌")} Subjek: *${s.tkt_subject || text.slice(0,30)}*\n${tge("MEMO","📝")} Pesan: ${text.slice(0,100)}${text.length > 100 ? "..." : ""}`);
    return ctx.reply(
      `${tge("SUCCESS","✅")} <b>Tiket Berhasil Dibuat!</b>\n\n${tge("TICKET","🎫")} ID: \`${tktId.slice(-6)}\`\n${tge("PIN","📌")} Subjek: *${s.tkt_subject || "-"}*\n\nOwner akan membalas secepatnya.`,
      { parse_mode: "HTML", ...mainMenuKeyboard(role) }
    );
  }

  // ── Tiket Reply (User) ────────────────────────────────────────────
  if (s.step === "tkt_reply") {
    const repTicketId = s.reply_ticket_id;
    const myTkts2 = db.getUserTickets(userId);
    const repTkt = myTkts2.find(t => t.id.endsWith(repTicketId));
    if (!repTkt || repTkt.status !== "open") {
      clearState(userId);
      return ctx.reply(`${tge("ERROR","❌")} Tiket tidak ditemukan atau sudah ditutup.`, backKeyboard());
    }
    db.addTicketReply(repTkt.id, { fromId: userId, message: text, isOwner: false });
    clearState(userId);
    notifyOwners2(`${tge("SPEECH","💬")} *Balasan Tiket #${repTkt.id.slice(-6)}*\n\n${tge("USER","👤")} User: \`${userId}\`\n${tge("PIN","📌")} Subjek: ${repTkt.subject}\n${tge("MEMO","📝")} Balasan: ${text.slice(0,100)}`);
    return ctx.reply(`${tge("SUCCESS","✅")} Balasan terkirim!\n\nOwner akan merespons secepatnya.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }

  // ── Tiket Reply (Owner) ───────────────────────────────────────────
  if (s.step === "otkt_reply") {
    if (!isOwner(userId)) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Hanya Owner.`, backKeyboard()); }
    const repTicketId2 = s.reply_ticket_id;
    const allTkts4 = db.getAllTickets(50);
    const repTkt2 = allTkts4.find(t => t.id.endsWith(repTicketId2));
    if (!repTkt2) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Tiket tidak ditemukan.`, backKeyboard()); }
    db.addTicketReply(repTkt2.id, { fromId: userId, message: text, isOwner: true });
    clearState(userId);
    try {
      await bot.telegram.sendMessage(repTkt2.userId,
        `${tge("SPEECH","💬")} *Balasan Owner — Tiket #${repTkt2.id.slice(-6)}*\n\n${tge("PIN","📌")} Subjek: ${repTkt2.subject}\n\n${tge("CROWN","👑")} Owner: ${text}`,
        { parse_mode: "HTML" }
      );
    } catch {}
    return ctx.reply(`${tge("SUCCESS","✅")} Balasan terkirim ke user \`${repTkt2.userId}\`.`, { parse_mode: "HTML", ...mainMenuKeyboard(role) });
  }


  // ── Panel Creation — Username Step ────────────────────────────────
  // ── Template-based panel: hanya input username lalu langsung konfirmasi ──
  if (s.step === "panel_username") {
    s.username = text.toLowerCase().replace(/\s+/g, "_");
    s.email    = generateEmail(s.username);
    s.password = generatePassword();
    try {
      await bot.telegram.sendMessage(userId,
        `${tge("LOCK_KEY","🔐")} <b>Info Akun Panel Kamu</b>\n\n${tge("USER","👤")} Username: \`${s.username}\`\n${tge("EMAIL","📧")} Email: \`${s.email}\`\n${tge("KEY","🔑")} Password: \`${s.password}\`\n\n_Simpan sebelum panel selesai dibuat!_`,
        { parse_mode: "HTML" }
      );
    } catch (_) {}
    // Fetch egg dari pterodactyl untuk ambil docker_image, startup, env
    let eggData;
    try {
      const eggs = await ptero.getEggs(s.nest_id, s.server_num || 1);
      eggData = eggs.find(e => String(e.attributes?.id || e.id) === String(s.egg_id));
    } catch (_) {}
    if (eggData) {
      s.docker_image = eggData.attributes?.docker_image || eggData.docker_image || "";
      s.startup      = eggData.attributes?.startup || eggData.startup || "";
      s.environment  = buildEnvFromEgg(eggData);
    } else {
      s.environment = {};
    }
    // Fallback nest_name dari template
    s.nest_name = s.template?.nest_name || s.nest_name || String(s.nest_id);
    const plan = s.plan || config.RESOURCE_PLANS[0];
    s.plan_name = plan.name;
    s.ram = plan.ram; s.disk = plan.disk; s.cpu = plan.cpu;
    s.step = "confirm_panel";
    return ctx.reply(
      `${tge("SUCCESS","✅")} Username *${s.username}* diterima!\n\n` +
      `${tge("LIST","📋")} *Konfigurasi Panel (Template: ${s.template?.name || "?"})*\n` +
      `${tge("EGG","🥚")} Egg: ${s.egg_name || "?"}\n` +
      `${tge("PACKAGE","📦")} Plan: ${plan.name}\n` +
      `${tge("FLOPPY","💾")} RAM: ${plan.ram}MB | ${tge("DISK","💿")} Disk: ${plan.disk}MB | ${tge("GEAR","⚙️")} CPU: ${plan.cpu}%\n\n` +
      `Konfirmasi buat panel?`,
      { parse_mode: "HTML", ...Markup.inlineKeyboard([
        [Markup.button.callback("✅ Buat Panel", "do_create_panel")],
        [Markup.button.callback("✖️ Batal", "cancel")],
      ]) }
    );
  }

  if (s.step === "username" || s.step === "trial_username") {
    const isTrial = s.step === "trial_username";
    s.username = text.toLowerCase().replace(/\s+/g, "_");
    s.email    = generateEmail(s.username);
    s.password = generatePassword();
    s.step     = "nest";

    if (isTrial) {
      s.plan_name = config.TRIAL_PLAN.name;
      s.ram = config.TRIAL_PLAN.ram;
      s.disk = config.TRIAL_PLAN.disk;
      s.cpu = config.TRIAL_PLAN.cpu;
      s.panel_type = "biasa";
      s.is_trial = true;
    }

    // Kirim info akun ke PRIVATE CHAT saja
    try {
      await bot.telegram.sendMessage(userId,
        `${tge("LOCK_KEY","🔐")} <b>Info Akun Panel Kamu</b>\n\n` +
        `${tge("USER","👤")} Username: \`${s.username}\`\n` +
        `${tge("EMAIL","📧")} Email: \`${s.email}\`\n` +
        `${tge("KEY","🔑")} Password: \`${s.password}\`\n\n` +
        `_Simpan sebelum panel selesai dibuat!_`,
        { parse_mode: "HTML" }
      );
    } catch (_) {}

    // Ack singkat di grup
    await ctx.reply(`${tge("SUCCESS","✅")} Username *${s.username}* diterima!\n\n${tge("HOURGLASS","⏳")} Mengambil daftar Nest...`, { parse_mode: "HTML" });

    if (isTrial) {
      // Langsung ke pemilihan nest
      const nests = await ptero.getNests(s.server_num || 1);
      if (!nests.length) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Tidak ada Nest tersedia.`, mainMenuKeyboard(role)); }
      s.nests = nests;
      return ctx.reply(`${tge("CARD_INDEX","🗂️")} <b>Pilih Nest</b>\n\nPilih kategori server:`, { parse_mode: "HTML", ...nestsKeyboard(nests) });
    }

    const nests = await ptero.getNests(s.server_num || 1);
    if (!nests.length) { clearState(userId); return ctx.reply(`${tge("ERROR","❌")} Tidak ada Nest tersedia.`, mainMenuKeyboard(role)); }
    s.nests = nests;
    return ctx.reply(`${tge("CARD_INDEX","🗂️")} <b>Pilih Nest</b>\n\nPilih kategori server:`, { parse_mode: "HTML", ...nestsKeyboard(nests) });
  }

  } catch (err) {
    botLog("ERROR", "TEXT_HANDLER", `User:${userId} | Input:"${text.slice(0, 60)}"`, err);
    try { await ctx.reply(`${tge("ERROR","❌")} Terjadi kesalahan internal. Silakan coba lagi atau hubungi owner.`); } catch {}
  }
});

// ─── Notification Helpers ─────────────────────────────────────────────────────

async function notifyOwners2(message) {
  const allOwners = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);
  for (const ownerId of allOwners) {
    try { await bot.telegram.sendMessage(ownerId, message, { parse_mode: "HTML" }); } catch {}
  }
}

async function notifyOwners({ creatorId, creatorFrom, server, panelTypeLabel, s }) {
  const _sn = s.server_num || 1;
  const creatorDisplayName = telegramName(creatorFrom);
  const isAdminPanel = s.panel_type === "admin";
  const ps = planSummary({ ram: s.ram, disk: s.disk, cpu: s.cpu });
  const headerLine = isAdminPanel ? `${tge("SIREN","🚨")} <b>PERINGATAN: ADMIN PANEL DIBUAT!</b>` : `${tge("BELL","🔔")} <b>Notifikasi Panel Baru</b>`;

  const _ownerPanelUrl = serverUrl(_sn);
  const ownerMsg =
    `${headerLine}\n\n━━━━ ${tge("USER","👤")} Pembuat Panel ━━━━\n${tge("ID_BADGE","🪪")} Nama: <b>${he(creatorDisplayName)}</b>\n${tge("ID_CARD","🆔")} ID: <code>${creatorId}</code>\n\n` +
    `━━━━ ${tge("DESKTOP","🖥️")} Info Panel ━━━━\n${tge("MASK","🎭")} Tipe: ${panelTypeLabel}${s.is_trial ? " (Trial)" : ""}\n${tge("GLOBE","🌐")} Server: <b>${he2(serverLabel(_sn))}</b>\n${tge("ID_CARD","🆔")} Server ID: <code>${he(String(server.id))}</code>\n${tge("NAME_BADGE","📛")} Nama: <code>${he(server.name)}</code>\n` +
    `${tge("USER","👤")} Username: <code>${he(s.username || s.email)}</code>\n${tge("EMAIL","📧")} Email: <code>${he(s.email)}</code>\n${tge("CARD_INDEX","🗂️")} Nest: <code>${he(s.nest_name)}</code>\n${tge("EGG","🥚")} Egg: <code>${he(s.egg_name)}</code>\n` +
    `${tge("PACKAGE","📦")} Paket: <b>${he(s.plan_name)}</b>\n${tge("FLOPPY","💾")} RAM: ${ps.ram}  •  ${tge("DISK","💿")} Disk: ${ps.disk}  •  ${tge("GEAR","⚙️")} CPU: ${ps.cpu}\n` +
    `${tge("BRAIN","🧠")} OOM Killer: <b>Aktif</b> ${tge("SUCCESS","✅")}\n\n` +
    `━━━━ ${tge("LOCK_KEY","🔐")} Kredensial ━━━━\n` +
    (_ownerPanelUrl ? `${tge("LINK","🔗")} URL: <code>${he(_ownerPanelUrl)}</code>\n` : `${tge("LINK","🔗")} URL: <i>(PANEL_URL belum diisi di config)</i>\n`) +
    `${tge("KEY","🔑")} Password: <code>${he(s.password)}</code>` +
    (isAdminPanel ? `\n\n${tge("WARNING","⚠️")} <b>Akun ini memiliki hak ADMIN di panel!</b>` : "");

  // KEAMANAN: Notifikasi pembuatan panel + admin panel berisi PASSWORD.
  // Hanya kirim ke Bot Owner (config.OWNER_IDS), JANGAN ke role="owner" di DB,
  // agar user role-owner tidak bisa lihat/ubah password panel orang lain.
  const botOwners = new Set((config.OWNER_IDS || []).map(String));

  for (const ownerId of botOwners) {
    try { await bot.telegram.sendMessage(ownerId, ownerMsg, { parse_mode: "HTML" }); }
    catch (err) { botLog("WARN", "NOTIFY", `Gagal kirim ke bot owner ${ownerId}`, err); }
  }
}

async function notifyGroup({ creatorFrom, server, panelTypeLabel, s }) {
  if (!config.GROUP_ID) return;
  const _sn = s.server_num || 1;
  const creatorDisplayName = telegramName(creatorFrom);
  const isAdminPanel = s.panel_type === "admin";
  const ps = planSummary({ ram: s.ram, disk: s.disk, cpu: s.cpu });
  const expDate = formatDate(new Date(Date.now() + config.PANEL_EXPIRE_DAYS * 24*60*60*1000).toISOString());
  const headerLine = isAdminPanel ? `${tge("SIREN","🚨")} <b>ADMIN PANEL BARU DIBUAT!</b>` : `${tge("LOUDSPEAKER","📢")} <b>Panel Baru Dibuat!</b>`;

  const groupMsg =
    `${headerLine}${s.is_trial ? " (Trial)" : ""}\n\n━━━━ ${tge("USER","👤")} Pembuat ━━━━\n${tge("ID_BADGE","🪪")} Nama: <b>${he(creatorDisplayName)}</b>\n${tge("ID_CARD","🆔")} ID: <code>${creatorFrom.id}</code>\n\n` +
    `━━━━ ${tge("DESKTOP","🖥️")} Info Panel ━━━━\n${tge("MASK","🎭")} Tipe: ${panelTypeLabel}\n${tge("GLOBE","🌐")} Server: <b>${he2(serverLabel(_sn))}</b>\n${tge("ID_CARD","🆔")} Server ID: <code>${he(String(server.id))}</code>\n${tge("NAME_BADGE","📛")} Nama Server: <code>${he(server.name)}</code>\n` +
    `${tge("CARD_INDEX","🗂️")} Nest: <code>${he(s.nest_name)}</code>\n${tge("EGG","🥚")} Egg: <code>${he(s.egg_name)}</code>\n` +
    `${tge("PACKAGE","📦")} Paket: <b>${he(s.plan_name)}</b>\n${tge("FLOPPY","💾")} RAM: ${ps.ram}  •  ${tge("DISK","💿")} Disk: ${ps.disk}  •  ${tge("GEAR","⚙️")} CPU: ${ps.cpu}\n` +
    `${tge("CALENDAR","📅")} Expired: <b>${s.is_trial ? formatDate(new Date(Date.now() + config.TRIAL_HOURS*3600*1000).toISOString()) : expDate}</b>` +
    (isAdminPanel ? `\n\n${tge("WARNING","⚠️")} <b>Akun ini punya hak ADMIN! Owner segera cek!</b>` : "");

  try { await bot.telegram.sendMessage(config.GROUP_ID, groupMsg, { parse_mode: "HTML" }); }
  catch (err) { botLog("WARN", "NOTIFY", "Gagal kirim ke grup", err); }
}

// ─── Server Down Detection ────────────────────────────────────────────────────

const serverStateCache = {}; // { serverId: "running"|"offline"|"starting"|... }

async function checkServerDown() {
  const allPanels = db.getAllPanels(); // [{ ...panelFields, userId }] — flat format
  if (!allPanels.length) return;

  const ownerSet = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);

  for (const panel of allPanels) {
    const identifier = panel.server_identifier || panel.identifier;
    if (!identifier) continue;
    const sid = String(panel.server_id);
    let stats;
    try {
      stats = await ptero.getServerResources(identifier, psn(panel));
    } catch { continue; }

    const currentState = stats?.current_state ?? null;
    if (!currentState) continue;

    const prevState = serverStateCache[sid];
    serverStateCache[sid] = currentState;

    // Hanya kirim notif ketika transisi dari berjalan → offline
    const wasRunning = prevState === "running" || prevState === "starting";
    const isOffline  = currentState === "offline" || currentState === "stopping";

    if (wasRunning && isOffline) {
      logger.warn("SERVER_DOWN", `Server ${sid} ("${panel.name}") userId:${panel.userId} – offline!`);

      const msg =
        `${tge("RED_DOT","🔴")} <b>Server Down Terdeteksi!</b>\n\n` +
        `${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n` +
        `${tge("ID_CARD","🆔")} ID: \`${sid}\`\n` +
        `${tge("CHART","📊")} Status: *${currentState}*\n` +
        `${tge("CLOCK_FACE","🕐")} Waktu: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB\n\n` +
        `Cek kondisi server dan restart jika diperlukan.`;

      // Notif ke pemilik panel
      try { await bot.telegram.sendMessage(panel.userId, msg, { parse_mode: "HTML" }); } catch {}
      // Notif ke grup log
      if (config.LOG_GROUP_ID) {
        try { await bot.telegram.sendMessage(config.LOG_GROUP_ID, msg, { parse_mode: "HTML" }); } catch {}
      }
      // Notif ke semua owner
      for (const ownerId of ownerSet) {
        try { await bot.telegram.sendMessage(ownerId, msg, { parse_mode: "HTML" }); } catch {}
      }
    }
  }
}

// ─── Sistem Expired Panel + Auto Delete ──────────────────────────────────────

async function checkExpiredPanels() {
  logger.sys("EXPIRE_CHECK", "Menjalankan pengecekan panel expired...");

  // H-7, H-3, H-1 warning
  const ownerSetExp = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);
  for (const daysAhead of [7, 3, 1]) {
    const expiringSoon = db.getExpiringPanels(daysAhead);
    for (const { userId, panel } of expiringSoon) {
      const dl = daysLeft(panel.expire_date);
      if (dl === daysAhead) {
        logger.warn("EXPIRE_WARN", `Panel ${panel.server_id} ("${panel.name}") userId:${userId} – sisa ${dl} hari`);
        // Kirim ke user
        try {
          const urgency = dl === 1 ? `${tge("RED_DOT","🔴")} SEGERA` : dl === 3 ? `${tge("ORANGE_DOT","🟠")} Penting` : `${tge("YELLOW_DOT","🟡")} Info`;
          await bot.telegram.sendMessage(userId,
            `${urgency} <b>Panel Akan Expired!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n${tge("CALENDAR","📅")} Expired dalam: *${dl} hari* (${formatDate(panel.expire_date)})\n\n` +
            `Redeem <b>Voucher Hari</b> dan hubungi owner untuk perpanjangan.\n_Jangan tunggu sampai expired!_`,
            { parse_mode: "HTML" }
          );
        } catch {}
        // Notifikasi ke owner (khusus H-3 dan H-1 saja)
        if (dl <= 3) {
          for (const ownerId of ownerSetExp) {
            try {
              await bot.telegram.sendMessage(ownerId,
                `${tge("ALARM","⏰")} *Panel User Akan Expired (H-${dl})*\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n${tge("USER","👤")} User ID: \`${userId}\`\n${tge("CALENDAR","📅")} Expired: *${formatDate(panel.expire_date)}*\n\nCek apakah user sudah punya pending days untuk diperpanjang.`,
                { parse_mode: "HTML" }
              );
            } catch {}
          }
        }
      }
    }
  }

  // Suspend / Hapus yang expired
  const expired = db.getExpiringPanels(0);
  for (const { userId, panel } of expired) {
    const dl = daysLeft(panel.expire_date);
    if (dl <= 0) {

      // ── Trial panel: hapus langsung di Pterodactyl + bot DB ──────────────
      if (panel.is_trial) {
        logger.event("TRIAL_EXPIRE", `Trial panel ${panel.server_id} ("${panel.name}") userId:${userId} expired — menghapus...`);
        const delOk = await ptero.deleteServer(panel.server_id, psn(panel));
        if (delOk) {
          db.deletePanelRecord(userId, panel.server_id);
          db.decrementPanelCount(userId);
          db.resetBandwidthTracking && db.resetBandwidthTracking(panel.server_id);
          logger.event("TRIAL_EXPIRE", `Trial panel ${panel.server_id} dihapus dari Pterodactyl & DB`);
          try {
            await bot.telegram.sendMessage(userId,
              `${tge("TRASH","🗑️")} <b>Trial Panel Anda Telah Dihapus!</b>\n\n` +
              `${tge("NAME_BADGE","📛")} Server: <code>${panel.name}</code>\n` +
              `${tge("ID_CARD","🆔")} ID: <code>${panel.server_id}</code>\n` +
              `${tge("ALARM","⏰")} Masa trial ${config.TRIAL_HOURS} jam telah berakhir dan server dihapus otomatis.\n\n` +
              `Buat panel berbayar untuk layanan lebih lama 💡`,
              { parse_mode: "HTML" }
            );
          } catch {}
        } else {
          // Gagal hapus dari ptero — tandai suspended agar tidak dicoba terus
          db.markPanelSuspended(userId, panel.server_id, true);
          logger.warn("TRIAL_EXPIRE", `Gagal hapus trial panel ${panel.server_id} dari Pterodactyl`);
        }
        continue; // jangan proses sebagai panel biasa
      }

      // ── Panel biasa: suspend ──────────────────────────────────────────────
      const ok = await ptero.suspendServer(panel.server_id, psn(panel));
      if (ok) {
        db.markPanelSuspended(userId, panel.server_id, true);
        logger.event("EXPIRE", `Panel ${panel.server_id} ("${panel.name}") milik userId:${userId} disuspend karena expired`);
        try {
          await bot.telegram.sendMessage(userId,
            `${tge("LOCK","🔒")} <b>Panel Anda Telah Di-suspend!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n${tge("CALENDAR","📅")} Expired: ${formatDate(panel.expire_date)}\n\nHubungi owner untuk perpanjang atau hapus panel.`,
            { parse_mode: "HTML" }
          );
        } catch {}
      }
    }
  }

  // Reminder ke owner: panel expired belum dihapus (di atas AUTO_DELETE/2 hari)
  const reminderThreshold = Math.max(1, Math.floor((config.AUTO_DELETE_DAYS || 7) / 2));
  const oldSuspended = db.getSuspendedExpiredPanels(reminderThreshold);
  for (const { userId: panelOwner, panel } of oldSuspended) {
    // Cek sudah ada tracking reminder (gunakan daily flag)
    const db2 = db.loadDb();
    const flagKey = `expire_reminder_${panel.server_id}_${db.getTodayKey()}`;
    if (db2.daily_counts && db2.daily_counts[flagKey]) continue;
    if (!db2.daily_counts) db2.daily_counts = {};
    db2.daily_counts[flagKey] = 1;
    db.saveDb(db2);
    const suspendedAt = panel.expire_date;
    for (const ownerId of ownerSetExp) {
      try {
        await bot.telegram.sendMessage(ownerId,
          `${tge("WARNING","⚠️")} <b>Panel Expired Belum Dihapus</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name || panel.server_id}\`\n${tge("USER","👤")} User ID: \`${panelOwner}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n${tge("CALENDAR","📅")} Expired: ${formatDate(suspendedAt)}\n\nPanel ini sudah suspended cukup lama. Pertimbangkan untuk hapus manual jika user tidak merespons.`,
          { parse_mode: "HTML" }
        );
      } catch {}
    }
  }

  // Auto-delete panel yang sudah lama suspended
  if (config.AUTO_DELETE_DAYS > 0) {
    const toDelete = db.getSuspendedExpiredPanels(config.AUTO_DELETE_DAYS);
    for (const { userId, panel } of toDelete) {
      const ok = await ptero.deleteServer(panel.server_id, psn(panel));
      if (ok) {
        db.deletePanelRecord(userId, panel.server_id);
        logger.event("AUTO-DELETE", `Panel ${panel.server_id} ("${panel.name}") milik userId:${userId} dihapus otomatis setelah ${config.AUTO_DELETE_DAYS} hari suspended`);
        try {
          await bot.telegram.sendMessage(userId,
            `${tge("TRASH","🗑️")} <b>Panel Anda Telah Dihapus Otomatis!</b>\n\n${tge("NAME_BADGE","📛")} Server: \`${panel.name}\`\n${tge("ID_CARD","🆔")} ID: \`${panel.server_id}\`\n\nPanel dihapus karena sudah *${config.AUTO_DELETE_DAYS} hari* dalam kondisi suspended/expired.`,
            { parse_mode: "HTML" }
          );
        } catch {}
      }
    }
  }
}

// ─── Node Down Alert ──────────────────────────────────────────────────────────

async function checkNodeStatus() {
  if (!config.NODE_CHECK_INTERVAL_MINUTES || config.NODE_CHECK_INTERVAL_MINUTES <= 0) return;
  logger.sys("NODE_CHECK", "Mengecek status semua node...");
  try {
    const targets = config.PTLA2 && config.PTLC2 ? [1, 2] : [1];
    for (const sn of targets) {
    const nodes = await ptero.getNodes(sn);
    for (const n of nodes) {
      const a = n.attributes;
      const ns = await ptero.getNodeStatus(a, sn);
      const prevStatus = nodeStatusCache.get(`${sn}:${a.id}`);

      if (typeof prevStatus !== "undefined" && prevStatus !== ns.online) {
        // Status berubah!
        const alertMsg = ns.online
          ? `${tge("SUCCESS","✅")} <b>Node Kembali Online!</b>\n\n${tge("DESKTOP","🖥️")} Node: *${a.name}*\n${tge("ID_CARD","🆔")} ID: \`${a.id}\`\n\n_Node sudah bisa digunakan kembali._`
          : `${tge("SIREN","🚨")} <b>Node Down Terdeteksi!</b>\n\n${tge("DESKTOP","🖥️")} Node: *${a.name}*\n${tge("ID_CARD","🆔")} ID: \`${a.id}\`\n\n${tge("WARNING","⚠️")} Server yang berjalan di node ini mungkin tidak bisa diakses!`;

        // Alert ke grup dan semua owner
        if (config.GROUP_ID) {
          try { await bot.telegram.sendMessage(config.GROUP_ID, alertMsg, { parse_mode: "HTML" }); } catch {}
        }
        const allOwners = new Set([
          ...config.OWNER_IDS.map(String),
          ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
        ]);
        for (const ownerId of allOwners) {
          try { await bot.telegram.sendMessage(ownerId, alertMsg, { parse_mode: "HTML" }); } catch {}
        }
        if (ns.online) {
          logger.sys("NODE_ALERT", `Node "${a.name}" (ID:${a.id}) kembali ONLINE`);
        } else {
          logger.error("NODE_ALERT", `Node "${a.name}" (ID:${a.id}) DOWN – server mungkin tidak bisa diakses`);
        }
      }
      nodeStatusCache.set(`${sn}:${a.id}`, ns.online);
    }
    }
  } catch (err) {
    botLog("ERROR", "NODE_CHECK", "Error saat cek status node", err);
  }
}

// ─── Daily Report ─────────────────────────────────────────────────────────────

async function checkDailyReport() {
  const reportHour = config.DAILY_REPORT_HOUR || 7;
  const now = new Date();
  if (now.getHours() !== reportHour) return;

  const today = now.toDateString();
  const lastReport = db.getLastDailyReport();
  if (lastReport === today) return; // Sudah kirim hari ini

  db.setLastDailyReport(today);
  const reportText = buildDailyReportText();

  if (config.GROUP_ID) {
    try { await bot.telegram.sendMessage(config.GROUP_ID, reportText, { parse_mode: "HTML" }); } catch {}
  }
  const allOwners = new Set([
    ...config.OWNER_IDS.map(String),
    ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
  ]);
  for (const ownerId of allOwners) {
    try { await bot.telegram.sendMessage(ownerId, reportText, { parse_mode: "HTML" }); } catch {}
  }
  console.log("[REPORT] Laporan harian dikirim.");
}

// ─── Over Resource Monitor ────────────────────────────────────────────────────

async function checkOverResource(manualTrigger = false, triggerUserId = null) {
  if (!config.OVER_RESOURCE_ACTION || config.OVER_RESOURCE_ACTION === "none") return;

  // Batas absolut dari config
  const cpuLimit  = config.RESOURCE_CPU_LIMIT     || 0;  // persen
  const ramLimitB = (config.RESOURCE_RAM_LIMIT_MB  || 0) * 1024 * 1024;  // bytes
  const diskLimitB= (config.RESOURCE_DISK_LIMIT_MB || 0) * 1024 * 1024;  // bytes
  // Threshold: peringatan berapa kali sebelum tindakan (default 2 = 1 warning lalu aksi)
  const alertThreshold = config.RESOURCE_ALERT_THRESHOLD || 2;
  // Bandwidth global default
  const bwDefaultGb = config.BANDWIDTH_LIMIT_GB_PER_SERVER || 0;

  // Helper: kirim notifikasi ke grup dan semua owner
  async function notifyGroupAndOwners(text, parseMode = "Markdown") {
    if (config.GROUP_ID) {
      try { await bot.telegram.sendMessage(config.GROUP_ID, text, { parse_mode: parseMode }); } catch {}
    }
    const ownerSet = new Set([
      ...config.OWNER_IDS.map(String),
      ...Object.entries(db.listAllUsers()).filter(([,u]) => u.role === "owner").map(([uid]) => uid),
    ]);
    for (const ownerId of ownerSet) {
      try { await bot.telegram.sendMessage(ownerId, text, { parse_mode: parseMode }); } catch {}
    }
  }

  // Helper: tindakan suspend atau delete
  async function takeAction(panel, resourceLine) {
    const actionWord = config.OVER_RESOURCE_ACTION === "delete" ? "dihapus" : "disuspend";
    if (config.OVER_RESOURCE_ACTION === "suspend") {
      const ok = await ptero.suspendServer(panel.server_id, psn(panel));
      if (!ok) { logger.warn("RESOURCE_CHECK", `Gagal suspend server ${panel.server_id}`); return; }
      db.markPanelSuspended(panel.userId, panel.server_id, true);
      db.addAuditLog({ actorId: "SYSTEM", action: "Auto Suspend (Over Resource)", target: String(panel.server_id) });
      const msg = `${tge("LOCK","🔒")} <b>Server Auto-Suspend — Over Limit!</b>\n\n` +
        `${tge("DESKTOP","🖥️")} Server: <code>${he2(panel.name || String(panel.server_id))}</code>\n` +
        `${tge("ID_CARD","🆔")} ID: <code>${he2(String(panel.server_id))}</code>\n` +
        `${tge("USER","👤")} User: <code>${he2(String(panel.userId))}</code>\n\n` + resourceLine;
      await notifyGroupAndOwners(msg, "HTML");
      try { await bot.telegram.sendMessage(panel.userId, `${tge("LOCK","🔒")} <b>Server Disuspend — Over Limit!</b>\n\n` +
        `Server <code>${he2(panel.name || String(panel.server_id))}</code> disuspend otomatis.\n\n` +
        resourceLine + `\n\nHubungi owner untuk unsuspend.`, { parse_mode: "HTML" }); } catch {}

    } else if (config.OVER_RESOURCE_ACTION === "delete") {
      const ok = await ptero.deleteServer(panel.server_id, psn(panel));
      if (!ok) { logger.warn("RESOURCE_CHECK", `Gagal delete server ${panel.server_id}`); return; }
      db.deletePanelRecord(panel.userId, panel.server_id);
      db.decrementPanelCount(panel.userId);
      db.resetBandwidthTracking && db.resetBandwidthTracking(panel.server_id);
      db.addAuditLog({ actorId: "SYSTEM", action: "Auto Delete (Over Resource)", target: String(panel.server_id) });
      const msg = `${tge("TRASH","🗑️")} <b>Server Auto-Delete — Over Limit!</b>\n\n` +
        `${tge("DESKTOP","🖥️")} Server: <code>${he2(panel.name || String(panel.server_id))}</code>\n` +
        `${tge("ID_CARD","🆔")} ID: <code>${he2(String(panel.server_id))}</code>\n` +
        `${tge("USER","👤")} User: <code>${he2(String(panel.userId))}</code>\n\n` + resourceLine;
      await notifyGroupAndOwners(msg, "HTML");
      try { await bot.telegram.sendMessage(panel.userId, `${tge("TRASH","🗑️")} <b>Server Dihapus — Over Limit!</b>\n\n` +
        `Server <code>${he2(panel.name || String(panel.server_id))}</code> dihapus otomatis.\n\n` +
        resourceLine + `\n\nHubungi owner untuk info lebih lanjut.`, { parse_mode: "HTML" }); } catch {}
    }
  }

  try {
    const allPanels = db.getAllPanels ? db.getAllPanels() : [];
    // Cek panel aktif — yang punya server_identifier (untuk Client API)
    const activePanels = allPanels.filter(p => !p.expired && !p.suspended);
    for (const panel of activePanels) {
      // Butuh server_identifier untuk Client API (resource stats)
      const identifier = panel.server_identifier || panel.identifier;
      if (!identifier) {
        logger.warn("RESOURCE_CHECK", `Panel ${panel.server_id} tidak punya server_identifier — skip cek resource`);
        continue;
      }
      const stats = await ptero.getServerResources(identifier, psn(panel));
      if (!stats) continue;

      // Jika server offline/stopped, tidak perlu cek resource (usage akan 0)
      if (stats.current_state === "offline" || stats.current_state === "stopped") {
        db.clearResourceAlert(String(panel.server_id), "over_resource");
        db.clearResourceAlert(String(panel.server_id), "over_bandwidth");
        continue;
      }

      const rss = stats.resources || {};
      const cpuPct    = rss.cpu_absolute    || 0;
      const ramBytes  = rss.memory_bytes    || 0;
      const diskBytes = rss.disk_bytes      || 0;
      const netRxBytes= rss.network_rx_bytes|| 0;
      const netTxBytes= rss.network_tx_bytes|| 0;
      const ramMB     = Math.round(ramBytes  / 1024 / 1024);
      const diskMB    = Math.round(diskBytes / 1024 / 1024);

      // ── Cek batas CPU / RAM / Disk ──────────────────────────────────────
      const cpuOver  = cpuLimit   > 0 && cpuPct   >= cpuLimit;
      const ramOver  = ramLimitB  > 0 && ramBytes >= ramLimitB;
      const diskOver = diskLimitB > 0 && diskBytes >= diskLimitB;
      const isOver   = cpuOver || ramOver || diskOver;

      const resourceLine =
        `${tge("GEAR","⚙️")} CPU:  ${cpuPct.toFixed(1)}% / batas ${cpuLimit || "∞"}% ${cpuOver   ? "🔴" : "✅"}\n` +
        `${tge("FLOPPY","💾")} RAM:  ${ramMB} MB / batas ${config.RESOURCE_RAM_LIMIT_MB || "∞"} MB ${ramOver  ? "🔴" : "✅"}\n` +
        `${tge("DISK","💿")} Disk: ${diskMB} MB / batas ${config.RESOURCE_DISK_LIMIT_MB || "∞"} MB ${diskOver ? "🔴" : "✅"}`;

      if (isOver) {
        const alertCount = db.addResourceAlert(panel.userId, String(panel.server_id), "over_resource");

        if (manualTrigger && triggerUserId) {
          try {
            await bot.telegram.sendMessage(triggerUserId,
              `⚠️ <b>Over-Resource Alert</b>\n\n` +
              `${tge("DESKTOP","🖥️")} Server: <code>${he2(panel.name || String(panel.server_id))}</code>\n` +
              `${tge("ID_CARD","🆔")} ID: <code>${he2(String(panel.server_id))}</code>\n` +
              `${tge("USER","👤")} User: <code>${he2(String(panel.userId))}</code>\n\n` +
              resourceLine + `\n\n🚨 Alert ke-${alertCount}`,
              { parse_mode: "HTML" }
            );
          } catch {}
        } else if (alertCount < alertThreshold) {
          // Kirim peringatan
          const actionWord = config.OVER_RESOURCE_ACTION === "delete" ? "dihapus" : "disuspend";
          await notifyGroupAndOwners(
            `⚠️ <b>Over-Resource Warning!</b>\n\n` +
            `${tge("DESKTOP","🖥️")} <code>${he2(panel.name || String(panel.server_id))}</code>\n` +
            `${tge("ID_CARD","🆔")} ID: <code>${he2(String(panel.server_id))}</code>  •  User: <code>${he2(String(panel.userId))}</code>\n\n` +
            resourceLine + `\n\n⏱️ Peringatan ${alertCount}/${alertThreshold} — akan <b>${actionWord}</b> jika masih over.`,
            "HTML"
          );
          try {
            await bot.telegram.sendMessage(panel.userId,
              `⚠️ <b>Peringatan Resource!</b>\n\n` +
              `Server <code>${he2(panel.name || String(panel.server_id))}</code> melebihi batas!\n\n` +
              resourceLine + `\n\n⏱️ Kurangi penggunaan atau server akan <b>${actionWord}</b>!`,
              { parse_mode: "HTML" }
            );
          } catch {}
        } else {
          // Ambil tindakan
          logger.warn("RESOURCE_CHECK", `Server ${panel.server_id} over-resource (${alertCount} alert) — ambil tindakan ${config.OVER_RESOURCE_ACTION}`);
          await takeAction(panel, resourceLine);
          db.clearResourceAlert(String(panel.server_id), "over_resource");
        }
      } else {
        db.clearResourceAlert(String(panel.server_id), "over_resource");
      }

      // ── Cek batas Bandwidth bulanan per server ──────────────────────────
      const bwLimitGb = panel.bandwidth_limit_gb > 0 ? panel.bandwidth_limit_gb : bwDefaultGb;
      if (bwLimitGb > 0) {
        const monthlyBytes = db.updateBandwidthBytes(panel.server_id, netRxBytes, netTxBytes);
        const monthlyGb    = monthlyBytes / (1024 * 1024 * 1024);
        const bwOver       = monthlyGb >= bwLimitGb;
        const bwMb         = Math.round(monthlyBytes / 1024 / 1024);

        const bwLine = `📡 Bandwidth bulan ini: <b>${bwMb >= 1024 ? (monthlyGb).toFixed(2) + " GB" : bwMb + " MB"}</b> / batas <b>${bwLimitGb} GB</b> ${bwOver ? "🔴" : "✅"}`;

        if (bwOver) {
          const bwAlertCount = db.addResourceAlert(panel.userId, String(panel.server_id), "over_bandwidth");
          logger.warn("BANDWIDTH_CHECK", `Server ${panel.server_id} over-bandwidth ${monthlyGb.toFixed(2)}GB/${bwLimitGb}GB — alert #${bwAlertCount}`);

          if (!manualTrigger) {
            if (bwAlertCount < alertThreshold) {
              const actionWord = config.OVER_RESOURCE_ACTION === "delete" ? "dihapus" : "disuspend";
              await notifyGroupAndOwners(
                `📡 <b>Over-Bandwidth Warning!</b>\n\n` +
                `${tge("DESKTOP","🖥️")} <code>${he2(panel.name || String(panel.server_id))}</code>\n` +
                `${tge("ID_CARD","🆔")} ID: <code>${he2(String(panel.server_id))}</code>  •  User: <code>${he2(String(panel.userId))}</code>\n\n` +
                bwLine + `\n\n⏱️ Peringatan ${bwAlertCount}/${alertThreshold} — akan <b>${actionWord}</b> jika tidak berkurang.`,
                "HTML"
              );
              try {
                await bot.telegram.sendMessage(panel.userId,
                  `📡 <b>Bandwidth Limit!</b>\n\nServer <code>${he2(panel.name || String(panel.server_id))}</code> melebihi kuota bandwidth bulan ini!\n\n${bwLine}\n\nHubungi owner jika butuh tambah kuota.`,
                  { parse_mode: "HTML" }
                );
              } catch {}
            } else {
              const bwResourceLine = resourceLine + `\n${bwLine}`;
              await takeAction(panel, bwResourceLine);
              db.clearResourceAlert(String(panel.server_id), "over_bandwidth");
            }
          }
        } else {
          db.clearResourceAlert(String(panel.server_id), "over_bandwidth");
          // Update tracking tanpa melewati batas — simpan data saja
          db.updateBandwidthBytes(panel.server_id, netRxBytes, netTxBytes);
        }
      }
    }
  } catch (err) {
    botLog("ERROR", "RESOURCE_CHECK", "Error saat cek resource server", err);
  }
}

// ─── Auto Backup ──────────────────────────────────────────────────────────────

async function runAutoBackup(isManual = false, requesterId = null) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupName = `bot-backup-${timestamp}.tar.gz`;
  const backupPath = path.join(os.tmpdir(), backupName);
  const botDir = path.resolve(__dirname);

  try {
    // Buat tar.gz dari seluruh folder bot (kecuali node_modules & .git)
    execSync(
      `tar -czf "${backupPath}" --exclude="node_modules" --exclude=".git" --exclude="*.tar.gz" -C "${path.dirname(botDir)}" "${path.basename(botDir)}"`,
      { stdio: "pipe" }
    );

    const fileSizeKB = Math.round(fs.statSync(backupPath).size / 1024);
    const caption =
      `${tge("FLOPPY","💾")} *${isManual ? "Manual" : "Auto"} Backup Bot*\n\n` +
      `${tge("PACKAGE","📦")} Isi: script + database bot\n` +
      `${tge("FOLDER","📁")} File: \`${backupName}\`\n` +
      `${tge("RULER","📏")} Ukuran: *${fileSizeKB} KB*\n` +
      `${tge("CLOCK_FACE","🕐")} Waktu: *${formatDate(new Date().toISOString())}*`;

    // ── PENERIMA BACKUP ──
    // File backup berisi seluruh script + database bot (SANGAT SENSITIF).
    // Jadi HANYA dikirim ke Bot Owner asli yang terdaftar di config.OWNER_IDS.
    // TIDAK pernah dikirim ke user dengan role="owner" di DB (karena role itu
    // bisa di-set lewat voucher / promosi dan tidak boleh dapat akses ke script).
    const configOwners = (config.OWNER_IDS || []).map(String);
    let allOwners;
    if (isManual && requesterId && configOwners.includes(String(requesterId))) {
      // Manual backup → hanya ke requester (HARUS terdaftar di config.OWNER_IDS).
      allOwners = new Set([String(requesterId)]);
    } else {
      // Auto backup atau fallback → HANYA bot owner di config.OWNER_IDS.
      allOwners = new Set(configOwners);
    }

    let sentCount = 0;
    for (const ownerId of allOwners) {
      try {
        await bot.telegram.sendDocument(
          ownerId,
          { source: fs.createReadStream(backupPath), filename: backupName },
          { caption, parse_mode: "HTML" }
        );
        sentCount++;
      } catch (err) {
        botLog("WARN", "AUTO_BACKUP", `Gagal kirim backup ke owner ${ownerId}`, err);
      }
    }

    // Hapus file temp setelah dikirim
    try { fs.unlinkSync(backupPath); } catch {}

    db.setAutoBackup({ last_run: new Date().toISOString() });
    db.addAuditLog({
      actorId: "SYSTEM",
      action: isManual ? "Manual Backup Bot" : "Auto Backup Bot",
      detail: `${backupName} (${fileSizeKB} KB) → ${sentCount} owner`,
    });

    console.log(`[AUTO BACKUP] ${tge("SUCCESS","✅")} ${backupName} (${fileSizeKB} KB) terkirim ke ${sentCount} owner`);
    return { success: true, filename: backupName, sizeKB: fileSizeKB, sentCount };

  } catch (err) {
    botLog("ERROR", "AUTO_BACKUP", "Proses backup bot gagal", err);
    try { fs.unlinkSync(backupPath); } catch {}
    db.addAuditLog({ actorId: "SYSTEM", action: "Auto Backup Bot GAGAL", detail: err.message });
    return { success: false, error: err.message };
  }
}

async function checkAutoBackup() {
  try {
    const ab = db.getAutoBackup();
    if (!ab.enabled) return;
    const intervalMs = ab.interval_hours * 60 * 60 * 1000;
    const lastRun = ab.last_run ? new Date(ab.last_run).getTime() : 0;
    if (Date.now() - lastRun < intervalMs) return;
    botLog("INFO", "AUTO_BACKUP", `Memulai backup otomatis (interval: ${ab.interval_hours}j)...`);
    await runAutoBackup(false);
  } catch (err) {
    botLog("ERROR", "AUTO_BACKUP", "Error saat jadwal auto backup", err);
  }
}

// ─── Global Error Handlers ────────────────────────────────────────────────────

bot.catch((err, ctx) => {
  const userId = ctx?.from?.id ?? "?";
  const action = ctx?.callbackQuery?.data ?? ctx?.message?.text?.slice(0, 40) ?? "?";
  botLog("ERROR", "BOT.CATCH", `User:${userId} | Ctx:${action}`, err);
});

process.on("uncaughtException", (err) => {
  botLog("ERROR", "UNCAUGHT_EXCEPTION", "Exception tidak tertangkap!", err);
});

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  botLog("ERROR", "UNHANDLED_REJECTION", "Promise rejection tidak tertangkap!", err);
});

// ─── Apply New Features (anti-spam, monitoring, friends, snapshot, etc.) ────
features.applyAll(bot, db, ptero, logger, config);

// ═══════════════════════════════════════════════════════════════════════════════
// ─── V3 New Features (commands & background jobs) ────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
// Commands:
//   /favorite          — kelola panel favorit (#7)
//   /coowner           — owner panel: tambah/hapus co-owner (#3)
//   /theme             — pilih theme/emoji pack (#17, premium)
//   /searchpanel       — owner: cari panel berdasarkan nama/user/identifier (#6)
//   /topuser           — leaderboard top resource user (#14)
//   /sla               — laporan SLA bulanan (#13)
//   /diskcleaner       — saran cleanup disk (#23)
//   /quota             — cek quota resource (#5)
//   /chart             — grafik usage 7-hari (#11)
//   /suspicious        — owner: lihat aktivitas mencurigakan (#19)

// helper: cari panel by id, akses dicek
function findUserPanelOrAccessible(uid, sid) {
  const myPanels = db.getUserPanels(uid);
  let p = myPanels.find(x => String(x.server_id) === String(sid));
  if (p) return { panel: p, ownerOnly: false };
  // Cek co-owner
  if (db.isCoOwner(sid, uid)) {
    const all = db.getAllPanels();
    p = all.find(x => String(x.server_id) === String(sid));
    if (p) return { panel: p, ownerOnly: false };
  }
  // Owner bot bisa akses semua
  if (isOwner(uid)) {
    const all = db.getAllPanels();
    p = all.find(x => String(x.server_id) === String(sid));
    if (p) return { panel: p, ownerOnly: true };
  }
  return null;
}

// ── /favorite (#7) ──
bot.command("favorite", async (ctx) => {
  const uid = ctx.from.id;
  const args = (ctx.message.text || "").split(/\s+/).slice(1);
  const sub = (args[0] || "list").toLowerCase();
  const sid = args[1];

  if (sub === "list") {
    const favs = db.getFavorites(uid);
    if (!favs.length) return ctx.reply(`${tge("STAR","⭐")} <b>Favorit Kosong</b>\n\nGunakan: <code>/favorite add &lt;server_id&gt;</code>`, { parse_mode: "HTML" });
    const myPanels = db.getUserPanels(uid);
    const lines = favs.map((sid, i) => {
      const p = myPanels.find(x => String(x.server_id) === String(sid));
      return `${i+1}. ${p ? `<b>${he(p.name)}</b>` : "(tidak diketahui)"} • <code>${sid}</code>`;
    });
    return ctx.reply(`${tge("STAR","⭐")} <b>Panel Favorit</b>\n\n${lines.join("\n")}\n\n<i>Hapus: /favorite remove &lt;id&gt;</i>`, { parse_mode: "HTML" });
  }
  if (sub === "add" && sid) {
    const myPanels = db.getUserPanels(uid);
    if (!myPanels.find(p => String(p.server_id) === String(sid)))
      return ctx.reply(`${tge("ERROR","❌")} Server <code>${sid}</code> bukan milikmu.`, { parse_mode: "HTML" });
    db.addFavorite(uid, sid);
    return ctx.reply(`${tge("STAR","⭐")} Favorit ditambahkan: <code>${sid}</code>`, { parse_mode: "HTML" });
  }
  if (sub === "remove" && sid) {
    db.removeFavorite(uid, sid);
    return ctx.reply(`${tge("SUCCESS","✅")} Favorit dihapus: <code>${sid}</code>`, { parse_mode: "HTML" });
  }
  return ctx.reply(`${tge("STAR","⭐")} <b>Favorit</b>\n\nUsage:\n• <code>/favorite list</code>\n• <code>/favorite add &lt;server_id&gt;</code>\n• <code>/favorite remove &lt;server_id&gt;</code>`, { parse_mode: "HTML" });
});

// ── /coowner (#3) ──
bot.command("coowner", async (ctx) => {
  const uid = ctx.from.id;
  const args = (ctx.message.text || "").split(/\s+/).slice(1);
  const sub = (args[0] || "help").toLowerCase();

  if (sub === "list") {
    const sid = args[1];
    if (!sid) return ctx.reply(`Usage: <code>/coowner list &lt;server_id&gt;</code>`, { parse_mode: "HTML" });
    const myPanels = db.getUserPanels(uid);
    const p = myPanels.find(x => String(x.server_id) === String(sid));
    if (!p && !isOwner(uid)) return ctx.reply(`${tge("ERROR","❌")} Server <code>${sid}</code> bukan milikmu.`, { parse_mode: "HTML" });
    const cos = db.getCoOwners(sid);
    if (!cos.length) return ctx.reply(`${tge("USERS","👥")} Belum ada co-owner untuk <code>${sid}</code>.`, { parse_mode: "HTML" });
    return ctx.reply(`${tge("USERS","👥")} <b>Co-owner</b> untuk <code>${sid}</code>:\n\n${cos.map((u,i)=>`${i+1}. <code>${u}</code>`).join("\n")}`, { parse_mode: "HTML" });
  }
  if (sub === "add" || sub === "remove") {
    const sid = args[1];
    const target = (args[2] || "").replace(/^@/, "");
    if (!sid || !target) return ctx.reply(`Usage: <code>/coowner ${sub} &lt;server_id&gt; &lt;tg_user_id&gt;</code>`, { parse_mode: "HTML" });
    const myPanels = db.getUserPanels(uid);
    const p = myPanels.find(x => String(x.server_id) === String(sid));
    if (!p && !isOwner(uid)) return ctx.reply(`${tge("ERROR","❌")} Server <code>${sid}</code> bukan milikmu.`, { parse_mode: "HTML" });
    if (!/^\d+$/.test(target)) return ctx.reply(`${tge("ERROR","❌")} TG user ID harus angka.`, { parse_mode: "HTML" });
    if (sub === "add") db.addCoOwner(sid, target); else db.removeCoOwner(sid, target);
    db.addAuditLog({ actorId: uid, action: `Co-owner ${sub}`, target: sid, detail: target });
    return ctx.reply(`${tge("SUCCESS","✅")} Co-owner <code>${target}</code> berhasil di-${sub === "add" ? "tambah" : "hapus"} untuk <code>${sid}</code>.`, { parse_mode: "HTML" });
  }
  return ctx.reply(`${tge("USERS","👥")} <b>Co-owner Panel</b>\n\nUsage:\n• <code>/coowner list &lt;server_id&gt;</code>\n• <code>/coowner add &lt;server_id&gt; &lt;tg_user_id&gt;</code>\n• <code>/coowner remove &lt;server_id&gt; &lt;tg_user_id&gt;</code>\n\nCo-owner bisa kelola panel kamu (start/stop/backup) tapi tidak bisa hapus/transfer.`, { parse_mode: "HTML" });
});

// ── /theme (#17) ──
bot.command("theme", async (ctx) => {
  const uid = ctx.from.id;
  const role = db.getRole(uid);
  if (!["premium", "owner"].includes(role))
    return ctx.reply(`${tge("DIAMOND","💎")} <b>Theme Pack</b> hanya untuk <b>Premium</b> &amp; <b>Owner</b>.`, { parse_mode: "HTML" });
  const args = (ctx.message.text || "").split(/\s+/).slice(1);
  const pack = (args[0] || "").toLowerCase();
  const packs = config.THEME_PACKS || {};
  if (!pack || !packs[pack]) {
    const list = Object.entries(packs).map(([k, v]) => `• <code>${k}</code> ${v.prefix} ${v.name}`).join("\n");
    const cur = db.getThemePack(uid);
    return ctx.reply(`${tge("SPARKLES","✨")} <b>Theme/Emoji Pack</b>\n\nTheme aktif: <b>${cur}</b>\n\n${list}\n\nGunakan: <code>/theme &lt;nama&gt;</code>`, { parse_mode: "HTML" });
  }
  db.setThemePack(uid, pack);
  return ctx.reply(`${tge("SUCCESS","✅")} Theme di-set ke <b>${packs[pack].name}</b> ${packs[pack].prefix}`, { parse_mode: "HTML" });
});

// ── /searchpanel (#6) ──
bot.command("searchpanel", async (ctx) => {
  const uid = ctx.from.id;
  if (!isOwner(uid)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
  const q = (ctx.message.text || "").split(/\s+/).slice(1).join(" ").toLowerCase().trim();
  if (!q) return ctx.reply(`${tge("SEARCH","🔎")} Usage: <code>/searchpanel &lt;keyword&gt;</code>\n\nKeyword cocok ke nama panel, username, email, identifier, atau TG user ID.`, { parse_mode: "HTML" });
  const all = db.getAllPanels();
  const hits = all.filter(p =>
    String(p.name || "").toLowerCase().includes(q) ||
    String(p.username || "").toLowerCase().includes(q) ||
    String(p.email || "").toLowerCase().includes(q) ||
    String(p.server_identifier || "").toLowerCase().includes(q) ||
    String(p.server_id || "").includes(q) ||
    String(p.userId || "").includes(q)
  );
  if (!hits.length) return ctx.reply(`${tge("EMPTY_BOX","📭")} Tidak ada panel cocok untuk <code>${he(q)}</code>.`, { parse_mode: "HTML" });
  const lines = hits.slice(0, 20).map((p, i) =>
    `${i+1}. <b>${he(p.name)}</b>\n   🆔 <code>${p.server_id}</code> • Srv ${p.server_num || 1}\n   👤 <code>${p.userId}</code> • ${he(p.username || "-")}\n   📦 ${he(p.plan_name || "-")}`
  );
  return ctx.reply(`${tge("SEARCH","🔎")} <b>Hasil Pencarian</b> (${hits.length} ditemukan):\n\n${lines.join("\n\n")}${hits.length > 20 ? "\n\n<i>Hanya menampilkan 20 pertama.</i>" : ""}`, { parse_mode: "HTML" });
});

// ── /apikey (#21) — REMOVED (HTTP API tidak dipakai lagi) ──

// ── /topuser (#14) ──
bot.command("topuser", async (ctx) => {
  const top = db.getResourceQuotaLeaderboard(15);
  if (!top.length) return ctx.reply(`${tge("EMPTY_BOX","📭")} Belum ada data user.`);
  const medals = ["🥇", "🥈", "🥉"];
  const lines = top.map((u, i) => {
    const medal = medals[i] || `${i+1}.`;
    return `${medal} <code>${u.uid}</code> [${u.role}]\n   💾 ${u.ram} MB • 💿 ${u.disk} MB • ⚙️ ${u.cpu}% • 📊 ${u.count} panel`;
  });
  return ctx.reply(`${tge("TROPHY","🏆")} <b>Top Resource Leaderboard</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
});

// ── /sla (#13) ──
bot.command("sla", async (ctx) => {
  const uid = ctx.from.id;
  const args = (ctx.message.text || "").split(/\s+/).slice(1);
  const month = args[0] || new Date().toISOString().slice(0, 7);
  const data = db.getSlaForMonth(month);
  const myPanels = isOwner(uid) ? db.getAllPanels() : db.getUserPanels(uid);
  const visible = Object.entries(data).filter(([sid]) => myPanels.find(p => String(p.server_id) === String(sid)));
  if (!visible.length) return ctx.reply(`${tge("EMPTY_BOX","📭")} Belum ada data SLA bulan <b>${month}</b>.`, { parse_mode: "HTML" });
  const lines = visible.sort((a,b)=>b[1]-a[1]).map(([sid, pct]) => {
    const p = myPanels.find(x => String(x.server_id) === String(sid));
    const bar = asciiBar(pct, 100, 12);
    return `<code>${sid}</code> ${he(p?.name || "")}\n<pre>${bar} ${pct.toFixed(2)}%</pre>`;
  });
  return ctx.reply(`${tge("SCROLL","📜")} <b>SLA Report — ${month}</b>\n\n${lines.join("\n")}\n\n<i>SLA dihitung dari uptime_history setiap snapshot.</i>`, { parse_mode: "HTML" });
});

// ── /diskcleaner (#23) ──
bot.command("diskcleaner", async (ctx) => {
  const uid = ctx.from.id;
  const args = (ctx.message.text || "").split(/\s+/).slice(1);
  const sid = args[0];
  if (!sid) return ctx.reply(`${tge("BROOM","🧹")} <b>Disk Cleaner</b>\n\nUsage: <code>/diskcleaner &lt;server_id&gt;</code>\n\nMencari file log/cache/temp yang bisa dibersihkan.`, { parse_mode: "HTML" });
  const acc = findUserPanelOrAccessible(uid, sid);
  if (!acc) return ctx.reply(`${tge("ERROR","❌")} Panel <code>${sid}</code> tidak ditemukan / tidak ada akses.`, { parse_mode: "HTML" });
  const { panel } = acc;
  if (!panel.server_identifier) return ctx.reply(`${tge("ERROR","❌")} Server identifier tidak tersedia.`);
  await ctx.reply(`${tge("HOURGLASS","⏳")} Memindai file...`);
  const sn = psn(panel);
  const dirs = ["/", "/logs", "/cache", "/tmp", "/temp"];
  const candidates = [];
  for (const dir of dirs) {
    const files = await ptero.listFiles(panel.server_identifier, dir, sn);
    files.forEach(f => {
      const a = f.attributes || f;
      const name = a.name || "";
      const isLog = /\.log$|\.log\.\d+$/i.test(name);
      const isCache = /cache|tmp|temp/i.test(name);
      const sz = Number(a.size || 0);
      if ((isLog || isCache) && sz > 1024 * 100) // > 100 KB
        candidates.push({ dir, name, sz });
    });
  }
  if (!candidates.length) return ctx.reply(`${tge("BROOM","🧹")} Tidak ada file log/cache besar yang ditemukan untuk dibersihkan.`);
  const totalMB = (candidates.reduce((s, c) => s + c.sz, 0) / 1024 / 1024).toFixed(1);
  const lines = candidates.slice(0, 15).map(c => `• <code>${c.dir}/${he(c.name)}</code> (${(c.sz/1024).toFixed(0)} KB)`);
  return ctx.reply(`${tge("BROOM","🧹")} <b>Disk Cleaner Suggestion</b>\n\nServer <code>${sid}</code> punya <b>${candidates.length}</b> file log/cache (~ <b>${totalMB} MB</b>):\n\n${lines.join("\n")}\n\n<i>Hapus manual lewat panel atau gunakan SFTP.</i>`, { parse_mode: "HTML" });
});

// ── /quota (#5) ──
bot.command("quota", async (ctx) => {
  const uid = ctx.from.id;
  const role = db.getRole(uid);
  const quota = (config.ROLE_QUOTAS || {})[role] || {};
  const usage = db.computeUserResourceUsage(uid);
  function fmt(used, max, unit) {
    if (max <= 0) return `${used} ${unit} / <b>Unlimited</b>`;
    const pct = max > 0 ? (used/max*100) : 0;
    const bar = asciiBar(used, max, 12);
    return `${used} / ${max} ${unit} (${pct.toFixed(0)}%)\n<pre>${bar}</pre>`;
  }
  const text = `${tge("BAR_CHART","📊")} <b>Quota Resource Kamu</b>\n\n👤 Role: <b>${role}</b>\n\n💾 RAM:  ${fmt(usage.ram, quota.ram || 0, "MB")}\n💿 Disk: ${fmt(usage.disk, quota.disk || 0, "MB")}\n⚙️ CPU:  ${fmt(usage.cpu, quota.cpu || 0, "%")}\n📊 Panels: <b>${usage.count} / ${quota.panels || "∞"}</b>`;
  return ctx.reply(text, { parse_mode: "HTML" });
});

// ── /chart (#11) ──
bot.command("chart", async (ctx) => {
  const uid = ctx.from.id;
  const args = (ctx.message.text || "").split(/\s+/).slice(1);
  const sid = args[0];
  if (!sid) return ctx.reply(`${tge("BAR_CHART","📊")} Usage: <code>/chart &lt;server_id&gt;</code>`, { parse_mode: "HTML" });
  const acc = findUserPanelOrAccessible(uid, sid);
  if (!acc) return ctx.reply(`${tge("ERROR","❌")} Panel tidak ditemukan / tidak ada akses.`);
  const chart = buildUsageChart(sid);
  return ctx.reply(`${tge("BAR_CHART","📊")} <b>Usage Chart</b> — <code>${sid}</code>\n\n${chart}`, { parse_mode: "HTML" });
});

// ── /webhook (#2) — REMOVED (tidak dipakai lagi) ──

// ── /suspicious (#19) — owner only ──
bot.command("suspicious", async (ctx) => {
  const uid = ctx.from.id;
  if (!isOwner(uid)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
  const list = db.getSuspiciousRecent(20);
  if (!list.length) return ctx.reply(`${tge("SUCCESS","✅")} Tidak ada aktivitas mencurigakan terbaru.`);
  const lines = list.map((s, i) => `${i+1}. <b>${he(s.type)}</b>\n   👤 <code>${s.uid}</code>\n   📝 ${he(s.detail || "-")}\n   ⏰ ${formatDate(s.ts)}`);
  return ctx.reply(`${tge("SIREN","🚨")} <b>Aktivitas Mencurigakan (20 terbaru)</b>\n\n${lines.join("\n\n")}`, { parse_mode: "HTML" });
});

// ── Background: auto-lock inactive panel (#20) ──
async function checkInactivePanels() {
  try {
    if (!config.AUTO_LOCK || !config.AUTO_LOCK.enabled) return;
    const days = config.AUTO_LOCK.days || 30;
    const inactive = db.getInactivePanels(days);
    if (!inactive.length) return;
    for (const { uid, panel } of inactive) {
      try {
        const ok = await ptero.suspendServer(panel.server_id, psn(panel));
        if (ok) {
          db.markPanelSuspended(uid, panel.server_id, true);
          db.addAuditLog({ actorId: "SYSTEM", action: "Auto-lock Inactive", target: panel.server_id, detail: `inactive ${days}+ days` });
          try { await bot.telegram.sendMessage(uid, `${tge("LOCK","🔒")} <b>Panel Auto-locked</b>\n\nPanel <code>${panel.server_id}</code> (<b>${he(panel.name)}</b>) di-suspend otomatis karena tidak aktif >${days} hari. Hubungi owner untuk membuka.`, { parse_mode: "HTML" }); } catch {}
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { botLog("ERROR", "AUTO_LOCK", "Inactive scan gagal", e); }
}

// ── Background: monthly SLA report (#13) ──
async function checkMonthlySlaReport() {
  try {
    const now = new Date();
    if (now.getDate() !== 1) return; // hanya tanggal 1
    const monthYear = now.toISOString().slice(0, 7);
    if (db.getLastSlaReport() === monthYear) return;
    const allPanels = db.getAllPanels();
    if (!allPanels.length) { db.setLastSlaReport(monthYear); return; }
    let snapshot = {};
    allPanels.forEach(p => {
      const pct = db.getUptimePercent(p.server_id, 30);
      snapshot[p.server_id] = pct;
      db.recordSlaSnapshot(p.server_id, pct);
    });
    db.setLastSlaReport(monthYear);
    // Kirim ke bot owner saja
    const top = Object.entries(snapshot).sort((a,b)=>a[1]-b[1]).slice(0, 10);
    const lines = top.map(([sid, pct]) => {
      const p = allPanels.find(x => String(x.server_id) === String(sid));
      return `• <code>${sid}</code> ${he(p?.name || "-")}: ${pct.toFixed(2)}%`;
    });
    const text = `${tge("SCROLL","📜")} <b>SLA Bulanan</b> — ${monthYear}\n\n10 server SLA terendah:\n${lines.join("\n")}\n\nGunakan /sla untuk lihat lengkap.`;
    for (const oid of (config.OWNER_IDS || [])) {
      try { await bot.telegram.sendMessage(oid, text, { parse_mode: "HTML" }); } catch {}
    }
  } catch (e) { botLog("ERROR", "SLA_REPORT", "Gagal generate", e); }
}

// ── Hook: server-down → coba kirim "snapshot" status console (#4) ──
const _origServerDown = typeof checkServerDown === "function" ? checkServerDown : null;
async function notifyConsoleSnapshot(panel, downSince) {
  try {
    const snap = await ptero.getConsoleLogs(panel.server_identifier, psn(panel));
    if (!snap) return null;
    const upMin = snap.uptime_ms ? Math.round(snap.uptime_ms / 60000) : 0;
    return `${tge("CAMERA","📸")} <b>Console Snapshot</b>\n<pre>state    : ${snap.state}\nCPU      : ${snap.cpu.toFixed(1)} %\nRAM used : ${snap.ram_mb} MB\nDisk used: ${snap.disk_mb} MB\nNet RX   : ${(snap.net_rx/1024/1024).toFixed(1)} MB\nNet TX   : ${(snap.net_tx/1024/1024).toFixed(1)} MB\nUptime   : ${upMin} min</pre>`;
  } catch { return null; }
}
// expose ke global agar dipakai di checkServerDown notif (lihat features.js bila ada)
global.__notifyConsoleSnapshot = notifyConsoleSnapshot;


// ─── /panel — shortcut buat panel biasa ──────────────────────────────────────
bot.command("panel", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /panel`);
  const role = db.getRole(userId);

  const panelLimit = getPanelLimit(role);
  const panelCount = db.getPanelCount(userId);
  const dailyLimit = getDailyLimit(role);
  const dailyCount = db.getDailyCount(userId);

  if (panelLimit === 0)
    return ctx.reply(`${tge("ERROR","❌")} Role kamu belum punya akses buat panel.\n${tge("ADMISSION","🎟️")} Redeem voucher untuk upgrade role!`, { parse_mode: "HTML" });
  if (panelCount >= panelLimit && panelLimit !== 9999)
    return ctx.reply(`${tge("ERROR","❌")} Kamu sudah mencapai batas <b>${panelLimit} panel</b>.\n\nHubungi owner untuk perpanjang atau hapus panel.`, { parse_mode: "HTML" });
  if (dailyLimit < 9999 && dailyCount >= dailyLimit)
    return ctx.reply(`${tge("ERROR","❌")} Kamu sudah membuat <b>${dailyCount}</b> panel hari ini.\nBatas harian: <b>${dailyLimit}</b> panel.\n\nCoba lagi besok!`, { parse_mode: "HTML" });

  if (role === "reseller") {
    const limCheck = db.checkResellerLimit(userId);
    if (!limCheck.ok) {
      const msgs = {
        no_limit:     `${tge("ERROR","❌")} Kamu belum memiliki limit panel.\n\nHubungi owner untuk mendapatkan limit.`,
        expired:      `${tge("ERROR","❌")} Limit panel kamu sudah <b>kadaluarsa</b>.\n\nHubungi owner untuk perpanjang.`,
        no_count:     `${tge("ERROR","❌")} Limit panel kamu <b>habis</b> (0 slot tersisa).\n\nHubungi owner untuk tambah limit.`,
        invalid_date: `${tge("ERROR","❌")} Tanggal limit tidak valid. Hubungi owner.`,
      };
      return ctx.reply(msgs[limCheck.reason] || `${tge("ERROR","❌")} Limit reseller tidak valid.`, { parse_mode: "HTML" });
    }
  }

  const s = getState(userId);
  s.panel_type = "biasa";

  const allowed = allowedServers(role);
  if (allowed.length > 1) {
    s.step = "pick_server";
    const labels = allowed.map(n => `• <b>${he2(serverLabel(n))}</b>`).join("\n");
    return ctx.reply(
      `${tge("DESKTOP","🖥️")} <b>Pilih Server Panel</b>\n\n${tge("MASK","🎭")} Tipe: <b>${tge("DESKTOP","🖥️")} Panel Biasa</b>\n\nServer tersedia:\n${labels}\n\nPilih server tempat panel akan dibuat:`,
      { parse_mode: "HTML", ...serverPickerKeyboard(role, "pick_srv_") }
    );
  }
  s.server_num = allowed[0] || 1;
  s.step = "username";
  return ctx.reply(
    `${tge("DESKTOP","🖥️")} <b>Buat Panel Baru</b>\n\n${tge("MASK","🎭")} Tipe: <b>${tge("DESKTOP","🖥️")} Panel Biasa</b>\n${tge("GLOBE","🌐")} Server: <b>${he2(serverLabel(s.server_num))}</b>\n\n${tge("USER","👤")} Masukkan <b>username</b> yang diinginkan\n(huruf kecil, angka, underscore):`,
    { parse_mode: "HTML", ...cancelKeyboard() }
  );
});

// ─── /admin — shortcut buat admin panel ──────────────────────────────────────
bot.command("admin", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /admin`);
  const role = db.getRole(userId);

  if (!["premium", "owner"].includes(role))
    return ctx.reply(`${tge("ERROR","❌")} Hanya <b>Premium</b> & <b>Owner</b> yang bisa membuat Admin Panel.`, { parse_mode: "HTML" });

  const panelLimit = getPanelLimit(role);
  const panelCount = db.getPanelCount(userId);
  const dailyLimit = getDailyLimit(role);
  const dailyCount = db.getDailyCount(userId);

  if (panelLimit === 0)
    return ctx.reply(`${tge("ERROR","❌")} Role kamu belum punya akses buat panel.`, { parse_mode: "HTML" });
  if (panelCount >= panelLimit && panelLimit !== 9999)
    return ctx.reply(`${tge("ERROR","❌")} Kamu sudah mencapai batas <b>${panelLimit} panel</b>.\n\nHubungi owner untuk perpanjang atau hapus panel.`, { parse_mode: "HTML" });
  if (dailyLimit < 9999 && dailyCount >= dailyLimit)
    return ctx.reply(`${tge("ERROR","❌")} Kamu sudah membuat <b>${dailyCount}</b> panel hari ini.\nBatas harian: <b>${dailyLimit}</b> panel.\n\nCoba lagi besok!`, { parse_mode: "HTML" });

  const s = getState(userId);
  s.panel_type = "admin";

  const allowed = allowedServers(role);
  if (allowed.length > 1) {
    s.step = "pick_server";
    const labels = allowed.map(n => `• <b>${he2(serverLabel(n))}</b>`).join("\n");
    return ctx.reply(
      `${tge("DESKTOP","🖥️")} <b>Pilih Server Panel</b>\n\n${tge("MASK","🎭")} Tipe: <b>${tge("CROWN","👑")} Admin Panel</b>\n\nServer tersedia:\n${labels}\n\nPilih server tempat panel akan dibuat:`,
      { parse_mode: "HTML", ...serverPickerKeyboard(role, "pick_srv_") }
    );
  }
  s.server_num = allowed[0] || 1;
  s.step = "username";
  return ctx.reply(
    `${tge("DESKTOP","🖥️")} <b>Buat Admin Panel</b>\n\n${tge("MASK","🎭")} Tipe: <b>${tge("CROWN","👑")} Admin Panel</b>\n${tge("GLOBE","🌐")} Server: <b>${he2(serverLabel(s.server_num))}</b>\n\n${tge("USER","👤")} Masukkan <b>username</b> yang diinginkan\n(huruf kecil, angka, underscore):`,
    { parse_mode: "HTML", ...cancelKeyboard() }
  );
});

// ─── /listsrvon — daftar server yang aktif/ON (paginated + real-time) ────────
bot.command("listsrvon", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /listsrvon`);
  if (!isOwner(userId)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
  const sAdm = getState(userId);
  const srvNum = sAdm.admin_srv || 1;
  await handleLsrvPow(ctx, userId, srvNum, 1, "n");
});

// ─── /listsrvoff — daftar server yang mati/OFF/suspended (paginated + real-time)
bot.command("listsrvoff", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /listsrvoff`);
  if (!isOwner(userId)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
  const sAdm = getState(userId);
  const srvNum = sAdm.admin_srv || 1;
  await handleLsrvPow(ctx, userId, srvNum, 1, "f");
});

// ─── handleLsrv — paginated list server (overview) ────────────────────────────
async function handleLsrv(ctx, userId, srvNum, page) {
  const isEdit = !!ctx.callbackQuery;
  const loadMsg = `${tge("HOURGLASS","⏳")} <b>Memuat halaman ${page}...</b>\n<i>Server: ${he2(serverLabel(srvNum))}</i>`;
  if (isEdit) await safeEdit(ctx, loadMsg, { parse_mode: "HTML" });
  else await ctx.reply(loadMsg, { parse_mode: "HTML" });

  const result = await ptero.listServersPage(srvNum, page, 50);
  if (!result.servers.length && result.totalCount === 0) {
    const msg = `${tge("EMPTY_BOX","📭")} Tidak ada server di panel ${he2(serverLabel(srvNum))}.`;
    return isEdit ? safeEdit(ctx, msg, backKeyboard()) : ctx.reply(msg, backKeyboard());
  }

  const servers = result.servers;
  const suspended  = servers.filter(sv => sv.attributes.suspended).length;
  const installing = servers.filter(sv => sv.attributes.status === "installing").length;
  const failed     = servers.filter(sv => sv.attributes.status === "install_failed").length;
  const active     = servers.length - suspended - installing - failed;

  const s = getState(userId);
  s.lsrv_page = page; s.lsrv_srv = srvNum;

  let text =
    `🖥️ <b>List Server — ${he2(serverLabel(srvNum))}</b>\n` +
    `📄 Halaman: <b>${result.currentPage}</b>/${result.totalPages} | Total: <b>${result.totalCount}</b> server\n` +
    `🟢 Aktif: <b>${active}</b>  •  🔒 Suspended: <b>${suspended}</b>  •  ⚙️ Installing: <b>${installing}</b>  •  ❌ Failed: <b>${failed}</b>\n\n`;

  servers.forEach((sv, idx) => {
    const a   = sv.attributes;
    const icon = srvStatusIcon(a);
    const no  = (page - 1) * 50 + idx + 1;
    const ram  = a.limits?.memory || 0;
    const disk = a.limits?.disk   || 0;
    const cpu  = a.limits?.cpu    || 0;
    const alloc = (a.relationships?.allocations?.data || [])[0]?.attributes;
    const ipPort = alloc ? `${alloc.ip}:${alloc.port}` : "-";
    text += `${no}. ${icon} <b>${he((a.name || "N/A").slice(0,30))}</b>\n`;
    text += `    🆔 <code>${a.id}</code>  🔑 <code>${a.identifier || "-"}</code>  🌐 ${he(ipPort)}\n`;
    text += `    💾 ${ram}MB  •  💿 ${disk}MB  •  ⚙️ ${cpu}%\n\n`;
    if (text.length > 3800) { text += `<i>... (${servers.length - idx - 1} server berikutnya, gunakan Next)</i>\n`; return; }
  });

  const rows = [];
  const navRow = [];
  if (result.currentPage > 1)              navRow.push(Markup.button.callback("◀ Prev", `lsrv_${srvNum}_${result.currentPage - 1}`));
  navRow.push(Markup.button.callback(`${result.currentPage}/${result.totalPages} | ${result.totalCount}`, "srv_noop"));
  if (result.currentPage < result.totalPages) navRow.push(Markup.button.callback("Next ▶", `lsrv_${srvNum}_${result.currentPage + 1}`));
  rows.push(navRow);

  // Quick page jump (setiap 10 halaman)
  if (result.totalPages > 5) {
    const jumpRow = [];
    if (result.currentPage > 5)  jumpRow.push(Markup.button.callback("⏮ Hal.1", `lsrv_${srvNum}_1`));
    if (result.currentPage < result.totalPages - 4) jumpRow.push(Markup.button.callback(`⏭ Hal.${result.totalPages}`, `lsrv_${srvNum}_${result.totalPages}`));
    if (jumpRow.length) rows.push(jumpRow);
  }

  rows.push([
    Markup.button.callback("⚡ Cek Power State", `lsrvpow_${srvNum}_${result.currentPage}_a`),
    Markup.button.callback("♻️ Refresh", `lsrv_${srvNum}_${result.currentPage}`),
  ]);
  rows.push([Markup.button.callback("◀️ Kembali", "back_main")]);

  const keyboard = Markup.inlineKeyboard(rows);
  if (text.length > 4096) text = text.slice(0, 4000) + `\n<i>... (terpotong)</i>`;
  return isEdit ? safeEdit(ctx, text, { parse_mode: "HTML", ...keyboard })
                : ctx.reply(text, { parse_mode: "HTML", ...keyboard });
}

// ─── handleLsrvPow — paginated ON/OFF real-time power state check ─────────────
async function handleLsrvPow(ctx, userId, srvNum, page, filt = "a") {
  const filtLabels = { a: "Semua + Power State", n: "🟢 ON / Running", f: "🔴 OFF / Stopped" };
  const isEdit = !!ctx.callbackQuery;
  const loadMsg =
    `${tge("HOURGLASS","⏳")} <b>Mengambil halaman ${page}...</b>\n` +
    `📡 Filter: <b>${filtLabels[filt] || "Semua"}</b>\n` +
    `<i>Memeriksa status power real-time via Pterodactyl API...</i>`;
  if (isEdit) await safeEdit(ctx, loadMsg, { parse_mode: "HTML" });
  else await ctx.reply(loadMsg, { parse_mode: "HTML" });

  const result = await ptero.listServersPage(srvNum, page, 50);
  if (!result.servers.length && result.totalCount === 0) {
    const msg = `${tge("EMPTY_BOX","📭")} Tidak ada server di panel ${he2(serverLabel(srvNum))}.`;
    return isEdit ? safeEdit(ctx, msg, backKeyboard()) : ctx.reply(msg, backKeyboard());
  }

  const servers = result.servers;
  const notSuspended = servers.filter(sv => !sv.attributes.suspended && sv.attributes.status !== "install_failed");

  const BATCH = 30;
  const fetchBatch = notSuspended.slice(0, BATCH);
  const resResults = await Promise.allSettled(
    fetchBatch.map(sv => ptero.getServerResources(sv.attributes.identifier, srvNum))
  );
  const stateMap = {};
  fetchBatch.forEach((sv, i) => {
    const r = resResults[i];
    stateMap[sv.attributes.identifier] =
      (r.status === "fulfilled" && r.value) ? (r.value.current_state || "unknown") : "unknown";
  });

  const filterName = { a: "📋 Semua (Power State)", n: "🟢 ON/Running", f: "🔴 OFF/Stopped/Suspended" }[filt] || "Semua";
  let text =
    `${filterName} — <b>${he2(serverLabel(srvNum))}</b>\n` +
    `📄 Hal. <b>${result.currentPage}</b>/${result.totalPages} | Total: <b>${result.totalCount}</b>\n` +
    `<i>⚡ Power state real-time (${BATCH} server dicek per hal.)</i>\n\n`;

  let shown = 0;
  servers.forEach((sv, idx) => {
    if (text.length > 3800) return;
    const a = sv.attributes;
    const isSusp = a.suspended || a.status === "install_failed";
    const powerState = isSusp
      ? (a.status === "install_failed" ? "install_failed" : "suspended")
      : (stateMap[a.identifier] || "unknown");

    const isRunning = ["running", "starting", "unknown"].includes(powerState);
    const isStopped = ["stopped", "stopping", "suspended", "install_failed"].includes(powerState);
    if (filt === "n" && !isRunning) return;
    if (filt === "f" && !isStopped) return;

    const pwIcon = powerState === "running"       ? "🟢"
                 : powerState === "starting"      ? "🟡"
                 : powerState === "stopping"      ? "🟠"
                 : powerState === "stopped"       ? "🔴"
                 : powerState === "suspended"     ? "🔒"
                 : powerState === "install_failed"? "❌"
                 : "⚪";

    const no = (page - 1) * 50 + idx + 1;
    text += `${no}. ${pwIcon} <b>${he((a.name || "N/A").slice(0, 30))}</b>\n`;
    text += `    🆔 <code>${a.id}</code>  •  <b>${powerState}</b>\n\n`;
    shown++;
  });

  if (shown === 0) {
    const tips = filt === "n" ? "Tidak ada server ON di hal. ini. Gunakan Next atau ganti filter." :
                 filt === "f" ? "Tidak ada server OFF/Suspended di hal. ini. Gunakan Next." :
                                "Tidak ada server di halaman ini.";
    text += `<i>${tips}</i>\n`;
  }

  const rows = [];
  const navRow = [];
  if (result.currentPage > 1)              navRow.push(Markup.button.callback("◀ Prev", `lsrvpow_${srvNum}_${result.currentPage-1}_${filt}`));
  navRow.push(Markup.button.callback(`${result.currentPage}/${result.totalPages}`, "srv_noop"));
  if (result.currentPage < result.totalPages) navRow.push(Markup.button.callback("Next ▶", `lsrvpow_${srvNum}_${result.currentPage+1}_${filt}`));
  rows.push(navRow);

  if (result.totalPages > 5) {
    const jumpRow = [];
    if (result.currentPage > 5) jumpRow.push(Markup.button.callback("⏮ Hal.1", `lsrvpow_${srvNum}_1_${filt}`));
    if (result.currentPage < result.totalPages-4) jumpRow.push(Markup.button.callback(`⏭ Hal.${result.totalPages}`, `lsrvpow_${srvNum}_${result.totalPages}_${filt}`));
    if (jumpRow.length) rows.push(jumpRow);
  }

  rows.push([
    Markup.button.callback("🟢 ON",  `lsrvpow_${srvNum}_${result.currentPage}_n`),
    Markup.button.callback("🔴 OFF", `lsrvpow_${srvNum}_${result.currentPage}_f`),
    Markup.button.callback("📋 Semua", `lsrvpow_${srvNum}_${result.currentPage}_a`),
  ]);
  rows.push([
    Markup.button.callback("♻️ Refresh", `lsrvpow_${srvNum}_${result.currentPage}_${filt}`),
    Markup.button.callback("📄 List", `lsrv_${srvNum}_${result.currentPage}`),
    Markup.button.callback("◀️ Menu", "back_main"),
  ]);

  if (text.length > 4096) text = text.slice(0, 4000) + `\n<i>... (terpotong)</i>`;
  const keyboard = Markup.inlineKeyboard(rows);
  return isEdit ? safeEdit(ctx, text, { parse_mode: "HTML", ...keyboard })
                : ctx.reply(text, { parse_mode: "HTML", ...keyboard });
}

// ─── Launch ───────────────────────────────────────────────────────────────────

// ─── Owner: Monitor Commands ─────────────────────────────────────────────────
  bot.command("monitorstatus", async (ctx) => {
    if (!isOwner(ctx.from?.id)) return;
    monitor.resetNotified();
    return ctx.reply(
      `✅ <b>Panel Monitor</b>\n\n` +
      `Cache server & user direset.\n` +
      `Scan berikutnya akan melaporkan ulang semua yang ditemukan manual.\n` +
      `(Cache admin tetap — tidak spam notif admin lama)`,
      { parse_mode: "HTML" }
    );
  });

  bot.command("monitoradmin", async (ctx) => {
    if (!isOwner(ctx.from?.id)) return;
    monitor.resetAdminCache();
    return ctx.reply(
      `🔄 <b>Admin Cache Direset</b>\n\n` +
      `Scan admin akan jalan ulang dari awal.\n` +
      `Semua admin aktif akan dipelajari ulang saat scan berikutnya.`,
      { parse_mode: "HTML" }
    );
  });

  // ─── /setbw — set bandwidth limit per server ──────────────────────────────
  bot.command("setbw", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isOwner(userId)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    if (args.length < 2) {
      return ctx.reply(
        `📡 <b>Set Bandwidth Limit Per Server</b>\n\n` +
        `Cara pakai:\n<code>/setbw &lt;server_id&gt; &lt;limit_GB&gt;</code>\n\n` +
        `Contoh: <code>/setbw 42 100</code> → server ID 42 dibatasi 100 GB/bulan\n` +
        `<code>/setbw 42 0</code> → hapus limit (unlimited)\n\n` +
        `ℹ️ Gunakan /listpanel untuk cari server_id`,
        { parse_mode: "HTML" }
      );
    }
    const serverId = args[0];
    const limitGb  = parseFloat(args[1]);
    if (isNaN(limitGb) || limitGb < 0) {
      return ctx.reply(`${tge("ERROR","❌")} Limit GB tidak valid. Masukkan angka ≥ 0 (0 = unlimited).`);
    }
    // Cari panel record berdasarkan server_id
    const rec = db.getPanelByServerId(serverId);
    if (!rec) return ctx.reply(`${tge("ERROR","❌")} Server ID <code>${serverId}</code> tidak ditemukan di database bot.`, { parse_mode: "HTML" });

    const ok = db.setPanelBandwidthLimit(rec.ownerUserId, serverId, limitGb);
    if (!ok) return ctx.reply(`${tge("ERROR","❌")} Gagal update limit. Cek server_id.`);
    db.addAuditLog({ actorId: String(userId), action: "Set Bandwidth Limit", target: serverId, detail: `${limitGb} GB/bulan` });
    const msg = limitGb === 0
      ? `✅ Bandwidth limit server <code>${serverId}</code> (<b>${rec.name}</b>) dihapus — <b>unlimited</b>.`
      : `✅ Bandwidth limit server <code>${serverId}</code> (<b>${rec.name}</b>) diset <b>${limitGb} GB/bulan</b>.\n\nServer akan di-${config.OVER_RESOURCE_ACTION === "delete" ? "hapus" : "suspend"} otomatis jika melebihi kuota.`;
    return ctx.reply(msg, { parse_mode: "HTML" });
  });

  // ─── /resetbw — reset bandwidth counter bulanan per server ────────────────
  bot.command("resetbw", async (ctx) => {
    const userId = ctx.from?.id;
    if (!isOwner(userId)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
    const args = ctx.message.text.trim().split(/\s+/).slice(1);
    if (!args.length) {
      return ctx.reply(
        `📡 <b>Reset Bandwidth Counter</b>\n\nCara pakai:\n<code>/resetbw &lt;server_id&gt;</code>\n\nMereset hitungan bandwidth bulanan server ke nol.`,
        { parse_mode: "HTML" }
      );
    }
    const serverId = args[0];
    db.resetBandwidthTracking(serverId);
    db.clearResourceAlert(serverId, "over_bandwidth");
    db.addAuditLog({ actorId: String(userId), action: "Reset Bandwidth Counter", target: serverId });
    return ctx.reply(`✅ Bandwidth counter server <code>${serverId}</code> direset ke nol.`, { parse_mode: "HTML" });
  });

  bot.launch().then(() => {
  logger.sys("LAUNCH", `${tge("SUCCESS","✅")} Bot "${config.BOT_NAME}" berhasil dijalankan!`);
  logger.info("LAUNCH", `Expire check setiap ${config.EXPIRE_CHECK_HOURS} jam | Node check setiap ${config.NODE_CHECK_INTERVAL_MINUTES} menit`);

  // Pengecekan expired panel
  checkExpiredPanels();
  setInterval(checkExpiredPanels, config.EXPIRE_CHECK_HOURS * 60 * 60 * 1000);

  // Node monitoring
  if (config.NODE_CHECK_INTERVAL_MINUTES > 0) {
    setTimeout(checkNodeStatus, 60 * 1000);
    setInterval(checkNodeStatus, config.NODE_CHECK_INTERVAL_MINUTES * 60 * 1000);
  }

  // Over-resource monitoring
  if (config.RESOURCE_CHECK_INTERVAL_MINUTES > 0 && config.OVER_RESOURCE_ACTION && config.OVER_RESOURCE_ACTION !== "none") {
    logger.info("LAUNCH", `Resource check aktif: setiap ${config.RESOURCE_CHECK_INTERVAL_MINUTES} menit, aksi="${config.OVER_RESOURCE_ACTION}"`);
    setTimeout(checkOverResource, 2 * 60 * 1000); // cek pertama 2 menit setelah bot start
    setInterval(checkOverResource, config.RESOURCE_CHECK_INTERVAL_MINUTES * 60 * 1000);
  }

  // Server down detection
  if (config.SERVER_DOWN_CHECK_INTERVAL_MINUTES > 0) {
    logger.info("LAUNCH", `Server down check aktif: setiap ${config.SERVER_DOWN_CHECK_INTERVAL_MINUTES} menit`);
    setTimeout(checkServerDown, 2 * 60 * 1000); // mulai setelah 2 menit (beri waktu warm-up)
    setInterval(checkServerDown, config.SERVER_DOWN_CHECK_INTERVAL_MINUTES * 60 * 1000);
  }

  // Daily report — cek setiap jam
  setInterval(checkDailyReport, 60 * 60 * 1000);
  checkDailyReport();

  // Auto Backup — polling setiap 5 menit
  setInterval(checkAutoBackup, 5 * 60 * 1000);

  // Auto-lock inactive panel — cek setiap 12 jam (#20)
  if (config.AUTO_LOCK && config.AUTO_LOCK.enabled) {
    logger.info("LAUNCH", `Auto-lock aktif: panel inactive >${config.AUTO_LOCK.days} hari akan di-suspend.`);
    setTimeout(checkInactivePanels, 5 * 60 * 1000);
    setInterval(checkInactivePanels, 12 * 60 * 60 * 1000);
  }

  // Monthly SLA report — cek setiap 6 jam (akan jalan tgl 1 saja) (#13)
  setTimeout(checkMonthlySlaReport, 10 * 60 * 1000);
  setInterval(checkMonthlySlaReport, 6 * 60 * 60 * 1000);

  // ── Panel Monitor (deteksi pembuatan manual) ───────────────────────
  try {
    monitor.startMonitor(bot);
  } catch (e) { logger.log("ERROR", "MONITOR", "Gagal start monitor", e); }
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

// ═══════════════════════════════════════════════════════════════════════════════
//  FITUR TAMBAHAN — OWNER TOOLS & CONVERT COMMANDS
// ═══════════════════════════════════════════════════════════════════════════════

// ─── /cekserver [1/2/3] — info lengkap panel pterodactyl ─────────────────────
bot.command("cekserver", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /cekserver`);
  if (!isOwner(userId)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const srvNum = parseInt(args[0]) || getState(userId).admin_srv || 1;
  if (![1, 2, 3].includes(srvNum))
    return ctx.reply(`${tge("ERROR","❌")} Nomor server tidak valid. Gunakan: /cekserver 1\n(Tersedia: 1, 2, 3)`);

  const loadMsg = await ctx.reply(`${tge("HOURGLASS","⏳")} <b>Mengambil info Server ${srvNum}...</b>`, { parse_mode: "HTML" });

  const [result, nodes] = await Promise.allSettled([
    ptero.listServersPage(srvNum, 1, 1),
    ptero.getNodes(srvNum),
  ]);

  const res    = result.status === "fulfilled" ? result.value : { totalCount: 0, totalPages: 0, currentPage: 1 };
  const nodeList = nodes.status === "fulfilled" ? (nodes.value || []) : [];

  const upNodes   = nodeList.filter(n => n.attributes?.public !== false).length;
  const totalCap  = nodeList.reduce((s, n) => s + (n.attributes?.memory_overallocate || 0), 0);

  const text =
    `🖥️ <b>Info Panel — ${he2(serverLabel(srvNum))}</b>\n\n` +
    `📊 <b>Total Server:</b> <code>${res.totalCount.toLocaleString()}</code>\n` +
    `📄 <b>Total Halaman API:</b> <code>${res.totalPages}</code> (50 srv/hal)\n\n` +
    `🖥️ <b>Total Node:</b> <code>${nodeList.length}</code>\n` +
    `🟢 <b>Node Publik:</b> <code>${upNodes}</code>\n\n` +
    `<i>Gunakan /listserver untuk lihat daftar lengkap server.</i>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("♻️ Refresh", `ceksrv_${srvNum}`),
      Markup.button.callback("📑 List Server", `lsrv_${srvNum}_1`),
    ],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);

  try { await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch {}
  return ctx.reply(text, { parse_mode: "HTML", ...keyboard });
});

// ─── /totalserver [1/2/3] — total server di panel ────────────────────────────
bot.command("totalserver", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /totalserver`);
  if (!isOwner(userId)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const srvNum = parseInt(args[0]) || getState(userId).admin_srv || 1;
  if (![1, 2, 3].includes(srvNum))
    return ctx.reply(`${tge("ERROR","❌")} Nomor server tidak valid. Contoh: /totalserver 1`);

  const loadMsg = await ctx.reply(`${tge("HOURGLASS","⏳")} Mengambil total server...`);
  const result = await ptero.listServersPage(srvNum, 1, 1);
  try { await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch {}

  return ctx.reply(
    `📊 <b>Total Server — ${he2(serverLabel(srvNum))}</b>\n\n` +
    `🖥️ <b>Total Server:</b> <code>${result.totalCount.toLocaleString()}</code> server\n` +
    `📄 <b>Total Halaman API:</b> <code>${result.totalPages}</code> (50 server per halaman)\n\n` +
    `<i>Gunakan /listserver untuk lihat daftar lengkap.</i>`,
    { parse_mode: "HTML" }
  );
});

// ─── /servercpu [1/2/3] — cek server dengan CPU usage tertinggi ───────────────
bot.command("servercpu", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /servercpu`);
  if (!isOwner(userId)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
  const args = ctx.message.text.trim().split(/\s+/).slice(1);
  const srvNum = parseInt(args[0]) || getState(userId).admin_srv || 1;
  if (![1, 2, 3].includes(srvNum))
    return ctx.reply(`${tge("ERROR","❌")} Nomor server tidak valid. Contoh: /servercpu 1`);

  const loadMsg = await ctx.reply(
    `${tge("HOURGLASS","⏳")} <b>Mengambil CPU usage server...</b>\n<i>Memeriksa resource tiap server secara real-time (bisa 15-30 detik)...</i>`,
    { parse_mode: "HTML" }
  );

  const result = await ptero.listServersPage(srvNum, 1, 30);
  const servers = result.servers;
  if (!servers.length) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch {}
    return ctx.reply(`${tge("EMPTY_BOX","📭")} Tidak ada server di panel ${he2(serverLabel(srvNum))}.`);
  }

  const notSusp = servers.filter(sv => !sv.attributes.suspended && sv.attributes.status !== "install_failed");
  const CHECK_BATCH = 20;
  const batch = notSusp.slice(0, CHECK_BATCH);

  const resResults = await Promise.allSettled(
    batch.map(sv => ptero.getServerResources(sv.attributes.identifier, srvNum))
  );

  const cpuData = [];
  batch.forEach((sv, i) => {
    const r = resResults[i];
    if (r.status === "fulfilled" && r.value) {
      const resources = r.value.resources || {};
      cpuData.push({
        name:       sv.attributes.name || "N/A",
        id:         sv.attributes.id,
        identifier: sv.attributes.identifier,
        cpu:        resources.cpu_absolute || 0,
        ram:        Math.round((resources.memory_bytes || 0) / 1024 / 1024),
        disk:       Math.round((resources.disk_bytes   || 0) / 1024 / 1024),
        state:      r.value.current_state || "unknown",
      });
    }
  });

  cpuData.sort((a, b) => b.cpu - a.cpu);

  try { await ctx.telegram.deleteMessage(ctx.chat.id, loadMsg.message_id); } catch {}

  if (!cpuData.length)
    return ctx.reply(`${tge("EMPTY_BOX","📭")} Tidak ada data CPU yang tersedia saat ini.`);

  let text =
    `⚙️ <b>Top CPU Usage — ${he2(serverLabel(srvNum))}</b>\n` +
    `<i>(${batch.length} server dicek dari ${servers.length} server di halaman 1)</i>\n\n`;

  cpuData.slice(0, 15).forEach((d, i) => {
    const stIcon = d.state === "running" ? "🟢" : d.state === "stopped" ? "🔴" : "⚪";
    const bar = "█".repeat(Math.min(10, Math.round(d.cpu / 10))) + "░".repeat(Math.max(0, 10 - Math.round(d.cpu / 10)));
    text +=
      `${i+1}. ${stIcon} <b>${he(d.name.slice(0, 25))}</b>\n` +
      `    ⚙️ CPU: <b>${d.cpu.toFixed(1)}%</b>  |${bar}|\n` +
      `    💾 RAM: ${d.ram}MB  •  💿 Disk: ${d.disk}MB\n` +
      `    🆔 <code>${d.id}</code>\n\n`;
  });

  return ctx.reply(text, { parse_mode: "HTML" });
});

// ─── /listserver — alias for list server paginated ───────────────────────────
bot.command(["listserver", "listservers"], async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /listserver`);
  if (!isOwner(userId)) return ctx.reply(`${tge("LOCK","🔒")} Hanya Owner.`);
  const srvNum = getState(userId).admin_srv || 1;
  await handleLsrv(ctx, userId, srvNum, 1);
});

// ─── ceksrv_ callback ────────────────────────────────────────────────────────
bot.action(/^ceksrv_\d+$/, async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  if (!isOwner(userId)) return;
  const srvNum = parseInt(ctx.match[0].split("_")[1]) || 1;
  const [result, nodes] = await Promise.allSettled([
    ptero.listServersPage(srvNum, 1, 1),
    ptero.getNodes(srvNum),
  ]);
  const res      = result.status === "fulfilled" ? result.value : { totalCount: 0, totalPages: 0 };
  const nodeList = nodes.status === "fulfilled"  ? (nodes.value || []) : [];
  const upNodes  = nodeList.filter(n => n.attributes?.public !== false).length;

  const text =
    `🖥️ <b>Info Panel — ${he2(serverLabel(srvNum))}</b>\n\n` +
    `📊 <b>Total Server:</b> <code>${res.totalCount.toLocaleString()}</code>\n` +
    `📄 <b>Total Halaman API:</b> <code>${res.totalPages}</code>\n\n` +
    `🖥️ <b>Total Node:</b> <code>${nodeList.length}</code>\n` +
    `🟢 <b>Node Publik:</b> <code>${upNodes}</code>`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("♻️ Refresh", `ceksrv_${srvNum}`),
      Markup.button.callback("📑 List Server", `lsrv_${srvNum}_1`),
    ],
    [Markup.button.callback("◀️ Kembali", "back_main")],
  ]);
  return safeEdit(ctx, text, { parse_mode: "HTML", ...keyboard });
});

// ════════════════════════════════════════════════════════════════════════════════
//  CONVERT COMMANDS
// ════════════════════════════════════════════════════════════════════════════════

// ─── /tourl <url> — perpendek URL via TinyURL ─────────────────────────────────
bot.command("tourl", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /tourl`);
  const url = ctx.message.text.trim().split(/\s+/).slice(1).join("").trim();
  if (!url) {
    return ctx.reply(
      `🔗 <b>/tourl — Perpendek URL</b>\n\nCara pakai:\n<code>/tourl https://contoh-url-panjang.com/path?query=value</code>`,
      { parse_mode: "HTML" }
    );
  }
  if (!/^https?:\/\//i.test(url))
    return ctx.reply(`${tge("ERROR","❌")} URL harus diawali dengan <code>http://</code> atau <code>https://</code>`, { parse_mode: "HTML" });

  const wait = await ctx.reply(`${tge("HOURGLASS","⏳")} Mempersingkat URL...`);
  try {
    const resp = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`, { timeout: 10000 });
    const short = (resp.data || "").trim();
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    if (!short || !short.startsWith("http"))
      return ctx.reply(`${tge("ERROR","❌")} TinyURL gagal mempersingkat URL. Coba lagi.`);
    return ctx.reply(
      `🔗 <b>URL Diperpendek!</b>\n\n` +
      `📎 <b>Asli:</b>\n${he(url)}\n\n` +
      `✅ <b>Pendek:</b>\n<code>${short}</code>`,
      { parse_mode: "HTML" }
    );
  } catch (e) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    logger.log("ERROR", "TOURL", e.message);
    return ctx.reply(`${tge("ERROR","❌")} Gagal: ${e.message}. Pastikan URL valid dan coba lagi.`);
  }
});

// ─── /toqr <teks> — buat QR Code ─────────────────────────────────────────────
bot.command("toqr", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /toqr`);
  const text = ctx.message.text.trim().split(/\s+/).slice(1).join(" ").trim();
  if (!text) {
    return ctx.reply(
      `📷 <b>/toqr — Generate QR Code</b>\n\nCara pakai:\n<code>/toqr https://example.com</code>\natau\n<code>/toqr teks apa saja</code>`,
      { parse_mode: "HTML" }
    );
  }
  if (text.length > 2953)
    return ctx.reply(`${tge("ERROR","❌")} Teks terlalu panjang (max 2953 karakter untuk QR Code).`);

  const wait = await ctx.reply(`${tge("HOURGLASS","⏳")} Membuat QR Code...`);
  try {
    const QRCode = require("qrcode");
    const buffer = await QRCode.toBuffer(text, {
      type:           "png",
      width:          512,
      margin:         2,
      color:          { dark: "#000000", light: "#ffffff" },
      errorCorrectionLevel: "M",
    });
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    return ctx.replyWithPhoto(
      { source: buffer, filename: "qrcode.png" },
      { caption: `📷 <b>QR Code</b>\n\n📝 Isi: <code>${he(text.slice(0, 100))}${text.length > 100 ? "..." : ""}</code>`, parse_mode: "HTML" }
    );
  } catch (e) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    logger.log("ERROR", "TOQR", e.message);
    return ctx.reply(`${tge("ERROR","❌")} Gagal buat QR Code: ${e.message}`);
  }
});

// ─── /sticker — reply ke foto/gambar → convert ke WebP sticker ───────────────
bot.command("sticker", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /sticker`);
  const replied = ctx.message.reply_to_message;

  if (!replied || (!replied.photo && !replied.document)) {
    return ctx.reply(
      `🖼️ <b>/sticker — Ubah Gambar jadi Sticker</b>\n\n` +
      `Cara pakai:\n1. Reply ke sebuah foto/gambar\n2. Ketik <code>/sticker</code>\n\nBot akan mengubah foto menjadi WebP sticker (512x512).`,
      { parse_mode: "HTML" }
    );
  }

  let fileId;
  if (replied.photo) {
    fileId = replied.photo[replied.photo.length - 1].file_id;
  } else if (replied.document && replied.document.mime_type?.startsWith("image/")) {
    fileId = replied.document.file_id;
  } else {
    return ctx.reply(`${tge("ERROR","❌")} Hanya foto/gambar yang bisa diubah jadi sticker.\nReply ke foto/gambar, lalu ketik /sticker.`);
  }

  const wait = await ctx.reply(`${tge("HOURGLASS","⏳")} Mengkonversi gambar ke WebP sticker...`);
  try {
    const sharp = require("sharp");
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const imgResp = await axios.get(fileLink.href, { responseType: "arraybuffer", timeout: 30000 });
    const imgBuf  = Buffer.from(imgResp.data);

    const webpBuf = await sharp(imgBuf)
      .resize(512, 512, { fit: "inside", withoutEnlargement: false })
      .webp({ quality: 90 })
      .toBuffer();

    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    return ctx.replyWithDocument(
      { source: webpBuf, filename: "sticker.webp" },
      { caption: `🎭 <b>Sticker siap!</b>\n<i>Simpan file .webp ini, lalu kirim ke @Stickers bot untuk ditambahkan ke pack.</i>`, parse_mode: "HTML" }
    );
  } catch (e) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    logger.log("ERROR", "STICKER", e.message);
    if (e.message.includes("Cannot find module")) {
      return ctx.reply(`${tge("ERROR","❌")} Module <code>sharp</code> belum terinstall.\nJalankan: <code>npm install sharp</code> di folder bot.`, { parse_mode: "HTML" });
    }
    return ctx.reply(`${tge("ERROR","❌")} Gagal konversi: ${e.message}`);
  }
});

// ─── /toimg — reply ke sticker/WebP → convert ke PNG foto ────────────────────
bot.command("toimg", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /toimg`);
  const replied = ctx.message.reply_to_message;

  if (!replied || (!replied.sticker && !replied.document && !replied.photo)) {
    return ctx.reply(
      `🖼️ <b>/toimg — Ubah Sticker/WebP ke Foto</b>\n\n` +
      `Cara pakai:\n1. Reply ke sebuah sticker atau file .webp\n2. Ketik <code>/toimg</code>\n\nBot akan mengubahnya menjadi foto PNG.`,
      { parse_mode: "HTML" }
    );
  }

  let fileId;
  if (replied.sticker) {
    fileId = replied.sticker.file_id;
  } else if (replied.document && (replied.document.mime_type === "image/webp" || replied.document.file_name?.endsWith(".webp"))) {
    fileId = replied.document.file_id;
  } else if (replied.photo) {
    fileId = replied.photo[replied.photo.length - 1].file_id;
  } else {
    return ctx.reply(`${tge("ERROR","❌")} Reply ke sticker, file .webp, atau foto untuk dikonversi.`);
  }

  const wait = await ctx.reply(`${tge("HOURGLASS","⏳")} Mengkonversi ke PNG...`);
  try {
    const sharp = require("sharp");
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const imgResp  = await axios.get(fileLink.href, { responseType: "arraybuffer", timeout: 30000 });
    const imgBuf   = Buffer.from(imgResp.data);

    const pngBuf = await sharp(imgBuf).png().toBuffer();
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    return ctx.replyWithPhoto(
      { source: pngBuf, filename: "image.png" },
      { caption: `🖼️ <b>Berhasil dikonversi ke PNG!</b>`, parse_mode: "HTML" }
    );
  } catch (e) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    logger.log("ERROR", "TOIMG", e.message);
    if (e.message.includes("Cannot find module")) {
      return ctx.reply(`${tge("ERROR","❌")} Module <code>sharp</code> belum terinstall.\nJalankan: <code>npm install sharp</code>`, { parse_mode: "HTML" });
    }
    return ctx.reply(`${tge("ERROR","❌")} Gagal konversi: ${e.message}`);
  }
});

// ─── /tovideo — reply ke foto → convert ke MP4 video pendek ──────────────────
bot.command("tovideo", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /tovideo`);
  const replied = ctx.message.reply_to_message;

  if (!replied || (!replied.photo && !replied.document)) {
    return ctx.reply(
      `🎬 <b>/tovideo — Ubah Foto jadi Video MP4</b>\n\n` +
      `Cara pakai:\n1. Reply ke sebuah foto/gambar\n2. Ketik <code>/tovideo</code>\n\n` +
      `<i>Membutuhkan ffmpeg terinstall di server.</i>`,
      { parse_mode: "HTML" }
    );
  }

  let fileId;
  if (replied.photo) {
    fileId = replied.photo[replied.photo.length - 1].file_id;
  } else if (replied.document && replied.document.mime_type?.startsWith("image/")) {
    fileId = replied.document.file_id;
  } else {
    return ctx.reply(`${tge("ERROR","❌")} Hanya foto/gambar yang didukung. Reply ke foto lalu ketik /tovideo.`);
  }

  const wait = await ctx.reply(`${tge("HOURGLASS","⏳")} Mengkonversi gambar ke video...`);
  const { exec } = require("child_process");
  const os = require("os");
  const path = require("path");
  const fs = require("fs");

  // Cek apakah ffmpeg tersedia
  const ffmpegAvailable = await new Promise(resolve => {
    exec("ffmpeg -version", (err) => resolve(!err));
  });

  if (!ffmpegAvailable) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    return ctx.reply(
      `${tge("ERROR","❌")} <b>ffmpeg tidak ditemukan di server.</b>\n\n` +
      `Untuk menggunakan /tovideo, install ffmpeg:\n` +
      `• Ubuntu/Debian: <code>sudo apt install ffmpeg</code>\n` +
      `• CentOS: <code>sudo yum install ffmpeg</code>\n\n` +
      `<i>Alternatif: gunakan /sticker untuk konversi ke WebP.</i>`,
      { parse_mode: "HTML" }
    );
  }

  try {
    const fileLink = await ctx.telegram.getFileLink(fileId);
    const imgResp  = await axios.get(fileLink.href, { responseType: "arraybuffer", timeout: 30000 });
    const tmpImg   = path.join(os.tmpdir(), `tovideo_in_${userId}.jpg`);
    const tmpOut   = path.join(os.tmpdir(), `tovideo_out_${userId}.mp4`);
    fs.writeFileSync(tmpImg, Buffer.from(imgResp.data));

    // ffmpeg: buat video 3 detik dari 1 gambar, 25fps, libx264, resolusi even
    await new Promise((resolve, reject) => {
      exec(
        `ffmpeg -y -loop 1 -i "${tmpImg}" -c:v libx264 -t 3 -pix_fmt yuv420p -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" "${tmpOut}"`,
        { timeout: 60000 },
        (err) => err ? reject(err) : resolve()
      );
    });

    const videoBuffer = fs.readFileSync(tmpOut);
    try { fs.unlinkSync(tmpImg); fs.unlinkSync(tmpOut); } catch {}
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}

    return ctx.replyWithVideo(
      { source: videoBuffer, filename: "video.mp4" },
      { caption: `🎬 <b>Video berhasil dibuat!</b> (3 detik loop)`, parse_mode: "HTML" }
    );
  } catch (e) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    logger.log("ERROR", "TOVIDEO", e.message);
    return ctx.reply(`${tge("ERROR","❌")} Gagal konversi: ${e.message}`);
  }
});

// ─── /play <lagu> — cari di Spotify, kirim 30-sec preview ────────────────────
bot.command("play", async (ctx) => {
  const userId = ctx.from.id;
  logger.sys("CMD", `User:${userId} /play`);
  const query = ctx.message.text.trim().split(/\s+/).slice(1).join(" ").trim();

  if (!query) {
    return ctx.reply(
      `🎵 <b>/play — Putar Lagu dari Spotify</b>\n\n` +
      `Cara pakai:\n<code>/play nama lagu - artis</code>\n\nContoh:\n<code>/play Blinding Lights The Weeknd</code>\n\n` +
      `<i>Bot akan mencari di Spotify dan mengirimkan 30-detik preview (jika tersedia).\n` +
      `Isi SPOTIFY_CLIENT_ID & SPOTIFY_CLIENT_SECRET di config.js untuk mengaktifkan fitur ini.</i>`,
      { parse_mode: "HTML" }
    );
  }

  const CLIENT_ID     = config.SPOTIFY_CLIENT_ID;
  const CLIENT_SECRET = config.SPOTIFY_CLIENT_SECRET;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    // Fallback: hanya kirim link pencarian YouTube
    const ytUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const spUrl = `https://open.spotify.com/search/${encodeURIComponent(query)}`;
    return ctx.reply(
      `🎵 <b>Cari Lagu: ${he(query)}</b>\n\n` +
      `<i>Spotify API belum dikonfigurasi (isi SPOTIFY_CLIENT_ID & SECRET di config.js).</i>\n\n` +
      `🔴 <b>Cari di YouTube:</b>\n${ytUrl}\n\n` +
      `🟢 <b>Cari di Spotify:</b>\n${spUrl}`,
      { parse_mode: "HTML" }
    );
  }

  const wait = await ctx.reply(`${tge("HOURGLASS","⏳")} <b>Mencari lagu di Spotify...</b>\n🔍 <i>${he(query)}</i>`, { parse_mode: "HTML" });

  try {
    // Langkah 1: Spotify Client Credentials → access token
    const tokenResp = await axios.post(
      "https://accounts.spotify.com/api/token",
      "grant_type=client_credentials",
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 15000,
      }
    );
    const token = tokenResp.data.access_token;

    // Langkah 2: Search track
    const searchResp = await axios.get(
      `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`,
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );
    const tracks = searchResp.data?.tracks?.items || [];
    if (!tracks.length) {
      try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
      return ctx.reply(
        `${tge("EMPTY_BOX","📭")} <b>Lagu tidak ditemukan di Spotify.</b>\n\nCoba cari dengan kata kunci berbeda.\n\n` +
        `🔴 <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(query)}">Cari di YouTube</a>`,
        { parse_mode: "HTML" }
      );
    }

    const track    = tracks[0];
    const artists  = track.artists.map(a => a.name).join(", ");
    const album    = track.album?.name || "-";
    const imgUrl   = track.album?.images?.[0]?.url || null;
    const spLink   = track.external_urls?.spotify || `https://open.spotify.com/search/${encodeURIComponent(query)}`;
    const ytLink   = `https://www.youtube.com/results?search_query=${encodeURIComponent(`${track.name} ${artists}`)}`;
    const prevUrl  = track.preview_url; // 30-sec MP3, bisa null

    const caption =
      `🎵 <b>${he(track.name)}</b>\n` +
      `👤 <b>Artis:</b> ${he(artists)}\n` +
      `💿 <b>Album:</b> ${he(album)}\n\n` +
      `🔗 <a href="${spLink}">Buka di Spotify</a>  •  🔴 <a href="${ytLink}">Cari di YouTube</a>`;

    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}

    if (prevUrl) {
      // Download 30-sec preview dan kirim sebagai audio
      const audioResp = await axios.get(prevUrl, { responseType: "arraybuffer", timeout: 30000 });
      const audioBuf  = Buffer.from(audioResp.data);

      if (imgUrl) {
        // Kirim sebagai audio dengan thumbnail
        return ctx.replyWithAudio(
          { source: audioBuf, filename: `${track.name}.mp3` },
          {
            title:     track.name,
            performer: artists,
            caption:   caption + "\n\n<i>⏱️ Preview 30 detik dari Spotify</i>",
            parse_mode: "HTML",
          }
        );
      } else {
        return ctx.replyWithAudio(
          { source: audioBuf, filename: `${track.name}.mp3` },
          {
            title:      track.name,
            performer:  artists,
            caption:    caption + "\n\n<i>⏱️ Preview 30 detik dari Spotify</i>",
            parse_mode: "HTML",
          }
        );
      }
    } else {
      // Tidak ada preview URL (hak cipta) — kirim info + link
      const infoText =
        `${caption}\n\n` +
        `<i>⚠️ Preview 30 detik tidak tersedia untuk lagu ini (mungkin karena hak cipta).\n` +
        `Gunakan link di atas untuk mendengarkan.</i>`;

      if (imgUrl) {
        return ctx.replyWithPhoto(imgUrl, { caption: infoText, parse_mode: "HTML" });
      } else {
        return ctx.reply(infoText, { parse_mode: "HTML" });
      }
    }
  } catch (e) {
    try { await ctx.telegram.deleteMessage(ctx.chat.id, wait.message_id); } catch {}
    logger.log("ERROR", "PLAY", e.message);
    // Fallback ke link pencarian
    const ytLink = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    return ctx.reply(
      `${tge("ERROR","❌")} <b>Gagal terhubung ke Spotify API.</b>\n\n` +
      `<i>Error: ${he(e.message.slice(0, 100))}</i>\n\n` +
      `Coba cari manual di YouTube:\n${ytLink}`,
      { parse_mode: "HTML" }
    );
  }
});
