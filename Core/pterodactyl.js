const axios  = require("axios");
const logger = require("../Utils/logger");
const config = require("../config");

// ─── Server Config Picker ─────────────────────────────────────────────────────
// Setiap fungsi di file ini terima parameter `serverNum` (default 1) untuk
// memilih panel mana yang dipakai (Server 1 = default, Server 2 = panel kedua).
function _cfg(n = 1) {
  const num = Number(n) || 1;
  if (num === 2) {
    return {
      num: 2,
      base: config.PANEL_URL2 || config.PANEL_URL,
      app: {
        Authorization: `Bearer ${config.PTLA2 || config.PTLA}`,
        "Content-Type": "application/json",
        Accept: "Application/vnd.pterodactyl.v1+json",
      },
      client: {
        Authorization: `Bearer ${config.PTLC2 || config.PTLC}`,
        "Content-Type": "application/json",
        Accept: "Application/vnd.pterodactyl.v1+json",
      },
    };
  }
  return {
    num: 1,
    base: config.PANEL_URL,
    app: {
      Authorization: `Bearer ${config.PTLA}`,
      "Content-Type": "application/json",
      Accept: "Application/vnd.pterodactyl.v1+json",
    },
    client: {
      Authorization: `Bearer ${config.PTLC}`,
      "Content-Type": "application/json",
      Accept: "Application/vnd.pterodactyl.v1+json",
    },
  };
}

// Helper: log API result
function apiOk(fn, detail = "") {
  logger.api("PTERO", `✅ ${fn}${detail ? " | " + detail : ""}`);
}
// ─── Last API Error Tracker (dipakai executeCreatePanel untuk error detail) ───
let _lastApiError = null;

function getLastApiError() { return _lastApiError; }
function clearLastApiError() { _lastApiError = null; }

function apiFail(fn, err, detail = "") {
  const pteroErrors = err?.response?.data?.errors;
  const firstDetail = Array.isArray(pteroErrors) && pteroErrors.length
    ? pteroErrors.map(e => e.detail || e.message || JSON.stringify(e)).join("; ")
    : null;
  const msg = firstDetail || err?.response?.data?.message || err?.message || String(err);
  const code = err?.response?.status || 0;
  _lastApiError = { msg: String(msg || "unknown"), code, fn, detail };
  logger.error("PTERO", `❌ ${fn}${detail ? " | " + detail : ""} → ${msg}`, err instanceof Error ? err : null);
}

// ─── Locations ────────────────────────────────────────────────────────────────

async function getLocations(serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/application/locations`, { headers: c.app });
    apiOk("getLocations", `srv${c.num} ${r.data.data.length} lokasi`);
    return r.data.data;
  } catch (e) { apiFail("getLocations", e, `srv${c.num}`); return []; }
}

// ─── Nests & Eggs ─────────────────────────────────────────────────────────────

async function getNests(serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/application/nests`, { headers: c.app });
    apiOk("getNests", `srv${c.num} ${r.data.data.length} nest`);
    return r.data.data;
  } catch (e) { apiFail("getNests", e, `srv${c.num}`); return []; }
}

async function getEggs(nestId, serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/application/nests/${nestId}/eggs?include=variables`, { headers: c.app });
    apiOk("getEggs", `srv${c.num} nestId=${nestId} | ${r.data.data.length} egg`);
    return r.data.data;
  } catch (e) { apiFail("getEggs", e, `srv${c.num} nestId=${nestId}`); return []; }
}

// ─── Users ────────────────────────────────────────────────────────────────────

async function createUser({ username, email, firstName, lastName, password, isAdmin = false }, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ createUser srv${c.num} username=${username} email=${email}`);
  try {
    const r = await axios.post(`${c.base}/api/application/users`, {
      username, email, first_name: firstName, last_name: lastName,
      password, root_admin: isAdmin, language: "en",
    }, { headers: c.app });
    if (r.status === 201) { apiOk("createUser", `srv${c.num} id=${r.data.attributes.id} username=${username}`); return r.data.attributes; }
    return null;
  } catch (e) { apiFail("createUser", e, `srv${c.num} username=${username}`); return null; }
}

