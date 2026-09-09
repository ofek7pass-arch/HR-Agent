/**
 * האספן המקומי — רץ על המחשב של אופק, לא על Railway.
 *
 * למה: אול ג'ובס חוסם IP זר. זה בדיוק הלקח מפרויקט הנדל"ן, שם נשרפו שבועות
 * על scrapers שהחזירו 0 תוצאות מ-Railway US-West. הפתרון שעבד שם ומשוכפל כאן:
 * לסרוק מ-IP ישראלי ולשלוח את התוצאות לשרת דרך /api/ingest.
 *
 * לינקדין דווקא כן עובד מכל IP (endpoint ציבורי), אבל הוא רץ כאן יחד עם
 * אול ג'ובס כדי שיהיה מקום אחד לתזמן ולנטר.
 *
 * הרצה:  node local-collector/run.js
 * תזמון: Task Scheduler מריץ את run.bat
 */
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const alljobs = require('../collectors/alljobs');
const linkedin = require('../collectors/linkedin');

const SERVER = (process.env.SERVER_URL || 'http://localhost:3000').replace(/\/$/, '');
const SECRET = (process.env.INGEST_SECRET || '').trim();

/** מושך הגדרות מהשרת כדי שהקריטריונים ינוהלו במקום אחד (הדשבורד) */
async function getConfig() {
  try {
    const { data } = await axios.get(`${SERVER}/api/settings`, { timeout: 15000 });
    console.log('[config] נטען מהשרת');
    return data;
  } catch (err) {
    console.warn(`[config] השרת לא זמין (${err.message}) — נופל לקובץ המקומי`);
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
  }
}

async function main() {
  const started = Date.now();
  const cfg = await getConfig();
  const all = [];

  if (cfg.sources?.alljobs?.enabled) {
    console.log('\n--- אול ג\'ובס ---');
    try {
      all.push(...await alljobs.collect(cfg.sources.alljobs));
    } catch (err) {
      console.error('[alljobs] נכשל כליל:', err.message);
    }
  }

  if (cfg.sources?.linkedin?.enabled) {
    console.log('\n--- לינקדין ---');
    try {
      all.push(...await linkedin.collect(cfg.sources.linkedin));
    } catch (err) {
      console.error('[linkedin] נכשל כליל:', err.message);
    }
  }

  console.log(`\nסה"כ נאספו ${all.length} משרות ב-${Math.round((Date.now() - started) / 1000)} שניות`);

  if (!all.length) {
    // אזהרה מכוונת: 0 תוצאות פעמיים ברצף = בעיה תשתיתית, לא קוד. לבדוק חסימת IP.
    console.warn('אזהרה: לא נאספה אף משרה. אם זה חוזר — לבדוק חסימה, לא לשנות סלקטורים.');
    return;
  }

  try {
    const { data } = await axios.post(`${SERVER}/api/ingest`, { jobs: all }, {
      headers: SECRET ? { 'x-ingest-secret': SECRET } : {},
      timeout: 60000,
    });
    console.log(`[ingest] ${data.received} נשלחו · ${data.passed} עברו סינון · ${data.new} חדשות · ${data.rejected} נפסלו`);
  } catch (err) {
    console.error(`[ingest] שליחה לשרת נכשלה: ${err.response?.status || err.message}`);
    process.exitCode = 1;
  }
}

main().catch(err => { console.error('שגיאה כללית:', err); process.exit(1); });
