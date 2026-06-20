const express = require("express");
const session = require("express-session");
const fetch   = require("node-fetch");
const path    = require("path");
const fs      = require("fs");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();

const CLIENT_ID      = process.env.CLIENT_ID;
const CLIENT_SECRET  = process.env.CLIENT_SECRET;
const REDIRECT_URI   = process.env.REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || "cfw-secret-change-me";
const GUILD_ID       = process.env.GUILD_ID;
const SHEET_ID       = process.env.SHEET_ID;
const PORT           = process.env.PORT || 3000;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const PANEL_URL      = process.env.PANEL_URL || "";
const BOT_TOKEN       = process.env.BOT_TOKEN;        // توكن البوت (من Discord Developer Portal > Bot)
const ACCEPT_ROLE_NAME = process.env.ACCEPT_ROLE_NAME || "Whitelist"; // اسم الرول اللي يتعطى عند القبول

app.use(express.json());

// ── CORS: يسمح لموقع Netlify يتواصل مع هذا السيرفر ──
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 1000 * 60 * 60 * 8 }
}));

/* ════════════════════════════════════════════════════════════
   بوت ديسكورد — يعطي الرول تلقائياً عند القبول
   ════════════════════════════════════════════════════════════ */
let bot = null;
let botReady = false;

if (BOT_TOKEN) {
  bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
    ],
  });

  bot.once("ready", () => {
    botReady = true;
    console.log(`🤖 البوت متصل: ${bot.user.tag}`);
  });

  bot.login(BOT_TOKEN).catch(e => console.error("❌ فشل تسجيل دخول البوت:", e.message));
} else {
  console.warn("⚠️ BOT_TOKEN غير موجود — إعطاء الرول التلقائي معطّل.");
}

// ── يحاول إيجاد العضو بالسيرفر بناءً على اسم المستخدم اللي كتبه بالنموذج ──
async function findMemberByUsername(usernameRaw) {
  if (!bot || !botReady || !GUILD_ID) return null;
  const username = String(usernameRaw || "").trim().replace(/^@/, "").toLowerCase();
  if (!username) return null;

  try {
    const guild = await bot.guilds.fetch(GUILD_ID);
    // نجيب كل الأعضاء (يحتاج Server Members Intent مفعّل من Discord Developer Portal)
    const members = await guild.members.fetch();
    const match = members.find(m =>
      m.user.username.toLowerCase() === username ||
      (m.user.globalName && m.user.globalName.toLowerCase() === username) ||
      m.user.tag.toLowerCase() === username
    );
    return match || null;
  } catch (e) {
    console.error("خطأ بالبحث عن العضو:", e.message);
    return null;
  }
}

// ── يعطي رول معيّن لعضو ──
async function giveRole(member, roleName) {
  try {
    const guild = member.guild;
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
      console.warn(`⚠️ الرول "${roleName}" غير موجود بالسيرفر`);
      return { ok: false, reason: "role_not_found" };
    }
    await member.roles.add(role);
    return { ok: true };
  } catch (e) {
    console.error("خطأ بإعطاء الرول:", e.message);
    return { ok: false, reason: e.message };
  }
}

/* ════════════════════════════════════════════════════════════
   مساعد: اجيب قائمة الأدمنز من Google Sheets
   ════════════════════════════════════════════════════════════ */
async function fetchAdminIds() {
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv`;
    const res  = await fetch(url);
    const text = await res.text();
    const rows = text.trim().split("\n").map(r =>
      r.split(",").map(c => c.trim().replace(/^"|"$/g, ""))
    );
    const headers = rows[0].map(h => h.toLowerCase().replace(/\s/g,""));
    const idCol   = headers.findIndex(h => h.includes("discord") || h.includes("id"));
    return rows.slice(1).map(r => (r[idCol]||"").trim()).filter(Boolean);
  } catch(e) {
    console.error("Sheet error:", e.message);
    return [];
  }
}

/* ════════════════════════════════════════════════════════════
   تسجيل دخول الأدمن عبر Discord OAuth2
   ════════════════════════════════════════════════════════════ */
app.get("/auth/login", (req, res) => {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         "identify guilds",
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect("/?error=no_code");

  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect("/?error=token_failed");

    const userRes  = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    const adminIds = await fetchAdminIds();
    if (!adminIds.includes(user.id)) {
      return res.redirect("/?error=not_admin");
    }

    req.session.user = {
      id:       user.id,
      username: user.username,
      avatar:   user.avatar
        ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/0.png`,
    };

    res.redirect("/panel");
  } catch(e) {
    console.error("Auth error:", e.message);
    res.redirect("/?error=auth_failed");
  }
});

app.get("/auth/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: "غير مصرح" });
}

app.get("/api/me", requireAuth, (req, res) => {
  res.json(req.session.user);
});

