/**
 * אספן AllJobs — תצוגת אורח, ללא התחברות וללא דפדפן.
 *
 * מה שאומת מול האתר (09.09.2026):
 *  - SearchResultsGuest.aspx מחזיר 200 עם 30 משרות לעמוד, ב-HTTP רגיל מ-IP ישראלי.
 *  - חיפוש חופשי הוא `freetxt` — לא `freetext`. השם השגוי מתקבל בשקט ומוחזר פיד לא מסונן,
 *    כלומר מקבלים 30 משרות אקראיות ונדמה שהחיפוש עבד. מלכודת אמיתית — נפלתי בה בבדיקה.
 *  - סינון בצד שרת: freetxt / region / city / type. אין סינון לפי ותק או שכר.
 */
const axios = require('axios');
const cheerio = require('cheerio');

const BASE = 'https://www.alljobs.co.il';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// אזורים לפי קודי האתר (חולצו מדף הבית)
const REGIONS = {
  'חיפה': 1, 'מרכז': 2, 'ירושלים': 3, 'דרום': 7, 'צפון': 10,
  'עבודה מהבית': 11, 'גליל עליון': 14, 'גליל מערבי': 15,
  'רמת הגולן': 16, 'גליל תחתון': 17,
};

/**
 * "לפני 3 שעות" / "1 ימים" / "אתמול" → גיל בשעות (null אם לא זוהה).
 * AllJobs לא עקבי: לפעמים עם "לפני" ולפעמים בלי. שתי הצורות חייבות להיתפס.
 */
function parseAgeHours(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (/עכשיו|לפני\s*דקה/.test(t)) return 0;

  let m = t.match(/(\d+)\s*דקות/);   if (m) return +m[1] / 60;
  m = t.match(/(\d+)\s*שעות/);       if (m) return +m[1];
  if (/לפני\s*שעה/.test(t)) return 1;
  if (/אתמול/.test(t)) return 24;
  m = t.match(/(\d+)\s*ימים/);       if (m) return +m[1] * 24;
  if (/לפני\s*יום/.test(t)) return 24;
  m = t.match(/(\d+)\s*שבועות/);     if (m) return +m[1] * 168;
  if (/לפני\s*שבוע/.test(t)) return 168;
  m = t.match(/(\d+)\s*חודשים/);     if (m) return +m[1] * 720;
  return null;
}

function buildUrl({ query = '', region = '', city = '', type = '', page = 1 }) {
  const p = new URLSearchParams({
    page: String(page), position: '', type: String(type),
    freetxt: query, city: String(city), region: String(region),
  });
  return `${BASE}/SearchResultsGuest.aspx?${p}`;
}

async function fetchPage(opts) {
  const { data } = await axios.get(buildUrl(opts), {
    headers: { 'User-Agent': UA, 'Accept-Language': 'he-IL,he;q=0.9' },
    timeout: 30000,
  });
  const $ = cheerio.load(data);
  const jobs = [];

  $('div.job-content-top').each((_, el) => {
    const $el = $(el);
    const $link = $el.find('.job-content-top-title a[href*="JobID="]').first();
    const href = $link.attr('href') || '';
    const id = href.match(/JobID=(\d+)/)?.[1];
    if (!id) return;

    const title = ($link.find('h2').text() || $link.attr('title') || '').trim();
    if (!title) return;

    // מיקום: כל עיר היא <a> נפרד. טקסט גולמי מדביק אותן ("קרית טבעוןטירת כרמלנשר"),
    // לכן מחלצים עיר-עיר. נפילה לטקסט גולמי רק כשאין קישורים.
    const $loc = $el.find('[class*="job-content-top-location"]').first();
    const cities = $loc.find('a').map((_, a) => $(a).text().trim()).get().filter(Boolean);
    const location = cities.length
      ? cities.join(', ')
      : $loc.clone().find('b').remove().end().text().replace('מספר מקומות', '').trim();

    const jobType = $el.find('[class*="job-content-top-type"]').first()
                       .clone().find('b').remove().end().text().trim();
    const dateText = $el.find('.job-content-top-date').first().text().trim();

    jobs.push({
      id: `alljobs:${id}`,
      source: 'alljobs',
      title,
      company: null, // תצוגת אורח לא חושפת מעסיק (רוב המשרות דרך חברות השמה)
      location: location || null,
      job_type: jobType || null,
      description: $el.find('.job-content-top-desc').first().text().trim().slice(0, 2000) || null,
      url: `${BASE}${href.startsWith('/') ? '' : '/'}${href}`,
      posted_text: dateText || null,
      age_hours: parseAgeHours(dateText),
    });
  });

  return jobs;
}

/**
 * סורק שאילתה אחת על פני מספר עמודים.
 * עוצר כשעמוד לא מוסיף מזהים חדשים — AllJobs מחזיר את העמוד האחרון שוב במקום
 * עמוד ריק, ובלי העצירה הזו נכנסים ללולאה אינסופית.
 */
async function search({ query, region = '', city = '', type = '', maxPages = 3, delayMs = 1200 }) {
  const seen = new Set();
  const out = [];

  for (let page = 1; page <= maxPages; page++) {
    let jobs;
    try {
      jobs = await fetchPage({ query, region, city, type, page });
    } catch (err) {
      console.error(`[alljobs] "${query}" עמוד ${page} נכשל: ${err.response?.status || err.message}`);
      break;
    }
    const fresh = jobs.filter(j => !seen.has(j.id));
    if (!fresh.length) break;
    fresh.forEach(j => { seen.add(j.id); out.push({ ...j, query }); });
    if (jobs.length < 25) break; // עמוד חלקי = סוף התוצאות
    if (page < maxPages) await new Promise(r => setTimeout(r, delayMs));
  }
  return out;
}

/** מריץ את כל השאילתות המוגדרות ומאחד לפי מזהה */
async function collect(config = {}) {
  const queries = config.queries || [];
  const regions = config.regions?.length ? config.regions : [''];
  const byId = new Map();

  for (const query of queries) {
    for (const regionName of regions) {
      const region = REGIONS[regionName] ?? regionName ?? '';
      const jobs = await search({ query, region, maxPages: config.maxPages || 3 });
      jobs.forEach(j => { if (!byId.has(j.id)) byId.set(j.id, j); });
      console.log(`[alljobs] "${query}"${regionName ? ` (${regionName})` : ''} → ${jobs.length}`);
    }
  }
  return [...byId.values()];
}

module.exports = { collect, search, fetchPage, REGIONS, parseAgeHours };
