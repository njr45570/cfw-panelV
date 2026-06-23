const express = require("express");
const session = require("express-session");
const fetch   = require("node-fetch");
const path    = require("path");
const fs      = require("fs");
const { Client, GatewayIntentBits } = require("discord.js");
const { GoogleSpreadsheet } = require("google-spreadsheet");
const { JWT } = require("google-auth-library");

const app = express();

const CLIENT_ID      = process.env.CLIENT_ID;
const CLIENT_SECRET  = process.env.CLIENT_SECRET;
const REDIRECT_URI   = process.env.REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || "cfw-secret-change-me";
const GUILD_ID       = process.env.GUILD_ID;
const PORT           = process.env.PORT || 3000;
const WEBHOOK_URL    = process.env.WEBHOOK_URL;
const PANEL_URL      = process.env.PANEL_URL || "";
const BOT_TOKEN       = process.env.BOT_TOKEN;        // توكن البوت (من Discord Developer Portal > Bot)
const ACCEPT_ROLE_NAME = process.env.ACCEPT_ROLE_NAME || "Whitelist"; // اسم الرول اللي يتعطى عند القبول
const SITE_URL          = process.env.SITE_URL || "";    // رابط موقع Netlify الرئيسي (يُستخدم بـCORS وبروابط تسجيل الدخول)

