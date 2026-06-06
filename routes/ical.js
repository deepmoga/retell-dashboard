// iCal feed — clients copy this URL and add to Google Calendar / Apple Calendar / Outlook
const express = require('express');
const { db, userQueries } = require('../database/db');
const jwt = require('jsonwebtoken');

const router = express.Router();

// GET /api/ical/:userId?token=xxx
// Returns iCal format — subscribe this URL in any calendar app
router.get('/:userId', (req, res) => {
  try {
    // Verify token (passed as query param)
    const token = req.query.token;
    if (!token) return res.status(401).send('No token');

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).send('Invalid token');
    }

    const userId = parseInt(req.params.userId);
    if (decoded.userId !== userId && decoded.role !== 'admin') {
      return res.status(403).send('Forbidden');
    }

    const user = userQueries.findById.get(userId);
    if (!user) return res.status(404).send('User not found');

    // Get all non-cancelled appointments
    const appointments = db.prepare(`
      SELECT * FROM appointments
      WHERE user_id = ? AND status != 'cancelled'
      ORDER BY appointment_date DESC, appointment_time DESC
      LIMIT 200
    `).all(userId);

    const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const calName = user.company_name || user.name || 'Appointments';

    let ical = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//VoiceAgent//Appointment Calendar//EN',
      `X-WR-CALNAME:${calName} — Appointments`,
      'X-WR-TIMEZONE:Australia/Sydney',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
      'X-PUBLISHED-TTL:PT1H',
    ];

    appointments.forEach(appt => {
      const dtStart = formatICalDate(appt.appointment_date, appt.appointment_time);
      const dtEnd   = formatICalDate(appt.appointment_date, addMinutes(appt.appointment_time, appt.duration_minutes || 60));
      const uid     = `appt-${appt.id}@voiceagent`;
      const summary = `${appt.service_type || 'Appointment'} — ${appt.customer_name || 'Customer'}`;
      const desc    = [
        `Customer: ${appt.customer_name || '—'}`,
        `Phone: ${appt.customer_phone || '—'}`,
        `Service: ${appt.service_type || '—'}`,
        `Status: ${appt.status}`,
        appt.notes ? `Notes: ${appt.notes}` : '',
      ].filter(Boolean).join('\\n');

      const statusMap = { confirmed: 'CONFIRMED', pending: 'TENTATIVE', completed: 'CONFIRMED', cancelled: 'CANCELLED' };
      const icalStatus = statusMap[appt.status] || 'TENTATIVE';

      ical.push(
        'BEGIN:VEVENT',
        `UID:${uid}`,
        `DTSTAMP:${now}`,
        `DTSTART;TZID=Australia/Sydney:${dtStart}`,
        `DTEND;TZID=Australia/Sydney:${dtEnd}`,
        `SUMMARY:${escapeIcal(summary)}`,
        `DESCRIPTION:${escapeIcal(desc)}`,
        `STATUS:${icalStatus}`,
        appt.status === 'pending' ? 'TRANSP:TRANSPARENT' : 'TRANSP:OPAQUE',
        'END:VEVENT',
      );
    });

    ical.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${calName}-appointments.ics"`);
    res.send(ical.join('\r\n'));
  } catch (err) {
    console.error('[iCal]', err.message);
    res.status(500).send('Error generating calendar');
  }
});

function formatICalDate(date, time) {
  // Returns YYYYMMDDTHHMMSS
  return date.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
}

function addMinutes(time, minutes) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function escapeIcal(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

module.exports = router;
