/**
 * מאזין וואטסאפ מקומי.
 *
 * Green API מציע שתי דרכים לקבל הודעות נכנסות:
 *  1. webhook — הוא דוחף לכתובת ציבורית. זו הדרך בפרודקשן (Railway).
 *  2. תור — הוא שומר את ההודעות ואנחנו מושכים. זו הדרך כאן, כי אין עדיין
 *     כתובת ציבורית, והיא מאפשרת לבדוק את כל המסלול עוד לפני הפריסה.
 *
 * הסקריפט מושך מהתור ושולח כל הודעה ל-/api/whatsapp-webhook המקומי —
 * בדיוק אותו קוד שירוץ בפרודקשן. מה שעובד כאן יעבוד שם.
 *
 * חובה למחוק כל התראה אחרי הטיפול בה, אחרת היא תחזור שוב ושוב והתור ייחנק.
 *
 * תוצר לוואי חשוב: כל קבוצה שנראית נרשמת ל-discovered-groups.json עם המזהה
 * שלה. ככה מוצאים קבוצה שלא מופיעה ב-getContacts/getChats — פשוט ממתינים
 * שתיכנס בה הודעה.
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ID = (process.env.GREEN_API_INSTANCE_ID || '').trim();
const TOK = (process.env.GREEN_API_TOKEN || '').trim();
const HOST = (process.env.GREEN_API_URL || 'https://7107.api.greenapi.com').trim();
const SERVER = (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const BASE = `${HOST}/waInstance${ID}`;

const DISCOVERY_PATH = path.join(__dirname, 'discovered-groups.json');

function loadDiscovered() {
  try { return JSON.parse(fs.readFileSync(DISCOVERY_PATH, 'utf8')); } catch { return {}; }
}

let discovered = loadDiscovered();

/** רושם קבוצה שנראתה. מחזיר true אם זו קבוצה חדשה שלא הכרנו. */
function remember(chatId, chatName) {
  if (!chatId.endsWith('@g.us')) return false;
  const known = discovered[chatId];
  if (known && known.name === chatName) return false;
  discovered[chatId] = { name: chatName || '(ללא שם)', lastSeen: new Date().toISOString() };
  fs.writeFileSync(DISCOVERY_PATH, JSON.stringify(discovered, null, 1), 'utf8');
  return !known;
}

async function receive() {
  const { data } = await axios.get(`${BASE}/receiveNotification/${TOK}`, { timeout: 40000 });
  return data; // null כשהתור ריק (השרת מחזיק את הבקשה עד 20 שניות)
}

async function remove(receiptId) {
  try { await axios.delete(`${BASE}/deleteNotification/${TOK}/${receiptId}`, { timeout: 15000 }); }
  catch (err) { console.error(`[poll] מחיקת התראה ${receiptId} נכשלה: ${err.message}`); }
}

async function forward(body) {
  try {
    await axios.post(`${SERVER}/api/whatsapp-webhook`, body, { timeout: 15000 });
  } catch (err) {
    console.error(`[poll] העברה לשרת נכשלה: ${err.response?.status || err.message}`);
  }
}

async function main() {
  if (!ID || !TOK) { console.error('חסרים GREEN_API_INSTANCE_ID / GREEN_API_TOKEN'); process.exit(1); }
  const runSeconds = Number(process.argv[2]) || 0; // 0 = לרוץ עד עצירה ידנית
  const until = runSeconds ? Date.now() + runSeconds * 1000 : Infinity;

  console.log(`מאזין לוואטסאפ. ${runSeconds ? `רץ ${runSeconds} שניות.` : 'Ctrl+C לעצירה.'}`);
  console.log(`קבוצות מוכרות עד כה: ${Object.keys(discovered).length}\n`);

  let handled = 0;
  while (Date.now() < until) {
    let n;
    try {
      n = await receive();
    } catch (err) {
      console.error(`[poll] שגיאת קליטה: ${err.message} — ממתין`);
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }
    if (!n) continue; // תור ריק

    const body = n.body || {};
    const sd = body.senderData || {};
    if (body.typeWebhook === 'incomingMessageReceived' && sd.chatId) {
      if (remember(sd.chatId, sd.chatName)) {
        console.log(`  ⭐ קבוצה חדשה זוהתה: "${sd.chatName}"  →  ${sd.chatId}`);
      }
      await forward(body);
    }

    await remove(n.receiptId);
    handled++;
  }

  console.log(`\nטופלו ${handled} התראות. קבוצות מוכרות: ${Object.keys(discovered).length}`);
}

main().catch(err => { console.error('שגיאה:', err.message); process.exit(1); });
