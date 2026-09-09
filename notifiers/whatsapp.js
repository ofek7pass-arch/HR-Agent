/**
 * שליחת התראות בוואטסאפ דרך Green API.
 *
 * הועתק מפרויקט הנדל"ן אחרי שעבד שם בפרודקשן — כולל שני התיקונים שעלו ביוקר:
 *  1. host חייב להיות `{prefix}.api.greenapi.com` (בלי מקף). הדומיין הישן
 *     api.green-api.com מחזיר 403 ל-IP של Railway.
 *  2. toChatId חייב להסיר 0 מוביל אחרי 972. מספר שמור כ-+9720507226589 ייצר
 *     chatId לא תקין, ו-Green API "ישלח" בשקט בלי שההודעה תגיע.
 * אבחון קודים: 403=host/IP · 401=טוקן · 404=מזהה אינסטנס.
 */
const axios = require('axios');

const INSTANCE_ID = (process.env.GREEN_API_INSTANCE_ID || '').trim();
const API_TOKEN = (process.env.GREEN_API_TOKEN || '').trim();
const API_HOST = (process.env.GREEN_API_URL || 'https://7107.api.greenapi.com').trim();
const BASE_URL = `${API_HOST}/waInstance${INSTANCE_ID}`;

/** ממיר כל צורת מספר ישראלי ל-chatId תקין: 05X / +9725X / 97205X */
function toChatId(phone) {
  let digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('972')) digits = digits.slice(3);
  digits = digits.replace(/^0+/, '');
  return `972${digits}@c.us`;
}

function enabledRecipients(config) {
  const list = config?.notifications?.recipients || [];
  return list.filter(r => r.enabled !== false && r.phone);
}

async function sendMessage(phone, text) {
  if (!INSTANCE_ID || !API_TOKEN) {
    console.warn('[whatsapp] GREEN_API_INSTANCE_ID או GREEN_API_TOKEN חסרים');
    return false;
  }
  try {
    await axios.post(`${BASE_URL}/sendMessage/${API_TOKEN}`, {
      chatId: toChatId(phone),
      message: text,
    }, { timeout: 20000 });
    console.log(`[whatsapp] נשלח ל-${phone}`);
    return true;
  } catch (err) {
    console.error(`[whatsapp] שגיאה בשליחה ל-${phone}: ${err.response?.status || err.message}`);
    return false;
  }
}

const SOURCE_LABEL = {
  alljobs: 'אול ג׳ובס',
  linkedin: 'לינקדין',
  whatsapp: 'וואטסאפ',
  facebook: 'פייסבוק',
};

/** בונה את גוף ההודעה. טקסט נקי בלי אמוג׳י מיותר — לקח מהסוכן האישי. */
function buildDigestText(jobs, dashboardUrl) {
  const lines = jobs.map((j, i) => {
    const bits = [
      `${i + 1}. ${j.title}`,
      j.company ? `   חברה: ${j.company}` : null,
      j.location ? `   מיקום: ${j.location}` : null,
      `   מקור: ${SOURCE_LABEL[j.source] || j.source}${j.score ? ` | התאמה: ${j.score}` : ''}`,
      j.url ? `   ${j.url}` : null,
    ].filter(Boolean);
    return bits.join('\n');
  });

  let text = `סוכן משרות — סיכום יומי\nנמצאו ${jobs.length} משרות מתאימות:\n\n${lines.join('\n\n')}`;
  if (dashboardUrl) text += `\n\nכל המשרות בדשבורד:\n${dashboardUrl}`;
  return text;
}

/** מחזיר true אם לפחות נמען אחד קיבל — רק אז מסמנים "נשלח" */
async function sendDigest(jobs, config, dashboardUrl) {
  if (!jobs || !jobs.length) return false;
  const recipients = enabledRecipients(config);
  if (!recipients.length) {
    console.warn('[whatsapp] אין נמענים מסומנים');
    return false;
  }
  const text = buildDigestText(jobs, dashboardUrl);
  const results = await Promise.all(recipients.map(r => sendMessage(r.phone, text)));
  return results.some(Boolean);
}

/** בדיקת מצב האינסטנס — לאבחון בלי לשלוח הודעה */
async function checkState() {
  if (!INSTANCE_ID || !API_TOKEN) return { ok: false, error: 'חסרים פרטי התחברות' };
  try {
    const { data } = await axios.get(`${BASE_URL}/getStateInstance/${API_TOKEN}`, { timeout: 15000 });
    return { ok: true, state: data.stateInstance, host: API_HOST, instanceLen: INSTANCE_ID.length };
  } catch (err) {
    return { ok: false, status: err.response?.status, error: err.message };
  }
}

module.exports = { sendDigest, sendMessage, checkState, toChatId, buildDigestText, SOURCE_LABEL };
