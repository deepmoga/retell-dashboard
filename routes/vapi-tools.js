// VAPI Tool Webhook Handler — with full debug logging + timezone support
const express = require('express');
const { db } = require('../database/db');
const gcal = require('../services/google-calendar');

const router = express.Router();

// ── Timezone helpers ──────────────────────────────────────────────────────────

function getUserTimezone(userId) {
  try {
    const user = db.prepare('SELECT timezone FROM users WHERE id=?').get(userId);
    return user?.timezone || 'Australia/Sydney';
  } catch(_) { return 'Australia/Sydney'; }
}

// Get today's date string (YYYY-MM-DD) in user's timezone
function getTodayStr(tz) {
  try {
    return new Date().toLocaleDateString('en-CA', { timeZone: tz }); // en-CA → YYYY-MM-DD
  } catch(_) {
    return new Date().toISOString().slice(0, 10);
  }
}

// Get "today" as a Date object (midnight) in user's timezone
function getTodayDate(tz) {
  const todayStr = getTodayStr(tz);
  return new Date(todayStr + 'T00:00:00');
}

// Get current time string (HH:MM) in user's timezone
function getCurrentTimeStr(tz) {
  try {
    return new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit' });
  } catch(_) {
    return new Date().toTimeString().slice(0, 5);
  }
}

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