// قائمة الأدمنز: حِط الـ Discord ID لكل أدمن مفصول بفاصلة بمتغير بيئة ADMIN_IDS
// مثال بـ Railway > Variables:  ADMIN_IDS = 123456789012345678,987654321098765432
const ADMIN_IDS = String(process.env.ADMIN_IDS || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

if (!ADMIN_IDS.length) {
  console.warn("⚠️ ADMIN_IDS غير موجود — هذا عادي لو معتمد على Google Sheets فقط.");
}

// ── إعدادات Google Service Account (قراءة فقط من شيت الأدمنز) ──
const GOOGLE_SERVICE_EMAIL = process.env.GOOGLE_SERVICE_EMAIL || "";
const GOOGLE_PRIVATE_KEY   = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const ADMIN_SHEET_ID       = process.env.ADMIN_SHEET_ID || ""; // معرف الشيت (من رابط الشيت، الجزء بين /d/ و /edit)

/**
 * يجلب قائمة الـ Discord IDs من شيت جوجل عبر Service Account (Viewer فقط).
 * يبحث عن أي عمود اسمه يحتوي كلمة "discord" أو "id" (بأي صيغة: مسافات، شرطات سفلية، حروف كبيرة/صغيرة).
 * عند أي خطأ (اتصال، صلاحيات، إلخ) يرجّع قائمة فاضية بدل ما يكسر السيرفر.
 */
async function fetchAdminIdsFromSheet() {
  if (!GOOGLE_SERVICE_EMAIL || !GOOGLE_PRIVATE_KEY || !ADMIN_SHEET_ID) {
    return []; // إعدادات الشيت غير مكتملة — يعتمد فقط على ADMIN_IDS الثابتة
  }
  try {
    const auth = new JWT({
      email: GOOGLE_SERVICE_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const doc = new GoogleSpreadsheet(ADMIN_SHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0]; // أول ورقة بالملف
    const rows = await sheet.getRows();

    // تطبيع اسم العمود: نشيل المسافات والشرطات السفلية ونحول لحروف صغيرة
    // عشان "id discord" و "Discord_ID" و "ID Discord" كلها تتطابق
    const normalize = (s) => s.toLowerCase().replace(/[\s_]+/g, "");
    const idHeader = sheet.headerValues.find((h) => {
      const n = normalize(h);
      return n.includes("discord") || n.includes("id");
    });
    if (!idHeader) {
      console.warn("⚠️ ما لقيت عمود يحتوي 'discord' أو 'id' بصف العناوين بالشيت.");
      return [];
    }

    return rows
      .map(row => String(row.get(idHeader) || "").trim())
      .filter(Boolean);
  } catch (err) {
    console.error("❌ خطأ بقراءة شيت الأدمنز:", err.message);
    return [];
  }
}

app.use(express.json());

// ── حماية بسيطة من الإغراق (Rate Limiting) — بدون مكتبات خارجية ──
// يحدد عدد الطلبات المسموحة لكل IP خلال فترة زمنية معينة
function createRateLimiter({ windowMs, max }) {
  const hits = new Map(); // ip -> [timestamps]
  return function (req, res, next) {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const timestamps = (hits.get(ip) || []).filter(t => now - t < windowMs);
    if (timestamps.length >= max) {
      return res.status(429).json({ error: "طلبات كثيرة، حاول بعد قليل." });
    }
    timestamps.push(now);
    hits.set(ip, timestamps);
    next();
  };
}

// تنظيف دوري للذاكرة عشان ما تكبر بلا حدود مع مرور الوقت
const submitLimiter = createRateLimiter({ windowMs: 10 * 60 * 1000, max: 5 }); // 5 طلبات كل 10 دقايق لكل IP

// ── CORS: يسمح بس لموقعك (Netlify) يتواصل مع هذا السيرفر، ويسمح بإرسال الكوكي (الجلسة) ──
app.use((req, res, next) => {
  if (SITE_URL) {
    res.header("Access-Control-Allow-Origin", SITE_URL);
    res.header("Access-Control-Allow-Credentials", "true");
  }
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Vary", "Origin");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname, "public")));
app.set("trust proxy", 1); // لازم لـ Railway عشان الكوكي secure يشتغل صحيح خلف الـproxy
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: true,      // الكوكي يُرسل فقط عبر HTTPS
    httpOnly: true,     // يمنع الجافاسكربت بالمتصفح من قراءة الكوكي (حماية من XSS)
    sameSite: "none",   // لازم "none" (مع secure:true) عشان الكوكي يرسل من موقعك (Netlify) لسيرفر مختلف (Railway)
    maxAge: 1000 * 60 * 60 * 8
  }
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

    const sheetAdminIds = await fetchAdminIdsFromSheet();
    const adminIds = [...new Set([...ADMIN_IDS, ...sheetAdminIds])];
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

/* ════════════════════════════════════════════════════════════
   تسجيل دخول عادي لأي زائر بالموقع (مو أدمن) — يعرض اسمه وصورته بس
   ════════════════════════════════════════════════════════════ */
const SITE_REDIRECT_URI = process.env.SITE_REDIRECT_URI; // مثال: https://xxx.railway.app/auth/site-callback

app.get("/auth/site-login", (req, res) => {
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
    redirect_uri:  SITE_REDIRECT_URI,
    response_type: "code",
    scope:         "identify",
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get("/auth/site-callback", async (req, res) => {
  const { code } = req.query;
  if (!code || !SITE_URL) return res.redirect(SITE_URL || "/");

  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  SITE_REDIRECT_URI,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.redirect(SITE_URL + "?login_error=1");

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const user = await userRes.json();
    if (!user?.id) return res.redirect(SITE_URL + "?login_error=1");

    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/0.png`;

    // التحقق من صلاحية الأدمن يصير هنا، بالسيرفر، لحظة تسجيل الدخول — وليس بالمتصفح أبدًا
    const sheetAdminIds = await fetchAdminIdsFromSheet();
    const adminIds = [...new Set([...ADMIN_IDS, ...sheetAdminIds])];
    const isAdmin = adminIds.includes(user.id);

    // كل بيانات المستخدم تُخزن بالـsession (بالسيرفر) — لا تُمرر أبدًا عبر رابط أو localStorage
    req.session.siteUser = {
      id:       user.id,
      username: user.username,
      avatar,
      isAdmin,
    };

    // الرابط النهائي لا يحمل أي بيانات شخصية، فقط علم بسيط للواجهة
    res.redirect(`${SITE_URL}?login=1&t=${Date.now()}`);
  } catch(e) {
    console.error("Site auth error:", e.message);
    res.redirect(SITE_URL + "?login_error=1");
  }
});

app.get("/auth/site-logout", (req, res) => {
  if (req.session) delete req.session.siteUser;
  res.redirect(SITE_URL || "/");
});

function requireAuth(req, res, next) {
  if (req.session?.user) return next();
  res.status(401).json({ error: "غير مصرح" });
}

app.get("/api/me", requireAuth, (req, res) => {
  res.json(req.session.user);
});

// نقطة جديدة: يستخدمها index.html لمعرفة بيانات الزائر المسجل دخوله بالموقع العادي (بما فيها isAdmin)
app.get("/api/site-me", (req, res) => {
  if (!req.session?.siteUser) {
    return res.json({ loggedIn: false });
  }
  res.json({ loggedIn: true, ...req.session.siteUser });
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
app.post("/api/submit", submitLimiter, async (req, res) => {
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

// ── جلب بيانات العضو من البوت (للملف الشخصي) ──
app.get("/api/member-info", async (req, res) => {
  if (!req.session?.siteUser) return res.json({ loggedIn: false });

  const userId = req.session.siteUser.id;

  if (!bot || !botReady || !GUILD_ID) {
    return res.json({ loggedIn: true, roles: [], whitelistStatus: "unknown", requests: [] });
  }

  try {
    const guild = await bot.guilds.fetch(GUILD_ID);
    const member = await guild.members.fetch(userId).catch(() => null);

    const roles = member
      ? member.roles.cache
          .filter(r => r.name !== "@everyone")
          .map(r => r.name)
      : [];

    // جلب طلبات العضو من الملف المحلي
    const memberRequests = requests
      .filter(r => r.data?.discord_tag && member?.user &&
        (r.data.discord_tag.toLowerCase() === member.user.username.toLowerCase() ||
         r.data.discord_tag.toLowerCase() === member.user.tag?.toLowerCase()))
      .map(r => ({
        id: r.id,
        status: r.status,
        submittedAt: r.submittedAt,
      }));

    // حالة الوايت لست
    const hasWhitelist = roles.some(r => r.toLowerCase() === ACCEPT_ROLE_NAME.toLowerCase());
    const hasPending = memberRequests.some(r => r.status === "pending");
    const whitelistStatus = hasWhitelist ? "accepted" : hasPending ? "pending" : "none";

    res.json({
      loggedIn: true,
      roles,
      whitelistStatus,
      requests: memberRequests,
    });
  } catch (e) {
    console.error("member-info error:", e.message);
    res.json({ loggedIn: true, roles: [], whitelistStatus: "unknown", requests: [] });
  }
});

app.get("/panel", (req, res) => {
  if (!req.session?.user) return res.redirect("/");
  res.sendFile(path.join(__dirname, "public", "panel.html"));
});

app.listen(PORT, () => console.log(`✅ CFW Panel running on port ${PORT}`));
