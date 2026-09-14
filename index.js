require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const store = require('./db/database');
const filter = require('./filters/filter');
const waCollector = require('./collectors/whatsapp');
const waNotifier = require('./notifiers/whatsapp');
const mailNotifier = require('./notifiers/email');

const app = express();
const PORT = process.env.PORT || 3000;
// ב-Railway מצביע על ה-Volume (/app/data) כדי שההגדרות והמאגר ישרדו deploy
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const DEFAULTS_PATH = path.join(__dirname, 'config.json');
const INGEST_SECRET = (process.env.INGEST_SECRET || '').trim();

app.use(express.json({ limit: '15mb' })); // הודעות וואטסאפ ארוכות + אצוות גדולות מהאספן
app.use(express.static(path.join(__dirname, 'public')));

// ---------- הגדרות ----------

/** מיזוג עמוק — כך ששדה חדש בברירות המחדל מגיע גם למשתמש עם config ישן */
function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof base?.[k] === 'object' && !Array.isArray(base?.[k])
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
  if (!fs.existsSync(CONFIG_PATH)) return defaults;
  try {
    return deepMerge(defaults, JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')));
  } catch (err) {
    console.error('[config] קובץ ההגדרות פגום, נטענו ברירות המחדל:', err.message);
    return defaults;
  }
}

function saveConfig(cfg) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

const dashboardUrl = () => process.env.PUBLIC_URL || '';

// ---------- API: מאגר המשרות (הדשבורד) ----------

app.get('/api/jobs', (req, res) => {
  const { status, source, search, limit, offset } = req.query;
  res.json(store.query({
    status, source, search,
    limit: Math.min(+limit || 500, 2000),
    offset: +offset || 0,
  }));
});

app.get('/api/stats', (_req, res) => res.json(store.stats()));

