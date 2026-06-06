const { google } = require('googleapis');

const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'https://calling.officialdigitalmarketing.in/auth/google/callback';
const TIMEZONE      = process.env.TIMEZONE || 'Australia/Sydney';

function getOAuth2Client(tokens = null) {
  const client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
  if (tokens) client.setCredentials(tokens);
  return client;
}

function getAuthUrl(userId) {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: String(userId),
  });
}

async function getTokensFromCode(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

function getCalendar(accessToken, refreshToken) {
  const client = getOAuth2Client({ access_token: accessToken, refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth: client });
}

function toDateTime(date, time, durationMinutes = 60) {
  const start = new Date(`${date}T${time}:00`);
  const end   = new Date(start.getTime() + durationMinutes * 60000);
  return {
    start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
    end:   { dateTime: end.toISOString(),   timeZone: TIMEZONE },
  };
}

async function createEvent(accessToken, refreshToken, calendarId = 'primary', appointment) {
  try {
    const cal = getCalendar(accessToken, refreshToken);
    const dt  = toDateTime(appointment.appointment_date, appointment.appointment_time, appointment.duration_minutes || 60);
    const event = await cal.events.insert({
      calendarId,
      requestBody: {
        summary: `${appointment.service_type || 'Appointment'} — ${appointment.customer_name}`,
        description: `Customer: ${appointment.customer_name}\nPhone: ${appointment.customer_phone}\nService: ${appointment.service_type || '—'}\n\nBooked via VoiceAgent AI`,
        start: dt.start,
        end:   dt.end,
        colorId: '2', // green
        reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
      },
    });
    return event.data.id;
  } catch (err) {
    console.error('[GCal] createEvent error:', err.message);
    return null;
  }
}

async function updateEvent(accessToken, refreshToken, calendarId = 'primary', eventId, appointment) {
  try {
    const cal = getCalendar(accessToken, refreshToken);
    const dt  = toDateTime(appointment.appointment_date, appointment.appointment_time, appointment.duration_minutes || 60);
    await cal.events.patch({
      calendarId,
      eventId,
      requestBody: {
        summary: `${appointment.service_type || 'Appointment'} — ${appointment.customer_name}`,
        start: dt.start,
        end:   dt.end,
      },
    });
    return true;
  } catch (err) {
    console.error('[GCal] updateEvent error:', err.message);
    return false;
  }
}

async function deleteEvent(accessToken, refreshToken, calendarId = 'primary', eventId) {
  try {
    const cal = getCalendar(accessToken, refreshToken);
    await cal.events.delete({ calendarId, eventId });
    return true;
  } catch (err) {
    console.error('[GCal] deleteEvent error:', err.message);
    return false;
  }
}

async function listCalendars(accessToken, refreshToken) {
  try {
    const cal = getCalendar(accessToken, refreshToken);
    const res = await cal.calendarList.list();
    return res.data.items || [];
  } catch (err) {
    console.error('[GCal] listCalendars error:', err.message);
    return [];
  }
}

module.exports = { getAuthUrl, getTokensFromCode, createEvent, updateEvent, deleteEvent, listCalendars, REDIRECT_URI };