async function getUserByEmail(email, serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/application/users?filter[email]=${encodeURIComponent(email)}`, { headers: c.app });
    const found = r.data.data?.length > 0;
    logger.api("PTERO", `getUserByEmail srv${c.num} email=${email} → ${found ? "DITEMUKAN id=" + r.data.data[0].attributes.id : "tidak ditemukan"}`);
    return found ? r.data.data[0].attributes : null;
  } catch (e) { apiFail("getUserByEmail", e, `srv${c.num} email=${email}`); return null; }
}

async function getAllUsers(serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/application/users`, { headers: c.app });
    apiOk("getAllUsers", `srv${c.num} ${r.data.data.length} user`);
    return r.data.data;
  } catch (e) { apiFail("getAllUsers", e, `srv${c.num}`); return []; }
}

// ─── Servers ──────────────────────────────────────────────────────────────────

async function createServer({ name, userId, eggId, dockerImage, startup, environment, ram, disk, cpu, locationId, backups = 1, description = "" }, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ createServer srv${c.num} name="${name}" userId=${userId} egg=${eggId} RAM=${ram} Disk=${disk} CPU=${cpu} oom_killer=true oom_disabled=false`);
  try {
    const r = await axios.post(`${c.base}/api/application/servers`, {
      name, user: userId, egg: eggId, docker_image: dockerImage, startup, environment,
      description,
      limits: { memory: ram, swap: 0, disk, io: 500, cpu, oom_killer: true, oom_disabled: false },
      feature_limits: { databases: 0, backups, allocations: 1 },
      deploy: { locations: [locationId], dedicated_ip: false, port_range: [] },
    }, { headers: c.app });
    if (r.status === 201) {
      apiOk("createServer", `srv${c.num} id=${r.data.attributes.id} identifier=${r.data.attributes.identifier} name="${name}"`);
      return r.data.attributes;
    }
    return null;
  } catch (e) { apiFail("createServer", e, `srv${c.num} name="${name}"`); return null; }
}

async function getServer(serverId, serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/application/servers/${serverId}`, { headers: c.app });
    if (r.status === 200) { apiOk("getServer", `srv${c.num} id=${serverId} name="${r.data.attributes.name}"`); return r.data.attributes; }
    return null;
  } catch (e) { apiFail("getServer", e, `srv${c.num} id=${serverId}`); return null; }
}

async function getServerDetails(serverId, serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/application/servers/${serverId}?include=allocations,egg,nest`, { headers: c.app });
    if (r.status === 200) { apiOk("getServerDetails", `srv${c.num} id=${serverId}`); return r.data.attributes; }
    return null;
  } catch (e) { apiFail("getServerDetails", e, `srv${c.num} id=${serverId}`); return null; }
}

async function changeServerUser(serverId, newPteroUserId, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ changeServerUser srv${c.num} serverId=${serverId} newUser=${newPteroUserId}`);
  try {
    const r1 = await axios.get(`${c.base}/api/application/servers/${serverId}`, { headers: c.app });
    if (r1.status !== 200) return false;
    const srv = r1.data.attributes;
    const r2 = await axios.patch(`${c.base}/api/application/servers/${serverId}/details`, {
      name: srv.name, user: newPteroUserId,
      description: srv.description || "", external_id: srv.external_id || null,
    }, { headers: c.app });
    const ok = r2.status === 200;
    if (ok) apiOk("changeServerUser", `srv${c.num} server=${serverId} → user=${newPteroUserId}`);
    else apiFail("changeServerUser", { message: `status ${r2.status}` }, `srv${c.num} server=${serverId}`);
    return ok;
  } catch (e) { apiFail("changeServerUser", e, `srv${c.num} server=${serverId}`); return false; }
}

