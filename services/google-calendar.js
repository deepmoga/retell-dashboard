const { google } = require('googleapis');
const { db } = require('../database/db');

const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const REDIRECT_URI = (process.env.BASE_URL || 'https://calling.officialdigitalmarketing.in') + '/api/google-auth/callback';

function getOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
}

function getAuthUrl(userId) {
  const client = getOAuthClient();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: String(userId),
  });
}

async function handleCallback(code, userId) {
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  db.prepare('UPDATE users SET google_refresh_token=? WHERE id=?').run(tokens.refresh_token, userId);
  return tokens;
}

function disconnect(userId) {
  db.prepare('UPDATE users SET google_refresh_token=NULL WHERE id=?').run(userId);
}

function isConnected(userId) {
  const u = db.prepare('SELECT google_refresh_token FROM users WHERE id=?').get(userId);
  return !!(u?.google_refresh_token);
}

async function getCalendarClient(userId) {
  const u = db.prepare('SELECT google_refresh_token, google_calendar_id FROM users WHERE id=?').get(userId);
  if (!u?.google_refresh_token) return null;

  const client = getOAuthClient();
  client.setCredentials({ refresh_token: u.google_refresh_token });
  return { calendar: google.calendar({ version: 'v3', auth: client }), calendarId: u.google_calendar_id || 'primary' };
}

// Format appointment date+time into Google Calendar event times
function makeEventTimes(dateStr, timeStr, durationMins = 30, tz = 'Australia/Sydney') {
  const start = new Date(`${dateStr}T${timeStr}:00`);
  const end   = new Date(start.getTime() + durationMins * 60000);
  return {
    start: { dateTime: start.toISOString(), timeZone: tz },
    end:   { dateTime: end.toISOString(),   timeZone: tz },
  };
}

async function createEvent(userId, appointment) {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return null;
    const gc = await getCalendarClient(userId);
    if (!gc) return null;

    const tz = db.prepare('SELECT timezone FROM users WHERE id=?').get(userId)?.timezone || 'Australia/Sydney';
    const times = makeEventTimes(appointment.appointment_date, appointment.appointment_time, appointment.duration_minutes || 30, tz);

    const event = {
      summary: `${appointment.service_type || 'Appointment'} — ${appointment.customer_name}`,
      description: `📞 Booked via AI Voice Agent\n\nCustomer: ${appointment.customer_name}\nPhone: ${appointment.customer_phone || 'N/A'}\nService: ${appointment.service_type || 'N/A'}`,
      ...times,
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'email', minutes: 1440 }] },
    };

    const res = await gc.calendar.events.insert({ calendarId: gc.calendarId, resource: event });
    const eventId = res.data.id;

    // Save event ID to appointment
    if (appointment.id) {
      db.prepare('UPDATE appointments SET google_event_id=? WHERE id=?').run(eventId, appointment.id);
    }

    console.log(`[GCal] Event created for user ${userId}: ${eventId}`);
    return eventId;
  } catch (err) {
    console.error('[GCal] createEvent error:', err.message);
    return null;
  }
}

async function deleteEvent(userId, appointmentId) {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return;
    const appt = db.prepare('SELECT google_event_id FROM appointments WHERE id=?').get(appointmentId);
    if (!appt?.google_event_id) return;

    const gc = await getCalendarClient(userId);
    if (!gc) return;

    await gc.calendar.events.delete({ calendarId: gc.calendarId, eventId: appt.google_event_id });
    db.prepare('UPDATE appointments SET google_event_id=NULL WHERE id=?').run(appointmentId);
    console.log(`[GCal] Event deleted for appointment ${appointmentId}`);
  } catch (err) {
    console.error('[GCal] deleteEvent error:', err.message);
  }
}

async function updateEvent(userId, appointmentId, appointment) {
  try {
    if (!process.env.GOOGLE_CLIENT_ID) return;
    const appt = db.prepare('SELECT google_event_id FROM appointments WHERE id=?').get(appointmentId);
    if (!appt?.google_event_id) return;

    const gc = await getCalendarClient(userId);
    if (!gc) return;

    const tz = db.prepare('SELECT timezone FROM users WHERE id=?').get(userId)?.timezone || 'Australia/Sydney';
    const times = makeEventTimes(appointment.appointment_date, appointment.appointment_time, appointment.duration_minutes || 30, tz);

    await gc.calendar.events.patch({
      calendarId: gc.calendarId,
      eventId: appt.google_event_id,
      resource: {
        summary: `${appointment.service_type || 'Appointment'} — ${appointment.customer_name}`,
        ...times,
      },
    });
    console.log(`[GCal] Event updated for appointment ${appointmentId}`);
  } catch (err) {
    console.error('[GCal] updateEvent error:', err.message);
  }
}

module.exports = { getAuthUrl, handleCallback, disconnect, isConnected, createEvent, deleteEvent, updateEvent };
