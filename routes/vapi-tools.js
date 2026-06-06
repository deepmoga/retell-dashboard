// VAPI Tool Webhook Handler
// VAPI calls these endpoints when agent needs to check/book appointments
const express = require('express');
const { db } = require('../database/db');

const router = express.Router();

// Helper: parse VAPI tool call request
function parseToolCall(body) {
  console.log('[VAPI Tool] Incoming body:', JSON.stringify(body).slice(0, 500));
  const msg = body.message || body;
  const toolCalls = msg.toolCallList || msg.tool_calls || [];
  console.log('[VAPI Tool] Parsed toolCalls:', toolCalls.length);
  return toolCalls;
}

// Helper: build VAPI tool result response
function toolResult(toolCallId, result) {
  return {
    results: [{ toolCallId, result: String(result) }]
  };
}

// POST /api/vapi-tools/:userId/check-availability
router.post('/:userId/check-availability', (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const toolCalls = parseToolCall(req.body);
    const call = toolCalls[0];
    if (!call) return res.json({ results: [] });

    const args = typeof call.function?.arguments === 'string'
      ? JSON.parse(call.function.arguments)
      : (call.function?.arguments || {});

    const { date, time } = args;
    if (!date || !time) {
      return res.json(toolResult(call.id, 'Please provide both date and time.'));
    }

    // Check if slot is already booked
    const existing = db.prepare(`
      SELECT id FROM appointments
      WHERE user_id = ? AND appointment_date = ? AND appointment_time = ?
      AND status != 'cancelled'
    `).get(userId, date, time);

    if (existing) {
      // Find next available slots
      const booked = db.prepare(`
        SELECT appointment_time FROM appointments
        WHERE user_id = ? AND appointment_date = ? AND status != 'cancelled'
      `).all(userId, date).map(r => r.appointment_time);

      const allSlots = generateSlots();
      const available = allSlots.filter(s => !booked.includes(s));
      const suggestions = available.slice(0, 3).join(', ');

      return res.json(toolResult(call.id,
        `Slot ${time} on ${date} is already booked. Available slots: ${suggestions || 'No slots available that day'}`
      ));
    }

    return res.json(toolResult(call.id,
      `Slot ${time} on ${formatDate(date)} is available. Please confirm customer name and phone number.`
    ));
  } catch (err) {
    console.error('[VAPI Tool] check-availability error:', err);
    res.json(toolResult('unknown', 'Error checking availability. Please try again.'));
  }
});

// POST /api/vapi-tools/:userId/book-appointment
router.post('/:userId/book-appointment', (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const toolCalls = parseToolCall(req.body);
    const call = toolCalls[0];
    if (!call) return res.json({ results: [] });

    const args = typeof call.function?.arguments === 'string'
      ? JSON.parse(call.function.arguments)
      : (call.function?.arguments || {});

    const { date, time, customer_name, customer_phone, service_type } = args;
    if (!date || !time || !customer_name || !customer_phone) {
      return res.json(toolResult(call.id, 'Missing details. Need date, time, customer name and phone number.'));
    }

    // Double-check slot availability
    const existing = db.prepare(`
      SELECT id FROM appointments
      WHERE user_id = ? AND appointment_date = ? AND appointment_time = ?
      AND status != 'cancelled'
    `).get(userId, date, time);

    if (existing) {
      return res.json(toolResult(call.id,
        `Sorry, slot ${time} on ${date} just got booked. Please choose another time.`
      ));
    }

    // Save booking
    const result = db.prepare(`
      INSERT INTO appointments (user_id, customer_name, customer_phone, appointment_date, appointment_time, status, service_type, notes)
      VALUES (?, ?, ?, ?, ?, 'confirmed', ?, 'Booked via AI voice agent')
    `).run(userId, customer_name, customer_phone, date, time, service_type || 'FREE Consultation');

    const bookingId = result.lastInsertRowid;

    return res.json(toolResult(call.id,
      `Booking confirmed! Reference #${bookingId}. ${customer_name} is booked for ${service_type || 'FREE Consultation'} on ${formatDate(date)} at ${time}. We will send a confirmation.`
    ));
  } catch (err) {
    console.error('[VAPI Tool] book-appointment error:', err);
    res.json(toolResult('unknown', 'Error saving booking. Please try again.'));
  }
});

function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
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
