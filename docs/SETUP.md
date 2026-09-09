# הפעלה והתקנה

## מקומי

```bash
cd "C:\Users\OfekPass\Ofek-GitHub\HR-Agent"
npm install
```

Node נייד (לא מותקן גלובלית):
`C:\Users\OfekPass\tools\node-v20.19.1-win-x64\node.exe`

צור `.env` לפי `.env.example`.

**הרצת השרת:**
```bash
node index.js
```
הדשבורד: http://localhost:3000

**הרצת האספן (סורק אול ג'ובס + לינקדין ושולח לשרת):**
```bash
node local-collector/run.js
```

## תזמון האספן — Task Scheduler

בדיוק כמו `NadlanYad2Scraper` בפרויקט הנדל"ן:

1. Task Scheduler → Create Task, שם: `HRAgentCollector`
2. Trigger: כל 3 שעות (אין טעם בתדירות גבוהה — לוחות משרות לא מתעדכנים כל דקה)
3. Action: `C:\Users\OfekPass\Ofek-GitHub\HR-Agent\local-collector\run.bat`
4. הפעל גם כשהמשתמש לא מחובר

הלוג נכתב ל-`local-collector/collector.log`.

## פריסה ל-Railway

1. `git push` לריפו ב-GitHub
2. Railway → New Project → Deploy from GitHub repo
3. **Volume** ממופה ל-`/app/data` — חובה, אחרת המאגר וההגדרות נמחקים בכל deploy
4. משתני סביבה:

| משתנה | ערך |
|-------|-----|
| `GREEN_API_INSTANCE_ID` | `7107617295` (10 ספרות בדיוק) |
| `GREEN_API_TOKEN` | הטוקן מ-Green API |
| `GREEN_API_URL` | `https://7107.api.greenapi.com` |
| `BREVO_API_KEY` | מפתח Brevo |
| `EMAIL_USER` | `ofek7pass@gmail.com` |
| `INGEST_SECRET` | סוד שמגן על `/api/ingest` — אותו ערך גם ב-`.env` המקומי |
| `PUBLIC_URL` | כתובת השירות, מופיעה כקישור בהתראות |
| `DATA_DIR` | `/app/data` |

> שמות ניטרליים בכוונה. ב-Railway היו בעיות עם משתנים שמכילים
> `TOKEN`/`INSTANCE`/`KEY` בשם בזמן build — ראה יומן הנדל"ן.

## חיבור קבוצות וואטסאפ

1. בקונסולת Green API — לוודא ש-`incomingWebhook` = `yes`
2. להגדיר webhook URL: `https://<השירות>/api/whatsapp-webhook`
3. לפתוח `https://<השירות>/api/whatsapp-groups` ולהעתיק את ה-chatId של כל קבוצה
4. בדשבורד → הגדרות → קבוצות וואטסאפ, שורה לכל קבוצה: `chatId | שם`

## בדיקות שימושיות

| כתובת | מה עושה |
|--------|----------|
| `GET /api/notif-check` | מצב Green API, מפתח Brevo, נמענים, כמה ממתינות |
| `POST /api/send-digest?dryrun=1` | מה היה נשלח — בלי לשלוח |
| `POST /api/send-digest` | שליחה אמיתית |
| `GET /api/whatsapp-groups` | רשימת הקבוצות והמזהים שלהן |