async function deleteServer(serverId, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ deleteServer srv${c.num} id=${serverId}`);
  try {
    const r = await axios.delete(`${c.base}/api/application/servers/${serverId}`, { headers: c.app });
    const ok = r.status === 204;
    if (ok) apiOk("deleteServer", `srv${c.num} id=${serverId}`);
    else apiFail("deleteServer", { message: `status ${r.status}` }, `srv${c.num} id=${serverId}`);
    return ok;
  } catch (e) { apiFail("deleteServer", e, `srv${c.num} id=${serverId}`); return false; }
}

async function listServers(serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    let all = [];
    let page = 1;
    while (true) {
      const r = await axios.get(
        `${c.base}/api/application/servers?include=allocations&page=${page}&per_page=100`,
        { headers: c.app }
      );
      all = all.concat(r.data.data);
      const meta = r.data.meta?.pagination;
      if (!meta || meta.current_page >= meta.total_pages) break;
      page++;
      if (page > 500) break; // safety cap untuk jutaan server
    }
    apiOk("listServers", `srv${c.num} ${all.length} server (${page} halaman)`);
    return all;
  } catch (e) { apiFail("listServers", e, `srv${c.num}`); return []; }
}

// ─── Paginated listServers (satu halaman API per request) ─────────────────────
async function listServersPage(serverNum = 1, page = 1, perPage = 50) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(
      `${c.base}/api/application/servers?include=allocations&page=${page}&per_page=${perPage}`,
      { headers: c.app }
    );
    const meta = r.data.meta?.pagination || {};
    apiOk("listServersPage", `srv${c.num} pg=${page}/${meta.total_pages || 1} (${meta.total || 0} server)`);
    return {
      servers:     r.data.data || [],
      currentPage: meta.current_page || page,
      totalPages:  meta.total_pages  || 1,
      totalCount:  meta.total        || (r.data.data || []).length,
    };
  } catch (e) {
    apiFail("listServersPage", e, `srv${c.num} page=${page}`);
    return { servers: [], currentPage: 1, totalPages: 1, totalCount: 0 };
  }
}

async function suspendServer(serverId, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ suspendServer srv${c.num} id=${serverId}`);
  try {
    const r = await axios.post(`${c.base}/api/application/servers/${serverId}/suspend`, {}, { headers: c.app });
    const ok = r.status === 204;
    if (ok) apiOk("suspendServer", `srv${c.num} id=${serverId}`); else apiFail("suspendServer", { message: `status ${r.status}` });
    return ok;
  } catch (e) { apiFail("suspendServer", e, `srv${c.num} id=${serverId}`); return false; }
}

async function unsuspendServer(serverId, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ unsuspendServer srv${c.num} id=${serverId}`);
  try {
    const r = await axios.post(`${c.base}/api/application/servers/${serverId}/unsuspend`, {}, { headers: c.app });
    const ok = r.status === 204;
    if (ok) apiOk("unsuspendServer", `srv${c.num} id=${serverId}`); else apiFail("unsuspendServer", { message: `status ${r.status}` });
    return ok;
  } catch (e) { apiFail("unsuspendServer", e, `srv${c.num} id=${serverId}`); return false; }
}

async function reinstallServer(serverId, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ reinstallServer srv${c.num} id=${serverId}`);
  try {
    const r = await axios.post(`${c.base}/api/application/servers/${serverId}/reinstall`, {}, { headers: c.app });
    const ok = r.status === 204;
    if (ok) apiOk("reinstallServer", `srv${c.num} id=${serverId}`); else apiFail("reinstallServer", { message: `status ${r.status}` });
    return ok;
  } catch (e) { apiFail("reinstallServer", e, `srv${c.num} id=${serverId}`); return false; }
}

// ─── Power Control (Wings Client API) ────────────────────────────────────────

async function sendPowerAction(identifier, action, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ sendPowerAction srv${c.num} identifier=${identifier} signal=${action}`);
  try {
    const r = await axios.post(`${c.base}/api/client/servers/${identifier}/power`,
      { signal: action }, { headers: c.client });
    const ok = r.status === 204;
    if (ok) apiOk("sendPowerAction", `srv${c.num} ${identifier} → ${action}`);
    else apiFail("sendPowerAction", { message: `status ${r.status}` }, `srv${c.num} ${identifier} signal=${action}`);
    return ok;
  } catch (e) { apiFail("sendPowerAction", e, `srv${c.num} ${identifier} signal=${action}`); return false; }
}

async function getServerResources(identifier, serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/client/servers/${identifier}/resources`, { headers: c.client });
    if (r.status === 200) {
      const st = r.data.attributes?.current_state || "?";
      const cpu = (r.data.attributes?.resources?.cpu_absolute || 0).toFixed(1);
      apiOk("getServerResources", `srv${c.num} ${identifier} state=${st} cpu=${cpu}%`);
      return r.data.attributes;
    }
    return null;
  } catch (e) { apiFail("getServerResources", e, `srv${c.num} identifier=${identifier}`); return null; }
}

// ─── Backup ───────────────────────────────────────────────────────────────────

