module.exports = {
  BOT_TOKEN: "8115246791:AAFe4k_c7n7JUWL-J1fsmLOksILIUsXtbxU",

  // ─── Identitas Bot ────────────────────────────────────────────────────────
  BOT_NAME: "Pterodactyl Panel Bot",
  DEVELOPER_NAME: "@ALFA21L",
  DEVELOPER_USERNAME: "ALFA21L",
  CREDIT_TEXT: "Dibuat dengan ❤️ oleh Developer",

  // ─── Pesan Sambutan (/start) ──────────────────────────────────────────────
  WELCOME_GREETING: "Selamat datang! Bot siap membantumu kelola panel dengan mudah 🚀",

  // ─── Banner /start ────────────────────────────────────────────────────────
  // BANNER_TYPE: "none" | "photo" | "video" | "animation"
  BANNER_TYPE: "video", // ubah aja tergantung link di bawah foto/video
  BANNER_FILE_ID: "https://n.uguu.se/eAnJrWrH.mp4", // taro link video/foto kalian 

  // ─── Server Panel ─────────────────────────────────────────────────────────
  // Server 1 = panel utama (legacy, dipakai semua role)
  // Server 2 = panel kedua (hanya owner secara default — lihat SERVER_ACCESS)
  PTLA: "",
  PTLC: "",
  PANEL_URL: "",

  // Konfigurasi Server 2 (isi kalau pakai server kedua)
  PTLA2: "",
  PTLC2: "",
  PANEL_URL2: "",

  // Nama tampilan tiap server
  SERVER_NAMES: {
    1: "Server 1",
    2: "Server 2",
  },

  // Akses server per role — angka = nomor server yang BOLEH dipakai
  // Reseller & Premium hanya boleh server 1; Owner bebas pakai 1 & 2
  SERVER_ACCESS: {
    user:     [1],
    reseller: [1],
    premium:  [1,2],
    owner:    [1, 2],
  },

  OWNER_IDS: [6525450582],

  // ─── Spotify API (untuk command /play) ───────────────────────────────────────
  // Daftarkan di https://developer.spotify.com/dashboard → buat app → salin Client ID & Secret
  SPOTIFY_CLIENT_ID:     "",
  SPOTIFY_CLIENT_SECRET: "",

  GROUP_ID: -1003783008929,

  // true  = bot hanya aktif di GROUP_ID
  // false = bot aktif di semua chat
  GROUP_ONLY: false,

  // ─── Batas Panel Per Role ─────────────────────────────────────────────────
  // Reseller: batasnya per-user (diatur owner via "Set Limit Reseller")
  // Nilai di sini hanya fallback jika reseller belum punya limit yang diset owner
  PANEL_LIMITS: {
    user:     0,
    premium:  9999,
    reseller: 5,
    owner:    9999,
  },

  DAILY_PANEL_LIMIT: {
    user:     0,
    reseller: 3,
    premium:  10,
    owner:    9999,
  },

  DB_FILE: "bot_data.json",
  EMAIL_DOMAIN: "alfa.id",

  // ─── Sistem Expired Panel ─────────────────────────────────────────────────
  PANEL_EXPIRE_DAYS: 30,
  EXPIRE_CHECK_HOURS: 12,
  AUTO_DELETE_DAYS: 7,

  // ─── Trial Panel ─────────────────────────────────────────────────────────
  TRIAL_HOURS: 24,
  TRIAL_PLAN: { name: "Trial", ram: 512, disk: 5120, cpu: 50 },

  // ─── Referral System ──────────────────────────────────────────────────────
  // Jumlah bonus hari panel yang diterima per referral berhasil
  REFERRAL_BONUS_DAYS: 3,

  // ─── Auto Renewal ─────────────────────────────────────────────────────────
  AUTO_RENEWAL_ENABLED: false,

  // ─── Over Resource Action ─────────────────────────────────────────────────
  // Aksi otomatis jika server melebihi batas: "suspend" atau "delete"
  OVER_RESOURCE_ACTION: "suspend",
  // Batas absolut resource (bukan persen):
  RESOURCE_CPU_LIMIT:     80,    // CPU dalam persen (%)  — 0 = nonaktifkan
  RESOURCE_RAM_LIMIT_MB:  2048,  // RAM dalam MB (2048=2GB) — 0 = nonaktifkan
  RESOURCE_DISK_LIMIT_MB: 5120,  // Disk dalam MB (5120=5GB) — 0 = nonaktifkan
  // Interval cek resource dalam menit (0 = nonaktifkan)
  RESOURCE_CHECK_INTERVAL_MINUTES: 5,
  // Batas peringatan sebelum suspend/delete (1 = langsung suspend setelah 1 warning)
  RESOURCE_ALERT_THRESHOLD: 2,

  // ─── Bandwidth Limit Per Server ───────────────────────────────────────────
  // 0 = nonaktifkan; set per-server via perintah /setbw <server_id> <GB>
  BANDWIDTH_LIMIT_GB_PER_SERVER: 0,

  // ─── Multi-Node ───────────────────────────────────────────────────────────
  // true = tampilkan pilihan node saat buat server
  MULTI_NODE_ENABLED: true,

  // ─── Whitelist Egg Per Role ───────────────────────────────────────────────
  // null = semua egg boleh | [1,2,3] = hanya egg ID tertentu
  EGG_WHITELIST: {
    user:     null,
    reseller: null,
    premium:  null,
    owner:    null,
  },

  // ─── Laporan Harian ───────────────────────────────────────────────────────
  DAILY_REPORT_HOUR: 7,

  // ─── Node Monitoring ──────────────────────────────────────────────────────
  NODE_CHECK_INTERVAL_MINUTES: 30,

  // ─── Server Down Monitoring ───────────────────────────────────────────────
  // Cek apakah server panel user mati (crash sendiri), notifikasi user + grup + owner
  // 0 = nonaktifkan
  SERVER_DOWN_CHECK_INTERVAL_MINUTES: 5,

  // ─── 2FA PIN ──────────────────────────────────────────────────────────────
  PIN_REQUIRED_ACTIONS: ["power", "delete"],

  // ─── Notifikasi User Baru ─────────────────────────────────────────────────
  // true = kirim notif ke grup saat ada user baru /start pertama kali
  NEW_USER_NOTIFY_GROUP: true,

  // ─── Custom Welcome Per Role ──────────────────────────────────────────────
  // Kosongkan ("") untuk menggunakan WELCOME_GREETING default
  WELCOME_BY_ROLE: {
    owner:    "Selamat datang, Owner! Semua fitur tersedia untukmu 👑",
    partner:  "Selamat datang, Partner! Akses premium plus fitur kelola tim tersedia untukmu 🌟",
    premium:  "Selamat datang, Member Premium! Nikmati akses tak terbatas 💎",
    reseller: "Selamat datang, Reseller! Kelola panel bisnismu di sini 🔶",
    user:     "",
  },

  // ─── Sistem Poin & Reward ─────────────────────────────────────────────────
  POINT_REWARDS: {
    create_panel:   5,   // poin saat buat panel baru
    extend_panel:   2,   // poin saat perpanjang panel
    referral:       15,  // poin saat referral buat panel
    redeem_voucher: 3,   // poin saat redeem voucher apapun
    daily_login:    1,   // poin saat /start per hari
  },
  // Berapa poin untuk mendapatkan 1 hari perpanjangan
  POINT_EXCHANGE_RATE: 50,

  // ─── Whitelist Mode ───────────────────────────────────────────────────────
  // Jika true, hanya user yang di-whitelist owner yang bisa pakai bot
  // (Override dari DB — DB yang jadi sumber kebenaran setelah bot jalan)

  // ─── Warna Tombol Dashboard Web ───────────────────────────────────────────
  // Warna bisa diisi kode hex (#rrggbb), rgb(), atau nama warna CSS
  // Kosongkan ("") untuk menggunakan warna default dari tema yang dipilih

    // ─── Panel Monitor ────────────────────────────────────────────────────────
    // Deteksi otomatis server/user/admin yang dibuat manual di Pterodactyl
    // (tidak melalui bot) → kirim notifikasi ke owner.
    //
    // Cara kerja:
    //   - Setiap interval, bot fetch semua server & user via PTLA (admin API key)
    //   - Bandingkan dengan database bot
    //   - Jika ada yang tidak terdaftar → notif owner
    //   - Admin baru (root_admin) → notif owner SEKETIKA dengan peringatan kritis
    PANEL_MONITOR: {
      enabled:          true,   // true = aktif | false = nonaktifkan
      interval_minutes: 10,     // cek setiap N menit (minimal 5)
    },
    MONITOR_DEBUG: false,       // true = tampilkan error detail ke console

  
  // ─── Emoji Toggle Telegram Bot ────────────────────────────────────────────
  // Ganti emoji sesuai selera untuk tombol toggle ON/OFF di bot Telegram
  TOGGLE_EMOJI: {
    ON:  "🟢",  // emoji saat fitur AKTIF   — bisa ganti ke ✅ 💚 🔵 dsb
    OFF: "🔴",  // emoji saat fitur NONAKTIF — bisa ganti ke ❌ 🔕 ⭕ dsb
  },

  // ─── Premium Animated Emoji (tg-emoji) ───────────────────────────────────
  // ID emoji premium/animated Telegram untuk dipakai di TEKS PESAN (bukan tombol).
  // Cara dapat ID:
  //   1. Kirim emoji animasi ke chat siapapun
  //   2. Forward pesan itu ke @EmojiIDsBot ATAU gunakan Bot API getUpdates
  //   3. Salin field custom_emoji_id dari respons
  //
  // Telegram Premium user bisa pakai emoji apapun dari pack mereka.
  // CATATAN: Teks label TOMBOL (button) tidak mendukung animated emoji
  //          karena batasan Telegram Bot API — hanya teks pesan yang bisa.
  //
  // Kosongkan string ("") untuk fallback ke emoji Unicode biasa.
  PREMIUM_EMOJI: {
    // Emoji untuk pesan notifikasi & hasil toggle (default: ID premium publik)
    SUCCESS:       "",   // ✅ animated
    ERROR:         "6206110936789423908",   // ❌ animated
    WARNING:       "6206174450765796040",   // ⚠️ animated
    INFO:          "",   // ℹ️ animated
    FIRE:          "",   // 🔥 animated
    LIGHTNING:     "5456140674028019486",   // ⚡ animated
    DIAMOND:       "6206479140040743133",   // 💎 animated
    ROCKET:        "5445284980978621387",   // 🚀 animated
    CROWN:         "6206096153511990389",   // 👑 animated
    TOGGLE_ON:     "6206479140040743133",   // ✅ animated saat fitur diaktifkan
    TOGGLE_OFF:    "6206110936789423908",   // ❌ animated saat fitur dinonaktifkan
    PANEL_CREATED: "6206479140040743133",   // 💎 animated saat panel berhasil dibuat
    PANEL_DELETED: "6206110936789423908",   // ❌ animated saat panel dihapus
    ALERT:         "6206174450765796040",   // ⚠️ animated untuk peringatan resource
    STAR:          "6298821774423361023",   // ⭐ animated
    PARTY:         "6206378324273403309",   // 🎉 animated
    HEART:         "5406926593698312391",   // ❤️ animated
    SPARKLES:      "5852724394928905160",   // ✨ animated
    GIFT:          "6206027872121918710",   // 🎁 animated
    SHIELD:        "5963192688948811454",   // 🛡 animated
    MONEY:         "6190336264940559752",   // 💰 animated
    CHART:         "6206445639295834047",   // 📊 animated
    GEAR:          "4904936030232117798",   // ⚙️ animated
    BACK:          "",   // ◀️ animated
    // ─── Tambahan emoji untuk teks menu (welcome, header, dll) ────────────
    BOT:           "5372981976804366741",   // 🤖 animated
    WAVE:          "5472055112702629499",   // 👋 animated
    PIN:           "6206190608432764318",   // 📌 animated
    USER:          "5877530150345641603",   // 👤 animated
    ID_CARD:       "5969696910112463071",   // 🆔 animated
    MASK:          "5359441070201513074",   // 🎭 animated
    USERS:         "5258513401784573443",   // 👥 animated
    CLOCK:         "6242308461598610637",   // ⏱️ animated
    LAPTOP:        "5431376038628171216",   // 💻 animated
    DESKTOP:       "5431376038628171216",   // 🖥️ animated
    HOURGLASS:     "5289930378885214069",   // ⏳ animated
    DISK:          "5462956611033117422",   // 💿 animated
    EARTH:         "5399898266265475100",   // 🌍 animated
    HOME:          "5395831812704452001",   // 🏠 animated
    LIST:          "5197269100878907942",   // 📋 animated
    PAGES:         "5839323457015256759",   // 📑 animated
    ARROW_LEFT:    "5852580977380956488",   // ◀️ animated
    ARROW_RIGHT:   "5852669475182090523",   // ▶️ animated
    // ── Tambahan emoji premium (auto-added) ──
    ADMISSION: "5257969839313526622", // 🎟️ animated
    ALARM: "6206174450765796040", // ⏰ animated
    ARROW_UP: "5852484701394049164", // ⬆️ animated
    BELL: "6204010762206189094", // 🔔 animated
    BLUE_DOT: "5787237241860394459", // 🔵 animated
    BRAIN: "5116380246626534280", // 🧠 animated
    BRIGHT: "5852724394928905160", // 🔆 animated
    BULB: "5258466217273871977", // 💡 animated
    CALENDAR: "5274055917766202507", // 📅 animated
    CARD_INDEX: "5877680341057015789", // 🗂️ animated
    CHART_UP: "6206445639295834047", // 📈 animated
    CLOCK_FACE: "6242308461598610637", // 🕐 animated
    DIAMOND_ORANGE: "5280735858926822987", // 🔶 animated
    EGG: "6237876149838420539", // 🥚 animated
    EMAIL: "6203886371363364022", // 📧 animated
    EMPTY_BOX: "5352896944496728039", // 📭 animated
    ENVELOPE: "5258514780469075716", // ✉️ animated
    FLOPPY: "5462956611033117422", // 💾 animated
    FOLDER: "5258514780469075716", // 📁 animated
    GAMEPAD: "5258508428212445001", // 🎮 animated
    GLOBE: "5879585266426973039", // 🌐 animated
    GREEN_DOT: "6084897373329296142", // 🟢 animated
    ID_BADGE: "5422683699130933153", // 🪪 animated
    INFINITY: "5945206916396357400", // ♾️ animated
    KEY: "5454386656628991407", // 🔑 animated
    LABEL: "5843862283964390528", // 🏷️ animated
    LINK: "5945206916396357400", // 🔗 animated
    LOCK: "5258476306152038031", // 🔒 animated
    LOCK_KEY: "5472308992514464048", // 🔐 animated
    LOUDSPEAKER: "5780405967527089720", // 📢 animated
    MAN: "5319161050128459957", // 👨 animated
    MEDAL_BRONZE: "5282750778409233531", // 🥉 animated
    MEDAL_GOLD: "5280735858926822987", // 🥇 animated
    MEDAL_SILVER: "5283195573812340110", // 🥈 animated
    MEMO: "5257965174979042426", // 📝 animated
    MINUS: "6206446249181189526", // ➖ animated
    NAME_BADGE: "6206041890895172990", // 📛 animated
    OPEN_FOLDER: "5258514780469075716", // 📂 animated
    ORANGE_DOT: "5873162705476524021", // 🟠 animated
    OUTBOX: "5433614747381538714", // 📤 animated
    PACKAGE: "5463172695132745432", // 📦 animated
    PAPERCLIP: "5350305387000130384", // 📎 animated
    PAUSE: "6255738287462288807", // ⏸️ animated
    PENCIL: "5879841310902324730", // ✏️ animated
    PHONE: "5852565159016417673", // 📱 animated
    PINGPONG: "5269563867305879894", // 🏓 animated
    PLUS: "5830060857530257978", // ➕ animated
    POINT_RIGHT: "5463392464314315076", // 👉 animated
    PROHIBITED: "6206396878532121864", // 🚫 animated
    QUESTION: "6203722870548338074", // ❓ animated
    RED_DOT: "5918075981649679952", // 🔴 animated
    REFRESH: "6204251568137574946", // 🔄 animated
    RULER: "6097934939829839073", // 📏 animated
    SCROLL: "5956561916573782596", // 📜 animated
    SEARCH: "6206446249181189526", // 🔎 animated
    SIREN: "6257780484281997093", // 🚨 animated
    SKULL: "5942930295966668605", // 💀 animated
    SPEECH: "6206495649895028694", // 💬 animated
    SPIRAL_CAL: "5879841310902324730", // 🗓️ animated
    STOP: "6298608963088812117", // ⏹️ animated
    TICKET: "5418010521309815154", // 🎫 animated
    TRASH: "5267123797600783095", // 🗑️ animated
    TROPHY: "5352899482822404135", // 🏆 animated
    UNLOCK: "6269065588161645115", // 🔓 animated
    WRENCH: "4904936030232117798", // 🔧 animated
    YELLOW_DOT: "5273931763146565225", // 🟡 animated
    BAR_CHART:  "6206445639295834047", // 📊 animated (alias CHART)
    CAMERA:     "5210157719796481",    // 📸 animated
    BROOM:      "5373139478272364263", // 🧹 animated

  },

  // ─── Quota Resource per User (#5) ──────────────────────────────────────
  // Maks total RAM/Disk/CPU yang boleh dimiliki tiap role.
  // Set 0 = unlimited. Cek dilakukan saat create/upgrade panel.
  ROLE_QUOTAS: {
    user:     { ram: 4096,   disk: 40960,   cpu: 200,  panels: 2 },
    reseller: { ram: 32768,  disk: 327680,  cpu: 1500, panels: 20 },
    premium:  { ram: 65536,  disk: 655360,  cpu: 3000, panels: 50 },
    owner:    { ram: 0,      disk: 0,       cpu: 0,    panels: 0 },
  },

  // ─── Auto-lock Panel Inactive (#20) ──────────────────────────────────
  AUTO_LOCK: {
    enabled: false,        // true untuk enable auto-suspend panel inactive
    days: 30,              // batas hari inactive sebelum auto-suspend
  },

  // ─── Theme Pack (#17) ────────────────────────────────────────────────
  // Premium-only. Gunakan /theme untuk pilih.
  THEME_PACKS: {
    default: { name: "Default",  prefix: "" },
    neon:    { name: "Neon",     prefix: "✨" },
    pastel:  { name: "Pastel",   prefix: "🌸" },
    cyber:   { name: "Cyberpunk",prefix: "⚡" },
    retro:   { name: "Retro",    prefix: "📺" },
  },

  // ─── Wajib Join Channel ───────────────────────────────────────────────────
  // User harus join SEMUA channel di bawah sebelum bisa pakai bot.
  // Bot HARUS jadi admin di channel agar bisa cek keanggotaan user.
  // - id   : username channel (pakai "@namaChannel") atau ID negatif (contoh: -1001234567890)
  // - label: nama tampilan di pesan bot
  // - url  : link invite / link channel (https://t.me/namaChannel)
  // Kosongkan array [] untuk menonaktifkan fitur ini.
  REQUIRED_CHANNELS: [
    { id: "-1003364709444", label: "Channel 1", url: "https://t.me/Alfa_Store_Official" },
    { id: "-1003789378942", label: "Channel 2", url: "https://t.me/informasiserveralfa" },
  ],

  // ─── Paket Resource Panel ─────────────────────────────────────────────────
  RESOURCE_PLANS: [
    { name: "1 GB",      ram: 1024,  disk: 1024,  cpu: 20 },
    { name: "2 GB",      ram: 2048,  disk: 2048,  cpu: 30 },
    { name: "3 GB",      ram: 3072,  disk: 3072,  cpu: 40 },
    { name: "4 GB",      ram: 4096,  disk: 4096,  cpu: 50 },
    { name: "5 GB",      ram: 5120,  disk: 5120,  cpu: 80 },
    { name: "6 GB",      ram: 6144,  disk: 6144,  cpu: 90 },
    { name: "7 GB",      ram: 7168,  disk: 7168,  cpu: 100 },
    { name: "8 GB",      ram: 8192,  disk: 8192,  cpu: 120 },
    { name: "9 GB",      ram: 9216,  disk: 9216,  cpu: 150 },
    { name: "10 GB",     ram: 10240, disk: 10240, cpu: 200 },
    { name: "Unlimited", ram: 0,     disk: 0,      cpu: 0   },
  ],
};
