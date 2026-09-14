/**
 * מנוע סינון וניקוד.
 *
 * העיקרון: פסילה קשיחה מצומצמת (רק מה שפוסל בוודאות), וניקוד רך לדירוג.
 * זה הלקח מפרויקט הנדל"ן — סינון קשיח על "נוחויות" זרק דירות טובות, ולכן שם הן
 * הפכו לבונוס. כאן אותו דבר: מילת מפתח חסרה מורידה ניקוד, לא פוסלת.
 */

// אותיות סופיות → צורתן הרגילה.
// בעברית האות הסופית מתחלפת ברגע שנוספת סיומת: "כלכלן" אבל "כלכלנים" (נ, לא ן).
// בלי הנרמול הזה, חיפוש "כלכלן" לא מוצא "כלכלנים" — המחרוזת פשוט לא שם.
const FINALS = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };

function norm(s) {
  return (s == null ? '' : String(s))
    .toLowerCase()
    .replace(/["'׳״]/g, '')          // גרש/גרשיים — "מנכ״ל" מול "מנכל"
    .replace(/[ךםןףץ]/g, c => FINALS[c])
    .replace(/\s+/g, ' ')
    .trim();
}

// אותיות (עברית + לטינית) — משמשות לזיהוי גבול מילה
const LETTER = '[A-Za-z\\u0590-\\u05FF]';
// אותיות השימוש בעברית, שנדבקות לתחילת מילה: הכלכלן, ולכלכלן, במנהל
const HEB_PREFIX = 'הובלכשמ';
// סיומות נטייה נפוצות: כלכלן → כלכלנים / כלכלנית.
// כתובות בצורה המנורמלת (אחרי המרת אותיות סופיות) — "ים" הופך ל-"ימ",
// כי הן מושוות מול טקסט שכבר עבר את norm(). זה נראה שגוי במבט ראשון, וזה מכוון.
const HEB_SUFFIX = '(?:ימ|יות|ות|ית|ת|ה|י|נ)?';

const rxCache = new Map();

/**
 * בונה ביטוי רגולרי לביטוי חיפוש אחד, עם גבולות מילה מודעי-עברית.
 *
 * למה זה נחוץ: התאמת תת-מחרוזת פשוטה תפסה את "חשב" בתוך "מחשבים", ולכן
 * "טכנאי מחשבים ורשתות" נכנס למאגר כמשרת כספים. אומת בהרצה על 380 משרות אמיתיות.
 *
 * הכלל: ביטוי קצר (עד 3 אותיות) דורש גבולות קשיחים משני הצדדים — הוא קצר מדי
 * מכדי לסבול נטיות בלי לתפוס מילים אחרות. ביטוי ארוך יותר מקבל סובלנות
 * לאות שימוש בהתחלה ולסיומת נטייה בסוף.
 */
/**
 * צורת זכר/נקבה שנדחפת אחרי מילה במודעות דרושים:
 * "בקר/ית", "מנהל /ת", "כלכלן.ית", "דרוש /ה".
 * בלי זה, "מנהל כספים" לא מוצא "מנהל/ת כספים" — וכך נכתבות רוב המודעות בעברית.
 */
const GENDER = '(?:\\s*[\\/.\\-]\\s*(?:יות|ית|ות|ימ|ת|ה|י))?';

function buildTermRegex(term) {
  const t = norm(term);
  const words = t.split(/\s+/).filter(Boolean);

  const parts = words.map((w, i) => {
    const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const short = w.length <= 3;
    // אות שימוש מותרת רק בתחילת הביטוי, וסיומת נטייה רק למילה ארוכה מ-3 אותיות
    const prefix = (i === 0 && !short) ? `[${HEB_PREFIX}]?` : '';
    const suffix = short ? '' : HEB_SUFFIX;
    return prefix + esc + suffix + GENDER;
  });

  // גבולות מילה רק בקצוות; בין המילים מותר רווח אחד או יותר
  return new RegExp(`(?<!${LETTER})${parts.join('\\s+')}(?!${LETTER})`, 'i');
}

function termRegex(term) {
  let rx = rxCache.get(term);
  if (!rx) { rx = buildTermRegex(term); rxCache.set(term, rx); }
  return rx;
}

/** מחזיר את הביטויים מתוך terms שמופיעים בטקסט כמילה שלמה */
function hasAny(text, terms) {
  const t = norm(text);
  if (!t) return [];
  return (terms || []).filter(term => term && termRegex(term).test(t));
}

/**
 * מנקד משרה מול הקריטריונים.
 * מחזיר { pass, score, matched, reasons } — reasons מסביר למה נפסלה, לצורך דיבוג.
 */
function evaluate(job, criteria = {}) {
  const {
    mustAny = [],           // חייב לפחות אחד מאלה — אחרת נפסל
    exclude = [],           // מילות פסילה בכל מקום בטקסט
    excludeTitleOnly = [],  // פוסלות רק אם מופיעות בכותרת
    bonus = [],             // מעלות ניקוד בלבד
    locations = [],         // ערים מועדפות
    requireLocation = false,// true = רשימת המיקומים הופכת לסינון קשיח, לא רק בונוס
    maxAgeHours = null,     // מבוגר מזה נפסל (null = ללא הגבלה)
    minScore = 0,
  } = criteria;

  const title = job.title || '';
  const body = `${title} ${job.description || ''} ${job.company || ''}`;
  const reasons = [];
  const matched = [];
  let score = 0;

  // --- פסילות ---
  const badTitle = hasAny(title, excludeTitleOnly);
  if (badTitle.length) reasons.push(`מילת פסילה בכותרת: ${badTitle.join(', ')}`);

  const bad = hasAny(body, exclude);
  if (bad.length) reasons.push(`מילת פסילה: ${bad.join(', ')}`);

  const must = hasAny(body, mustAny);
  if (mustAny.length && !must.length) reasons.push('לא נמצאה אף מילת מפתח נדרשת');

  // גיל לא ידוע לא פוסל — חלק ממודעות AllJobs פשוט לא מציגות תאריך,
  // ואין סיבה להעניש משרה טובה על שדה חסר.
  if (maxAgeHours != null && job.age_hours != null && job.age_hours > maxAgeHours) {
    reasons.push(`ישנה מדי (${Math.round(job.age_hours)} שעות)`);
  }

  // --- ניקוד ---
  // התאמה בכותרת שווה יותר מהתאמה בגוף: הכותרת מתארת את התפקיד, הגוף לרוב את החברה.
  const mustInTitle = hasAny(title, mustAny);
  score += mustInTitle.length * 30;
  score += (must.length - mustInTitle.length) * 10;
  matched.push(...must);

  const bonusHits = hasAny(body, bonus);
  score += bonusHits.length * 8;
  matched.push(...bonusHits);

  const locHits = hasAny(job.location || '', locations);
  if (locHits.length) { score += 15; matched.push(...locHits); }

  /*
   * סינון גאוגרפי קשיח (אופציונלי).
   * נדרש כי אול ג'ובס מתעלם מפרמטר האזור שלו ומחזיר משרות מכל הארץ —
   * עפולה, יקנעם ונהריה הגיעו למאגר שמוגדר "מרכז". כאן זה נחתך אצלנו.
   *
   * משרה בלי מיקום *עוברת*: לינקדין ווואטסאפ לא תמיד מציינים אחד, ואין סיבה
   * לפסול משרה טובה על שדה חסר. אותו עיקרון כמו גיל לא ידוע.
   * מודעות אול ג'ובס מציינות כמה ערים — התאמה לאחת מהן מספיקה.
   */
  if (requireLocation && locations.length && job.location && !locHits.length) {
    reasons.push(`מיקום מחוץ לאזור המבוקש: ${job.location}`);
  }

  // טריות — משרה בת שעתיים שווה יותר מאחת בת שבוע
  if (job.age_hours != null) {
    if (job.age_hours <= 24) score += 12;
    else if (job.age_hours <= 72) score += 6;
  }
  if (job.company) score += 3; // מעסיק מזוהה (לינקדין) — פחות "עיוור" ממודעת השמה

  if (score < minScore) reasons.push(`ניקוד ${score} מתחת לסף ${minScore}`);

  return { pass: reasons.length === 0, score, matched: [...new Set(matched)], reasons };
}

/** מסנן רשימה ומחזיר את העוברות, מנוקדות וממוינות */
function apply(jobs, criteria = {}) {
  const passed = [];
  const rejected = [];
  for (const job of jobs) {
    const r = evaluate(job, criteria);
    if (r.pass) passed.push({ ...job, score: r.score, matched: r.matched });
    else rejected.push({ ...job, reasons: r.reasons });
  }
  passed.sort((a, b) => b.score - a.score);
  return { passed, rejected };
}

module.exports = { evaluate, apply, hasAny, norm };