async function createBackup(identifier, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ createBackup srv${c.num} identifier=${identifier}`);
  try {
    const r = await axios.post(`${c.base}/api/client/servers/${identifier}/backups`,
      { name: `Backup-${new Date().toISOString().slice(0,10)}`, is_locked: false },
      { headers: c.client });
    if (r.status === 200) { apiOk("createBackup", `srv${c.num} ${identifier} uuid=${r.data.attributes.uuid}`); return r.data.attributes; }
    return null;
  } catch (e) { apiFail("createBackup", e, `srv${c.num} identifier=${identifier}`); return null; }
}

async function getBackups(identifier, serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/client/servers/${identifier}/backups`, { headers: c.client });
    if (r.status === 200) { apiOk("getBackups", `srv${c.num} ${identifier} → ${r.data.data.length} backup`); return r.data.data; }
    return [];
  } catch (e) { apiFail("getBackups", e, `srv${c.num} identifier=${identifier}`); return []; }
}

// ─── Schedules (Cron) ─────────────────────────────────────────────────────────

async function getSchedules(identifier, serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/client/servers/${identifier}/schedules`, { headers: c.client });
    if (r.status === 200) { apiOk("getSchedules", `srv${c.num} ${identifier} → ${r.data.data.length} jadwal`); return r.data.data; }
    return [];
  } catch (e) { apiFail("getSchedules", e, `srv${c.num} identifier=${identifier}`); return []; }
}

async function createSchedule(identifier, { name, minute, hour, dayOfWeek, dayOfMonth, month, isActive = true }, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ createSchedule srv${c.num} ${identifier} name="${name}" cron=${minute} ${hour} ${dayOfMonth} ${month} ${dayOfWeek}`);
  try {
    const r = await axios.post(`${c.base}/api/client/servers/${identifier}/schedules`, {
      name, cron_minute: minute, cron_hour: hour,
      cron_day_of_week: dayOfWeek, cron_day_of_month: dayOfMonth,
      cron_month: month, is_active: isActive,
    }, { headers: c.client });
    if (r.status === 200) { apiOk("createSchedule", `srv${c.num} ${identifier} id=${r.data.attributes.id}`); return r.data.attributes; }
    return null;
  } catch (e) { apiFail("createSchedule", e, `srv${c.num} identifier=${identifier}`); return null; }
}

async function deleteSchedule(identifier, scheduleId, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ deleteSchedule srv${c.num} ${identifier} scheduleId=${scheduleId}`);
  try {
    const r = await axios.delete(`${c.base}/api/client/servers/${identifier}/schedules/${scheduleId}`, { headers: c.client });
    const ok = r.status === 204;
    if (ok) apiOk("deleteSchedule", `srv${c.num} ${identifier} scheduleId=${scheduleId}`);
    return ok;
  } catch (e) { apiFail("deleteSchedule", e, `srv${c.num} ${identifier} scheduleId=${scheduleId}`); return false; }
}

// ─── Reset Password ───────────────────────────────────────────────────────────

async function resetUserPassword(pteroUserId, newPassword, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ resetUserPassword srv${c.num} pteroUserId=${pteroUserId}`);
  try {
    const r1 = await axios.get(`${c.base}/api/application/users/${pteroUserId}`, { headers: c.app });
    if (r1.status !== 200) return false;
    const u = r1.data.attributes;
    const r2 = await axios.patch(`${c.base}/api/application/users/${pteroUserId}`, {
      username: u.username, email: u.email,
      first_name: u.first_name, last_name: u.last_name,
      password: newPassword, language: "en",
    }, { headers: c.app });
    const ok = r2.status === 200;
    if (ok) apiOk("resetUserPassword", `srv${c.num} pteroUserId=${pteroUserId}`);
    else apiFail("resetUserPassword", { message: `status ${r2.status}` }, `srv${c.num} pteroUserId=${pteroUserId}`);
    return ok;
  } catch (e) { apiFail("resetUserPassword", e, `srv${c.num} pteroUserId=${pteroUserId}`); return false; }
}

// ─── Rename Server ────────────────────────────────────────────────────────────

