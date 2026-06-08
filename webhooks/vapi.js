const express = require('express');
const { callQueries, userQueries, db } = require('../database/db');
const { normalizeCallData } = require('../services/vapi');
const { downloadRecording } = require('../services/sync');

function getUserTimezone(userId) {
  try {
    const user = db.prepare('SELECT timezone FROM users WHERE id=?').get(userId);
    return user?.timezone || 'Australia/Sydney';
  } catch(_) { return 'Australia/Sydney'; }
}

// Check if booking already saved for this call
function bookingExistsForCall(callId) {
  return db.prepare(`SELECT id FROM appointments WHERE notes LIKE ?`).get(`%${callId}%`);
}

// Parse transcript to extract booking details
function extractBookingFromTranscript(transcript, callId) {
  if (!transcript) return null;
  const text = transcript.toLowerCase();

  // Must contain confirmation keywords
  const confirmed = /\b(booked|booking confirmed|all booked|locked in|see you|appointment.*confirm)\b/i.test(transcript);
  if (!confirmed) return null;

  // Extract date — look for YYYY-MM-DD or common date patterns
  let date = null;
  const isoDate = transcript.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoDate) {
    date = isoDate[1];
  } else {
    // Try to find date like "10th of June", "June 10", "10 June 2026"
    const monthMap = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12,
      january:1,february:2,march:3,april:4,june:6,july:7,august:8,september:9,october:10,november:11,december:12 };
    const m = transcript.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(\w+)(?:\s+(\d{4}))?/i);
    if (m) {
      const day = parseInt(m[1]);
      const mon = monthMap[m[2].toLowerCase()];
      const year = m[3] ? parseInt(m[3]) : new Date().getFullYear();
      if (mon) date = `${year}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    }
  }

  // Extract time — HH:MM or "10am", "2pm", "10 o'clock"
  let time = null;
  const timeMatch = transcript.match(/\b(\d{1,2}):(\d{2})\b/);
  if (timeMatch) {
    time = `${String(parseInt(timeMatch[1])).padStart(2,'0')}:${timeMatch[2]}`;
  } else {
    const ampm = transcript.match(/\b(\d{1,2})\s*(am|pm)\b/i);
    if (ampm) {
      let h = parseInt(ampm[1]);
      if (ampm[2].toLowerCase() === 'pm' && h < 12) h += 12;
      if (ampm[2].toLowerCase() === 'am' && h === 12) h = 0;
      time = `${String(h).padStart(2,'0')}:00`;
    }
  }

  if (!date || !time) return null;

  // Validate date is not in past
  if (new Date(date) < new Date(new Date().toDateString())) return null;

  // Extract phone number
  const phoneMatch = transcript.match(/\b(\+?[\d\s\-]{8,15})\b/);
  const phone = phoneMatch ? phoneMatch[1].replace(/\s/g, '') : 'Unknown';

  // Extract name — look for "name is X" or "I'm X" patterns
  const nameMatch = transcript.match(/(?:name is|my name'?s?|i'?m)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i);
  const name = nameMatch ? nameMatch[1] : 'Customer';

  return { date, time, name, phone, callId };
}


const router = express.Router();
let ioInstance = null;

function setSocketIO(io) { ioInstance = io; }

function findUserForCall(callData) {
  const vapiCallId = `vapi_${callData.call?.id || callData.id}`;
  const existing = callQueries.findByCallId.get(vapiCallId);
  if (existing?.user_id) return existing.user_id;
  // Find user with VAPI key
  const users = userQueries.getApiKeys.all();
  const vapiUser = users.find(u => u.vapi_api_key);
  return vapiUser?.id || 1;
}

function saveWebhookLog(source, eventType, callId, userId, rawBody, status = 'received', errorMsg = '') {
  try {
    db.prepare(`
      INSERT INTO webhook_logs (source, event_type, call_id, user_id, raw_body, status, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(source, eventType, callId || '', userId || null, String(rawBody).slice(0, 8000), status, errorMsg || '');
  } catch(e) { console.error('[WebhookLog] Failed:', e.message); }
}

