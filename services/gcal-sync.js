const { createEvent, updateEvent, deleteEvent } = require('./google-calendar');
const { db, userQueries } = require('../database/db');

async function syncAppointment(appointmentId, action = 'create') {
  try {
    const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
    if (!appt) return;

    const user = userQueries.findById.get(appt.user_id);
    if (!user?.google_access_token) return; // not connected

    const calId = user.google_calendar_id || 'primary';

    if (action === 'create') {
      const eventId = await createEvent(user.google_access_token, user.google_refresh_token, calId, appt);
      if (eventId) {
        db.prepare('UPDATE appointments SET google_event_id=? WHERE id=?').run(eventId, appointmentId);
        console.log(`[GCal] Event created: ${eventId} for appointment #${appointmentId}`);
      }
    }

    if (action === 'update' && appt.google_event_id) {
      await updateEvent(user.google_access_token, user.google_refresh_token, calId, appt.google_event_id, appt);
      console.log(`[GCal] Event updated: ${appt.google_event_id}`);
    }

    if (action === 'delete' && appt.google_event_id) {
      await deleteEvent(user.google_access_token, user.google_refresh_token, calId, appt.google_event_id);
      console.log(`[GCal] Event deleted: ${appt.google_event_id}`);
    }
  } catch (err) {
    console.error('[GCal Sync] Error:', err.message);
  }
}

module.exports = { syncAppointment };
