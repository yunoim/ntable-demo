// 간단 이메일 발송 — SMTP 환경변수 없으면 silent skip (개발 환경 안전)
// 환경변수: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE(default true if port=465)

let _transporter = null;
let _disabled = false;

function getTransporter() {
  if (_disabled) return null;
  if (_transporter) return _transporter;
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) {
    _disabled = true;
    console.log('[mailer] SMTP env not set — email disabled');
    return null;
  }
  try {
    const nodemailer = require('nodemailer');
    const port = parseInt(process.env.SMTP_PORT, 10) || 587;
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    _transporter = nodemailer.createTransport({
      host, port, secure, auth: { user, pass },
    });
    return _transporter;
  } catch (err) {
    console.error('[mailer] init failed:', err.message);
    _disabled = true;
    return null;
  }
}

async function send({ to, subject, text, html }) {
  if (!to) return { sent: false, reason: 'no_to' };
  const t = getTransporter();
  if (!t) return { sent: false, reason: 'disabled' };
  try {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;
    const info = await t.sendMail({ from, to, subject, text, html });
    return { sent: true, messageId: info.messageId };
  } catch (err) {
    console.error('[mailer] send failed:', err.message);
    return { sent: false, reason: 'send_error', error: err.message };
  }
}

module.exports = { send };