function parseVapiCall(body) {
  const msg = body.message || body;

  // Format 1: functionCall (VAPI serverUrl function-call)
  if (msg.functionCall) {
    const fc = msg.functionCall;
    const params = typeof fc.parameters === 'string' ? tryParse(fc.parameters) : (fc.parameters || fc.arguments || {});
    return { fnName: fc.name, args: params, toolCallId: null, callId: msg.call?.id || '', format: 'functionCall' };
  }

  // Format 2: toolCallList (VAPI serverUrl tool-calls)
  const toolList = msg.toolCallList || msg.tool_calls || body.toolCallList || [];
  if (toolList.length > 0) {
    const tc = toolList[0];
    const fn = tc.function || {};
    const args = typeof fn.arguments === 'string' ? tryParse(fn.arguments) : (fn.arguments || fn.parameters || {});
    return { fnName: fn.name, args, toolCallId: tc.id || null, callId: msg.call?.id || body.call?.id || '', format: 'toolCallList' };
  }

  // Format 3: Direct body (legacy)
  if (body.function_name || body.name) {
    return { fnName: body.function_name || body.name, args: body.parameters || body.arguments || body.args || body, toolCallId: null, callId: body.call_id || '', format: 'direct' };
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
      saveLog(userId, 'UNKNOWN', {}, 'ERROR: could not parse function call', 'error', '', rawBody, '');
      return res.json({ result: 'Could not read function call. Check VAPI tool configuration.' });
    }

    console.log(`[VAPI Tool] fn=${parsed.fnName} format=${parsed.format} args=`, parsed.args);

    if (parsed.fnName === 'getTodayDate') {
      return handleGetTodayDate(userId, res, parsed.toolCallId, parsed.callId, rawBody);
    }
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

// Backward compat endpoints
router.post('/:userId/check-availability', (req, res) => {
  const userId = parseInt(req.params.userId);
  const rawBody = JSON.stringify(req.body);
  const parsed = parseVapiCall(req.body);
  handleCheckAvailability(userId, parsed?.args || req.body, res, parsed?.toolCallId, parsed?.callId, rawBody);
});

router.post('/:userId/book-appointment', (req, res) => {
  const userId = parseInt(req.params.userId);
  const rawBody = JSON.stringify(req.body);
  const parsed = parseVapiCall(req.body);
  handleBookAppointment(userId, parsed?.args || req.body, res, parsed?.toolCallId, parsed?.callId, rawBody);
});

// ── getTodayDate ──────────────────────────────────────────────────────────────

function handleGetTodayDate(userId, res, toolCallId, callId, rawBody) {
  try {
    const tz = getUserTimezone(userId);

    const now = new Date();
    const todayStr  = now.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD
    const timeStr   = now.toLocaleTimeString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true });
    const fullDate  = now.toLocaleDateString('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    // Tomorrow
    const tom = new Date(now);
    tom.setDate(tom.getDate() + 1);
    const tomorrowStr  = tom.toLocaleDateString('en-CA', { timeZone: tz });
    const tomorrowFull = tom.toLocaleDateString('en-IN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    const resp = `Today is ${fullDate} (${todayStr}). Current time is ${timeStr} (${tz}). Tomorrow is ${tomorrowFull} (${tomorrowStr}).`;

    console.log(`[getTodayDate] userId=${userId} tz=${tz} → ${resp}`);
    saveLog(userId, 'getTodayDate', {}, resp, 'success', callId, rawBody, resp);
    return sendResult(res, toolCallId, resp);
  } catch(err) {
    const resp = `Today's date: ${new Date().toISOString().slice(0,10)}`;
    saveLog(userId, 'getTodayDate', {}, `CRASH: ${err.message}`, 'error', callId, rawBody, resp);
    return sendResult(res, toolCallId, resp);
  }
}

// ── checkAvailability ─────────────────────────────────────────────────────────

function handleCheckAvailability(userId, args, res, toolCallId, callId, rawBody) {
  try {
    const { date, time } = args;
    const tz = getUserTimezone(userId);
    const todayStr = getTodayStr(tz);
    const todayDate = getTodayDate(tz);
    const nowTime = getCurrentTimeStr(tz);

    console.log(`[checkAvailability] userId=${userId} tz=${tz} today=${todayStr} now=${nowTime} | asked: date=${date} time=${time}`);

    // Always tell LLM today's date so it uses correct year
    const dateHint = `[Today is ${todayStr}, current time is ${nowTime} ${tz}]`;

    if (!date || !time) {
      const resp = `${dateHint} Please provide both a date (YYYY-MM-DD) and time (HH:MM) to check availability.`;
      saveLog(userId, 'checkAvailability', args, 'ERROR: missing date or time', 'error', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Reject past dates
    const checkDate = new Date(date + 'T00:00:00');
    if (checkDate < todayDate) {
      const resp = `${dateHint} Date ${date} is in the past. Please choose a future date starting from ${todayStr}.`;
      saveLog(userId, 'checkAvailability', args, `ERROR: past date ${date}`, 'error', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Check if day is open (working hours)
    const dow = checkDate.getDay();
    const wh = db.prepare(`SELECT * FROM working_hours WHERE user_id=? AND day_of_week=?`).get(userId, dow);
    if (wh && !wh.is_open) {
      const dayName = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];
      const resp = `${dateHint} We are closed on ${dayName}. Please choose a working day.`;
      saveLog(userId, 'checkAvailability', args, `CLOSED: ${dayName}`, 'closed', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Check if time is within working hours
    if (wh) {
      const [sh, sm] = wh.start_time.split(':').map(Number);
      const [eh, em] = wh.end_time.split(':').map(Number);
      const [rh, rm] = time.split(':').map(Number);
      const reqMins   = rh * 60 + rm;
      const startMins = sh * 60 + sm;
      const endMins   = eh * 60 + em;
      if (reqMins < startMins || reqMins >= endMins) {
        const resp = `${dateHint} Time ${time} is outside business hours (${wh.start_time}–${wh.end_time}). Please choose a time within working hours.`;
        saveLog(userId, 'checkAvailability', args, `OUTSIDE_HOURS: ${time}`, 'outside_hours', callId, rawBody, resp);
        return sendResult(res, toolCallId, resp);
      }
    }

    // Check slot conflict
    const existing = db.prepare(`
      SELECT id FROM appointments
      WHERE user_id=? AND appointment_date=? AND appointment_time=? AND status != 'cancelled'
    `).get(userId, date, time);

    if (existing) {
      const bookedSlots = db.prepare(`
        SELECT appointment_time FROM appointments
        WHERE user_id=? AND appointment_date=? AND status != 'cancelled'
      `).all(userId, date).map(r => r.appointment_time);

      const available = generateSlots(wh).filter(s => !bookedSlots.includes(s)).slice(0, 3).join(', ');
      const resp = `${dateHint} Slot ${time} on ${formatDate(date)} is already booked. Available slots that day: ${available || 'None — please try another day'}.`;
      saveLog(userId, 'checkAvailability', args, `ALREADY_BOOKED: ${date} ${time}`, 'already_booked', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    const resp = `${dateHint} Slot ${time} on ${formatDate(date)} (${date}) is available. You can go ahead and book it.`;
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

    const tz = getUserTimezone(userId);
    const todayStr = getTodayStr(tz);
    const todayDate = getTodayDate(tz);
    const dateHint = `[Today is ${todayStr} ${tz}]`;

    // Check missing fields
    const missing = [];
    if (!date)           missing.push('date');
    if (!time)           missing.push('time');
    if (!customer_name)  missing.push('customer_name');
    if (!customer_phone) missing.push('customer_phone');

    if (missing.length) {
      const resp = `${dateHint} Missing required fields: ${missing.join(', ')}. Please collect these before booking.`;
      saveLog(userId, 'bookAppointment', args, `ERROR: missing ${missing.join(',')}`, 'error', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Reject past dates
    const bookDate = new Date(date + 'T00:00:00');
    if (bookDate < todayDate) {
      const resp = `${dateHint} Date ${date} is in the past. Cannot book a past date. Please confirm a future date with the customer.`;
      saveLog(userId, 'bookAppointment', args, `ERROR: past date ${date}`, 'error', callId, rawBody, resp);
      return sendResult(res, toolCallId, resp);
    }

    // Prevent double booking: if this call already saved a booking, return same confirmation
    if (callId) {
      const callBooking = db.prepare(`SELECT id, customer_name FROM appointments WHERE call_id=?`).get(callId);
      if (callBooking) {
        const resp = `Booking already confirmed! Reference #${callBooking.id} for ${callBooking.customer_name}.`;
        saveLog(userId, 'bookAppointment', args, `DUPLICATE_CALL: already booked #${callBooking.id}`, 'duplicate', callId, rawBody, resp);
        return sendResult(res, toolCallId, resp);
      }
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
      VALUES (?, ?, ?, ?, ?, 'confirmed', ?, 'Booked via AI voice agent', ?)
    `).run(userId, customer_name, customer_phone, date, time, service_type || 'Consultation', callId || null);

    const bookingId = result.lastInsertRowid;
    const resp = `Booking confirmed! Reference #${bookingId}. ${customer_name} is booked for ${service_type || 'Consultation'} on ${formatDate(date)} at ${time}. See you then!`;
    saveLog(userId, 'bookAppointment', args, `SUCCESS: Booking #${bookingId}`, 'success', callId, rawBody, resp);
    console.log(`[bookAppointment] ✅ Saved #${bookingId} for user ${userId}`);

    // Google Calendar sync (non-blocking)
    gcal.createEvent(userId, { id: bookingId, customer_name, customer_phone, appointment_date: date, appointment_time: time, service_type }).catch(() => {});

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
  const body = toolCallId ? { results: [{ toolCallId, result }] } : { result };
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