app.patch('/api/jobs/:id', (req, res) => {
  const { status, notes } = req.body || {};
  try {
    let changed = 0;
    if (status !== undefined) changed += store.setStatus(req.params.id, status);
    if (notes !== undefined) changed += store.setNotes(req.params.id, notes);
    res.json({ ok: changed > 0 });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/jobs/:id', (req, res) => res.json({ ok: store.remove(req.params.id) > 0 }));

app.get('/api/settings', (_req, res) => res.json(loadConfig()));

app.post('/api/settings', (req, res) => {
  try {
    saveConfig(deepMerge(loadConfig(), req.body || {}));
    scheduleDigest(); // שעת הדיג'סט אולי השתנתה
    res.json({ ok: true, config: loadConfig() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- קליטה מהאספן המקומי ----------

/**
 * האספן רץ על המחשב של אופק (IP ישראלי) ושולח לכאן.
 * זו הארכיטקטורה מפרויקט הנדל"ן: אתרים ישראליים חוסמים את ה-IP האמריקאי של Railway,
 * ולכן הסריקה לא יכולה לרוץ בשרת.
 */
app.post('/api/ingest', (req, res) => {
  if (INGEST_SECRET && req.get('x-ingest-secret') !== INGEST_SECRET) {
    return res.status(401).json({ ok: false, error: 'סוד לא תקין' });
  }
  const incoming = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
  if (!incoming.length) return res.json({ ok: true, received: 0, saved: 0 });

  const cfg = loadConfig();
  const { passed, rejected } = filter.apply(incoming, cfg.criteria);
  const fresh = passed.filter(j => !store.exists(j.id));
  store.saveMany(passed);

  console.log(`[ingest] התקבלו ${incoming.length} · עברו סינון ${passed.length} · חדשות ${fresh.length}`);
  res.json({
    ok: true,
    received: incoming.length,
    passed: passed.length,
    rejected: rejected.length,
    new: fresh.length,
  });
});

// ---------- קליטת וואטסאפ (webhook של Green API) ----------

/**
 * רישום כל קבוצה שנראתה, גם כזו שלא מוגדרת.
 * זה הפתרון לקבוצה שלא מופיעה ב-getContacts/getChats — פשוט ממתינים שתיכנס
 * בה הודעה, והיא מזהה את עצמה. נשמר על ה-Volume ונקרא מ-/api/whatsapp-seen.
 */
const SEEN_PATH = path.join(DATA_DIR, 'seen-groups.json');

function rememberGroup(chatId, chatName) {
  if (!chatId?.endsWith('@g.us')) return;
  let seen = {};
  try { seen = JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8')); } catch { /* קובץ חדש */ }
  const known = seen[chatId];
  if (known && known.name === chatName) return;
  seen[chatId] = { name: chatName || '(ללא שם)', lastSeen: new Date().toISOString() };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 1), 'utf8');
  if (!known) console.log(`[whatsapp] קבוצה חדשה זוהתה: "${chatName}" → ${chatId}`);
}

app.get('/api/whatsapp-seen', (_req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(SEEN_PATH, 'utf8'))); }
  catch { res.json({}); }
});

app.post('/api/whatsapp-webhook', (req, res) => {
  // עונים 200 מיד — Green API שולח שוב כל webhook שלא נענה
  res.json({ ok: true });
  try {
    const sd = req.body?.senderData;
    if (req.body?.typeWebhook === 'incomingMessageReceived' && sd?.chatId) {
      rememberGroup(sd.chatId, sd.chatName);
    }

    const cfg = loadConfig();
    const groups = cfg.sources?.whatsapp?.groups || [];
    if (!cfg.sources?.whatsapp?.enabled || !groups.length) return;

    const groupMap = Object.fromEntries(groups.map(g => [g.chatId, g.name]));
    const job = waCollector.fromWebhook(req.body, groupMap);
    if (!job) return;

    const r = filter.evaluate(job, cfg.criteria);
    if (!r.pass) {
      console.log(`[whatsapp] נפסלה: ${job.title.slice(0, 50)} — ${r.reasons.join('; ')}`);
      return;
    }
    store.save({ ...job, score: r.score, matched: r.matched });
    console.log(`[whatsapp] נשמרה (${r.score}): ${job.title.slice(0, 60)}`);
  } catch (err) {
    console.error('[whatsapp-webhook] שגיאה:', err.message);
  }
});

/** עוזר חד-פעמי: מציג את כל הקבוצות שהחשבון חבר בהן, כדי להעתיק chatId להגדרות */
app.get('/api/whatsapp-groups', async (_req, res) => {
  const axios = require('axios');
  const id = (process.env.GREEN_API_INSTANCE_ID || '').trim();
  const token = (process.env.GREEN_API_TOKEN || '').trim();
  const host = (process.env.GREEN_API_URL || 'https://7107.api.greenapi.com').trim();
  if (!id || !token) return res.status(400).json({ ok: false, error: 'חסרים פרטי Green API' });
  try {
    const { data } = await axios.get(`${host}/waInstance${id}/getContacts/${token}`, { timeout: 20000 });
    const groups = (data || []).filter(c => String(c.id).endsWith('@g.us'))
      .map(c => ({ chatId: c.id, name: c.name || c.contactName || '(ללא שם)' }));
    res.json({ ok: true, count: groups.length, groups });
  } catch (err) {
    res.status(500).json({ ok: false, status: err.response?.status, error: err.message });
  }
});

// ---------- התראות ----------

/** אבחון בלי לשלוח דבר — 403=host/IP · 401=טוקן · 404=מזהה אינסטנס */
app.get('/api/notif-check', async (_req, res) => {
  const cfg = loadConfig();
  res.json({
    whatsapp: await waNotifier.checkState(),
    brevoKey: !!(process.env.BREVO_API_KEY || '').trim(),
    recipients: cfg.notifications?.recipients || [],
    pending: store.getUnnotified().length,
    digestTime: cfg.notifications?.dailyDigestTime,
  });
});

/** בונה ושולח את הדיג'סט. מסמן "נשלח" רק אם ערוץ אחד באמת הצליח. */
async function sendDailyDigest({ dryRun = false } = {}) {
  const cfg = loadConfig();
  const minScore = cfg.notifications?.minScoreForDigest ?? 0;
  const max = cfg.notifications?.maxJobsInDigest ?? 10;

  const candidates = store.getUnnotified().filter(j => (j.score || 0) >= minScore);
  if (!candidates.length) {
    console.log('[digest] אין משרות חדשות מעל הסף — לא נשלחת הודעה');
    return { sent: false, count: 0 };
  }
  const jobs = candidates.slice(0, max);
  if (dryRun) return { sent: false, dryRun: true, count: jobs.length, jobs };

  const [waOk, mailOk] = await Promise.all([
    waNotifier.sendDigest(jobs, cfg, dashboardUrl()),
    mailNotifier.sendDigest(jobs, cfg, dashboardUrl()),
  ]);

  // הלקח מהנדל"ן: לסמן "נשלח" רק על הצלחה אמיתית, אחרת משרות נעלמות בשקט
  if (waOk || mailOk) store.markNotified(candidates.map(j => j.id));
  else console.error('[digest] כל הערוצים נכשלו — המשרות נשארות ממתינות');

  return { sent: waOk || mailOk, whatsapp: waOk, email: mailOk, count: jobs.length };
}

app.post('/api/send-digest', async (req, res) => {
  try {
    res.json(await sendDailyDigest({ dryRun: req.query.dryrun === '1' }));
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- תזמון ----------

let digestTask = null;

/** מתזמן מחדש לפי ההגדרות. שעון ישראל מפורש — Railway רץ ב-UTC. */
function scheduleDigest() {
  const cfg = loadConfig();
  const time = cfg.notifications?.dailyDigestTime || '09:00';
  const [h, m] = time.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) {
    console.error(`[cron] שעה לא תקינה: ${time}`);
    return;
  }
  if (digestTask) digestTask.stop();
  digestTask = cron.schedule(`${m} ${h} * * *`, () => {
    console.log('[cron] מריץ דיג\'סט יומי');
    sendDailyDigest().catch(err => console.error('[cron] הדיג\'סט נכשל:', err.message));
  }, { timezone: 'Asia/Jerusalem' });
  console.log(`[cron] דיג'סט יומי מתוזמן ל-${time} (שעון ישראל)`);
}

app.listen(PORT, () => {
  console.log(`סוכן HR רץ על פורט ${PORT}`);
  scheduleDigest();
});

module.exports = { app, sendDailyDigest, loadConfig, saveConfig };
