const express = require('express');
const { callQueries, userQueries, db } = require('../database/db');
const { normalizeCallData } = require('../services/vapi');
const { downloadRecording } = require('../services/sync');

const router = express.Router();
let ioInstance = null;
function setSocketIO(io) { ioInstance = io; }

// ── Helpers ───────────────────────────────────────────────────────────────────

function getUserTimezone(userId) {
  try {
    const u = db.prepare('SELECT timezone FROM users WHERE id=?').get(userId);
    return u?.timezone || 'Australia/Sydney';
  } catch(_) { return 'Australia/Sydney'; }
}

function bookingExistsForCall(callId) {
  return db.prepare(`SELECT id FROM appointments WHERE notes LIKE ? OR call_id=?`)
    .get(`%${callId}%`, callId);
}

function saveWebhookLog(source, eventType, callId, userId, rawBody, status = 'received', errorMsg = '') {
  try {
    db.prepare(`
      INSERT INTO webhook_logs (source, event_type, call_id, user_id, raw_body, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(source, eventType, callId || '', userId || null,
      String(rawBody).slice(0, 8000), status, errorMsg || '');
  } catch(e) { console.error('[WebhookLog] Failed:', e.message); }
}

function findUserForCall(callData) {
  const vapiCallId = `vapi_${callData.call?.id || callData.id}`;
  const existing = callQueries.findByCallId.get(vapiCallId);
  if (existing?.user_id) return existing.user_id;
  const vapiUser = userQueries.getApiKeys.all().find(u => u.vapi_api_key);
  return vapiUser?.id || 1;
}

// ── Working Hours Check ───────────────────────────────────────────────────────

function checkWorkingHours(userId, dateStr, timeStr) {
  // Returns { ok: true } or { ok: false, reason: '...', detail: {...} }
  try {
    const bookDate = new Date(dateStr + 'T00:00:00');
    const dow = bookDate.getDay();
    const wh = db.prepare(`SELECT * FROM working_hours WHERE user_id=? AND day_of_week=?`).get(userId, dow);
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    if (!wh) return { ok: true }; // no hours configured → allow all

    if (!wh.is_open) {
      return { ok: false, reason: 'closed day', detail: { day: dayNames[dow] } };
    }

    if (timeStr) {
      const [sh, sm] = wh.start_time.split(':').map(Number);
      const [eh, em] = wh.end_time.split(':').map(Number);
      const [rh, rm] = timeStr.split(':').map(Number);
      const req   = rh * 60 + rm;
      const start = sh * 60 + sm;
      const end   = eh * 60 + em;
      if (req < start || req >= end) {
        return { ok: false, reason: 'outside working hours',
          detail: { time: timeStr, working_hours: `${wh.start_time}–${wh.end_time}` } };
      }
    }
    return { ok: true };
  } catch(e) {
    return { ok: true }; // on error, allow
  }
}

// ── Save appointment (shared logic) ──────────────────────────────────────────

function saveBookingFromWebhook(userId, sd, normalizedCallId, rawCallId) {
  const slotTaken = db.prepare(`
    SELECT id, customer_name FROM appointments
    WHERE user_id=? AND appointment_date=? AND appointment_time=? AND status='confirmed'
  `).get(userId, sd.appointment_date, sd.appointment_time);

  const status = slotTaken ? 'pending' : 'confirmed';
  const notes  = slotTaken
    ? `⚠️ CONFLICT — slot booked by ${slotTaken.customer_name}. Via AI call — ${normalizedCallId}`
    : `Booked via AI call — ${normalizedCallId}`;

  db.prepare(`
    INSERT INTO appointments (user_id, customer_name, customer_phone, appointment_date,
      appointment_time, status, service_type, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, sd.customer_name, sd.customer_phone || '',
    sd.appointment_date, sd.appointment_time,
    status, sd.service_type || 'Service', notes);

  console.log(`[VAPI Webhook] ✅ Booking saved: ${sd.customer_name} ${sd.appointment_date} ${sd.appointment_time} (${status})`);
  saveWebhookLog('vapi', 'booking-saved', rawCallId, userId,
    JSON.stringify({ customer: sd.customer_name, date: sd.appointment_date,
      time: sd.appointment_time, status, conflict: !!slotTaken }),
    'saved');

  if (ioInstance) {
    ioInstance.emit('new_appointment', {
      customer_name: sd.customer_name,
      date: sd.appointment_date,
      time: sd.appointment_time,
      status,
      conflict: !!slotTaken,
    });
  }
}

// ── Main Webhook Handler ──────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  res.status(200).json({ received: true });
  const rawBody = JSON.stringify(req.body);

  try {
    const event    = req.body;
    const msg      = event.message || event;
    const type     = msg.type || event.type;
    const callData = msg.call || event.call || msg;

    console.log(`[VAPI Webhook] type=${type} call=${callData?.id}`);

    const userId = findUserForCall(callData);
    saveWebhookLog('vapi', type || 'unknown', callData?.id, userId, rawBody, 'received');

    // ── call-started ──────────────────────────────────────────────────────
    if (type === 'call-started') {
      const normalized = normalizeCallData({ ...callData, status: 'in-progress' }, userId);
      callQueries.upsert.run(normalized);
      if (ioInstance) {
        ioInstance.emit('call_started', {
          callId: normalized.call_id,
          fromNumber: normalized.from_number,
          toNumber: normalized.to_number,
          agentName: normalized.agent_name,
          startTime: normalized.start_timestamp || Date.now(),
        });
        ioInstance.emit('calls_updated', { totalActive: callQueries.getActiveCalls.all().length });
      }
    }

    // ── end-of-call-report / call-ended ──────────────────────────────────
    if (type === 'end-of-call-report' || type === 'call-ended') {
      const reportData = msg.call || callData;
      const normalized = normalizeCallData({ ...reportData, status: 'ended' }, userId);
      callQueries.upsert.run(normalized);

      if (normalized.recording_url) {
        downloadRecording(normalized.call_id, normalized.recording_url)
          .then(p => { if (p) callQueries.updateRecordingPath.run(p, normalized.call_id); })
          .catch(() => {});
      }

      // ── Try to save appointment from analysisPlan structuredData ──────
      try {
        const analysis = msg.analysis || reportData.analysis || event.analysis || {};
        const sd = analysis.structuredData || {};

        // Always log structuredData for debugging
        saveWebhookLog('vapi', 'structured-data-check', callData?.id, userId,
          JSON.stringify({
            booking_confirmed:  sd.booking_confirmed,
            customer_name:      sd.customer_name,
            customer_phone:     sd.customer_phone,
            appointment_date:   sd.appointment_date,
            appointment_time:   sd.appointment_time,
            service_type:       sd.service_type,
          }), 'received');

        const isConfirmed = sd.booking_confirmed === true || sd.booking_confirmed === 'true';

        if (!isConfirmed) {
          saveWebhookLog('vapi', 'booking-skip', callData?.id, userId,
            JSON.stringify({ reason: 'booking_confirmed not true', value: sd.booking_confirmed }),
            'skipped');

        } else if (!sd.appointment_date || !sd.appointment_time || !sd.customer_name) {
          saveWebhookLog('vapi', 'booking-skip', callData?.id, userId,
            JSON.stringify({ reason: 'missing fields', has_date: !!sd.appointment_date,
              has_time: !!sd.appointment_time, has_name: !!sd.customer_name }),
            'skipped');

        } else if (bookingExistsForCall(normalized.call_id)) {
          console.log('[VAPI Webhook] Booking already saved for call:', normalized.call_id);

        } else {
          // ── Past date check (timezone aware) ───────────────────────────
          const userTz  = getUserTimezone(userId);
          const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: userTz });
          const bookDate = new Date(sd.appointment_date + 'T00:00:00');
          const today    = new Date(todayStr + 'T00:00:00');

          if (bookDate < today) {
            saveWebhookLog('vapi', 'booking-skip', callData?.id, userId,
              JSON.stringify({ reason: 'past date',
                appointment_date: sd.appointment_date, today: todayStr, tz: userTz }),
              'skipped');

          } else {
            // ── Working hours check ─────────────────────────────────────
            const whCheck = checkWorkingHours(userId, sd.appointment_date, sd.appointment_time);

            if (!whCheck.ok) {
              console.log(`[VAPI Webhook] ⚠️ Working hours: ${whCheck.reason}`, whCheck.detail);
              saveWebhookLog('vapi', 'booking-skip', callData?.id, userId,
                JSON.stringify({ reason: whCheck.reason, ...whCheck.detail,
                  appointment_date: sd.appointment_date, appointment_time: sd.appointment_time }),
                'skipped');

            } else {
              // ✅ All checks passed — save the booking
              saveBookingFromWebhook(userId, sd, normalized.call_id, callData?.id);
            }
          }
        }
      } catch(e) {
        console.error('[VAPI Webhook] Booking error:', e.message, e.stack);
        saveWebhookLog('vapi', 'booking-error', callData?.id, userId,
          JSON.stringify({ error: e.message }), 'error', e.message);
      }

      if (ioInstance) {
        ioInstance.emit('call_ended', {
          callId: normalized.call_id,
          duration: normalized.duration_seconds,
          cost: normalized.total_cost,
        });
        ioInstance.emit('calls_updated', { totalActive: callQueries.getActiveCalls.all().length });
      }
    }

  } catch (err) {
    console.error('[VAPI Webhook] Error:', err.message);
    saveWebhookLog('vapi', 'error', '', null, rawBody, 'error', err.message);
  }
});

module.exports = { router, setSocketIO };
