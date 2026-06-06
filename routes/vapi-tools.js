// VAPI Tool Webhook Handler
// VAPI calls POST /api/vapi-tools/:userId/call for all function calls
const express = require('express');
const { db } = require('../database/db');

const router = express.Router();

// Unified handler — VAPI serverUrl approach
router.post('/:userId/call', (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const body = req.body;
    console.log('[VAPI Tool] Incoming:', JSON.stringify(body).slice(0, 600));

    // Parse function call from VAPI message
    const msg = body.message || body;
    const fnCall = msg.functionCall || msg.function_call;

    if (!fnCall) {
      console.log('[VAPI Tool] No function call found');
      return res.json({ result: 'No function call received' });
    }

    const fnName = fnCall.name;
    const args = typeof fnCall.parameters === 'string'
      ? JSON.parse(fnCall.parameters)
      : (fnCall.parameters || fnCall.arguments || {});

    console.log(`[VAPI Tool] Function: ${fnName}`, args);

    if (fnName === 'checkAvailability') {
      return handleCheckAvailability(userId, args, res);
    }
    if (fnName === 'bookAppointment') {
      return handleBookAppointment(userId, args, res);
    }

    return res.json({ result: `Unknown function: ${fnName}` });
  } catch (err) {
    console.error('[VAPI Tool] Error:', err.message);
    res.json({ result: 'Error processing request. Please try again.' });
  }
});

// Keep old individual endpoints for backward compatibility
router.post('/:userId/check-availability', (req, res) => {
  const userId = parseInt(req.params.userId);
  const body = req.body;
  const msg = body.message || body;
  const toolCalls = msg.toolCallList || msg.tool_calls || [];
  const call = toolCalls[0];
  const args = call ? (typeof call.function?.arguments === 'string'
    ? JSON.parse(call.function.arguments)
    : (call.function?.arguments || {})) : body;
  handleCheckAvailability(userId, args, res, call?.id);
});

router.post('/:userId/book-appointment', (req, res) => {
  const userId = parseInt(req.params.userId);
  const body = req.body;
  const msg = body.message || body;
  const toolCalls = msg.toolCallList || msg.tool_calls || [];
  const call = toolCalls[0];
  const args = call ? (typeof call.function?.arguments === 'string'
    ? JSON.parse(call.function.arguments)
    : (call.function?.arguments || {})) : body;
  handleBookAppointment(userId, args, res, call?.id);
});

function handleCheckAvailability(userId, args, res, toolCallId) {
  try {
    const { date, time } = args;
    if (!date || !time) {
      return sendResult(res, toolCallId, 'Please provide both date and time.');
    }

    const existing = db.prepare(`
      SELECT id FROM appointments
      WHERE user_id = ? AND appointment_date = ? AND appointment_time = ?
      AND status != 'cancelled'
    `).get(userId, date, time);

    if (existing) {
      const booked = db.prepare(`
        SELECT appointment_time FROM appointments
        WHERE user_id = ? AND appointment_date = ? AND status != 'cancelled'
      `).all(userId, date).map(r => r.appointment_time);

      const available = generateSlots().filter(s => !booked.includes(s)).slice(0, 3).join(', ');
      return sendResult(res, toolCallId,
        `Slot ${time} on ${formatDate(date)} is already booked. Available slots: ${available || 'No slots available that day'}`
      );
    }

    return sendResult(res, toolCallId,
      `Slot ${time} on ${formatDate(date)} is available.`
    );
  } catch (err) {
    console.error('[checkAvailability] Error:', err.message);
    return sendResult(res, toolCallId, 'Error checking availability. Please try again.');
  }
}

function handleBookAppointment(userId, args, res, toolCallId) {
  try {
    const { date, time, customer_name, customer_phone, service_type } = args;
    if (!date || !time || !customer_name || !customer_phone) {
      return sendResult(res, toolCallId, 'Missing details. Need date, time, customer name and phone number.');
    }

    const existing = db.prepare(`
      SELECT id FROM appointments
      WHERE user_id = ? AND appointment_date = ? AND appointment_time = ?
      AND status != 'cancelled'
    `).get(userId, date, time);

    if (existing) {
      return sendResult(res, toolCallId,
        `Sorry, slot ${time} on ${date} just got booked. Please choose another time.`
      );
    }

    const result = db.prepare(`
      INSERT INTO appointments (user_id, customer_name, customer_phone, appointment_date, appointment_time, status, service_type, notes)
      VALUES (?, ?, ?, ?, ?, 'confirmed', ?, 'Booked via AI voice agent')
    `).run(userId, customer_name, customer_phone, date, time, service_type || 'Consultation');

    const bookingId = result.lastInsertRowid;
    console.log(`[bookAppointment] Saved booking #${bookingId} for user ${userId}`);

    return sendResult(res, toolCallId,
      `Booking confirmed! Reference #${bookingId}. ${customer_name} booked for ${service_type || 'Consultation'} on ${formatDate(date)} at ${time}.`
    );
  } catch (err) {
    console.error('[bookAppointment] Error:', err.message);
    return sendResult(res, toolCallId, 'Error saving booking. Please try again.');
  }
}

// Send result in correct format for both serverUrl and toolCall approaches
function sendResult(res, toolCallId, result) {
  if (toolCallId) {
    return res.json({ results: [{ toolCallId, result }] });
  }
  return res.json({ result });
}

function formatDate(dateStr) {
  try {
    return new Date(dateStr).toLocaleDateString('en-IN', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    });
  } catch (_) { return dateStr; }
}

function generateSlots() {
  const slots = [];
  for (let h = 9; h <= 18; h++) {
    slots.push(`${String(h).padStart(2,'0')}:00`);
    if (h < 18) slots.push(`${String(h).padStart(2,'0')}:30`);
  }
  return slots;
}

module.exports = router;
