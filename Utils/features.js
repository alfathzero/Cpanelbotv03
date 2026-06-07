// All new features bundled into one module
const { Markup } = require("telegraf");
const { t, LANG_NAMES } = require("./i18n");

// Helper multi-server: ambil nomor server dari record panel (default 1)
function psn(panel) { return panel && panel.server_num ? Number(panel.server_num) : 1; }
// Cari nomor server dari serverId — pakai DB sebagai sumber kebenaran
function srvOfId(serverId, dbRef) {
  try {
    const rec = dbRef && dbRef.getPanelByServerId ? dbRef.getPanelByServerId(serverId) : null;
    if (rec && rec.server_num) return Number(rec.server_num);
  } catch {}
  return 1;
}

const QUARANTINE_HOURS = 24;
const RATE_LIMIT_PER_MIN = 15;
const MUTE_DURATION_MS = 5 * 60 * 1000;
const MINER_KEYWORDS = ["xmrig", "ethminer", "nbminer", "t-rex", "phoenixminer", "lolminer", "teamredminer", "ccminer", "cgminer", "bfgminer", "minerd", "cpuminer", "cryptonight", "stratum+tcp", "ethermine", "nanopool", "supportxmr", "moneroocean"];

const muteCache = new Map(); // userId -> unmute timestamp

