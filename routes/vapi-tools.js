// VAPI Tool Webhook Handler — with full debug logging
const express = require('express');
const { db } = require('../database/db');

const router = express.Router();

// ── Logging ───────────────────────────────────────────────────────────────────

function saveLog(userId, fnName, args, result, status = 'success', callId = '', rawRequest = '', responseSent = '') {
  try {
    db.prepare(`
      INSERT INTO function_logs (user_id, function_name, args_json, result, status, call_id, raw_request, response_sent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId,
      fnName,
      JSON.stringify(args),
      String(result).slice(0, 2000),
      status,
      callId || '',
      String(rawRequest).slice(0, 5000),
      String(responseSent).slice(0, 2000)
    );
  } catch(e) {
    console.error('[Log] Failed to save log:', e.message);
  }
}

// ── Arg parser — handles ALL VAPI formats ────────────────────────────────────
// VAPI sends tool args in multiple possible ways depending on version + config:
//  1. body.message.functionCall.parameters  (string or object)
//  2. body.message.toolCallList[0].function.arguments  (string or object)
//  3. body.toolCallList[0].function.arguments
//  4. Direct body keys (legacy server URL)

function parseVapiCall(body) {
  const msg = body.message || body;
  const type = msg.type || body.type || '';

  // Format 1: functionCall (VAPI serverUrl function-call)
  if (msg.functionCall) {
    const fc = msg.functionCall;
    const params = typeof fc.parameters === 'string'
      ? tryParse(fc.parameters)
      : (fc.parameters || fc.arguments || {});
    return {
      fnName: fc.name,
      args: params,
      toolCallId: null,
      callId: msg.call?.id || '',
      format: 'functionCall',
    };
  }

  // Format 2: toolCallList (VAPI serverUrl tool-calls)
  const toolList = msg.toolCallList || msg.tool_calls || body.toolCallList || [];
  if (toolList.length > 0) {
    const tc = toolList[0];
    const fn = tc.function || {};
    const args = typeof fn.arguments === 'string'
      ? tryParse(fn.arguments)
      : (fn.arguments || fn.parameters || {});
    return {
      fnName: fn.name,
      args,
      toolCallId: tc.id || null,
      callId: msg.call?.id || body.call?.id || '',
      format: 'toolCallList',
    };
  }

  // Format 3: Direct body (legacy / webhook style)
  if (body.function_name || body.name) {
    return {
      fnName: body.function_name || body.name,
      args: body.parameters || body.arguments || body.args || body,
      toolCallId: null,
      callId: body.call_id || '',
      format: 'direct',
    };
  }

  return null;
}

function tryParse(str) {
  try { return JSON.parse(str); } catch(_) { return {}; }
}

// ── Unified handler ───────────────────────────────────────────────────────────

router.post('/:userId/call', (req, res) => {
  const userId = parseInt(req.params.userId);
  const rawBody = JSON.stringify(req.body);
  console.log(`[VAPI Tool] /call userId=${userId} raw:`, rawBody.slice(0, 800));

  try {
    const parsed = parseVapiCall(req.body);

    if (!parsed || !parsed.fnName) {
      console.warn('[VAPI Tool] Could not parse function call. Body:', rawBody.slice(0, 400));
      saveLog(userId, 'UNKNOWN', {}, 'ERROR: could not parse function call from body', 'error', '', rawBody, '');
      return res.json({ result: 'Could not read function call. Check VAPI tool configuration.' });
    }

    console.log(`[VAPI Tool] fn=${parsed.fnName} format=${parsed.format} args=`, parsed.args);

    if (parsed.fnName === 'checkAvailability') {
      return handleCheckAvailability(userId, parsed.args, res, parsed.toolCallId, parsed.callId, rawBody);
    }
    if (parsed.fnName === 'bookAppointment') {
      return handleBookAppointment(userId, parsed.args, res, parsed.toolCallId, parsed.callId, rawBody);
    }

    saveLog(userId, parsed.fnName, parsed.args, `Unknown function: ${parsed.fnName}`, 'error', parsed.callId, rawBody, '');
    return res.json({ result: `Unknown function: ${parsed.fnName}` });

  } catch (err) {
    console.error('[VAPI Tool] Crash:', err.message, err.stack);
    saveLog(userId, 'CRASH', {}, `CRASH: ${err.message}`, 'error', '', rawBody, '');
    return res.json({ result: 'Server error. Please try again.' });
  }
});

// Keep individual endpoints (backward compat)
router.post('/:userId/check-availability', (req, res) => {
  const userId = parseInt(req.params.userId);
  const rawBody = JSON.stringify(req.body);
  const parsed = parseVapiCall(req.body);
  const args = parsed?.args || req.body;
  handleCheckAvailability(userId, args, res, parsed?.toolCallId, parsed?.callId, rawBody);
});

router.post('/:userId/book-appointment', (req, res) => {
  const userId = parseInt(req.params.userId);
  const rawBody = JSON.stringify(req.body);
  const parsed = parseVapiCall(req.body);
  const args = parsed?.args || req.body;
  handleBookAppointment(userId, args, res, parsed?.toolCallId, parsed?.callId, rawBody);
});

// ── checkAvailability ─────────────────────────────────────────────────────────

function handleCheckAvailability(userId, args, res, toolCallId, callId, rawBody) {
  try {
    const { date, time } = args;
    console.log(`[checkAvailability] userId=${userId} date=${date} time=${time}`);

    if (!date || !time) {
      const resp = 'Please provide both a date (YYYY-MM-DD) and time (HH:MM) to check.';
      saveLog(userId, 'checkAvailability', args, 'ERROR: missing date or time', 'error', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Validate date not in past
    const checkDate = new Date(date);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (checkDate < today) {
      const resp = `Date ${date} is in the past. Please choose a future date.`;
      saveLog(userId, 'checkAvailability', args, 'ERROR: past date', 'error', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Check working hours for this day
    const dow = checkDate.getDay(); // 0=Sun..6=Sat
    const wh = db.prepare(`SELECT * FROM working_hours WHERE user_id=? AND day_of_week=?`).get(userId, dow);
    if (wh && !wh.is_open) {
      const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
      const resp = `We are closed on ${dayName}. Please choose a different day.`;
      saveLog(userId, 'checkAvailability', args, `CLOSED: ${dayName}`, 'closed', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Check if time is within working hours
    if (wh) {
      const [sh, sm] = wh.start_time.split(':').map(Number);
      const [eh, em] = wh.end_time.split(':').map(Number);
      const [rh, rm] = time.split(':').map(Number);
      const reqMins = rh * 60 + rm;
      const startMins = sh * 60 + sm;
      const endMins = eh * 60 + em;
      if (reqMins < startMins || reqMins >= endMins) {
        const resp = `Time ${time} is outside business hours (${wh.start_time}–${wh.end_time}). Please choose a time within hours.`;
        saveLog(userId, 'checkAvailability', args, `OUTSIDE_HOURS: ${time}`, 'outside_hours', callId, rawBody, resp);
        return sendResult(res, toolCallId, resp);
      }
    }

    // Check if slot already taken
    const existing = db.prepare(`
      SELECT id FROM appointments
      WHERE user_id=? AND appointment_date=? AND appointment_time=? AND status != 'cancelled'
    `).get(userId, date, time);

    if (existing) {
      // Suggest next 3 available
      const bookedToday = db.prepare(`
        SELECT appointment_time FROM appointments
        WHERE user_id=? AND appointment_date=? AND status != 'cancelled'
      `).all(userId, date).map(r => r.appointment_time);

      const available = generateSlots(wh).filter(s => !bookedToday.includes(s)).slice(0, 3).join(', ');
      const resp = `Slot ${time} on ${formatDate(date)} is already booked. Available slots that day: ${available || 'None — try another day'}.`;
      saveLog(userId, 'checkAvailability', args, `ALREADY_BOOKED: ${date} ${time}`, 'already_booked', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    const resp = `Slot ${time} on ${formatDate(date)} is available. You can book it.`;
    saveLog(userId, 'checkAvailability', args, `AVAILABLE: ${date} ${time}`, 'available', callId, rawBody, resp);
    return sendResult(res, toolCallId, resp);

  } catch (err) {
    console.error('[checkAvailability] Error:', err.message);
    const resp = 'Error checking availability. Please try again.';
    saveLog(userId, 'checkAvailability', args, `CRASH: ${err.message}`, 'error', callId, rawBody, resp);
    return sendResult(res, toolCallId, resp);
  }
}

// ── bookAppointment ───────────────────────────────────────────────────────────

function handleBookAppointment(userId, args, res, toolCallId, callId, rawBody) {
  try {
    console.log(`[bookAppointment] userId=${userId} args=`, JSON.stringify(args));
    const { date, time, customer_name, customer_phone, service_type } = args;

    // Check missing fields
    const missing = [];
    if (!date)          missing.push('date');
    if (!time)          missing.push('time');
    if (!customer_name) missing.push('customer_name');
    if (!customer_phone) missing.push('customer_phone');

    if (missing.length) {
      const resp = `Missing required fields: ${missing.join(', ')}. Please collect these before booking.`;
      saveLog(userId, 'bookAppointment', args, `ERROR: missing ${missing.join(',')}`, 'error', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Validate date not in past
    const bookDate = new Date(date);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (bookDate < today) {
      const resp = `Date ${date} is in the past. Cannot book a past date.`;
      saveLog(userId, 'bookAppointment', args, 'ERROR: past date', 'error', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Check slot conflict
    const existing = db.prepare(`
      SELECT id FROM appointments
      WHERE user_id=? AND appointment_date=? AND appointment_time=? AND status != 'cancelled'
    `).get(userId, date, time);

    if (existing) {
      const resp = `Slot ${time} on ${date} is already booked. Please choose another time.`;
      saveLog(userId, 'bookAppointment', args, `CONFLICT: ${date} ${time}`, 'conflict', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Save booking
    const result = db.prepare(`
      INSERT INTO appointments (user_id, customer_name, customer_phone, appointment_date, appointment_time, status, service_type, notes, call_id)
      VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?)
    `).run(
      userId,
      customer_name,
      customer_phone,
      date,
      time,
      service_type || 'Consultation',
      `Booked via AI voice agent`,
      callId || null
    );

    const bookingId = result.lastInsertRowid;
    const resp = `Booking confirmed! Reference #${bookingId}. ${customer_name} is booked for ${service_type || 'Consultation'} on ${formatDate(date)} at ${time}. See you then!`;
    saveLog(userId, 'bookAppointment', args, `SUCCESS: Booking #${bookingId}`, 'success', callId, rawBody, resp);
    console.log(`[bookAppointment] ✅ Saved #${bookingId} for user ${userId}`);

    return sendResult(res, toolCallId, resp);

  } catch (err) {
    console.error('[bookAppointment] CRASH:', err.message, err.stack);
    const resp = 'Error saving booking. Please try again.';
    saveLog(userId, 'bookAppointment', args, `CRASH: ${err.message}`, 'error', callId, rawBody, resp);
    return sendResult(res, toolCallId, resp);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendResult(res, toolCallId, result) {
  const body = toolCallId
    ? { results: [{ toolCallId, result }] }
    : { result };
  console.log('[VAPI Tool] Responding:', JSON.stringify(body).slice(0, 300));
  return res.json(body);
}

function formatDate(dateStr) {
  try {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-AU', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch(_) { return dateStr; }
}

function generateSlots(wh) {
  const startH = wh ? parseInt(wh.start_time.split(':')[0]) : 9;
  const endH   = wh ? parseInt(wh.end_time.split(':')[0])   : 17;
  const dur    = wh ? (wh.slot_duration || 30) : 30;
  const slots  = [];
  for (let m = startH * 60; m + dur <= endH * 60; m += dur) {
    slots.push(`${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`);
  }
  return slots;
}

module.exports = router;