/* ════════════════════════════════════════════════════════════
   تخزين الطلبات (ملف JSON على القرص)
   ════════════════════════════════════════════════════════════ */
const DB_FILE = path.join(__dirname, "requests.json");

function loadRequestsFromDisk() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf-8")); }
  catch(e) { return []; }
}
function saveRequestsToDisk(arr) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(arr, null, 2)); }
  catch(e) { console.warn("Save error:", e.message); }
}

let requests = loadRequestsFromDisk();

app.get("/api/requests", requireAuth, (req, res) => {
  res.json(requests);
});

// ── استقبال طلب جديد من موقع CFW ──
app.post("/api/submit", async (req, res) => {
  const entry = {
    id:          Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    submittedAt: new Date().toISOString(),
    status:      "pending",
    note:        "",
    data:        req.body,
  };
  requests.unshift(entry);
  saveRequestsToDisk(requests);

  // إشعار الديسكورد بطلب جديد — يعرض كل الأسئلة والأجوبة
  if (WEBHOOK_URL) {
    const qaList = Array.isArray(req.body.qaList) ? req.body.qaList : [];
    const fields = qaList.length
      ? qaList.slice(0, 24).map(qa => ({
          name:  String(qa.label || "—").slice(0, 256),
          value: String(qa.value || "—").slice(0, 1024),
          inline: false,
        }))
      : [
          { name: "الاسم", value: req.body.real_name_txt || "—", inline: true },
          { name: "ديسكورد", value: req.body.discord_tag || "—", inline: true },
        ];

    fields.push({
      name: "🔗 مراجعة الطلب",
      value: PANEL_URL ? `افتح لوحة الإدارة: ${PANEL_URL}` : "افتح لوحة الإدارة",
      inline: false,
    });

    const payload = {
      username: "CFW — طلبات التفعيل",
      embeds: [{
        title:  "📋 طلب تفعيل جديد",
        color:  13212234,
        fields,
        timestamp: new Date().toISOString(),
      }],
    };
    try {
      await fetch(WEBHOOK_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
    } catch(e) { console.warn("Webhook error:", e.message); }
  }

  res.json({ ok: true, id: entry.id });
});

// ── قرار القبول أو الرفض ──
app.post("/api/decide", requireAuth, async (req, res) => {
  const { id, decision, note } = req.body;
  const entry = requests.find(r => r.id === id);
  if (!entry) return res.status(404).json({ error: "طلب غير موجود" });

  entry.status    = decision;
  entry.note      = note || "";
  entry.decidedAt = new Date().toISOString();
  entry.decidedBy = req.session.user.username;

  let roleResult = null;

  // ── لو قبول: نحاول نعطي الرول تلقائياً ──
  if (decision === "accepted" && BOT_TOKEN) {
    const usernameToFind = entry.data.discord_tag;
    const member = await findMemberByUsername(usernameToFind);
    if (member) {
      roleResult = await giveRole(member, ACCEPT_ROLE_NAME);
      entry.roleGiven = roleResult.ok;
    } else {
      entry.roleGiven = false;
      entry.roleNote  = "العضو غير موجود بالسيرفر — أعطِ الرول يدوياً";
    }
  }

  saveRequestsToDisk(requests);

  // ── إشعار الديسكورد بالقرار ──
  if (WEBHOOK_URL) {
    const isAccepted = decision === "accepted";
    const fields = [
      { name: "الاسم",     value: entry.data.real_name_txt || "—", inline: true },
      { name: "ديسكورد",   value: entry.data.discord_tag   || "—", inline: true },
      { name: "قرار من",   value: req.session.user.username,        inline: true },
      ...(note ? [{ name: "ملاحظة", value: note, inline: false }] : []),
    ];

    if (isAccepted) {
      if (roleResult?.ok) {
        fields.push({ name: "🎭 الرول", value: `✅ تم إعطاء رول "${ACCEPT_ROLE_NAME}" تلقائياً`, inline: false });
      } else if (BOT_TOKEN) {
        fields.push({ name: "🎭 الرول", value: `⚠️ تعذّر إعطاء الرول تلقائياً — تأكد إن "${entry.data.discord_tag}" منضم بالسيرفر وأعطه الرول يدوياً`, inline: false });
      }
    }

    const payload = {
      username: "CFW — الإدارة",
      embeds: [{
        title:  isAccepted ? "✅ تم قبول طلب تفعيل" : "❌ تم رفض طلب تفعيل",
        color:  isAccepted ? 4169982 : 14495300,
        fields,
        timestamp: new Date().toISOString(),
      }],
    };
    try {
      await fetch(WEBHOOK_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
    } catch(e) { console.warn("Webhook error:", e.message); }
  }

  res.json({ ok: true, roleResult });
});

app.get("/panel", (req, res) => {
  if (!req.session?.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "panel.html"));
});

app.listen(PORT, () => console.log(`✅ CFW Panel running on port ${PORT}`));
