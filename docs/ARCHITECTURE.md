# ארכיטקטורה

```
┌─ המחשב של אופק (IP ישראלי) ─────────────────────┐
│  local-collector/run.js   — Task Scheduler, כל 3 שעות
│   ├─ collectors/alljobs.js   SearchResultsGuest + freetxt
│   └─ collectors/linkedin.js  jobs-guest API (ללא התחברות)
│              │  POST /api/ingest  (x-ingest-secret)
└──────────────┼───────────────────────────────────┘
               ▼
┌─ Railway ────────────────────────────────────────┐
│  index.js                                        │
│   ├─ /api/ingest            → filter → SQLite    │
│   ├─ /api/whatsapp-webhook  → Green API נכנס     │
│   ├─ /api/jobs /stats /settings  ← הדשבורד       │
│   └─ cron 09:00 (Asia/Jerusalem) → דיג'סט יומי   │
│  data/ על Volume: jobs.db + config.json          │
└──────────────────────────────────────────────────┘
               ▼
        וואטסאפ (Green API) + מייל (Brevo)
```

## למה הפיצול הזה

אול ג'ובס חוסם IP זר, ולכן הסריקה **לא יכולה** לרוץ ב-Railway. זו בדיוק
הארכיטקטורה שנבנתה בפרויקט הנדל"ן אחרי ששבועות נשרפו על scrapers שהחזירו
0 תוצאות מ-US-West. המחשב עם ה-IP הישראלי סורק, והשרת נשאר קל — מסנן, שומר,
מציג ושולח.

לינקדין דווקא עובד מכל IP, אבל רץ באותו אספן כדי שיהיה מקום אחד לתזמן ולנטר.

וואטסאפ הוא היחיד שנקלט בשרת — webhook חייב כתובת ציבורית קבועה.

## זרימת נתונים

1. **איסוף** — כל מקור מחזיר אובייקטים במבנה אחיד:
   `{ id, source, title, company, location, description, url, age_hours }`
   ה-`id` הוא `<מקור>:<מזהה>` ומבטיח שאותה משרה לא תישמר פעמיים.
2. **סינון וניקוד** (`filters/filter.js`) — פסילה קשיחה מצומצמת + ניקוד רך.
3. **שמירה** — `ON CONFLICT` מעדכן פרטים אבל **לא נוגע ב-status/notes/notified**.
   משרה שסימנת "הגשתי" לא תחזור להיות "חדשה" רק כי הופיעה שוב בסריקה.
4. **תצוגה** — הדשבורד מושך מ-`/api/jobs` עם סינון לפי סטטוס/מקור/טקסט.
5. **התראה** — פעם ביום, רק משרות עם `notified=0` מעל סף הניקוד.

## מודל ה-CRM

לכל משרה סטטוס אחד מתוך:
`new → interested → applied → interview → offer` (או `rejected` / `archived`)

הסטטוס וההערות נשמרים בשורת המשרה עצמה. אין טבלת אירועים — למשתמש יחיד
זה סיבוך מיותר. `status_at` שומר מתי השתנה לאחרונה.

## קבצים

| קובץ | תפקיד |
|------|-------|
| `index.js` | שרת Express, API, webhook, cron |
| `db/database.js` | SQLite + פעולות CRM |
| `filters/filter.js` | ניקוד וסינון, כולל התאמת מילים בעברית |
| `collectors/alljobs.js` | אול ג'ובס |
| `collectors/linkedin.js` | לינקדין |
| `collectors/whatsapp.js` | פענוח webhook להודעת דרושים |
| `notifiers/whatsapp.js` | שליחה ב-Green API |
| `notifiers/email.js` | שליחה ב-Brevo |
| `local-collector/run.js` | האספן שרץ על המחשב |
| `public/index.html` | הדשבורד (קובץ יחיד, ללא build) |
| `config.json` | ברירות מחדל; העותק הפעיל ב-`data/config.json` |
