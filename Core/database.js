const fs   = require("fs");
const path = require("path");
const config  = require("../config");
const DB_FILE = config.DB_FILE;

// ─── Split-file paths ─────────────────────────────────────────────────────────
// data/
//   users/users.json  ← semua user yang pernah /start
//   roles/roles.json  ← role + blacklist + reseller_limit per user
const DATA_DIR   = path.join(__dirname, "../data");
const USERS_FILE = path.join(DATA_DIR, "users", "users.json");
const ROLES_FILE = path.join(DATA_DIR, "roles", "roles.json");

// ── Users file helpers ────────────────────────────────────────────────────────
function loadUsersFile() {
  if (!fs.existsSync(USERS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch { return {}; }
}
function saveUsersFile(data) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
  fs.writeFileSync(USERS_FILE, JSON.stringify(data, null, 2));
}

// ── Roles file helpers ────────────────────────────────────────────────────────
function loadRolesFile() {
  if (!fs.existsSync(ROLES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(ROLES_FILE, "utf8")); }
  catch { return {}; }
}
function saveRolesFile(data) {
  fs.mkdirSync(path.dirname(ROLES_FILE), { recursive: true });
  fs.writeFileSync(ROLES_FILE, JSON.stringify(data, null, 2));
}

function ensureRoleEntry(roles, userId) {
  const uid = String(userId);
  if (!roles[uid]) roles[uid] = { role: "user" };
  return roles[uid];
}

// ── One-time migration from old db.json ───────────────────────────────────────
// Runs once; after that, presence of both files is the guard.
function migrateToSplitFiles() {
  const usersOk = fs.existsSync(USERS_FILE);
  const rolesOk = fs.existsSync(ROLES_FILE);
  if (usersOk && rolesOk) return;
  if (!fs.existsSync(DB_FILE)) return;
  let raw;
  try { raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return; }

  if (!usersOk) {
    const usersData = raw.started_users || {};
    fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersData, null, 2));
  }
  if (!rolesOk) {
    const rolesData = {};
    for (const [uid, u] of Object.entries(raw.users || {})) {
      rolesData[uid] = { role: u.role || "user" };
      if (u.blacklisted)     rolesData[uid].blacklisted    = u.blacklisted;
      if (u.reseller_limit)  rolesData[uid].reseller_limit = u.reseller_limit;
      if (u.public_partner)  rolesData[uid].public_partner = u.public_partner;
    }
    fs.mkdirSync(path.dirname(ROLES_FILE), { recursive: true });
    fs.writeFileSync(ROLES_FILE, JSON.stringify(rolesData, null, 2));
  }
}

function loadDb() {
  migrateToSplitFiles();
  if (!fs.existsSync(DB_FILE)) return defaultDb();
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    return migrateDb(raw);
  } catch { return defaultDb(); }
}

function defaultDb() {
  return {
    users: {},
    reseller_panels: {},
    started_users: {},
    vouchers: {},
    transactions: [],
    maintenance: { active: false, message: "Bot sedang dalam maintenance. Silakan coba lagi nanti." },
    audit_logs: [],
    daily_counts: {},
    last_daily_report: null,
    trial_enabled: true,
    referral_enabled: true,
    tickets: [],
    resource_alerts: [],
    auto_backup: { enabled: false, interval_hours: 6, last_run: null },
    points: {},
    templates: [],
    whitelist: { enabled: false, users: [] },
    scheduled_maintenance: { enabled: false, start: "02:00", end: "04:00", days: [], message: "Bot sedang maintenance terjadwal." },
    friends: {},
    reviews: [],
    snapshots: {},
    uptime_history: {},
    bandwidth_history: {},
    resource_history: {},
    device_logs: {},
    down_counter: {},
    user_lang: {},
    user_theme: {},
    egg_presets: [],
    important_backups: {},
    rate_limits: {},
    miner_alerts: {},
    achievements: {},
    last_seen: {},
    co_owners: {},          // { server_id: [tg_uid] }
    favorites: {},          // { uid: [server_id] }
    theme_pack: {},         // { uid: "neon"|"pastel"|"default" }
    panel_last_active: {},  // { server_id: ISO } — auto-lock tracker
    suspicious_log: [],     // [{ uid, type, detail, ts }]
    login_attempts: {},     // { username: [ts...] }
    api_keys: {},           // { key: { uid, label, created, last_used } }
    webhook_config: {       // notif keluar ke Discord/Slack
      enabled: false,
      url: "",
      events: { panel_create: true, panel_suspend: true, panel_delete: true, miner: true, server_down: true },
    },
    sla_history: {},        // { yyyy-mm: { server_id: pct } }
    last_sla_report: null,
  };
}

function migrateDb(raw) {
  if (!raw.transactions)      raw.transactions = [];
  if (!raw.maintenance)       raw.maintenance = { active: false, message: "Bot sedang dalam maintenance." };
  if (!raw.audit_logs)        raw.audit_logs = [];
  if (!raw.daily_counts)      raw.daily_counts = {};
  if (!raw.last_daily_report) raw.last_daily_report = null;
  if (typeof raw.trial_enabled === "undefined")    raw.trial_enabled = true;
  if (typeof raw.referral_enabled === "undefined") raw.referral_enabled = true;
  if (!raw.tickets)           raw.tickets = [];
  if (!raw.resource_alerts)   raw.resource_alerts = [];
  if (!raw.auto_backup)       raw.auto_backup = { enabled: false, interval_hours: 6, last_run: null };
  if (!raw.started_users)     raw.started_users = {};
  if (!raw.points)            raw.points = {};
  if (!raw.templates)         raw.templates = [];
  if (!raw.whitelist)         raw.whitelist = { enabled: false, users: [] };
  if (!raw.scheduled_maintenance) raw.scheduled_maintenance = { enabled: false, start: "02:00", end: "04:00", days: [], message: "Bot sedang maintenance terjadwal." };
  if (!raw.friends)            raw.friends = {};
  if (!raw.reviews)            raw.reviews = [];
  if (!raw.snapshots)          raw.snapshots = {};
  if (!raw.uptime_history)     raw.uptime_history = {};
  if (!raw.bandwidth_history)  raw.bandwidth_history = {};
  if (!raw.resource_history)   raw.resource_history = {};
  if (!raw.device_logs)        raw.device_logs = {};
  if (!raw.down_counter)       raw.down_counter = {};
  if (!raw.user_lang)          raw.user_lang = {};
  if (!raw.user_theme)         raw.user_theme = {};
  if (!raw.egg_presets)        raw.egg_presets = [];
  if (!raw.important_backups)  raw.important_backups = {};
  if (!raw.rate_limits)        raw.rate_limits = {};
  if (!raw.miner_alerts)       raw.miner_alerts = {};
  if (!raw.achievements)       raw.achievements = {};
  if (!raw.last_seen)          raw.last_seen = {};
  if (!raw.co_owners)          raw.co_owners = {};
  if (!raw.favorites)          raw.favorites = {};
  if (!raw.theme_pack)         raw.theme_pack = {};
  if (!raw.panel_last_active)  raw.panel_last_active = {};
  if (!raw.suspicious_log)     raw.suspicious_log = [];
  if (!raw.login_attempts)     raw.login_attempts = {};
  if (!raw.api_keys)           raw.api_keys = {};
  if (!raw.webhook_config)     raw.webhook_config = {
    enabled: false, url: "",
    events: { panel_create: true, panel_suspend: true, panel_delete: true, miner: true, server_down: true },
  };
  if (!raw.sla_history)        raw.sla_history = {};
  if (typeof raw.last_sla_report === "undefined") raw.last_sla_report = null;
  return raw;
}

