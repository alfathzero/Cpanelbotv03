const fs   = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "bot.log");
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB, lalu rotate

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function pad(str, len) {
  return String(str).padEnd(len).slice(0, len);
}

function fmt(level, tag, message) {
  const icons = { ERROR: "❌", WARN: "⚠️ ", INFO: "ℹ️ ", DEBUG: "🔹", ACTION: "👆", STEP: "📝", API: "🌐", SYS: "⚙️ ", EVENT: "📢" };
  return `[${ts()}] ${icons[level] || "  "} ${pad("[" + tag + "]", 22)} ${message}`;
}

function writeToFile(line) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) {
      const old = fs.readFileSync(LOG_FILE, "utf8");
      fs.writeFileSync(LOG_FILE, old.slice(old.length / 2));
    }
    fs.appendFileSync(LOG_FILE, line + "\n");
  } catch {}
}

function log(level, tag, message, err = null) {
  const line = fmt(level, tag, message);
  if (level === "ERROR") {
    console.error(line);
    if (err) {
      const errLine = `          ↳ ${err.message || err}`;
      console.error(errLine);
      writeToFile(errLine);
      if (err.stack) {
        const stack = err.stack.split("\n").slice(1, 6).map(l => "            " + l.trim()).join("\n");
        console.error(stack);
        writeToFile(stack);
      }
    }
  } else if (level === "WARN") {
    console.warn(line);
    if (err) console.warn(`          ↳ ${err.message || err}`);
  } else {
    console.log(line);
  }
  writeToFile(line);
}

// Shortcut helpers
const info   = (tag, msg)       => log("INFO",   tag, msg);
const warn   = (tag, msg, err)  => log("WARN",   tag, msg, err);
const error  = (tag, msg, err)  => log("ERROR",  tag, msg, err);
const debug  = (tag, msg)       => log("DEBUG",  tag, msg);
const action = (tag, msg)       => log("ACTION", tag, msg);
const step   = (tag, msg)       => log("STEP",   tag, msg);
const api    = (tag, msg)       => log("API",    tag, msg);
const sys    = (tag, msg)       => log("SYS",    tag, msg);
const event  = (tag, msg)       => log("EVENT",  tag, msg);

module.exports = { log, info, warn, error, debug, action, step, api, sys, event };