router.post('/', async (req, res) => {
  res.status(200).json({ received: true });
  const rawBody = JSON.stringify(req.body);

  try {
    const event = req.body;
    const msg = event.message || event;
    const type = msg.type || event.type;
    const callData = msg.call || event.call || msg;

    console.log(`[VAPI Webhook] Event: ${type}, call: ${callData?.id}`);

    const userId = findUserForCall(callData);

    // Log every webhook event
    saveWebhookLog('vapi', type || 'unknown', callData?.id, userId, rawBody, 'received');

    if (type === 'call-started' || type === 'status-update' && callData.status === 'in-progress') {
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

    if (type === 'end-of-call-report' || type === 'call-ended') {
      const reportData = msg.call || callData;
      const normalized = normalizeCallData({ ...reportData, status: 'ended' }, userId);
      callQueries.upsert.run(normalized);

      if (normalized.recording_url) {
        downloadRecording(normalized.call_id, normalized.recording_url).then(p => {
          if (p) callQueries.updateRecordingPath.run(p, normalized.call_id);
        }).catch(() => {});
      }

      // PRIMARY: Save booking from VAPI's analysisPlan structured data
      try {
        const analysis = reportData.analysis || msg.analysis || {};
        const sd = analysis.structuredData || {};
        console.log('[VAPI Webhook] Structured data:', JSON.stringify(sd));

        if (sd.booking_confirmed && sd.appointment_date && sd.appointment_time
            && sd.customer_name && sd.customer_phone
            && !bookingExistsForCall(normalized.call_id)) {

          // Use user's timezone for "today" comparison
          const userTz = getUserTimezone(userId);
          const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: userTz });
          const bookDate = new Date(sd.appointment_date + 'T00:00:00');
          const today = new Date(todayStr + 'T00:00:00');

          if (bookDate >= today) {
            // Check if slot already taken
            const slotTaken = db.prepare(`
              SELECT id, customer_name FROM appointments
              WHERE user_id = ? AND appointment_date = ? AND appointment_time = ?
              AND status = 'confirmed'
            `).get(userId, sd.appointment_date, sd.appointment_time);

            const status = slotTaken ? 'pending' : 'confirmed';
            const notes = slotTaken
              ? `⚠️ CONFLICT — slot already booked by ${slotTaken.customer_name}. Booked via AI call — ${normalized.call_id}`
              : `Booked via AI call — ${normalized.call_id}`;

            db.prepare(`
              INSERT INTO appointments (user_id, customer_name, customer_phone, appointment_date, appointment_time, status, service_type, notes)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(userId, sd.customer_name, sd.customer_phone, sd.appointment_date, sd.appointment_time,
              status, sd.service_type || 'Service', notes);

            if (slotTaken) {
              console.log(`[VAPI Webhook] ⚠️ CONFLICT: ${sd.customer_name} vs ${slotTaken.customer_name} on ${sd.appointment_date} ${sd.appointment_time}`);
            } else {
              console.log(`[VAPI Webhook] ✅ Booking saved: ${sd.customer_name} on ${sd.appointment_date} at ${sd.appointment_time}`);
            }

            // Emit socket event for real-time dashboard notification
            if (ioInstance) {
              ioInstance.emit('new_appointment', {
                customer_name: sd.customer_name,
                date: sd.appointment_date,
                time: sd.appointment_time,
                status,
                conflict: !!slotTaken,
                conflictWith: slotTaken?.customer_name || null,
              });
            }
          } else {
            console.log('[VAPI Webhook] ⚠️ Skipped past date booking:', sd.appointment_date);
          }
        } else {
          console.log('[VAPI Webhook] No confirmed booking in this call. booking_confirmed:', sd.booking_confirmed);
        }
      } catch (e) {
        console.error('[VAPI Webhook] Analysis booking error:', e.message);
      }

      if (ioInstance) {
        ioInstance.emit('call_ended', { callId: normalized.call_id, duration: normalized.duration_seconds, cost: normalized.total_cost });
        ioInstance.emit('calls_updated', { totalActive: callQueries.getActiveCalls.all().length });
      }
    }
  } catch (err) {
    console.error('[VAPI Webhook] Error:', err.message);
    saveWebhookLog('vapi', 'error', '', null, rawBody, 'error', err.message);
  }
});

module.exports = { router, setSocketIO };