async function renameServer(serverId, newName, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ renameServer srv${c.num} id=${serverId} newName="${newName}"`);
  try {
    const r1 = await axios.get(`${c.base}/api/application/servers/${serverId}`, { headers: c.app });
    if (r1.status !== 200) return false;
    const srv = r1.data.attributes;
    const r2 = await axios.patch(`${c.base}/api/application/servers/${serverId}/details`, {
      name: newName, user: srv.user,
      description: srv.description || "", external_id: srv.external_id || null,
    }, { headers: c.app });
    const ok = r2.status === 200;
    if (ok) apiOk("renameServer", `srv${c.num} id=${serverId} → "${newName}"`);
    else apiFail("renameServer", { message: `status ${r2.status}` }, `srv${c.num} id=${serverId}`);
    return ok;
  } catch (e) { apiFail("renameServer", e, `srv${c.num} id=${serverId}`); return false; }
}

// ─── Nodes ────────────────────────────────────────────────────────────────────

async function getNodes(serverNum = 1) {
  const c = _cfg(serverNum);
  try {
    const r = await axios.get(`${c.base}/api/application/nodes`, { headers: c.app });
    apiOk("getNodes", `srv${c.num} ${r.data.data.length} node`);
    return r.data.data;
  } catch (e) { apiFail("getNodes", e, `srv${c.num}`); return []; }
}

async function getNodeStatus(nodeAttrs, serverNum = 1) {
  const c = _cfg(serverNum);
  const id     = nodeAttrs.id;
  const fqdn   = nodeAttrs.fqdn;
  const scheme = nodeAttrs.scheme || "https";
  const port   = nodeAttrs.daemon_listen || 8080;
  try {
    const cfg = await axios.get(`${c.base}/api/application/nodes/${id}/configuration`, { headers: c.app });
    const token = cfg.data.token;
    await axios.get(`${scheme}://${fqdn}:${port}/api/system`, {
      headers: { Authorization: `Bearer ${token}` }, timeout: 5000,
    });
    logger.api("PTERO", `getNodeStatus srv${c.num} node=${id} (${fqdn}) → ONLINE`);
    return { online: true };
  } catch (err) {
    if (err.response) {
      logger.api("PTERO", `getNodeStatus srv${c.num} node=${id} (${fqdn}) → ONLINE (HTTP response)`);
      return { online: true };
    }
    logger.api("PTERO", `getNodeStatus srv${c.num} node=${id} (${fqdn}) → OFFLINE: ${err.message}`);
    return { online: false };
  }
}

// ─── Update Server Build (Upgrade Resource) ───────────────────────────────────

async function updateServerBuild(serverId, { memory, disk, cpu, swap = 0, io = 500, backups = 1, databases = 0 }, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ updateServerBuild srv${c.num} id=${serverId} RAM=${memory} Disk=${disk} CPU=${cpu}`);
  try {
    const r1 = await axios.get(`${c.base}/api/application/servers/${serverId}`, { headers: c.app });
    if (r1.status !== 200) return false;
    const srv = r1.data.attributes;
    const allocs = srv.relationships?.allocations?.data || [];
    const allocId = allocs.length > 0 ? allocs[0].attributes.id : null;
    if (!allocId) { logger.warn("PTERO", `updateServerBuild: tidak ada alokasi untuk server ${serverId}`); return false; }
    const r2 = await axios.patch(`${c.base}/api/application/servers/${serverId}/build`, {
      allocation: allocId,
      memory:     memory   !== undefined ? memory   : srv.limits.memory,
      swap:       swap     !== undefined ? swap     : srv.limits.swap,
      disk:       disk     !== undefined ? disk     : srv.limits.disk,
      io:         io       !== undefined ? io       : srv.limits.io,
      cpu:        cpu      !== undefined ? cpu      : srv.limits.cpu,
      threads: null,
      feature_limits: {
        databases:   databases !== undefined ? databases : srv.feature_limits.databases,
        backups:     backups   !== undefined ? backups   : srv.feature_limits.backups,
        allocations: srv.feature_limits.allocations || 1,
      },
    }, { headers: c.app });
    const ok = r2.status === 200;
    if (ok) apiOk("updateServerBuild", `srv${c.num} id=${serverId}`);
    else apiFail("updateServerBuild", { message: `status ${r2.status}` }, `srv${c.num} id=${serverId}`);
    return ok;
  } catch (e) { apiFail("updateServerBuild", e, `srv${c.num} id=${serverId}`); return false; }
}

async function updateUserToAdmin(pteroUserId, isAdmin = true, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ updateUserToAdmin srv${c.num} pteroUserId=${pteroUserId} isAdmin=${isAdmin}`);
  try {
    const r = await axios.get(`${c.base}/api/application/users/${pteroUserId}`, { headers: c.app });
    if (r.status !== 200) return false;
    const u = r.data.attributes;
    const r2 = await axios.patch(`${c.base}/api/application/users/${pteroUserId}`, {
      username: u.username, email: u.email,
      first_name: u.first_name, last_name: u.last_name,
      root_admin: isAdmin, language: "en",
    }, { headers: c.app });
    const ok = r2.status === 200;
    if (ok) apiOk("updateUserToAdmin", `srv${c.num} pteroUserId=${pteroUserId} isAdmin=${isAdmin}`);
    return ok;
  } catch (e) { apiFail("updateUserToAdmin", e, `srv${c.num} pteroUserId=${pteroUserId}`); return false; }
}

