module.exports = {
    apps: [{
      name: "cpanel-bot", script: "index.js", instances: 1,
      autorestart: true, watch: false, max_memory_restart: "512M",
      restart_delay: 3000, max_restarts: 10,
      env: { NODE_ENV: "production" },
      error_file: "./logs/error.log", out_file: "./logs/output.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    }],
  };