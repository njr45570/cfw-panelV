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

// ضع هنا دومين موقعك على Netlify (بدون / في النهاية)
const ALLOWED_ORIGIN = process.env.SITE_ORIGIN || "https://fabulous-pony-9a0584.netlify.app";

app.use(express.json());

// ── CORS: نسمح لموقع Netlify يستعلم من هذا السيرفر مع إرسال الكوكي ──
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,        // لازم true عشان الكوكي يشتغل بين دومينين مختلفين (HTTPS)
    sameSite: "none",    // يسمح بمشاركة الكوكي بين Netlify و Railway
    maxAge: 1000 * 60 * 60 * 8
  }
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

// ── API جديد: هل الزائر أدمن؟ (بدون خطأ 401، فقط true/false) ──
app.get("/api/is-admin", (req, res) => {
  res.json({ isAdmin: !!req.session?.user });
});

// ── API: جيب الطلبات ──
let requests = [];
app.get("/api/requests", requireAuth, (req, res) => {
  res.json(requests);
});

// ── API: استقبال طلب جديد من الموقع الرئيسي ──
app.post("/api/submit", (req, res) => {
  const entry = {
    id:          Date.now().toString(36) + Math.random().toString(36).slice(2,6),
    submittedAt: new Date().toISOString(),
    status:      "pending",
    note:        "",
    data:        req.body,
  };
  requests.unshift(entry);
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
