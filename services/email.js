const nodemailer = require('nodemailer');
const { db } = require('../database/db');

function getEmailSettings(userId) {
  return db.prepare('SELECT * FROM email_settings WHERE user_id=?').get(userId);
}

function createTransporter(settings) {
  if (!settings?.smtp_host) return null;
  return nodemailer.createTransporter({
    host: settings.smtp_host,
    port: settings.smtp_port || 587,
    secure: settings.smtp_port === 465,
    auth: { user: settings.smtp_user, pass: settings.smtp_pass },
    tls: { rejectUnauthorized: false },
  });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-AU', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatTime(timeStr) {
  const [h, m] = timeStr.split(':');
  const hour = parseInt(h);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const h12 = hour % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

async function sendConfirmationEmail(userId, appointment) {
  try {
    const settings = getEmailSettings(userId);
    if (!settings?.smtp_host) {
      console.log('[Email] No email settings configured for user', userId);
      return false;
    }

    const transporter = createTransporter(settings);
    if (!transporter) return false;

    const businessName = settings.from_name || 'Official Digital Marketing';
    const fromEmail = settings.from_email || settings.smtp_user;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; }
  .card { background: #fff; border-radius: 8px; max-width: 560px; margin: 0 auto; padding: 32px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
  .header { text-align: center; margin-bottom: 28px; }
  .logo { font-size: 22px; font-weight: 700; color: #00d4aa; }
  .title { font-size: 20px; font-weight: 700; color: #1a1a1a; margin: 12px 0 4px; }
  .subtitle { color: #666; font-size: 14px; }
  .detail-box { background: #f9f9f9; border-left: 4px solid #00d4aa; border-radius: 4px; padding: 18px 20px; margin: 20px 0; }
  .detail-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #eee; font-size: 14px; }
  .detail-row:last-child { border-bottom: none; }
  .detail-label { color: #888; }
  .detail-value { font-weight: 600; color: #1a1a1a; }
  .badge { background: #00d4aa; color: #fff; padding: 4px 12px; border-radius: 12px; font-size: 12px; font-weight: 700; }
  .footer { text-align: center; color: #aaa; font-size: 12px; margin-top: 28px; }
</style></head>
<body>
<div class="card">
  <div class="header">
    <div class="logo">✓ Appointment Confirmed</div>
    <div class="title">Your booking is confirmed!</div>
    <div class="subtitle">${businessName}</div>
  </div>

  <p style="color:#444;font-size:14px">Hi <strong>${appointment.customer_name || 'there'}</strong>,<br><br>
  Great news! Your appointment has been successfully booked. Here are your details:</p>

  <div class="detail-box">
    <div class="detail-row">
      <span class="detail-label">📅 Date</span>
      <span class="detail-value">${formatDate(appointment.appointment_date)}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">🕐 Time</span>
      <span class="detail-value">${formatTime(appointment.appointment_time)} (AEST)</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">⏱ Duration</span>
      <span class="detail-value">${appointment.duration_minutes || 30} minutes</span>
    </div>
    ${appointment.service_type ? `
    <div class="detail-row">
      <span class="detail-label">💼 Service</span>
      <span class="detail-value">${appointment.service_type}</span>
    </div>` : ''}
    <div class="detail-row">
      <span class="detail-label">📞 Contact</span>
      <span class="detail-value">${appointment.customer_phone || '—'}</span>
    </div>
    <div class="detail-row">
      <span class="detail-label">Status</span>
      <span class="detail-value"><span class="badge">CONFIRMED</span></span>
    </div>
  </div>

  ${appointment.notes ? `<p style="color:#666;font-size:13px"><strong>Notes:</strong> ${appointment.notes}</p>` : ''}

  <p style="color:#444;font-size:14px">
    If you need to reschedule or have any questions, please reply to this email or call us directly.
  </p>

  <div class="footer">
    <p>This email was sent by ${businessName}</p>
    <p>© ${new Date().getFullYear()} ${businessName}. All rights reserved.</p>
  </div>
</div>
</body>
</html>`;

    await transporter.sendMail({
      from: `"${businessName}" <${fromEmail}>`,
      to: appointment.customer_email,
      subject: `✅ Appointment Confirmed — ${formatDate(appointment.appointment_date)} at ${formatTime(appointment.appointment_time)}`,
      html,
    });

    // Mark as sent
    db.prepare('UPDATE appointments SET confirmation_sent=1 WHERE id=?').run(appointment.id);
    console.log(`[Email] Confirmation sent to ${appointment.customer_email}`);
    return true;
  } catch (err) {
    console.error('[Email] Send error:', err.message);
    return false;
  }
}

async function testEmailConnection(settings) {
  try {
    const transporter = createTransporter(settings);
    if (!transporter) return { ok: false, error: 'No settings' };
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { sendConfirmationEmail, testEmailConnection, getEmailSettings };
