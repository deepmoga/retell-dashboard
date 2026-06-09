const express = require('express');
const { db } = require('../database/db');
const { sendConfirmationEmail } = require('../services/email');
const authMiddleware = require('../middleware/auth');
const readonlyBlock = require('../middleware/readonlyBlock');

const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

function getUserId(req) {
  return req.user.role === 'admin'
    ? (req.query.client_id ? parseInt(req.query.client_id) : req.user.userId)
    : req.user.userId;
}

function getWorkingHours(userId) {
  const rows = db.prepare('SELECT * FROM working_hours WHERE user_id=? ORDER BY day_of_week').all(userId);
  if (rows.length) return rows;
  // Default: Mon-Fri 9am-5pm
  return [0,1,2,3,4,5,6].map(d => ({
    day_of_week: d, is_open: d >= 1 && d <= 5 ? 1 : 0,
    start_time: '09:00', end_time: '17:00', slot_duration: 30,
  }));
}

function getAvailableSlots(userId, dateStr, daysAhead = 14) {
  const hours = getWorkingHours(userId);
  const slots = [];
  const today = new Date();
  today.setHours(0,0,0,0);

  for (let i = 0; i < daysAhead; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dow = d.getDay();
    const h = hours.find(x => x.day_of_week === dow);
    if (!h || !h.is_open) continue;

    const dateKey = d.toISOString().slice(0, 10);
    const maxConcurrent = h.max_concurrent_bookings || 1;
    // Count bookings per slot for this day
    const bookedCounts = {};
    db.prepare(
      "SELECT appointment_time, COUNT(*) as c FROM appointments WHERE user_id=? AND appointment_date=? AND status != 'cancelled' GROUP BY appointment_time"
    ).all(userId, dateKey).forEach(r => { bookedCounts[r.appointment_time] = r.c; });

    const [sh, sm] = h.start_time.split(':').map(Number);
    const [eh, em] = h.end_time.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    const duration = h.slot_duration || 30;

    for (let m = startMins; m + duration <= endMins; m += duration) {
      const hh = String(Math.floor(m / 60)).padStart(2, '0');
      const mm = String(m % 60).padStart(2, '0');
      const timeStr = `${hh}:${mm}`;

      // Skip past times for today
      if (i === 0) {
        const now = new Date();
        const slotTime = new Date(); slotTime.setHours(Math.floor(m/60), m%60, 0, 0);
        if (slotTime <= now) continue;
      }

      if ((bookedCounts[timeStr] || 0) < maxConcurrent) {
        slots.push({ date: dateKey, time: timeStr });
        if (slots.length >= 20) break;
      }
    }
    if (slots.length >= 20) break;
  }
  return slots;
}

// ── Public API for VAPI/Retell tools (no auth) ───────────────────────────────

