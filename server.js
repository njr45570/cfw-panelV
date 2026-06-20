const express = require("express");
const session = require("express-session");
const fetch   = require("node-fetch");
const path    = require("path");

const app = express();

const CLIENT_ID     = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI;
const SESSION_SECRET= process.env.SESSION_SECRET || "cfw-secret-change-me";
const GUILD_ID      = process.env.GUILD_ID;
const SHEET_ID      = process.env.SHEET_ID;
const PORT          = process.env.PORT || 3000;

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

// ── مساعد: اجيب قائمة الأدمنز من Google Sheets ──
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

// ── 1. ابدأ OAuth2 ──
app.get("/auth/login", (req, res) => {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  REDIRECT_URI,
    response_type: "code",
    scope:         "identify guilds",
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// ── 2. Callback من Discord ──
app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect("/?error=no_code");

  try {
    // استبدل الكود بتوكن
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

    // اجيب بيانات المستخدم
    const userRes  = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();

    // تحقق إنه أدمن
    const adminIds = await fetchAdminIds();
    if (!adminIds.includes(user.id)) {
      return res.redirect("/?error=not_admin");
    }

    // حفظ الجلسة
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

// ── 3. تسجيل الخروج ──
app.get("/auth/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/");
});

// ── Middleware: تحقق من الجلسة ──
function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: "غير مصرح" });
}

// ── API: بيانات المستخدم الحالي ──
app.get("/api/me", requireAuth, (req, res) => {
  res.json(req.session.user);
});

// ── API: استقبال طلب جديد من الموقع الرئيسي ──
const fs = require("fs");
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

  // إشعار الديسكورد بطلب جديد
  const webhook = process.env.WEBHOOK_URL;
  if (webhook) {
    const d = entry.data;
    const payload = {
      username: "CFW — طلبات التفعيل",
      embeds: [{
        title:  "📋 طلب تفعيل جديد",
        color:  13212234,
        fields: [
          { name: "الاسم",     value: d.real_name_txt || "—", inline: true },
          { name: "ديسكورد",   value: d.discord_tag   || "—", inline: true },
          { name: "اسم الشخصية", value: d.ign           || "—", inline: true },
          { name: "🔗 مراجعة الطلب", value: process.env.PANEL_URL || "افتح لوحة الإدارة", inline: false },
        ],
        timestamp: new Date().toISOString(),
      }],
    };
    try {
      await fetch(webhook, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
    } catch(e) { console.warn("Webhook error:", e.message); }
  }

  res.json({ ok: true, id: entry.id });
});

// ── API: قرار القبول أو الرفض ──
app.post("/api/decide", requireAuth, async (req, res) => {
  const { id, decision, note } = req.body;
  const entry = requests.find(r => r.id === id);
  if (!entry) return res.status(404).json({ error: "طلب غير موجود" });

  entry.status    = decision;
  entry.note      = note || "";
  entry.decidedAt = new Date().toISOString();
  entry.decidedBy = req.session.user.username;
  saveRequestsToDisk(requests);

  // أرسل ويبهوك للديسكورد
  const webhook = process.env.WEBHOOK_URL;
  if (webhook) {
    const isAccepted = decision === "accepted";
    const payload = {
      username: "CFW — الإدارة",
      embeds: [{
        title:  isAccepted ? "✅ تم قبول طلب تفعيل" : "❌ تم رفض طلب تفعيل",
        color:  isAccepted ? 4169982 : 14495300,
        fields: [
          { name: "الاسم",     value: entry.data.real_name_txt || "—", inline: true },
          { name: "ديسكورد",   value: entry.data.discord_tag   || "—", inline: true },
          { name: "قرار من",   value: req.session.user.username,        inline: true },
          ...(note ? [{ name: "ملاحظة", value: note, inline: false }] : []),
        ],
        timestamp: new Date().toISOString(),
      }],
    };
    try {
      await fetch(webhook, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      });
    } catch(e) { console.warn("Webhook error:", e.message); }
  }

  res.json({ ok: true });
});

// ── صفحة اللوحة ──
app.get("/panel", (req, res) => {
  if (!req.session?.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "panel.html"));
});

app.listen(PORT, () => console.log(`✅ CFW Panel running on port ${PORT}`));