// ─── New Feature Helpers ─────────────────────────────────────────────────────

// Friends
function addFriend(userId, friendId) {
  const d = loadDb();
  if (!d.friends[userId]) d.friends[userId] = [];
  if (!d.friends[userId].includes(String(friendId))) d.friends[userId].push(String(friendId));
  saveDb(d);
}
function removeFriend(userId, friendId) {
  const d = loadDb();
  if (d.friends[userId]) d.friends[userId] = d.friends[userId].filter(x => x !== String(friendId));
  saveDb(d);
}
function getFriends(userId) { return (loadDb().friends || {})[userId] || []; }
function isFriend(userId, friendId) { return getFriends(userId).includes(String(friendId)); }

// Reviews
function addReview(userId, serverId, rating, comment) {
  const d = loadDb();
  d.reviews = d.reviews || [];
  d.reviews = d.reviews.filter(r => !(r.userId === String(userId) && r.serverId === String(serverId)));
  d.reviews.push({ userId: String(userId), serverId: String(serverId), rating: Number(rating), comment: comment || "", timestamp: Date.now() });
  saveDb(d);
}
function getReviews(serverId) {
  const d = loadDb();
  return (d.reviews || []).filter(r => !serverId || r.serverId === String(serverId));
}
function getAverageRating(userId) {
  const d = loadDb();
  const userReviews = (d.reviews || []).filter(r => r.userId === String(userId));
  if (!userReviews.length) return null;
  return userReviews.reduce((a, b) => a + (b.rating || 0), 0) / userReviews.length;
}

// Snapshots
function saveSnapshot(serverId, name, data) {
  const d = loadDb();
  if (!d.snapshots[serverId]) d.snapshots[serverId] = [];
  d.snapshots[serverId].push({ id: genId(), name: name || `Snapshot ${new Date().toLocaleString("id-ID")}`, data, timestamp: Date.now() });
  if (d.snapshots[serverId].length > 5) d.snapshots[serverId].shift();
  saveDb(d);
}
function getSnapshots(serverId) { return (loadDb().snapshots || {})[serverId] || []; }
function getSnapshot(serverId, snapId) { return getSnapshots(serverId).find(s => s.id === snapId); }
function deleteSnapshot(serverId, snapId) {
  const d = loadDb();
  if (d.snapshots[serverId]) d.snapshots[serverId] = d.snapshots[serverId].filter(s => s.id !== snapId);
  saveDb(d);
}

// Uptime History
function logUptime(serverId, status) {
  const d = loadDb();
  if (!d.uptime_history[serverId]) d.uptime_history[serverId] = [];
  d.uptime_history[serverId].push({ t: Date.now(), s: status ? 1 : 0 });
  // Keep last 30 days max
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  d.uptime_history[serverId] = d.uptime_history[serverId].filter(e => e.t > cutoff).slice(-2000);
  saveDb(d);
}
function getUptimePercent(serverId, days = 30) {
  const hist = (loadDb().uptime_history || {})[serverId] || [];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = hist.filter(e => e.t > cutoff);
  if (!recent.length) return null;
  const up = recent.filter(e => e.s === 1).length;
  return (up / recent.length) * 100;
}

// Bandwidth History
function logBandwidth(serverId, rx, tx) {
  const d = loadDb();
  if (!d.bandwidth_history[serverId]) d.bandwidth_history[serverId] = [];
  d.bandwidth_history[serverId].push({ t: Date.now(), rx: Number(rx) || 0, tx: Number(tx) || 0 });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  d.bandwidth_history[serverId] = d.bandwidth_history[serverId].filter(e => e.t > cutoff).slice(-500);
  saveDb(d);
}
function getBandwidthHistory(serverId) { return (loadDb().bandwidth_history || {})[serverId] || []; }

// Resource History (CPU/RAM/Disk per panel for graphs)
function logResource(serverId, cpu, ram, disk) {
  const d = loadDb();
  if (!d.resource_history[serverId]) d.resource_history[serverId] = [];
  d.resource_history[serverId].push({ t: Date.now(), cpu: Number(cpu) || 0, ram: Number(ram) || 0, disk: Number(disk) || 0 });
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  d.resource_history[serverId] = d.resource_history[serverId].filter(e => e.t > cutoff).slice(-1000);
  saveDb(d);
}
function getResourceHistory(serverId) { return (loadDb().resource_history || {})[serverId] || []; }

// Top Resource Consumers
function getTopResourceConsumers(limit = 10) {
  const d = loadDb();
  const result = [];
  for (const sid of Object.keys(d.resource_history || {})) {
    const hist = d.resource_history[sid] || [];
    if (!hist.length) continue;
    const last = hist[hist.length - 1];
    result.push({ serverId: sid, cpu: last.cpu, ram: last.ram, disk: last.disk, total: last.cpu + last.ram });
  }
  return result.sort((a, b) => b.total - a.total).slice(0, limit);
}

// Device Logs
function logDevice(userId, info) {
  const d = loadDb();
  if (!d.device_logs[userId]) d.device_logs[userId] = { first_seen: Date.now(), language_code: info.language_code || "", username: info.username || "", chat_type: info.chat_type || "" };
  d.device_logs[userId].last_seen = Date.now();
  d.last_seen[userId] = Date.now();
  saveDb(d);
}
function getDeviceLog(userId) { return (loadDb().device_logs || {})[userId] || null; }

// Down counter (for auto-restart)
function incDownCounter(serverId) {
  const d = loadDb();
  d.down_counter[serverId] = (d.down_counter[serverId] || 0) + 1;
  saveDb(d);
  return d.down_counter[serverId];
}
function resetDownCounter(serverId) {
  const d = loadDb();
  delete d.down_counter[serverId];
  saveDb(d);
}

// User Language
function getUserLang(userId) { return (loadDb().user_lang || {})[userId] || "id"; }
function setUserLang(userId, lang) {
  const d = loadDb();
  d.user_lang[userId] = lang;
  saveDb(d);
}

// Egg Presets
function addEggPreset(preset) {
  const d = loadDb();
  d.egg_presets = d.egg_presets || [];
  d.egg_presets.push({ id: genId(), ...preset, createdAt: Date.now() });
  saveDb(d);
}
function getEggPresets() { return loadDb().egg_presets || []; }
function deleteEggPreset(id) {
  const d = loadDb();
  d.egg_presets = (d.egg_presets || []).filter(p => p.id !== id);
  saveDb(d);
}

