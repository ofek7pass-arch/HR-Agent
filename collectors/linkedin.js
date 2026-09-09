/**
 * אספן LinkedIn — דרך ה-endpoint הציבורי שמזין את תצוגת האורח באתר.
 *
 * למה זה הנתיב הנכון (אומת 09.09.2026):
 *  - `/jobs-guest/jobs/api/seeMoreJobPostings/search` מחזיר 200 עם משרות אמיתיות
 *    בלי קוקיז, בלי חשבון ובלי דפדפן. אין כאן חשיפה של החשבון האישי — אין חשבון בתמונה.
 *  - לכן *אין* להתחבר ללינקדין עם אוטומציה. זה הנתיב היחיד שבאמת מסכן חשבון,
 *    והוא מיותר כל עוד ה-endpoint הזה עונה.
 *
 * מגבלות: לינקדין מחזיר 429 כשמפציצים. מרווח בין בקשות + עצירה על 429 (לא retry אגרסיבי).
 */
const axios = require('axios');
const cheerio = require('cheerio');

const ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// חלון זמן: r86400 = 24 שעות, r604800 = שבוע
const TIME_WINDOWS = { day: 'r86400', week: 'r604800', month: 'r2592000' };
// סוג עבודה: 1=במשרד, 2=מרחוק, 3=היברידי
const WORKPLACE = { onsite: '1', remote: '2', hybrid: '3' };

function parseCards(html) {
  const $ = cheerio.load(html);
  const jobs = [];

  $('li').each((_, el) => {
    const $el = $(el);
    const urn = $el.find('[data-entity-urn]').attr('data-entity-urn')
             || $el.find('[data-row]').attr('data-entity-urn');
    const id = urn?.match(/jobPosting:(\d+)/)?.[1];
    if (!id) return;

    const title = $el.find('.base-search-card__title').text().trim();
    if (!title) return;

    const href = ($el.find('a.base-card__full-link').attr('href') || '').split('?')[0];
    const listdate = $el.find('time').attr('datetime') || null;

    jobs.push({
      id: `linkedin:${id}`,
      source: 'linkedin',
      title,
      company: $el.find('.base-search-card__subtitle').text().trim() || null,
      location: $el.find('.job-search-card__location').text().trim() || null,
      job_type: null,
      description: null, // תצוגת האורח מחזירה כרטיסים בלבד; התיאור נמצא בדף המשרה
      url: href || `https://www.linkedin.com/jobs/view/${id}/`,
      posted_text: listdate,
      age_hours: listdate ? Math.max(0, (Date.now() - Date.parse(listdate)) / 36e5) : null,
    });
  });

  return jobs;
}

async function search({ query, location = 'Israel', since = 'week', workplace = null,
                        maxPages = 3, delayMs = 2500 }) {
  const seen = new Set();
  const out = [];

  for (let page = 0; page < maxPages; page++) {
    const params = {
      keywords: query,
      location,
      start: page * 10,
      f_TPR: TIME_WINDOWS[since] || TIME_WINDOWS.week,
    };
    if (workplace && WORKPLACE[workplace]) params.f_WT = WORKPLACE[workplace];

    let html;
    try {
      ({ data: html } = await axios.get(ENDPOINT, {
        params,
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9,he;q=0.8' },
        timeout: 30000,
      }));
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) console.warn(`[linkedin] 429 — עוצר את "${query}" (rate limit)`);
      else console.error(`[linkedin] "${query}" עמוד ${page} נכשל: ${status || err.message}`);
      break;
    }

    const jobs = parseCards(html);
    const fresh = jobs.filter(j => !seen.has(j.id));
    if (!fresh.length) break;
    fresh.forEach(j => { seen.add(j.id); out.push({ ...j, query }); });
    if (page < maxPages - 1) await new Promise(r => setTimeout(r, delayMs));
  }

  return out;
}

async function collect(config = {}) {
  const queries = config.queries || [];
  const byId = new Map();

  for (const query of queries) {
    const jobs = await search({
      query,
      location: config.location || 'Israel',
      since: config.since || 'week',
      maxPages: config.maxPages || 3,
    });
    jobs.forEach(j => { if (!byId.has(j.id)) byId.set(j.id, j); });
    console.log(`[linkedin] "${query}" → ${jobs.length}`);
  }
  return [...byId.values()];
}

module.exports = { collect, search, parseCards, TIME_WINDOWS, WORKPLACE };
