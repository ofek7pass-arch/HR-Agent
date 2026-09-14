/**
 * שכבת נתונים — SQLite. ב-Railway הקובץ יושב על Volume ב-/app/data כדי לשרוד deploy.
 * הטבלה משמשת גם כמאגר משרות וגם כ-CRM: לכל משרה יש סטטוס טיפול והערות.
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'jobs.db'));
db.pragma('journal_mode = WAL');

// שלבי הטיפול ב-CRM. הסדר כאן הוא סדר ההתקדמות בתהליך.
const STATUSES = ['new', 'interested', 'applied', 'interview', 'offer', 'rejected', 'archived'];

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    source        TEXT NOT NULL,
    source_detail TEXT,
    title         TEXT NOT NULL,
    company       TEXT,
    location      TEXT,
    job_type      TEXT,
    description   TEXT,
    url           TEXT,
    posted_text   TEXT,
    age_hours     REAL,
    query         TEXT,
    score         INTEGER DEFAULT 0,
    matched       TEXT,
    status        TEXT DEFAULT 'new',
    notes         TEXT,
    raw_data      TEXT,
    found_at      TEXT DEFAULT (datetime('now','localtime')),
    last_seen     TEXT DEFAULT (datetime('now','localtime')),
    status_at     TEXT,
    notified      INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_source ON jobs(source);
  CREATE INDEX IF NOT EXISTS idx_jobs_found  ON jobs(found_at DESC);
`);

/**
 * שמירה. חשוב: ON CONFLICT לא נוגע ב-status/notes/notified —
 * משרה שכבר טיפלת בה לא תאופס בחזרה ל"חדשה" רק כי הופיעה שוב בסריקה.
 */
const upsertStmt = db.prepare(`
  INSERT INTO jobs (id, source, source_detail, title, company, location, job_type,
                    description, url, posted_text, age_hours, query, score, matched, raw_data)
  VALUES (@id, @source, @source_detail, @title, @company, @location, @job_type,
          @description, @url, @posted_text, @age_hours, @query, @score, @matched, @raw_data)
  ON CONFLICT(id) DO UPDATE SET
    title       = excluded.title,
    company     = COALESCE(excluded.company, jobs.company),
    location    = COALESCE(excluded.location, jobs.location),
    description = COALESCE(excluded.description, jobs.description),
    url         = excluded.url,
    score       = excluded.score,
    matched     = excluded.matched,
    last_seen   = datetime('now','localtime')
`);

function save(job) {
  upsertStmt.run({
    source_detail: null, company: null, location: null, job_type: null,
    description: null, url: null, posted_text: null, age_hours: null,
    query: null, score: 0,
    ...job,
    matched: Array.isArray(job.matched) ? job.matched.join(',') : (job.matched ?? null),
    raw_data: JSON.stringify(job.raw || {}),
  });
}

const saveMany = db.transaction(jobs => { jobs.forEach(save); });

function exists(id) {
  return !!db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id);
}

/** משרות שטרם נשלחו בדיג'סט — הבסיס להתראה היומית */
function getUnnotified() {
  return db.prepare(`
    SELECT * FROM jobs
    WHERE notified = 0 AND status NOT IN ('rejected','archived')
    ORDER BY score DESC, found_at DESC
  `).all();
}

function markNotified(ids) {
  if (!ids || !ids.length) return 0;
  const ph = ids.map(() => '?').join(',');
  return db.prepare(`UPDATE jobs SET notified = 1 WHERE id IN (${ph})`).run(...ids).changes;
}

/** שליפה לדשבורד — סינון לפי סטטוס / מקור / חיפוש חופשי */
function query({ status, source, search, limit = 500, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
  if (source && source !== 'all') { where.push('source = ?'); params.push(source); }
  if (search) {
    where.push('(title LIKE ? OR company LIKE ? OR description LIKE ? OR location LIKE ?)');
    params.push(...Array(4).fill(`%${search}%`));
  }
  const sql = `
    SELECT * FROM jobs
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE status WHEN 'new' THEN 0 WHEN 'interested' THEN 1 WHEN 'applied' THEN 2
                  WHEN 'interview' THEN 3 WHEN 'offer' THEN 4 ELSE 5 END,
      score DESC, found_at DESC
    LIMIT ? OFFSET ?`;
  return db.prepare(sql).all(...params, limit, offset);
}

function setStatus(id, status) {
  if (!STATUSES.includes(status)) throw new Error(`סטטוס לא חוקי: ${status}`);
  return db.prepare(
    `UPDATE jobs SET status = ?, status_at = datetime('now','localtime') WHERE id = ?`
  ).run(status, id).changes;
}

function setNotes(id, notes) {
  return db.prepare('UPDATE jobs SET notes = ? WHERE id = ?').run(notes == null ? '' : notes, id).changes;
}

function remove(id) {
  return db.prepare('DELETE FROM jobs WHERE id = ?').run(id).changes;
}

/**
 * ניקוי המאגר. משמש כשעוברים תחום חיפוש — המשרות הישנות כבר לא רלוונטיות
 * ולא ייסרקו שוב, ולכן יישארו תקועות עם ניקוד של קריטריונים שכבר לא קיימים.
 *
 * ברירת המחדל שומרת על כל מה שטיפלת בו (הגשת, ראיון, הצעה) — אין סיבה
 * שהיסטוריית החיפוש שלך תימחק רק כי החלפת מילות מפתח.
 * `everything: true` מוחק הכל בלי יוצא מן הכלל.
 */
function clear({ everything = false, source } = {}) {
  const where = [];
  const params = [];
  if (!everything) where.push("status IN ('new','rejected','archived')");
  if (source && source !== 'all') { where.push('source = ?'); params.push(source); }
  const sql = `DELETE FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  return db.prepare(sql).run(...params).changes;
}

/** מונים לכותרת הדשבורד */
function stats() {
  const byStatus = {};
  db.prepare('SELECT status, COUNT(*) n FROM jobs GROUP BY status')
    .all().forEach(r => { byStatus[r.status] = r.n; });
  const bySource = {};
  db.prepare('SELECT source, COUNT(*) n FROM jobs GROUP BY source')
    .all().forEach(r => { bySource[r.source] = r.n; });
  const total = db.prepare('SELECT COUNT(*) n FROM jobs').get().n;
  const today = db.prepare(
    "SELECT COUNT(*) n FROM jobs WHERE date(found_at) = date('now','localtime')"
  ).get().n;
  return { total, today, byStatus, bySource };
}

module.exports = {
  db, STATUSES, save, saveMany, exists, getUnnotified, markNotified,
  query, setStatus, setNotes, remove, clear, stats,
};