// Important Backups
function markBackupImportant(userId, backupId, important) {
  const d = loadDb();
  if (!d.important_backups[userId]) d.important_backups[userId] = [];
  if (important && !d.important_backups[userId].includes(backupId)) d.important_backups[userId].push(backupId);
  if (!important) d.important_backups[userId] = d.important_backups[userId].filter(b => b !== backupId);
  saveDb(d);
}
function isBackupImportant(userId, backupId) { return ((loadDb().important_backups || {})[userId] || []).includes(backupId); }

// Rate Limit (in-memory cache + persistent for abuse history)
// In-memory rate limit cache (reset on restart — acceptable for rate limiting)
const _rateLimitCache = new Map();
function checkRateLimit(userId, maxPerMin = 10) {
  const key = String(userId);
  const now = Date.now();
  const win = 60 * 1000;
  const timestamps = (_rateLimitCache.get(key) || []).filter(t => now - t < win);
  if (timestamps.length >= maxPerMin) {
    _rateLimitCache.set(key, timestamps);
    return false;
  }
  timestamps.push(now);
  _rateLimitCache.set(key, timestamps);
  return true;
}

// Miner alerts
function recordMinerAlert(serverId, reason) {
const d = loadDb();
d.miner_alerts[serverId] = { t: Date.now(), reason };
saveDb(d);
}
function getMinerAlerts() { return loadDb().miner_alerts || {}; }
function clearMinerAlert(serverId) {
  const d = loadDb();
  delete d.miner_alerts[serverId];
  saveDb(d);
}

// Achievements
function awardAchievement(userId, badge) {
  const d = loadDb();
  if (!d.achievements[userId]) d.achievements[userId] = [];
  if (!d.achievements[userId].includes(badge)) {
    d.achievements[userId].push(badge);
    saveDb(d);
    return true;
  }
  return false;
}
function getAchievements(userId) { return (loadDb().achievements || {})[userId] || []; }

// User Theme (web dashboard)
function getUserTheme(userId) { return (loadDb().user_theme || {})[userId] || "dark"; }
function setUserTheme(userId, theme) {
  const d = loadDb();
  d.user_theme[userId] = theme;
  saveDb(d);
}

function saveDb(data) {
    const tmp = DB_FILE + ".tmp";
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DB_FILE);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch {}
      throw e;
    }
  }

// ─── Toggle Trial / Referral ──────────────────────────────────────────────────

function getTrialEnabled() {
  const db = loadDb();
  return typeof db.trial_enabled !== "undefined" ? db.trial_enabled : true;
}

function setTrialEnabled(enabled) {
  const db = loadDb();
  db.trial_enabled = !!enabled;
  saveDb(db);
}

function getReferralEnabled() {
  const db = loadDb();
  return typeof db.referral_enabled !== "undefined" ? db.referral_enabled : true;
}

function setReferralEnabled(enabled) {
  const db = loadDb();
  db.referral_enabled = !!enabled;
  saveDb(db);
}

// ─── Maintenance Mode ─────────────────────────────────────────────────────────

function getMaintenanceMode() { return loadDb().maintenance; }

function setMaintenanceMode(active, message) {
  const db = loadDb();
  db.maintenance = { active: !!active, message: message || "Bot sedang dalam maintenance. Silakan coba lagi nanti." };
  saveDb(db);
}

// ─── Auto Backup ──────────────────────────────────────────────────────────────

function getAutoBackup() {
  const db = loadDb();
  return db.auto_backup || { enabled: false, interval_hours: 6, last_run: null };
}

function setAutoBackup(settings) {
  const db = loadDb();
  db.auto_backup = Object.assign(
    { enabled: false, interval_hours: 6, last_run: null },
    db.auto_backup || {},
    settings
  );
  saveDb(db);
}

// ─── User ─────────────────────────────────────────────────────────────────────

function getUser(userId) {
  const db    = loadDb();
  const roles = loadRolesFile();
  const uid   = String(userId);
  const base  = db.users[uid] || null;
  const role  = roles[uid]    || null;
  if (!base && !role) return null;
  return {
    ...(base  || {}),
    role: "user",        // default jika belum ada di roles.json
    blacklisted: false,
    ...(role  || {}),    // override dengan data aktual dari roles.json
  };
}

function ensureUser(db, userId) {
  const uid = String(userId);
  if (!db.users[uid]) db.users[uid] = { panel_count: 0 };
  return db.users[uid];
}

function setUserRole(userId, role) {
  const roles = loadRolesFile();
  const entry = ensureRoleEntry(roles, userId);
  entry.role = role;
  saveRolesFile(roles);
}

function getRole(userId) {
  const roles = loadRolesFile();
  return (roles[String(userId)]?.role) || "user";
}

function resetRole(userId) {
  const roles = loadRolesFile();
  const entry = ensureRoleEntry(roles, userId);
  entry.role = "user";
  saveRolesFile(roles);
}

// ─── Blacklist ────────────────────────────────────────────────────────────────

function blacklistUser(userId) {
  const roles = loadRolesFile();
  const entry = ensureRoleEntry(roles, userId);
  entry.blacklisted = true;
  saveRolesFile(roles);
}

function unblacklistUser(userId) {
  const roles = loadRolesFile();
  const uid   = String(userId);
  if (roles[uid]) { roles[uid].blacklisted = false; saveRolesFile(roles); }
}

function isBlacklisted(userId) {
  return !!(loadRolesFile()[String(userId)]?.blacklisted);
}

// ─── Panel Count ──────────────────────────────────────────────────────────────

function getPanelCount(userId) {
  const user = getUser(userId);
  return user ? user.panel_count || 0 : 0;
}

function incrementPanelCount(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.panel_count = (u.panel_count || 0) + 1;
  saveDb(db);
}

function decrementPanelCount(userId) {
  const db = loadDb();
  const uid = String(userId);
  if (db.users[uid] && db.users[uid].panel_count > 0) {
    db.users[uid].panel_count--;
    saveDb(db);
  }
}

// ─── Reseller Limit (count + expiry) ─────────────────────────────────────────
//
// Schema di user record:
// {
//   reseller_limit: {
//     count:       10,             // sisa slot panel
//     expire_date: "2026-06-15",   // null = tidak ada expiry
//     added_at:    "...",
//     added_by:    "..."
//   }
// }
//
// Cara pakai:
//   getResellerLimit(userId)                   → objek limit atau null
//   setResellerLimit(userId, count, expireDate, addedBy)  → set/update limit owner
//   checkResellerLimit(userId)                 → { ok, reason }
//   decrementResellerLimit(userId)             → kurangi count 1

function getResellerLimit(userId) {
  return loadRolesFile()[String(userId)]?.reseller_limit || null;
}

function setResellerLimit(userId, count, expireDate, addedBy) {
  const roles = loadRolesFile();
  const entry = ensureRoleEntry(roles, userId);
  entry.reseller_limit = {
    count:       Math.max(0, Number(count) || 0),
    expire_date: expireDate || null,
    added_at:    new Date().toISOString(),
    added_by:    String(addedBy || ""),
  };
  saveRolesFile(roles);
}

