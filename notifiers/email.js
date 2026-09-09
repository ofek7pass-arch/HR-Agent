/**
 * שליחת מייל דרך Brevo HTTP API.
 * למה לא SMTP: Railway חוסם פורטי SMTP יוצאים (25/465/587) — nodemailer מחזיר ETIMEDOUT.
 * זה נבדק ביסודיות בפרויקט הנדל"ן. ב-Railway תמיד HTTP API, לעולם לא SMTP.
 */
const axios = require('axios');

const BREVO_KEY = (process.env.BREVO_API_KEY || '').trim();
const FROM = (process.env.EMAIL_USER || 'ofek7pass@gmail.com').trim();
const { SOURCE_LABEL } = require('./whatsapp');

function enabledRecipients(config) {
  const list = config?.notifications?.recipients || [];
  return list.filter(r => r.enabled !== false && r.email);
}

function buildHtml(jobs, dashboardUrl) {
  const rows = jobs.map(j => `
    <tr>
      <td style="padding:12px;border-bottom:1px solid #e5e7eb">
        <a href="${j.url}" style="font-weight:600;color:#1d4ed8;text-decoration:none;font-size:15px">${j.title}</a>
        <div style="color:#4b5563;font-size:13px;margin-top:4px">
          ${[j.company, j.location].filter(Boolean).join(' · ') || ''}
        </div>
        <div style="color:#9ca3af;font-size:12px;margin-top:3px">
          ${SOURCE_LABEL[j.source] || j.source}${j.score ? ` · התאמה ${j.score}` : ''}
        </div>
      </td>
    </tr>`).join('');

  return `<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:auto">
    <h2 style="color:#111827">סוכן משרות — סיכום יומי</h2>
    <p style="color:#4b5563">נמצאו ${jobs.length} משרות מתאימות.</p>
    <table style="width:100%;border-collapse:collapse">${rows}</table>
    ${dashboardUrl ? `<p style="margin-top:20px"><a href="${dashboardUrl}" style="background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">פתח את הדשבורד</a></p>` : ''}
  </div>`;
}

async function sendDigest(jobs, config, dashboardUrl) {
  if (!jobs || !jobs.length) return false;
  if (!BREVO_KEY) {
    console.warn('[email] BREVO_API_KEY חסר');
    return false;
  }
  const recipients = enabledRecipients(config);
  if (!recipients.length) return false;

  try {
    await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { email: FROM, name: 'סוכן משרות' },
      to: recipients.map(r => ({ email: r.email, name: r.name })),
      subject: `סוכן משרות — ${jobs.length} משרות חדשות מתאימות`,
      htmlContent: buildHtml(jobs, dashboardUrl),
    }, {
      headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json' },
      timeout: 20000,
    });
    console.log(`[email] נשלח ל-${recipients.map(r => r.email).join(', ')}`);
    return true;
  } catch (err) {
    console.error(`[email] שגיאה: ${err.response?.status || err.message}`);
    return false;
  }
}

module.exports = { sendDigest };