// VAPI tool: check available slots
router.get('/public/:userId/available', (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const slots = getAvailableSlots(userId, null, 14);
    const next5 = slots.slice(0, 5);
    res.json({
      available_slots: next5,
      message: next5.length > 0
        ? `Next available: ${next5[0].date} at ${next5[0].time}`
        : 'No available slots in next 14 days',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VAPI tool: book appointment
router.post('/public/:userId/book', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const { customer_name, customer_phone, customer_email, date, time, service_type, notes, call_id } = req.body;

    if (!date || !time) return res.status(400).json({ error: 'date and time required' });

    // Double-check slot capacity
    const dow = new Date(date + 'T00:00:00').getDay();
    const wh = db.prepare(`SELECT * FROM working_hours WHERE user_id=? AND day_of_week=?`).get(userId, dow);
    const maxConcurrent = wh?.max_concurrent_bookings || 1;
    const bookedCount = db.prepare(
      "SELECT COUNT(*) as c FROM appointments WHERE user_id=? AND appointment_date=? AND appointment_time=? AND status != 'cancelled'"
    ).get(userId, date, time).c;

    if (bookedCount >= maxConcurrent) {
      const slots = getAvailableSlots(userId, null, 7);
      return res.status(409).json({
        error: 'Slot full',
        next_available: slots[0] || null,
        message: slots[0] ? `That time is full (${bookedCount}/${maxConcurrent}). Next available: ${slots[0].date} at ${slots[0].time}` : 'No slots available',
      });
    }

    const result = db.prepare(`
      INSERT INTO appointments (user_id, call_id, customer_name, customer_phone, customer_email,
        appointment_date, appointment_time, service_type, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
    `).run(userId, call_id || null, customer_name || 'Unknown', customer_phone || '', customer_email || '', date, time, service_type || '', notes || '');

    const appointment = db.prepare('SELECT * FROM appointments WHERE id=?').get(result.lastInsertRowid);

    // Send confirmation email if email provided
    if (customer_email) {
      sendConfirmationEmail(userId, appointment).catch(() => {});
    }

    res.json({
      success: true,
      appointment_id: result.lastInsertRowid,
      message: `Appointment confirmed for ${date} at ${time}. ${customer_email ? 'Confirmation email sent.' : ''}`,
      appointment: { date, time, customer_name, service_type },
    });
  } catch (err) {
    console.error('[Appointments] Book error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Authenticated Routes ──────────────────────────────────────────────────────

router.use(authMiddleware);

router.get('/', (req, res) => {
  try {
    const userId = getUserId(req);
    const { status, from_date, to_date } = req.query;
    let sql = 'SELECT * FROM appointments WHERE user_id=?';
    const params = [userId];
    if (status && status !== 'all') { sql += ' AND status=?'; params.push(status); }
    if (from_date) { sql += ' AND appointment_date>=?'; params.push(from_date); }
    if (to_date) { sql += ' AND appointment_date<=?'; params.push(to_date); }
    sql += ' ORDER BY appointment_date ASC, appointment_time ASC';
    const appointments = db.prepare(sql).all(...params);
    res.json({ appointments });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/', readonlyBlock, async (req, res) => {
  try {
    const userId = getUserId(req);
    const { customer_name, customer_phone, customer_email, appointment_date, appointment_time, service_type, notes, duration_minutes } = req.body;
    if (!appointment_date || !appointment_time) return res.status(400).json({ error: 'Date and time required' });

    const result = db.prepare(`
      INSERT INTO appointments (user_id, customer_name, customer_phone, customer_email,
        appointment_date, appointment_time, duration_minutes, service_type, notes, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed')
    `).run(userId, customer_name || '', customer_phone || '', customer_email || '',
      appointment_date, appointment_time, duration_minutes || 30, service_type || '', notes || '');

    const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(result.lastInsertRowid);
    if (customer_email) sendConfirmationEmail(userId, appt).catch(() => {});
    res.json({ id: result.lastInsertRowid, message: 'Appointment created' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/:id', readonlyBlock, (req, res) => {
  try {
    const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
    if (!appt) return res.status(404).json({ error: 'Not found' });
    const userId = getUserId(req);
    if (req.user.role !== 'admin' && appt.user_id !== userId) return res.status(403).json({ error: 'Access denied' });

    const { customer_name, customer_phone, customer_email, appointment_date, appointment_time, status, service_type, notes, duration_minutes } = req.body;
    db.prepare(`UPDATE appointments SET customer_name=@n, customer_phone=@p, customer_email=@e,
      appointment_date=@d, appointment_time=@t, status=@s, service_type=@st, notes=@no, duration_minutes=@dur
      WHERE id=@id`).run({
      n: customer_name ?? appt.customer_name, p: customer_phone ?? appt.customer_phone,
      e: customer_email ?? appt.customer_email, d: appointment_date ?? appt.appointment_date,
      t: appointment_time ?? appt.appointment_time, s: status ?? appt.status,
      st: service_type ?? appt.service_type, no: notes ?? appt.notes,
      dur: duration_minutes ?? appt.duration_minutes, id: req.params.id,
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', readonlyBlock, (req, res) => {
  try {
    const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
    if (!appt) return res.status(404).json({ error: 'Not found' });
    const userId = getUserId(req);
    if (req.user.role !== 'admin' && appt.user_id !== userId) return res.status(403).json({ error: 'Access denied' });
    db.prepare("UPDATE appointments SET status='cancelled' WHERE id=?").run(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/available-slots', (req, res) => {
  try {
    const userId = getUserId(req);
    const slots = getAvailableSlots(userId, req.query.date, parseInt(req.query.days) || 14);
    res.json({ slots });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Working Hours ─────────────────────────────────────────────────────────────

router.get('/working-hours', (req, res) => {
  try {
    const userId = getUserId(req);
    const hours = getWorkingHours(userId);
    res.json({ working_hours: hours });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/working-hours', (req, res) => {
  try {
    const userId = getUserId(req);
    const { working_hours } = req.body;
    if (!Array.isArray(working_hours)) return res.status(400).json({ error: 'working_hours array required' });

    // Delete old and insert new
    db.prepare('DELETE FROM working_hours WHERE user_id=?').run(userId);
    const insert = db.prepare(`INSERT INTO working_hours (user_id, day_of_week, is_open, start_time, end_time, slot_duration, max_concurrent_bookings)
      VALUES (@uid, @dow, @open, @start, @end, @dur, @mc)`);
    for (const h of working_hours) {
      insert.run({ uid: userId, dow: h.day_of_week, open: h.is_open ? 1 : 0, start: h.start_time, end: h.end_time, dur: h.slot_duration || 30, mc: h.max_concurrent_bookings || 1 });
    }
    res.json({ success: true, message: 'Working hours saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Email Settings ────────────────────────────────────────────────────────────

router.get('/email-settings', (req, res) => {
  try {
    const userId = getUserId(req);
    const s = db.prepare('SELECT smtp_host, smtp_port, smtp_user, from_name, from_email FROM email_settings WHERE user_id=?').get(userId);
    res.json({ settings: s || {} });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/email-settings', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { smtp_host, smtp_port, smtp_user, smtp_pass, from_name, from_email } = req.body;

    db.prepare(`INSERT INTO email_settings (user_id, smtp_host, smtp_port, smtp_user, smtp_pass, from_name, from_email)
      VALUES (@uid, @host, @port, @user, @pass, @name, @email)
      ON CONFLICT(user_id) DO UPDATE SET smtp_host=@host, smtp_port=@port, smtp_user=@user,
      smtp_pass=@pass, from_name=@name, from_email=@email`
    ).run({ uid: userId, host: smtp_host, port: smtp_port || 587, user: smtp_user, pass: smtp_pass, name: from_name, email: from_email });

    res.json({ success: true, message: 'Email settings saved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/email-settings/test', async (req, res) => {
  try {
    const userId = getUserId(req);
    const { testEmailConnection } = require('../services/email');
    const s = db.prepare('SELECT * FROM email_settings WHERE user_id=?').get(userId);
    if (!s) return res.status(400).json({ error: 'No email settings saved yet' });
    const result = await testEmailConnection(s);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Resend confirmation
router.post('/:id/send-confirmation', async (req, res) => {
  try {
    const appt = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
    if (!appt) return res.status(404).json({ error: 'Not found' });
    if (!appt.customer_email) return res.status(400).json({ error: 'No email for this customer' });
    const ok = await sendConfirmationEmail(appt.user_id, appt);
    res.json({ success: ok, message: ok ? 'Email sent!' : 'Email failed — check email settings' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