function addResellerLimit(userId, extraCount, newExpireDate, addedBy) {
  const roles    = loadRolesFile();
  const entry    = ensureRoleEntry(roles, userId);
  const existing = entry.reseller_limit || { count: 0, expire_date: null };
  entry.reseller_limit = {
    count:       Math.max(0, (existing.count || 0) + Math.max(0, Number(extraCount) || 0)),
    expire_date: newExpireDate !== undefined ? newExpireDate : existing.expire_date,
    added_at:    new Date().toISOString(),
    added_by:    String(addedBy || ""),
  };
  saveRolesFile(roles);
}

function checkResellerLimit(userId) {
  const lim = getResellerLimit(userId);
  if (!lim) return { ok: false, reason: "no_limit" };
  if (lim.expire_date) {
    const exp = new Date(lim.expire_date);
    if (isNaN(exp.getTime())) return { ok: false, reason: "invalid_date" };
    if (exp < new Date()) return { ok: false, reason: "expired", expDate: lim.expire_date };
  }
  if (lim.count <= 0) return { ok: false, reason: "no_count" };
  return { ok: true };
}

function decrementResellerLimit(userId) {
  const roles = loadRolesFile();
  const uid   = String(userId);
  const entry = roles[uid];
  if (entry?.reseller_limit?.count > 0) {
    entry.reseller_limit.count = Math.max(0, entry.reseller_limit.count - 1);
    saveRolesFile(roles);
    return true;
  }
  return false;
}

// ─── Support Ticket ───────────────────────────────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function addTicket(userId, { subject, message }) {
  const db = loadDb();
  const id = genId();
  db.tickets.push({
    id,
    userId:     String(userId),
    subject:    subject || "Tanpa Judul",
    message,
    status:     "open",
    replies:    [],
    created_at: new Date().toISOString(),
    closed_at:  null,
  });
  if (db.tickets.length > 300) db.tickets = db.tickets.slice(-300);
  saveDb(db);
  return id;
}

function getTicketById(id) {
  return (loadDb().tickets || []).find(t => t.id === id) || null;
}

function getOpenTickets() {
  return (loadDb().tickets || []).filter(t => t.status === "open");
}

function getAllTickets(limit = 20) {
  const tickets = loadDb().tickets || [];
  return tickets.slice(-limit).reverse();
}

function getUserTickets(userId) {
  return (loadDb().tickets || []).filter(t => t.userId === String(userId)).reverse();
}

function addTicketReply(id, { fromId, message, isOwner }) {
  const db = loadDb();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return false;
  ticket.replies.push({
    fromId: String(fromId),
    message,
    isOwner: !!isOwner,
    at: new Date().toISOString(),
  });
  saveDb(db);
  return true;
}

function closeTicket(id) {
  const db = loadDb();
  const ticket = (db.tickets || []).find(t => t.id === id);
  if (!ticket) return false;
  ticket.status    = "closed";
  ticket.closed_at = new Date().toISOString();
  saveDb(db);
  return true;
}

// ─── Auto Renewal ─────────────────────────────────────────────────────────────

function getAutoRenewal(userId) {
  const u = getUser(userId);
  return u ? (typeof u.auto_renewal !== "undefined" ? u.auto_renewal : true) : true;
}

function setAutoRenewal(userId, enabled) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.auto_renewal = !!enabled;
  saveDb(db);
}

// ─── Resource Alerts ──────────────────────────────────────────────────────────

function addResourceAlert(userId, serverId, alertType) {
  const db = loadDb();
  if (!db.resource_alerts) db.resource_alerts = [];
  const key = `${serverId}_${alertType}`;
  const existing = db.resource_alerts.find(a => a.key === key);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.last_at = new Date().toISOString();
    saveDb(db);
    return existing.count;
  }
  db.resource_alerts.push({
    key,
    userId: String(userId),
    serverId: String(serverId),
    alertType,
    count: 1,
    first_at: new Date().toISOString(),
    last_at:  new Date().toISOString(),
  });
  if (db.resource_alerts.length > 200) db.resource_alerts = db.resource_alerts.slice(-200);
  saveDb(db);
  return 1;
}

function clearResourceAlert(serverId, alertType) {
  const db = loadDb();
  const key = `${serverId}_${alertType}`;
  db.resource_alerts = (db.resource_alerts || []).filter(a => a.key !== key);
  saveDb(db);
}

function getResourceAlertCount(serverId, alertType) {
  const db = loadDb();
  const key = `${serverId}_${alertType}`;
  const found = (db.resource_alerts || []).find(a => a.key === key);
  return found ? found.count : 0;
}

// ─── Trial Panel ──────────────────────────────────────────────────────────────

function hasUsedTrial(userId) {
  const u = getUser(userId);
  return !!(u && u.trial_used);
}

function markTrialUsed(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.trial_used = true;
  u.trial_at = new Date().toISOString();
  saveDb(db);
}

