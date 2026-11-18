'use strict';
/**
 * Email is the ONLY notification and reminder channel in ARCHFLOW.
 * Every notification in the app goes through send(). Each message is recorded in
 * email_log; when SMTP is configured it is delivered, otherwise it is logged only.
 */
const nodemailer = require('nodemailer');
const db = require('./db');
const { config } = require('./config');
const { esc } = require('./util');

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (config.mail.host) {
    transport = nodemailer.createTransport({
      host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });
  }
  return transport;
}

function layout({ title, intro, rows = [], body = '', cta, footer }) {
  const rowHtml = rows.length
    ? `<table style="width:100%;border-collapse:collapse;margin:16px 0">${rows.map(([k, v]) =>
      `<tr><td style="padding:6px 8px;color:#5b6b82;border-bottom:1px solid #e5eaf2;width:40%">${esc(k)}</td><td style="padding:6px 8px;border-bottom:1px solid #e5eaf2;font-weight:600">${esc(v)}</td></tr>`).join('')}</table>`
    : '';
  const ctaHtml = cta ? `<p style="margin:24px 0"><a href="${esc(cta.url)}" style="background:#1d6fd8;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:600">${esc(cta.label)}</a></p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#f2f5fa;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#13233a">
<div style="max-width:600px;margin:0 auto;padding:24px">
<div style="background:#0b1a33;color:#fff;padding:16px 24px;border-radius:8px 8px 0 0;font-weight:700;letter-spacing:.08em">ARCHFLOW</div>
<div style="background:#fff;padding:24px;border-radius:0 0 8px 8px">
<h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>
${intro ? `<p style="line-height:1.55">${esc(intro)}</p>` : ''}${rowHtml}${body}${ctaHtml}
<p style="color:#8090a8;font-size:12px;margin-top:28px">${esc(footer || 'You are receiving this email because of activity in your ARCHFLOW workspace. Email is the only channel ARCHFLOW uses for notifications and reminders.')}</p>
</div></div></body></html>`;
}

function toText({ title, intro, rows = [], cta }) {
  return [title, '', intro || '', ...rows.map(([k, v]) => `${k}: ${v}`), cta ? `\n${cta.label}: ${cta.url}` : ''].join('\n');
}

/**
 * send({ to, subject, orgId, category, title, intro, rows, body, cta })
 * `to` may be a string or array; duplicates/empties are removed. Returns a promise.
 */
async function send(msg) {
  const recipients = [...new Set([].concat(msg.to || []).filter(Boolean).map((e) => String(e).trim().toLowerCase()))];
  if (!recipients.length) return [];
  const html = layout({ title: msg.title || msg.subject, ...msg });
  const text = toText({ title: msg.title || msg.subject, ...msg });
  const t = getTransport();
  const ids = [];
  for (const to of recipients) {
    ids.push({ to, id: await db.insert('email_log', {
      org_id: msg.orgId || null, to_email: to, subject: msg.subject, category: msg.category || 'general',
      body_html: html, status: t ? 'queued' : 'logged',
    }) });
    if (!t && process.env.NODE_ENV !== 'test') console.log(`[email:logged] to=${to} subject="${msg.subject}"`);
  }
  // SMTP delivery happens in the background so requests never wait on the mail server.
  if (t) {
    for (const { to, id } of ids) {
      const delivery = db.outsideTx(() => t.sendMail({ from: config.mail.from, to, subject: msg.subject, html, text })
        .then(() => db.run("UPDATE email_log SET status = 'sent' WHERE id = ?", id))
        .catch((err) => {
          console.error(`[email:failed] to=${to}: ${err.message}`);
          return db.run("UPDATE email_log SET status = 'failed', error = ? WHERE id = ?", String(err.message || err), id);
        })
        .catch((e) => console.error('[email] log update failed', e.message)));
      // On Vercel, keep the function alive until the email is handed to the SMTP server.
      if (config.onVercel) require('@vercel/functions').waitUntil(delivery);
    }
  }
  return ids;
}

module.exports = { send, layout };