async function updateServerDescription(serverId, description, serverNum = 1) {
  const c = _cfg(serverNum);
  logger.api("PTERO", `→ updateServerDescription srv${c.num} serverId=${serverId}`);
  try {
    const r1 = await axios.get(`${c.base}/api/application/servers/${serverId}`, { headers: c.app });
    if (r1.status !== 200) return false;
    const srv = r1.data.attributes;
    const r2 = await axios.patch(`${c.base}/api/application/servers/${serverId}/details`, {
      name: srv.name,
      user: srv.user,
      description: description || "",
      external_id: srv.external_id || null,
    }, { headers: c.app });
    const ok = r2.status === 200;
    if (ok) apiOk("updateServerDescription", `srv${c.num} server=${serverId}`);
    else apiFail("updateServerDescription", { message: `status ${r2.status}` }, `srv${c.num} server=${serverId}`);
    return ok;
  } catch (e) { apiFail("updateServerDescription", e, `srv${c.num} server=${serverId}`); return false; }
}

// ── Get last console logs (untuk auto-screenshot console) ──
async function getConsoleLogs(identifier, serverNum = 1, maxLines = 30) {
  try {
    const c = _cfg(serverNum);
    // Pterodactyl client API tidak punya endpoint langsung untuk log lampau,
    // tapi kita bisa coba ambil dari /resources atau workaround pakai Wings.
    // Sebagai approximation, kita ambil resource snapshot + status terakhir.
    const r = await axios.get(`${c.base}/api/client/servers/${identifier}/resources`, { headers: c.client });
    const a = r.data?.attributes || {};
    apiOk("getConsoleLogs", `srv${c.num} server=${identifier}`);
    return {
      state: a.current_state || "unknown",
      cpu: a.resources?.cpu_absolute || 0,
      ram_mb: Math.round((a.resources?.memory_bytes || 0) / 1024 / 1024),
      disk_mb: Math.round((a.resources?.disk_bytes || 0) / 1024 / 1024),
      net_rx: a.resources?.network_rx_bytes || 0,
      net_tx: a.resources?.network_tx_bytes || 0,
      uptime_ms: a.resources?.uptime || 0,
    };
  } catch (e) { apiFail("getConsoleLogs", e, `srv${serverNum} server=${identifier}`); return null; }
}

// ── List files (untuk disk cleaner suggestion) ──
async function listFiles(identifier, directory = "/", serverNum = 1) {
  try {
    const c = _cfg(serverNum);
    const r = await axios.get(`${c.base}/api/client/servers/${identifier}/files/list`, {
      headers: c.client,
      params: { directory },
    });
    apiOk("listFiles", `srv${c.num} server=${identifier} dir=${directory}`);
    return r.data?.data || [];
  } catch (e) { apiFail("listFiles", e, `srv${serverNum} server=${identifier} dir=${directory}`); return []; }
}

// ── Delete file (untuk disk cleaner) ──
async function deleteFiles(identifier, root, files, serverNum = 1) {
  try {
    const c = _cfg(serverNum);
    await axios.post(`${c.base}/api/client/servers/${identifier}/files/delete`,
      { root, files }, { headers: c.client });
    apiOk("deleteFiles", `srv${c.num} server=${identifier} count=${files.length}`);
    return true;
  } catch (e) { apiFail("deleteFiles", e, `srv${serverNum} server=${identifier}`); return false; }
}

module.exports = {
  getLocations, getNests, getEggs,
  createUser, getUserByEmail, getAllUsers,
  createServer, getServer, getServerDetails, deleteServer, listServers,
  suspendServer, unsuspendServer, reinstallServer,
  sendPowerAction, getServerResources,
  createBackup, getBackups,
  getSchedules, createSchedule, deleteSchedule,
  resetUserPassword, renameServer, changeServerUser,
  getNodes, getNodeStatus, updateUserToAdmin, updateServerBuild,
  updateServerDescription,
  getConsoleLogs, listFiles, deleteFiles,
  getLastApiError, clearLastApiError,
  listServersPage,
};