function colorize(text, color) {
  // Telegram doesn't truly support colors but we use unicode emoji squares as visual cues
  const palette = { red: "🟥", orange: "🟧", yellow: "🟨", green: "🟩", blue: "🟦", purple: "🟪", brown: "🟫", black: "⬛", white: "⬜" };
  return `${palette[color] || ""} ${text}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return (bytes || 0) + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function applyAll(bot, db, ptero, logger, config) {
  const isOwner = (uid) => config.OWNER_IDS.map(String).includes(String(uid));
  const lang = (uid) => db.getUserLang(uid);
  const tx = (uid, k) => t(lang(uid), k);

  // ─── #2 Anti-spam Rate Limit + Device Log ────────────────────────────────
  bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (!uid) return next();
    if (isOwner(uid)) return next();

    // Mute check
    const muteUntil = muteCache.get(uid);
    if (muteUntil && Date.now() < muteUntil) {
      const remain = Math.ceil((muteUntil - Date.now()) / 1000);
      if (ctx.callbackQuery) return ctx.answerCbQuery(`⏳ Mute ${remain}s lagi.`, { show_alert: true });
      return;
    }

    // Rate limit
    if (!db.checkRateLimit(uid, RATE_LIMIT_PER_MIN)) {
      muteCache.set(uid, Date.now() + MUTE_DURATION_MS);
      logger.warn("RATE_LIMIT", `User ${uid} di-mute 5 menit (spam)`);
      if (ctx.callbackQuery) return ctx.answerCbQuery(tx(uid, "rate_limited"), { show_alert: true });
      if (ctx.message) return ctx.reply(`⚠️ ${tx(uid, "rate_limited")}\n\n🔇 Auto-mute 5 menit.`);
      return;
    }

    // Device log + last seen
    try {
      db.logDevice(uid, {
        language_code: ctx.from.language_code || "",
        username: ctx.from.username || "",
        chat_type: ctx.chat?.type || "",
      });
    } catch (_) {}

    return next();
  });

  // ─── #13 Multi-language Command ──────────────────────────────────────────
  bot.command("language", async (ctx) => {
    const uid = ctx.from.id;
    const buttons = Object.entries(LANG_NAMES).map(([code, name]) => [Markup.button.callback(name, `setlang_${code}`)]);
    await ctx.reply(tx(uid, "lang_select"), Markup.inlineKeyboard(buttons));
  });
  // (setlang_* callback ditangani di main callback_query handler)

  // ─── #11 Quick Action Inline Buttons (helper to add to notifs) ───────────
  // Exported via featureHelpers below

  // ─── #12 Server Snapshot ─────────────────────────────────────────────────
  bot.command("snapshot", async (ctx) => {
    const uid = ctx.from.id;
    const args = ctx.message.text.split(" ").slice(1);
    if (!args[0]) return ctx.reply("📸 *Server Snapshot*\n\nGunakan:\n`/snapshot save <serverID> [nama]` — simpan snapshot\n`/snapshot list <serverID>` — daftar snapshot\n`/snapshot restore <serverID> <snapID>` — restore", { parse_mode: "Markdown" });

    const action = args[0].toLowerCase();
    const serverId = args[1];
    if (!serverId) return ctx.reply("❌ Server ID wajib diisi.");

    const panel = db.getPanelByServerId(serverId);
    if (!panel || (panel.ownerUserId !== String(uid) && !isOwner(uid))) return ctx.reply("❌ Server tidak ditemukan atau bukan milik kamu.");

    if (action === "save") {
      try {
        const details = await ptero.getServerDetails(serverId, psn(panel));
        const name = args.slice(2).join(" ") || "";
        db.saveSnapshot(serverId, name, { details, savedAt: Date.now() });
        return ctx.reply(`📸 ${tx(uid, "snapshot_saved")}\n\nNama: ${name || "(otomatis)"}\nMax 5 snapshot per server (yang terlama auto-hapus).`);
      } catch (e) {
        return ctx.reply(`❌ Gagal: ${e.message}`);
      }
    }
    if (action === "list") {
      const snaps = db.getSnapshots(serverId);
      if (!snaps.length) return ctx.reply(`📸 ${tx(uid, "snapshot_none")}`);
      const text = snaps.map((s, i) => `${i + 1}. *${s.name}*\n   ID: \`${s.id}\`\n   📅 ${new Date(s.timestamp).toLocaleString("id-ID")}`).join("\n\n");
      return ctx.reply(`📸 *Snapshots (${snaps.length}/5)*\n\n${text}`, { parse_mode: "Markdown" });
    }
    if (action === "restore") {
      const snapId = args[2];
      if (!snapId) return ctx.reply("❌ Snapshot ID wajib diisi.");
      const snap = db.getSnapshot(serverId, snapId);
      if (!snap) return ctx.reply("❌ Snapshot tidak ditemukan.");
      // Restoring real env requires more API calls - for now we log and notify
      try {
        if (snap.data?.details?.attributes?.name) {
          await ptero.renameServer(serverId, snap.data.details.attributes.name, psn(panel));
        }
        db.addAuditLog({ actorId: uid, action: "Snapshot Restore", target: serverId, meta: { snapshotId: snapId } });
        return ctx.reply(`♻️ ${tx(uid, "snapshot_restored")}\n\nNama server dipulihkan dari snapshot.`);
      } catch (e) {
        return ctx.reply(`❌ Restore gagal: ${e.message}`);
      }
    }
  });

  // ─── #18 Server Review/Rating ────────────────────────────────────────────
  bot.command("review", async (ctx) => {
    const uid = ctx.from.id;
    const args = ctx.message.text.split(" ").slice(1);
    if (args.length < 2) return ctx.reply("⭐ *Review Server*\n\nFormat: `/review <serverID> <1-5> [komentar]`\nContoh: `/review abc123 5 Mantap performa stabil!`", { parse_mode: "Markdown" });

    const serverId = args[0];
    const rating = parseInt(args[1]);
    const comment = args.slice(2).join(" ");
    if (rating < 1 || rating > 5) return ctx.reply("❌ Rating harus 1-5.");
    const panel = db.getPanelByServerId(serverId);
    if (!panel || panel.ownerUserId !== String(uid)) return ctx.reply("❌ Kamu cuma bisa review panel sendiri.");

    db.addReview(uid, serverId, rating, comment);
    const stars = "⭐".repeat(rating) + "☆".repeat(5 - rating);
    return ctx.reply(`${tx(uid, "review_thanks")}\n\n${stars}\n${comment ? `💬 _${comment}_` : ""}`, { parse_mode: "Markdown" });
  });

  // ─── #19 Friend List ─────────────────────────────────────────────────────
  bot.command("friend", async (ctx) => {
    const uid = ctx.from.id;
    const args = ctx.message.text.split(" ").slice(1);
    if (!args[0]) {
      const friends = db.getFriends(uid);
      const list = friends.length ? friends.map((f, i) => `${i + 1}. \`${f}\``).join("\n") : "_Belum ada teman._";
      return ctx.reply(`🤝 *Daftar Teman* (${friends.length})\n\n${list}\n\n📝 *Perintah:*\n\`/friend add <userID>\`\n\`/friend remove <userID>\`\n\`/friend send <userID> <points>\` — kirim poin\n\`/friend panels <userID>\` — lihat panel teman`, { parse_mode: "Markdown" });
    }
    const sub = args[0].toLowerCase();
    const targetId = args[1];
    if (!targetId) return ctx.reply("❌ User ID wajib diisi.");

    if (sub === "add") {
      db.addFriend(uid, targetId);
      return ctx.reply(`${tx(uid, "friend_added")} (\`${targetId}\`)`, { parse_mode: "Markdown" });
    }
    if (sub === "remove") {
      db.removeFriend(uid, targetId);
      return ctx.reply(`${tx(uid, "friend_removed")} (\`${targetId}\`)`, { parse_mode: "Markdown" });
    }
    if (sub === "send") {
      const pts = parseInt(args[2]);
      if (!pts || pts < 1) return ctx.reply("❌ Jumlah poin tidak valid.");
      if (!db.isFriend(uid, targetId)) return ctx.reply("❌ User itu bukan teman kamu. Tambah dulu dengan `/friend add`.");
      const myPts = db.getPoints(uid);
      if (myPts < pts) return ctx.reply(`❌ Poin tidak cukup. Kamu punya ${myPts} poin.`);
      db.spendPoints(uid, pts);
      db.addPoints(targetId, pts);
      return ctx.reply(`✅ Berhasil kirim ${pts} poin ke \`${targetId}\`!`, { parse_mode: "Markdown" });
    }
    if (sub === "panels") {
      if (!db.isFriend(uid, targetId)) return ctx.reply("❌ Bukan teman.");
      const panels = db.getUserPanels(targetId);
      if (!panels || !panels.length) return ctx.reply("📭 Teman ini belum punya panel.");
      const list = panels.slice(0, 10).map((p, i) => `${i + 1}. *${p.username || p.name || p.server_id}*\n   📅 Expire: ${p.expire_date ? p.expire_date.slice(0, 10) : "-"}\n   🟢 Status: ${p.suspended ? "Suspended" : p.expired ? "Expired" : "Aktif"}`).join("\n\n");
      return ctx.reply(`👀 *Panel Teman* \`${targetId}\` (read-only)\n\n${list}`, { parse_mode: "Markdown" });
    }
  });

  // ─── #21 Bulk Operations (Owner) ─────────────────────────────────────────
  bot.command("bulk", async (ctx) => {
    const uid = ctx.from.id;
    if (!isOwner(uid)) return ctx.reply("🔒 Khusus owner.");
    const args = ctx.message.text.split(" ").slice(1);
    if (args.length < 2) return ctx.reply(`⚙️ *Bulk Operation*\n\nFormat: \`/bulk <action> <filter>\`\n\n*Actions:* restart, stop, start, suspend, unsuspend\n*Filters:* all, expired, suspended, active, role:reseller, role:premium\n\nContoh:\n\`/bulk restart all\`\n\`/bulk suspend expired\`\n\`/bulk start role:premium\``, { parse_mode: "Markdown" });

    const action = args[0].toLowerCase();
    const filter = args[1].toLowerCase();
    const validActions = ["restart", "stop", "start", "suspend", "unsuspend"];
    if (!validActions.includes(action)) return ctx.reply("❌ Action tidak valid.");

    let panels = db.getAllPanels();
    if (filter === "expired") panels = panels.filter(p => p.expired);
    else if (filter === "suspended") panels = panels.filter(p => p.suspended);
    else if (filter === "active") panels = panels.filter(p => !p.expired && !p.suspended);
    else if (filter.startsWith("role:")) {
      const r = filter.slice(5);
      panels = panels.filter(p => db.getRole(p.userId) === r);
    } else if (filter !== "all") return ctx.reply("❌ Filter tidak valid.");

    if (!panels.length) return ctx.reply("📭 Tidak ada panel yang cocok dengan filter.");

    await ctx.reply(`🔄 Menjalankan \`${action}\` pada ${panels.length} panel...`, { parse_mode: "Markdown" });
    let ok = 0, fail = 0;
    for (const p of panels) {
      try {
        if (action === "suspend") await ptero.suspendServer(p.server_id, psn(p));
          else if (action === "unsuspend") await ptero.unsuspendServer(p.server_id, psn(p));
          else await ptero.sendPowerAction(p.server_id, action, psn(p));
        ok++;
      } catch (_) { fail++; }
    }
    db.addAuditLog({ actorId: uid, action: `Bulk ${action}`, target: filter, meta: { ok, fail } });
    return ctx.reply(`${tx(uid, "bulk_done")}\n\n✅ Sukses: ${ok}\n❌ Gagal: ${fail}\n📊 Total: ${panels.length}`);
  });

  // ─── #22 Migration Assistant (Owner) ─────────────────────────────────────
  bot.command("migrate", async (ctx) => {
    const uid = ctx.from.id;
    if (!isOwner(uid)) return ctx.reply("🔒 Khusus owner.");
    const args = ctx.message.text.split(" ").slice(1);
    if (args.length < 2) return ctx.reply("🚚 *Migration Assistant*\n\nFormat: `/migrate <serverID> <newNodeID>`\n\nLihat node ID dengan: `/nodes`", { parse_mode: "Markdown" });
    const [serverId, newNodeId] = args;

    // Migrasi antar-node di Pterodactyl harus dilakukan manual via Admin Panel
    db.addAuditLog({ actorId: uid, action: "Migrate Request", target: serverId, meta: { toNode: newNodeId } });
    return ctx.reply(
      `🚚 *Permintaan Migrasi Dicatat*\n\n🖥 Server: \`${serverId}\`\n🏠 Node tujuan: \`${newNodeId}\`\n\n` +
      `⚠️ *Migrasi antar-node harus dilakukan manual* melalui Pterodactyl Admin Panel:\n\n` +
      `1. Buka Admin Panel → Servers → pilih server\n` +
      `2. Tab *Build Configuration* → ganti Node & Allocation\n` +
      `3. Reinstall jika diperlukan\n\n` +
      `📋 Request sudah dicatat di audit log.`,
      { parse_mode: "Markdown" }
    );
  });

  // ─── #25 Egg Preset Library (Owner) ──────────────────────────────────────
  bot.command("preset", async (ctx) => {
    const uid = ctx.from.id;
    const args = ctx.message.text.split(" ").slice(1);
    if (!args[0]) {
      const presets = db.getEggPresets();
      const list = presets.length ? presets.map((p, i) => `${i + 1}. *${p.name}* (\`${p.id}\`)\n   🥚 Egg: ${p.eggId} | 🪺 Nest: ${p.nestId}`).join("\n\n") : "_Belum ada preset._";
      return ctx.reply(`🥚 *Egg Preset Library*\n\n${list}\n\n📝 *Perintah:*\n\`/preset add <nama>|<nestID>|<eggID>|<ram>|<cpu>|<disk>\` (owner)\n\`/preset use <presetID>\` — pakai preset buat panel`, { parse_mode: "Markdown" });
    }
    if (args[0] === "add") {
      if (!isOwner(uid)) return ctx.reply("🔒 Khusus owner.");
      const rest = args.slice(1).join(" ").split("|").map(s => s.trim());
      if (rest.length < 6) return ctx.reply("❌ Format salah.");
      const [name, nestId, eggId, ram, cpu, disk] = rest;
      db.addEggPreset({ name, nestId: Number(nestId), eggId: Number(eggId), ram: Number(ram), cpu: Number(cpu), disk: Number(disk) });
      return ctx.reply(`✅ Preset *${name}* ditambahkan!`, { parse_mode: "Markdown" });
    }
    if (args[0] === "delete" || args[0] === "del") {
      if (!isOwner(uid)) return ctx.reply("🔒 Khusus owner.");
      db.deleteEggPreset(args[1]);
      return ctx.reply("✅ Preset dihapus.");
    }
    if (args[0] === "use") {
      const preset = db.getEggPresets().find(p => p.id === args[1]);
      if (!preset) return ctx.reply("❌ Preset tidak ditemukan.");
      return ctx.reply(`🥚 *Preset: ${preset.name}*\n\nUntuk pakai preset ini, gunakan \`/createpanel\` lalu pilih:\n• Nest ID: \`${preset.nestId}\`\n• Egg ID: \`${preset.eggId}\`\n• RAM: ${preset.ram} MB\n• CPU: ${preset.cpu}%\n• Disk: ${preset.disk} MB`, { parse_mode: "Markdown" });
    }
  });

  // ─── #34 Owner: Stats command (impersonate-like view) ────────────────────
  bot.command("viewuser", async (ctx) => {
    const uid = ctx.from.id;
    if (!isOwner(uid)) return ctx.reply("🔒 Khusus owner.");
    const targetId = ctx.message.text.split(" ")[1];
    if (!targetId) return ctx.reply("Format: `/viewuser <userID>`", { parse_mode: "Markdown" });
    const u = db.getUser(targetId) || {};
    const role = db.getRole(targetId);
    const panels = db.getUserPanels(targetId) || [];
    const points = db.getPoints(targetId);
    const dev = db.getDeviceLog(targetId);
    const ach = db.getAchievements(targetId);
    const text = `👤 *Detail User \`${targetId}\`*\n\n` +
      `🎭 Role: ${role}\n` +
      `🏠 Panel: ${panels.length}\n` +
      `⭐ Poin: ${points}\n` +
      `🏆 Achievement: ${ach.join(", ") || "-"}\n\n` +
      `📱 *Device Info*\n` +
      `🌐 Lang: ${dev?.language_code || "-"}\n` +
      `👤 Username: @${dev?.username || "-"}\n` +
      `💬 Chat: ${dev?.chat_type || "-"}\n` +
      `🕒 First seen: ${dev?.first_seen ? new Date(dev.first_seen).toLocaleString("id-ID") : "-"}\n` +
      `🕒 Last seen: ${dev?.last_seen ? new Date(dev.last_seen).toLocaleString("id-ID") : "-"}`;
    return ctx.reply(text, { parse_mode: "Markdown" });
  });

  // (qa_*, snap_save_*, bkimp_* callback semua ditangani di main callback_query handler)

  // ─── Achievements check ──────────────────────────────────────────────────
  function checkAchievements(uid, ctx) {
    const earned = [];
    const allUsers = Object.keys(db.listAllUsers());
    const idx = allUsers.indexOf(String(uid));
    if (idx >= 0 && idx < 100 && db.awardAchievement(uid, "PIONEER")) earned.push("🚀 Pioneer (User #100 pertama)");
    const panels = db.getUserPanels(uid) || [];
    if (panels.length >= 10 && db.awardAchievement(uid, "HOARDER")) earned.push("📦 Hoarder (10+ panel)");
    if (db.getPoints(uid) >= 100 && db.awardAchievement(uid, "RICH")) earned.push("💰 Rich (100+ poin)");
    if ((db.getReferralStats(uid)?.referrals?.length || 0) >= 5 && db.awardAchievement(uid, "INFLUENCER")) earned.push("🌟 Influencer (5+ referral)");
    if (db.getFriends(uid).length >= 5 && db.awardAchievement(uid, "SOCIAL")) earned.push("🤝 Social (5+ teman)");
    if (earned.length && ctx) {
      ctx.reply(`🎉 *${tx(uid, "achievement_new")}!*\n\n${earned.join("\n")}`, { parse_mode: "Markdown" }).catch(() => {});
    }
    return earned;
  }
  bot.command("achievements", async (ctx) => {
    const uid = ctx.from.id;
    checkAchievements(uid, ctx);
    const ach = db.getAchievements(uid);
    const ALL = {
      PIONEER: "🚀 Pioneer (User #100 pertama)",
      HOARDER: "📦 Hoarder (10+ panel)",
      RICH: "💰 Rich (100+ poin)",
      INFLUENCER: "🌟 Influencer (5+ referral)",
      SOCIAL: "🤝 Social (5+ teman)",
    };
    const list = Object.entries(ALL).map(([k, v]) => `${ach.includes(k) ? "✅" : "🔒"} ${v}`).join("\n");
    return ctx.reply(`🏆 *Achievements Kamu*\n\n${list}`, { parse_mode: "Markdown" });
  });

  // ─── Top consumer (#8) ───────────────────────────────────────────────────
  bot.command("topusage", async (ctx) => {
    const uid = ctx.from.id;
    if (!isOwner(uid)) return ctx.reply("🔒 Khusus owner.");
    const top = db.getTopResourceConsumers(10);
    if (!top.length) return ctx.reply("📊 Belum ada data resource (tunggu monitoring berjalan).");
    const text = top.map((p, i) => {
      const panel = db.getPanelByServerId(p.serverId);
      const name = panel?.username || panel?.name || String(p.serverId).substring(0, 8);
      return `${i + 1}. *${name}*\n   🧠 RAM: ${p.ram.toFixed(0)}% | 🔥 CPU: ${p.cpu.toFixed(0)}% | 💾 Disk: ${p.disk.toFixed(0)}%`;
    }).join("\n\n");
    return ctx.reply(`📊 *Top 10 Resource Consumer*\n\n${text}`, { parse_mode: "Markdown" });
  });

  // ─── Uptime command (#9) ─────────────────────────────────────────────────
  bot.command("uptime", async (ctx) => {
    const uid = ctx.from.id;
    const args = ctx.message.text.split(" ").slice(1);
    const serverId = args[0];
    if (!serverId) {
      // Show all panels owned by user with uptime%
      const panels = db.getUserPanels(uid) || [];
      if (!panels.length) return ctx.reply("📭 Belum punya panel.");
      const lines = panels.map(p => {
        const up = db.getUptimePercent(p.server_id, 30);
        const name = p.username || p.name || String(p.server_id).substring(0, 8);
        const upStr = up !== null ? `${up.toFixed(1)}%` : "no data";
        const emoji = up === null ? "⚪" : up >= 99 ? "🟢" : up >= 95 ? "🟡" : "🔴";
        return `${emoji} *${name}* — ${upStr}`;
      }).join("\n");
      return ctx.reply(`📈 *Uptime 30 Hari*\n\n${lines}`, { parse_mode: "Markdown" });
    }
    const up = db.getUptimePercent(serverId, 30);
    if (up === null) return ctx.reply("📭 Belum ada data uptime untuk server ini.");
    return ctx.reply(`📈 Uptime server \`${serverId}\` (30 hari): *${up.toFixed(2)}%*`, { parse_mode: "Markdown" });
  });

  // ─── Background monitoring jobs ──────────────────────────────────────────

  // #3 Anti-miner detection (every 30 min)
  async function scanMiners() {
    try {
      const panels = db.getAllPanels();
      for (const p of panels) {
        if (p.suspended) continue;
        try {
          const details = await ptero.getServerDetails(p.server_id, psn(p));
          const startup = (details?.attributes?.container?.startup_command || "").toLowerCase();
          const env = JSON.stringify(details?.attributes?.container?.environment || {}).toLowerCase();
          const blob = startup + " " + env;
          const hit = MINER_KEYWORDS.find(k => blob.includes(k));
          if (hit) {
            await ptero.suspendServer(p.server_id, psn(p));
            db.markPanelSuspended(p.userId, p.server_id, true);
            db.recordMinerAlert(p.server_id, hit);
            logger.warn("MINER", `Server ${p.server_id} suspended: ${hit}`);
            // Notify owners
            config.OWNER_IDS.forEach(oid => {
              bot.telegram.sendMessage(oid, `🚨 *MINER TERDETEKSI!*\n\n🔍 Pattern: \`${hit}\`\n🖥 Server: \`${p.server_id}\`\n👤 Owner: \`${p.userId}\`\n\n⛔ Server otomatis di-SUSPEND.`, { parse_mode: "Markdown" }).catch(() => {});
            });
            // Notify victim user
            bot.telegram.sendMessage(p.userId, tx(p.userId, "miner_detected") + `\n\nServer: \`${p.server_id}\``, { parse_mode: "Markdown" }).catch(() => {});
          }
        } catch (_) {}
      }
    } catch (e) { logger.error("MINER_SCAN", e.message); }
  }
  setInterval(scanMiners, 30 * 60 * 1000);
  setTimeout(scanMiners, 5 * 60 * 1000); // run after 5 min warm-up

  // #6/#9/#10/#29 Combined monitoring (every 3 min)
  let resourceSpikeCache = {}; // serverId -> consecutive spike count
  async function monitorAll() {
    try {
      const panels = db.getAllPanels();
      for (const p of panels) {
        if (p.suspended || p.expired) continue;
        try {
          const res = await ptero.getServerResources(p.server_identifier || p.server_id, psn(p));
          const a = res?.attributes;
          if (!a) continue;
          const state = a.current_state; // running/offline/starting
          const isUp = state === "running";

          // Uptime log
          db.logUptime(p.server_id, isUp);

          // Resource history
          const cpu = a.resources?.cpu_absolute || 0;
          const memBytes = a.resources?.memory_bytes || 0;
          const diskBytes = a.resources?.disk_bytes || 0;
          // Convert to % using panel limits (fall back to bytes display)
          const memMB = memBytes / 1048576;
          const ramPct = p.ram > 0 ? Math.min(100, (memMB / p.ram) * 100) : memMB;
          const diskMB = diskBytes / 1048576;
          const diskPct = p.disk > 0 ? Math.min(100, (diskMB / p.disk) * 100) : diskMB;
          db.logResource(p.server_id, cpu, ramPct, diskPct);

          // Bandwidth
          const rx = a.resources?.network_rx_bytes || 0;
          const txBytes = a.resources?.network_tx_bytes || 0;
          db.logBandwidth(p.server_id, rx, txBytes);

          // #10 Bandwidth abnormal alert (>5GB total in last cycle)
          if (rx + txBytes > 5 * 1073741824) {
            config.OWNER_IDS.forEach(oid => {
              bot.telegram.sendMessage(oid, `🌐 *BANDWIDTH ABNORMAL*\n\n🖥 Server: \`${p.server_id}\`\n👤 Owner: \`${p.userId}\`\n📥 RX: ${formatBytes(rx)}\n📤 TX: ${formatBytes(txBytes)}`, { parse_mode: "Markdown" }).catch(() => {});
            });
          }

          // #6 Real-time spike anomaly (CPU/RAM > 90% for 3 cycles)
          if (cpu > 90 || ramPct > 90) {
            resourceSpikeCache[p.server_id] = (resourceSpikeCache[p.server_id] || 0) + 1;
            if (resourceSpikeCache[p.server_id] === 3) {
              config.OWNER_IDS.forEach(oid => {
                bot.telegram.sendMessage(oid, `🚨 *SPIKE ANOMALY*\n\n🖥 \`${p.server_id}\`\n👤 \`${p.userId}\`\n🔥 CPU: ${cpu.toFixed(0)}% | 🧠 RAM: ${ramPct.toFixed(0)}%\n\n⚠️ Spike >90% selama ~10 menit.`, { parse_mode: "Markdown" }).catch(() => {});
              });
            }
          } else {
            delete resourceSpikeCache[p.server_id];
          }

          // #29 Auto-restart on crash
          if (!isUp) {
            const cnt = db.incDownCounter(p.server_id);
            if (cnt >= 3) {
              try {
                await ptero.sendPowerAction(p.server_id, "restart", psn(p));
                bot.telegram.sendMessage(p.userId, `${tx(p.userId, "server_auto_restart")}\n\nServer: \`${p.server_id}\``, { parse_mode: "Markdown" }).catch(() => {});
                db.resetDownCounter(p.server_id);
                logger.event("AUTO_RESTART", `Server ${p.server_id} auto-restarted`);
              } catch (_) {}
            }
          } else {
            db.resetDownCounter(p.server_id);
          }
        } catch (_) {}
      }
    } catch (e) { logger.error("MONITOR_ALL", e.message); }
  }
  setInterval(monitorAll, 3 * 60 * 1000);
  setTimeout(monitorAll, 60 * 1000);

  // #28 Predictive expire reminder (H-7, H-3, H-1)
  const reminderCache = new Set();
  async function expireReminders() {
    try {
      const panels = db.getAllPanels();
      const now = Date.now();
      for (const p of panels) {
        if (p.expired || !p.expire_date) continue;
        const exp = new Date(p.expire_date).getTime();
        const daysLeft = Math.ceil((exp - now) / (24 * 60 * 60 * 1000));
        if ([7, 3, 1].includes(daysLeft)) {
          const key = `${p.server_id}_${daysLeft}`;
          if (reminderCache.has(key)) continue;
          reminderCache.add(key);
          const msgKey = daysLeft === 7 ? "expire_h7" : daysLeft === 3 ? "expire_h3" : "expire_h1";
          const name = p.username || p.name || p.server_id;
          bot.telegram.sendMessage(p.userId, `${tx(p.userId, msgKey)}\n\n🖥 Panel: \`${name}\`\n📅 Expire: ${p.expire_date}\n\n💡 Perpanjang segera dengan menu /mypanels`, { parse_mode: "Markdown" }).catch(() => {});
        }
      }
    } catch (e) { logger.error("EXPIRE_REMIND", e.message); }
  }
  setInterval(expireReminders, 6 * 60 * 60 * 1000); // every 6h
  setTimeout(expireReminders, 2 * 60 * 1000);

  // #24 Auto-cleanup expired >30d & #30 Backup retention
  async function autoCleanup() {
    try {
      const panels = db.getAllPanels();
      const now = Date.now();
      for (const p of panels) {
        if (!p.expired || !p.expire_date) continue;
        const expAge = now - new Date(p.expire_date).getTime();
        if (expAge > 30 * 24 * 60 * 60 * 1000) {
          // 7-day grace warn first
          if (expAge < 37 * 24 * 60 * 60 * 1000) {
            bot.telegram.sendMessage(p.userId, `${tx(p.userId, "cleanup_warn")}\n\nPanel \`${p.server_id}\` akan dihapus dalam 7 hari.`, { parse_mode: "Markdown" }).catch(() => {});
            continue;
          }
          // Delete
          try {
            await ptero.deleteServer(p.server_id, psn(p));
            db.deletePanelRecord(p.userId, p.server_id);
            db.addAuditLog({ actorId: "SYSTEM", action: "Auto-cleanup expired", target: p.server_id });
            logger.event("AUTO_CLEANUP", `Deleted expired panel ${p.server_id}`);
          } catch (_) {}
        }
      }

      // Backup retention (delete >7d unless important)
      for (const p of panels) {
        try {
          const backups = await ptero.getBackups(p.server_id, psn(p));
          for (const b of (backups || [])) {
            const age = now - new Date(b.created_at || b.attributes?.created_at).getTime();
            const bid = b.uuid || b.attributes?.uuid;
            if (age > 7 * 24 * 60 * 60 * 1000 && !db.isBackupImportant(p.userId, bid)) {
              // Pterodactyl deleteBackup might not be exposed; skip if not available
              // We don't have a delete backup function, so we just log
            }
          }
        } catch (_) {}
      }
    } catch (e) { logger.error("AUTO_CLEANUP", e.message); }
  }
  setInterval(autoCleanup, 24 * 60 * 60 * 1000); // daily
  setTimeout(autoCleanup, 10 * 60 * 1000);

  logger.sys("FEATURES", "✅ Semua fitur baru aktif (anti-spam, monitoring, friends, snapshot, dll)");
}

module.exports = {
  applyAll,
  // Helpers exported for use in main index.js (#11 quick action buttons in notifications)
  quickActionKeyboard: (serverId) => Markup.inlineKeyboard([
    [
      Markup.button.callback("▶️ Start", `qa_start_${serverId}`),
      Markup.button.callback("⏹ Stop", `qa_stop_${serverId}`),
      Markup.button.callback("🔄 Restart", `qa_restart_${serverId}`),
    ],
    [Markup.button.callback("📸 Snapshot", `snap_save_${serverId}`)],
  ]),
  colorize, formatBytes,
};