// ─── Rate Limit Harian ────────────────────────────────────────────────────────

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}`;
}

function getDailyCount(userId) {
  const db = loadDb();
  const key = `${String(userId)}:${getTodayKey()}`;
  return (db.daily_counts || {})[key] || 0;
}

function incrementDailyCount(userId) {
  const db = loadDb();
  if (!db.daily_counts) db.daily_counts = {};
  const key = `${String(userId)}:${getTodayKey()}`;
  db.daily_counts[key] = (db.daily_counts[key] || 0) + 1;
  const today = getTodayKey();
  for (const k of Object.keys(db.daily_counts)) {
    const sep = k.lastIndexOf(":");
    if (sep === -1 || k.slice(sep + 1) !== today) delete db.daily_counts[k];
  }
  saveDb(db);
}
// ─── 2FA PIN ──────────────────────────────────────────────────────────────────

function setPin(userId, pin) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.pin = pin;
  saveDb(db);
}

function getPin(userId) {
  const u = getUser(userId);
  return u ? u.pin || null : null;
}

function clearPin(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  delete u.pin;
  saveDb(db);
}

// ─── Referral System ──────────────────────────────────────────────────────────

function getReferralCode(userId) {
  const u = getUser(userId);
  if (u && u.referral_code) return u.referral_code;
  const code = `REF${String(userId).slice(-6)}${Math.random().toString(36).slice(2,5).toUpperCase()}`;
  const db = loadDb();
  const user = ensureUser(db, userId);
  user.referral_code = code;
  saveDb(db);
  return code;
}

function getUserByReferralCode(code) {
  const db = loadDb();
  for (const [uid, u] of Object.entries(db.users || {})) {
    if (u.referral_code === code) return uid;
  }
  return null;
}

function applyReferral(newUserId, referrerId) {
  const db = loadDb();
  const uid = String(newUserId);
  const refId = String(referrerId);
  const u = ensureUser(db, uid);
  if (u.referred_by) return false;
  u.referred_by = refId;
  const ref = ensureUser(db, refId);
  if (!ref.referrals) ref.referrals = [];
  ref.referrals.push({ userId: uid, at: new Date().toISOString(), bonus_claimed: false });
  saveDb(db);
  return true;
}

function claimReferralBonus(referrerId) {
  const db = loadDb();
  const ref = ensureUser(db, referrerId);
  if (!ref.referrals) return 0;
  let count = 0;
  for (const r of ref.referrals) {
    if (!r.bonus_claimed) { r.bonus_claimed = true; count++; }
  }
  if (count > 0) {
    ref.referral_bonus_days = (ref.referral_bonus_days || 0) + count * (config.REFERRAL_BONUS_DAYS || 3);
    saveDb(db);
  }
  return count * (config.REFERRAL_BONUS_DAYS || 3);
}

function getReferralBonus(userId) {
  const u = getUser(userId);
  return u ? u.referral_bonus_days || 0 : 0;
}

function consumeReferralBonus(userId) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  const bonus = u.referral_bonus_days || 0;
  u.referral_bonus_days = 0;
  saveDb(db);
  return bonus;
}

function getReferralStats(userId) {
  const u = getUser(userId);
  if (!u) return { code: getReferralCode(userId), referrals: [], bonus: 0 };
  const code = getReferralCode(userId);
  return {
    code,
    referrals: u.referrals || [],
    bonus: u.referral_bonus_days || 0,
    referred_by: u.referred_by || null,
  };
}

// ─── Audit Log ────────────────────────────────────────────────────────────────

function addAuditLog(entry) {
  const db = loadDb();
  if (!db.audit_logs) db.audit_logs = [];
  db.audit_logs.unshift({ ...entry, at: new Date().toISOString() });
  if (db.audit_logs.length > 300) db.audit_logs = db.audit_logs.slice(0, 300);
  saveDb(db);
}

function getAuditLogs(limit = 20) {
  return (loadDb().audit_logs || []).slice(0, limit);
}

// ─── Daily Report ─────────────────────────────────────────────────────────────

function getLastDailyReport() { return loadDb().last_daily_report; }

function setLastDailyReport(dateStr) {
  const db = loadDb();
  db.last_daily_report = dateStr;
  saveDb(db);
}

// ─── Panel Records ────────────────────────────────────────────────────────────

function addPanelRecord(userId, panelData, expireHours = null) {
  const db = loadDb();
  const uid = String(userId);
  if (!db.reseller_panels) db.reseller_panels = {};
  if (!db.reseller_panels[uid]) db.reseller_panels[uid] = [];
  const ms = expireHours
    ? expireHours * 60 * 60 * 1000
    : config.PANEL_EXPIRE_DAYS * 24 * 60 * 60 * 1000;
  const record = {
    ...panelData,
    created_at:  new Date().toISOString(),
    expire_date: new Date(Date.now() + ms).toISOString(),
    expired:     false,
    suspended:   false,
    suspended_at: null,
    auto_renewal: true,
  };
  db.reseller_panels[uid].push(record);
  saveDb(db);
}

function getUserPanels(userId) {
  const db = loadDb();
  return (db.reseller_panels || {})[String(userId)] || [];
}

function listAllUsers() {
  const db    = loadDb();
  const roles = loadRolesFile();
  const allUids = new Set([
    ...Object.keys(db.users || {}),
    ...Object.keys(roles),
  ]);
  const result = {};
  for (const uid of allUids) {
    result[uid] = {
      ...(db.users[uid] || {}),
      role: "user",
      ...(roles[uid] || {}),
    };
  }
  return result;
}

function getPanelByServerId(serverId) {
  const db = loadDb();
  for (const [uid, panels] of Object.entries(db.reseller_panels || {})) {
    const p = panels.find(p => String(p.server_id) === String(serverId));
    if (p) return { ...p, ownerUserId: uid };
  }
  return null;
}

function deletePanelRecord(userId, serverId) {
  const db = loadDb();
  const uid = String(userId);
  if (!db.reseller_panels?.[uid]) return false;
  const before = db.reseller_panels[uid].length;
  db.reseller_panels[uid] = db.reseller_panels[uid].filter(p => String(p.server_id) !== String(serverId));
  if (db.reseller_panels[uid].length !== before) { saveDb(db); return true; }
  return false;
}

function transferPanel(fromUserId, toUserId, serverId) {
  const db = loadDb();
  const from = String(fromUserId);
  const to   = String(toUserId);
  const idx  = (db.reseller_panels?.[from] || []).findIndex(p => String(p.server_id) === String(serverId));
  if (idx === -1) return false;
  const [panel] = db.reseller_panels[from].splice(idx, 1);
  if (!db.reseller_panels[to]) db.reseller_panels[to] = [];
  panel.userId = to;
  db.reseller_panels[to].push(panel);
  saveDb(db);
  return true;
}

function markPanelExpired(userId, serverId) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  p.expired = true;
  saveDb(db);
  return true;
}

function markPanelSuspended(userId, serverId, suspended) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  p.suspended    = !!suspended;
  p.suspended_at = suspended ? new Date().toISOString() : null;
  saveDb(db);
  return true;
}

function extendPanel(userId, serverId, extraDays) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  const current = p.expire_date ? new Date(p.expire_date) : new Date();
  const base = current < new Date() ? new Date() : current;
  p.expire_date = new Date(base.getTime() + extraDays * 24 * 60 * 60 * 1000).toISOString();
  p.expired     = false;
  saveDb(db);
  return true;
}

function updatePanelPlan(userId, serverId, planName) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  p.plan_name = planName;
  saveDb(db);
  return true;
}

function updatePanelName(userId, serverId, name) {
  const db = loadDb();
  const uid = String(userId);
  const p = (db.reseller_panels?.[uid] || []).find(p => String(p.server_id) === String(serverId));
  if (!p) return false;
  p.name = name;
  saveDb(db);
  return true;
}

function getAllPanels() {
  const db = loadDb();
  const result = [];
  for (const [uid, panels] of Object.entries(db.reseller_panels || {})) {
    for (const p of panels) {
      result.push({ ...p, userId: uid });
    }
  }
  return result;
}

function getExpiringPanels(daysAhead) {
  const result = [];
  const db = loadDb();
  for (const [uid, panels] of Object.entries(db.reseller_panels || {})) {
    for (const p of panels) {
      if (!p.expire_date) continue;
      const dl = Math.ceil((new Date(p.expire_date) - new Date()) / (1000 * 60 * 60 * 24));
      const match = daysAhead === 0 ? dl <= 0 : (dl > 0 && dl <= daysAhead);
      if (match) result.push({ userId: uid, panel: p });
    }
  }
  return result;
}

function getSuspendedExpiredPanels(afterDays) {
  const result = [];
  const db = loadDb();
  const cutoff = new Date(Date.now() - afterDays * 24 * 60 * 60 * 1000);
  for (const [uid, panels] of Object.entries(db.reseller_panels || {})) {
    for (const p of panels) {
      if (!p.suspended) continue;
      const suspAt = p.suspended_at ? new Date(p.suspended_at) : null;
      if (suspAt && suspAt < cutoff) result.push({ userId: uid, panel: p });
    }
  }
  return result;
}

// ─── Pending Days (Voucher Hari tersimpan di DB agar tidak hilang) ────────────

function getPendingDays(userId) {
  const u = getUser(userId);
  return u ? (u.pending_days || 0) : 0;
}

function setPendingDays(userId, days) {
  const db = loadDb();
  const u = ensureUser(db, userId);
  u.pending_days = Math.max(0, Number(days) || 0);
  saveDb(db);
}

function clearPendingDays(userId) {
  const db = loadDb();
  const u = db.users?.[String(userId)];
  if (u) { u.pending_days = 0; saveDb(db); }
}

// ─── Transactions ─────────────────────────────────────────────────────────────

function addTransaction(userId, { type, detail }) {
  const db = loadDb();
  if (!db.transactions) db.transactions = [];
  db.transactions.unshift({
    userId: String(userId),
    type,
    detail,
    at: new Date().toISOString(),
  });
  if (db.transactions.length > 1000) db.transactions = db.transactions.slice(0, 1000);
  saveDb(db);
}

function getUserTransactions(userId, limit = 10) {
  const txs = loadDb().transactions || [];
  return txs.filter(t => t.userId === String(userId)).slice(0, limit);
}

function getAllTransactions(limit = 50) {
  return (loadDb().transactions || []).slice(0, limit);
}

// ─── Started Users ────────────────────────────────────────────────────────────

function registerStartedUser(userId, from) {
  const users = loadUsersFile();
  users[String(userId)] = {
    first_name: from.first_name  || null,
    last_name:  from.last_name   || null,
    username:   from.username    || null,
    at:         new Date().toISOString(),
  };
  saveUsersFile(users);
}

function hasStarted(userId) {
  return !!(loadUsersFile()[String(userId)]);
}

function getAllStartedUsers() {
  return Object.keys(loadUsersFile());
}

function getAllStartedUsersData() {
  return loadUsersFile();
}

// ─── Voucher System ───────────────────────────────────────────────────────────

function genVoucherCode() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "PTERO-";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createVoucher(type, { role, discount, days, maxUses, code }) {
  const db = loadDb();
  if (!db.vouchers) db.vouchers = {};
  const vCode = code || genVoucherCode();
  db.vouchers[vCode] = {
    type,
    role:     role || null,
    discount: discount || null,
    days:     days || null,
    maxUses:  maxUses || 1,
    uses:     0,
    usedBy:   [],
    created_at: new Date().toISOString(),
  };
  saveDb(db);
  return vCode;
}

function getVoucher(code) {
  return (loadDb().vouchers || {})[code] || null;
}

function useVoucher(code, userId) {
  const db = loadDb();
  const v = (db.vouchers || {})[code];
  if (!v) return { ok: false, reason: "not_found" };
  if (v.usedBy.includes(String(userId))) return { ok: false, reason: "already_used" };
  if (v.uses >= v.maxUses) return { ok: false, reason: "exhausted" };
  v.uses++;
  v.usedBy.push(String(userId));
  saveDb(db);
  return { ok: true, voucher: v };
}

function getAllVouchers() {
  return loadDb().vouchers || {};
}

function deleteVoucher(code) {
  const db = loadDb();
  if (!db.vouchers?.[code]) return false;
  delete db.vouchers[code];
  saveDb(db);
  return true;
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function getStats() {
  const db = loadDb();
  const now = new Date();

  // ── User counts ────────────────────────────────────────────────────
  const rolesList = Object.values(loadRolesFile());
  const started   = Object.keys(loadUsersFile()).length;
  const resellers = rolesList.filter(r => r.role === "reseller").length;
  const premiums  = rolesList.filter(r => r.role === "premium").length;
  const partners  = rolesList.filter(r => r.role === "partner").length;
  const owners    = rolesList.filter(r => r.role === "owner").length;
  const blacklisted = rolesList.filter(r => r.blacklisted).length;

  // ── Panel counts ───────────────────────────────────────────────────
  let totalPanels = 0, activePanels = 0, suspendedPanels = 0, expiredPanels = 0;
  for (const panels of Object.values(db.reseller_panels || {})) {
    for (const p of panels) {
      totalPanels++;
      if (p.suspended) { suspendedPanels++; continue; }
      if (p.expired || (p.expire_date && new Date(p.expire_date) < now)) { expiredPanels++; continue; }
      activePanels++;
    }
  }

  // ── Voucher counts ─────────────────────────────────────────────────
  const vouchers     = Object.values(db.vouchers || {});
  const voucherTotal = vouchers.length;
  const voucherUsed  = vouchers.filter(v => v.uses > 0).length;

  // ── Transaction count ──────────────────────────────────────────────
  const transactions = (db.transactions || []).length;

  // ── Tickets ────────────────────────────────────────────────────────
  const openTickets  = (db.tickets || []).filter(t => t.status === "open").length;

  return {
    started, resellers, premiums, partners, owners, blacklisted,
    totalPanels, activePanels, suspendedPanels, expiredPanels,
    voucherTotal, voucherUsed,
    transactions,
    openTickets,
    totalUsers: rolesList.length,
  };
}

// ─── Points / Reward System ───────────────────────────────────────────────────

function getPoints(userId) {
  const db = loadDb();
  return (db.points || {})[String(userId)] || 0;
}

function addPoints(userId, pts) {
  if (!pts || pts <= 0) return;
  const db = loadDb();
  if (!db.points) db.points = {};
  db.points[String(userId)] = (db.points[String(userId)] || 0) + pts;
  saveDb(db);
}

function spendPoints(userId, pts) {
  const db = loadDb();
  if (!db.points) db.points = {};
  const current = db.points[String(userId)] || 0;
  if (current < pts) return false;
  db.points[String(userId)] = current - pts;
  saveDb(db);
  return true;
}

function getPointsLeaderboard(limit = 10) {
  const db = loadDb();
  return Object.entries(db.points || {})
    .map(([uid, pts]) => ({ userId: uid, points: pts }))
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

// ─── Panel Templates ──────────────────────────────────────────────────────────

function saveTemplate(name, cfg) {
  const db = loadDb();
  if (!db.templates) db.templates = [];
  const idx = db.templates.findIndex(t => t.name === name);
  if (idx !== -1) db.templates[idx] = { name, ...cfg, updated_at: new Date().toISOString() };
  else db.templates.push({ name, ...cfg, created_at: new Date().toISOString() });
  saveDb(db);
}

function getTemplates() {
  return loadDb().templates || [];
}

function deleteTemplate(name) {
  const db = loadDb();
  const before = (db.templates || []).length;
  db.templates = (db.templates || []).filter(t => t.name !== name);
  if (db.templates.length !== before) { saveDb(db); return true; }
  return false;
}

// ─── Whitelist System ─────────────────────────────────────────────────────────

function getWhitelistMode() {
  return !!(loadDb().whitelist?.enabled);
}

function setWhitelistMode(enabled) {
  const db = loadDb();
  if (!db.whitelist) db.whitelist = { enabled: false, users: [] };
  db.whitelist.enabled = !!enabled;
  saveDb(db);
}

function isWhitelisted(userId) {
  const db = loadDb();
  return (db.whitelist?.users || []).includes(String(userId));
}

function addToWhitelist(userId) {
  const db = loadDb();
  if (!db.whitelist) db.whitelist = { enabled: false, users: [] };
  const uid = String(userId);
  if (!db.whitelist.users.includes(uid)) { db.whitelist.users.push(uid); saveDb(db); return true; }
  return false;
}

function removeFromWhitelist(userId) {
  const db = loadDb();
  if (!db.whitelist) return false;
  const before = db.whitelist.users.length;
  db.whitelist.users = db.whitelist.users.filter(u => u !== String(userId));
  if (db.whitelist.users.length !== before) { saveDb(db); return true; }
  return false;
}

function getWhitelistUsers() {
  return loadDb().whitelist?.users || [];
}

// ─── Scheduled Maintenance ────────────────────────────────────────────────────

function getScheduledMaintenance() {
  const db = loadDb();
  return db.scheduled_maintenance || { enabled: false, start: "02:00", end: "04:00", days: [], message: "Bot sedang maintenance terjadwal." };
}

function setScheduledMaintenance(settings) {
  const db = loadDb();
  db.scheduled_maintenance = Object.assign(
    { enabled: false, start: "02:00", end: "04:00", days: [], message: "Bot sedang maintenance terjadwal." },
    db.scheduled_maintenance || {},
    settings
  );
  saveDb(db);
}

// ─── Referral Leaderboard ─────────────────────────────────────────────────────

function getReferralLeaderboard(limit = 10) {
  const db = loadDb();
  return Object.entries(db.users || {})
    .map(([uid, u]) => ({
      userId: uid,
      code:   u.referral_code || "",
      count:  (u.referrals || []).length,
    }))
    .filter(e => e.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ─── Bandwidth Tracking Per Server ───────────────────────────────────────────

function updateBandwidthBytes(serverId, currentRx, currentTx) {
  const db = loadDb();
  if (!db.bandwidth_tracking) db.bandwidth_tracking = {};
  const key = String(serverId);
  const monthKey = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const prev = db.bandwidth_tracking[key];

  let monthTotal = 0;
  if (!prev || prev.month_key !== monthKey) {
    // Bulan baru atau entry pertama — mulai fresh
    monthTotal = currentRx + currentTx;
  } else {
    const deltaRx = currentRx - prev.last_rx;
    const deltaTx = currentTx - prev.last_tx;
    if (deltaRx < 0 || deltaTx < 0) {
      // Server restart terdeteksi → tambahkan nilai current sebagai sesi baru
      monthTotal = (prev.month_total_bytes || 0) + currentRx + currentTx;
    } else {
      monthTotal = (prev.month_total_bytes || 0) + deltaRx + deltaTx;
    }
  }

  db.bandwidth_tracking[key] = {
    last_rx: currentRx,
    last_tx: currentTx,
    month_total_bytes: monthTotal,
    month_key: monthKey,
  };
  saveDb(db);
  return monthTotal;
}

function getBandwidthTracking(serverId) {
  const db = loadDb();
  return (db.bandwidth_tracking || {})[String(serverId)] || null;
}

function setPanelBandwidthLimit(userId, serverId, limitGb) {
  const db = loadDb();
  const uid = String(userId);
  if (!db.reseller_panels?.[uid]) return false;
  const idx = db.reseller_panels[uid].findIndex(p => String(p.server_id) === String(serverId));
  if (idx === -1) return false;
  db.reseller_panels[uid][idx].bandwidth_limit_gb = Number(limitGb);
  saveDb(db);
  return true;
}

function resetBandwidthTracking(serverId) {
  const db = loadDb();
  if (!db.bandwidth_tracking) return;
  delete db.bandwidth_tracking[String(serverId)];
  saveDb(db);
}

module.exports = {
  loadDb, saveDb,
  getTrialEnabled, setTrialEnabled,
  getReferralEnabled, setReferralEnabled,
  getMaintenanceMode, setMaintenanceMode,
  getAutoBackup, setAutoBackup,
  getUser, ensureUser, setUserRole, getRole, resetRole,
  blacklistUser, unblacklistUser, isBlacklisted,
  getPanelCount, incrementPanelCount, decrementPanelCount,
  getResellerLimit, setResellerLimit, addResellerLimit, checkResellerLimit, decrementResellerLimit,
  addTicket, getTicketById, getOpenTickets, getAllTickets, getUserTickets,
  addTicketReply, closeTicket,
  getAutoRenewal, setAutoRenewal,
  addResourceAlert, clearResourceAlert, getResourceAlertCount,
  hasUsedTrial, markTrialUsed,
  getTodayKey, getDailyCount, incrementDailyCount,
  setPin, getPin, clearPin,
  getReferralCode, getUserByReferralCode, applyReferral,
  claimReferralBonus, getReferralBonus, consumeReferralBonus, getReferralStats,
  addAuditLog, getAuditLogs,
  getLastDailyReport, setLastDailyReport,
  addPanelRecord, getUserPanels, listAllUsers,
  getPanelByServerId, deletePanelRecord, markPanelExpired, markPanelSuspended, extendPanel, transferPanel, updatePanelPlan,
  updatePanelName, getAllPanels, getExpiringPanels, getSuspendedExpiredPanels,
  getPendingDays, setPendingDays, clearPendingDays,
  addTransaction, getUserTransactions, getAllTransactions,
  registerStartedUser, hasStarted, getAllStartedUsers, getAllStartedUsersData,
  loadUsersFile, loadRolesFile, saveRolesFile,
  createVoucher, getVoucher, useVoucher, getAllVouchers, deleteVoucher,
  getStats, genId,
  getPoints, addPoints, spendPoints, getPointsLeaderboard,
  saveTemplate, getTemplates, deleteTemplate,
  getWhitelistMode, setWhitelistMode, isWhitelisted, addToWhitelist, removeFromWhitelist, getWhitelistUsers,
  getScheduledMaintenance, setScheduledMaintenance,
  getReferralLeaderboard,
  // New features
  addFriend, removeFriend, getFriends, isFriend,
  addReview, getReviews, getAverageRating,
  saveSnapshot, getSnapshots, getSnapshot, deleteSnapshot,
  logUptime, getUptimePercent,
  logBandwidth, getBandwidthHistory,
  updateBandwidthBytes, getBandwidthTracking, setPanelBandwidthLimit, resetBandwidthTracking,
  logResource, getResourceHistory, getTopResourceConsumers,
  logDevice, getDeviceLog,
  incDownCounter, resetDownCounter,
  getUserLang, setUserLang,
  addEggPreset, getEggPresets, deleteEggPreset,
  markBackupImportant, isBackupImportant,
  checkRateLimit,
  recordMinerAlert, getMinerAlerts, clearMinerAlert,
  awardAchievement, getAchievements,
  getUserTheme, setUserTheme,
  // ── New v3 features ──
  addCoOwner, removeCoOwner, getCoOwners, isCoOwner,
  addFavorite, removeFavorite, getFavorites, isFavorite,
  setThemePack, getThemePack,
  touchPanelActive, getPanelLastActive, getInactivePanels,
  recordSuspicious, getSuspiciousRecent,
  recordLoginAttempt, getRecentLoginAttempts,
  createApiKey, deleteApiKey, getApiKey, listApiKeysFor, touchApiKey,
  getWebhookConfig, setWebhookConfig,
  recordSlaSnapshot, getSlaForMonth, getLastSlaReport, setLastSlaReport,
  computeUserResourceUsage, getResourceQuotaLeaderboard,
};

// ── Co-owner ──
function addCoOwner(serverId, uid) {
  const d = loadDb();
  const k = String(serverId);
  if (!d.co_owners[k]) d.co_owners[k] = [];
  if (!d.co_owners[k].includes(String(uid))) d.co_owners[k].push(String(uid));
  saveDb(d);
}
function removeCoOwner(serverId, uid) {
  const d = loadDb();
  const k = String(serverId);
  if (d.co_owners[k]) d.co_owners[k] = d.co_owners[k].filter(x => x !== String(uid));
  saveDb(d);
}
function getCoOwners(serverId) { return (loadDb().co_owners || {})[String(serverId)] || []; }
function isCoOwner(serverId, uid) { return getCoOwners(serverId).includes(String(uid)); }

// ── Favorit ──
function addFavorite(uid, serverId) {
  const d = loadDb();
  const k = String(uid);
  if (!d.favorites[k]) d.favorites[k] = [];
  if (!d.favorites[k].includes(String(serverId))) d.favorites[k].push(String(serverId));
  saveDb(d);
}
function removeFavorite(uid, serverId) {
  const d = loadDb();
  const k = String(uid);
  if (d.favorites[k]) d.favorites[k] = d.favorites[k].filter(x => x !== String(serverId));
  saveDb(d);
}
function getFavorites(uid) { return (loadDb().favorites || {})[String(uid)] || []; }
function isFavorite(uid, serverId) { return getFavorites(uid).includes(String(serverId)); }

// ── Theme pack ──
function setThemePack(uid, pack) {
  const d = loadDb();
  d.theme_pack[String(uid)] = pack;
  saveDb(d);
}
function getThemePack(uid) { return (loadDb().theme_pack || {})[String(uid)] || "default"; }

// ── Panel activity tracking (auto-lock) ──
function touchPanelActive(serverId) {
  const d = loadDb();
  d.panel_last_active[String(serverId)] = new Date().toISOString();
  saveDb(d);
}
function getPanelLastActive(serverId) {
  return (loadDb().panel_last_active || {})[String(serverId)] || null;
}
function getInactivePanels(days = 30) {
  const d = loadDb();
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const out = [];
  const all = d.reseller_panels || {};
  Object.entries(all).forEach(([uid, list]) => {
    (list || []).forEach(p => {
      const last = d.panel_last_active[String(p.server_id)];
      const lastTs = last ? new Date(last).getTime() : (p.created_at ? new Date(p.created_at).getTime() : 0);
      if (lastTs && lastTs < cutoff && !p.suspended) out.push({ uid, panel: p, lastTs });
    });
  });
  return out;
}

// ── Suspicious activity log ──
function recordSuspicious(uid, type, detail) {
  const d = loadDb();
  d.suspicious_log.push({ uid: String(uid), type, detail, ts: new Date().toISOString() });
  if (d.suspicious_log.length > 1000) d.suspicious_log = d.suspicious_log.slice(-500);
  saveDb(d);
}
function getSuspiciousRecent(limit = 50) {
  const d = loadDb();
  return (d.suspicious_log || []).slice(-limit).reverse();
}

// ── Login attempts (untuk #19) ──
function recordLoginAttempt(username) {
  const d = loadDb();
  const k = String(username || "").toLowerCase();
  if (!d.login_attempts[k]) d.login_attempts[k] = [];
  d.login_attempts[k].push(Date.now());
  // keep last 50
  if (d.login_attempts[k].length > 50) d.login_attempts[k] = d.login_attempts[k].slice(-50);
  saveDb(d);
  // window 10 menit
  const wnd = Date.now() - 10 * 60 * 1000;
  return d.login_attempts[k].filter(t => t >= wnd).length;
}
function getRecentLoginAttempts(username, minutes = 10) {
  const d = loadDb();
  const k = String(username || "").toLowerCase();
  const wnd = Date.now() - minutes * 60 * 1000;
  return (d.login_attempts[k] || []).filter(t => t >= wnd).length;
}

// ── API keys ──
function createApiKey(uid, label = "default") {
  const d = loadDb();
  const key = "ak_" + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  d.api_keys[key] = { uid: String(uid), label, created: new Date().toISOString(), last_used: null };
  saveDb(d);
  return key;
}
function deleteApiKey(key) {
  const d = loadDb();
  delete d.api_keys[key];
  saveDb(d);
}
function getApiKey(key) { return (loadDb().api_keys || {})[key] || null; }
function listApiKeysFor(uid) {
  const d = loadDb();
  return Object.entries(d.api_keys || {}).filter(([, v]) => String(v.uid) === String(uid))
    .map(([k, v]) => ({ key: k, ...v }));
}
function touchApiKey(key) {
  const d = loadDb();
  if (d.api_keys[key]) { d.api_keys[key].last_used = new Date().toISOString(); saveDb(d); }
}

// ── Webhook ──
function getWebhookConfig() {
  const d = loadDb();
  return d.webhook_config || { enabled: false, url: "", events: {} };
}
function setWebhookConfig(cfg) {
  const d = loadDb();
  d.webhook_config = { ...d.webhook_config, ...cfg };
  saveDb(d);
}

// ── SLA snapshot ──
function recordSlaSnapshot(serverId, pct) {
  const d = loadDb();
  const month = new Date().toISOString().slice(0, 7);
  if (!d.sla_history[month]) d.sla_history[month] = {};
  d.sla_history[month][String(serverId)] = pct;
  saveDb(d);
}
function getSlaForMonth(month) { return (loadDb().sla_history || {})[month] || {}; }
function getLastSlaReport() { return loadDb().last_sla_report; }
function setLastSlaReport(month) {
  const d = loadDb();
  d.last_sla_report = month;
  saveDb(d);
}

// ── Resource quota & leaderboard (#5, #14) ──
function computeUserResourceUsage(uid) {
  const d = loadDb();
  const list = d.reseller_panels[String(uid)] || [];
  let ram = 0, disk = 0, cpu = 0;
  list.forEach(p => {
    ram  += Number(p.ram  || 0);
    disk += Number(p.disk || 0);
    cpu  += Number(p.cpu  || 0);
  });
  return { ram, disk, cpu, count: list.length };
}
function getResourceQuotaLeaderboard(limit = 10) {
  const d = loadDb();
  const out = Object.keys(d.reseller_panels || {}).map(uid => {
    const usage = computeUserResourceUsage(uid);
    const u = d.users[uid] || {};
    return { uid, role: u.role || "user", ...usage };
  });
  out.sort((a, b) => b.ram - a.ram);
  return out.slice(0, limit);
}
