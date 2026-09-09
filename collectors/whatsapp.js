/**
 * אספן וואטסאפ — קולט הודעות מקבוצות דרך webhook של Green API.
 *
 * בשונה משאר המקורות, כאן אין מבנה: כל הודעה היא טקסט חופשי שאדם כתב.
 * לכן החילוץ הוא היוריסטי ומכוון להיות *סלחני* — עדיף לשמור מודעה עם כותרת
 * לא מושלמת מאשר לפספס משרה. הטקסט המלא נשמר תמיד ומוצג בדשבורד.
 *
 * שדרוג עתידי: החלפת החילוץ ההיוריסטי בקריאה ל-Claude API, שמפרק טקסט חופשי
 * בעברית לשדות מובנים הרבה יותר טוב מכל regex. ראה docs/DECISIONS.md.
 */
const crypto = require('crypto');

// אינדיקציות לכך שההודעה היא מודעת דרושים ולא פטפוט בקבוצה
const JOB_SIGNALS = [
  'דרוש', 'דרושה', 'דרושים', 'מחפשים', 'מחפש', 'מגייס', 'מגייסים', 'גיוס',
  'משרה', 'משרות', 'תפקיד', 'הזדמנות', 'קורות חיים', 'קו"ח', 'קוח',
  'למשרה', 'לתפקיד', 'hiring', 'we are looking', 'job', 'position', 'opening',
];

// הודעות שהן בבירור לא מודעה
const NOISE_SIGNALS = [
  'מחפש עבודה', 'מחפשת עבודה', 'אשמח לעזרה', 'שלח לי בפרטי', 'תודה רבה',
  'בוקר טוב', 'שבת שלום', 'חג שמח',
];

const CITIES = [
  'תל אביב', 'רמת גן', 'גבעתיים', 'הרצליה', 'רעננה', 'כפר סבא', 'פתח תקווה',
  'ראשון לציון', 'חולון', 'בת ים', 'בני ברק', 'נתניה', 'ראש העין', 'הוד השרון',
  'ירושלים', 'חיפה', 'באר שבע', 'אשדוד', 'אשקלון', 'רחובות', 'נס ציונה',
  'לוד', 'רמלה', 'מודיעין', 'יקנעם', 'כרמיאל', 'עפולה', 'קיסריה', 'יבנה',
  'עבודה מהבית', 'היברידי', 'מרחוק', 'remote', 'hybrid',
];

/** מזהה יציב לפי תוכן ההודעה — אותה מודעה שנשלחת שוב לא תיווצר פעמיים */
function messageId(text, groupId) {
  const normalized = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const hash = crypto.createHash('sha1').update(`${groupId || ''}|${normalized}`).digest('hex');
  return `whatsapp:${hash.slice(0, 16)}`;
}

function looksLikeJobPost(text) {
  const t = (text || '').toLowerCase();
  if (t.length < 25) return false; // קצר מדי מכדי להיות מודעה
  const signals = JOB_SIGNALS.filter(s => t.includes(s.toLowerCase())).length;
  if (!signals) return false;
  // "מחפש עבודה" הוא ההפך ממודעה — מישהו מציע את עצמו
  const noise = NOISE_SIGNALS.filter(s => t.includes(s.toLowerCase())).length;
  return signals > noise;
}

/** הכותרת = השורה הראשונה שנראית משמעותית, מקוצרת לאורך סביר */
function extractTitle(text) {
  const lines = (text || '').split('\n').map(l => l.trim()).filter(Boolean);
  // מדלגים על שורות פתיחה שהן רק אמוג׳י/קישוט או ברכה קצרה
  const candidate = lines.find(l => {
    const clean = l.replace(/[^\p{L}\p{N}]/gu, '');
    return clean.length >= 8;
  }) || lines[0] || 'מודעה מוואטסאפ';
  return candidate.replace(/\s+/g, ' ').slice(0, 140);
}

function extractContacts(text) {
  const t = text || '';
  const phones = [...new Set((t.match(/0\d{1,2}[-\s]?\d{7}|\+972[-\s]?\d{1,2}[-\s]?\d{7}/g) || [])
    .map(p => p.replace(/[-\s]/g, '')))];
  const emails = [...new Set(t.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || [])];
  const links = [...new Set(t.match(/https?:\/\/\S+/g) || [])];
  return { phones, emails, links };
}

function extractLocation(text) {
  const t = (text || '').toLowerCase();
  const hits = CITIES.filter(c => t.includes(c.toLowerCase()));
  return hits.length ? [...new Set(hits)].join(', ') : null;
}

/**
 * ממיר webhook של Green API למשרה, או מחזיר null אם זו לא מודעת דרושים.
 * @param {object} body - גוף ה-webhook כפי ש-Green API שולח
 * @param {object} groupsConfig - { [chatId]: 'שם הקבוצה' } — רק קבוצות אלה נקלטות
 */
function fromWebhook(body, groupsConfig = {}) {
  if (body?.typeWebhook !== 'incomingMessageReceived') return null;

  const chatId = body?.senderData?.chatId || '';
  if (!chatId.endsWith('@g.us')) return null;          // רק קבוצות, לא צ'אטים פרטיים
  if (!Object.prototype.hasOwnProperty.call(groupsConfig, chatId)) return null; // רק קבוצות מוגדרות

  const md = body?.messageData || {};
  const text = md.textMessageData?.textMessage
            || md.extendedTextMessageData?.text
            || '';
  if (!looksLikeJobPost(text)) return null;

  const contacts = extractContacts(text);
  const ts = body?.timestamp ? new Date(body.timestamp * 1000) : new Date();

  return {
    id: messageId(text, chatId),
    source: 'whatsapp',
    source_detail: groupsConfig[chatId] || chatId,
    title: extractTitle(text),
    company: null,
    location: extractLocation(text),
    job_type: null,
    description: text.slice(0, 4000),
    url: contacts.links[0] || null,
    posted_text: ts.toISOString(),
    age_hours: 0,
    query: null,
    raw: {
      chatId,
      sender: body?.senderData?.sender,
      senderName: body?.senderData?.senderName,
      contacts,
    },
  };
}

module.exports = {
  fromWebhook, looksLikeJobPost, extractTitle, extractContacts,
  extractLocation, messageId, CITIES,
};
