const express = require('express');
const twilio = require('twilio');
const { db } = require('../database/db');
const authMiddleware = require('../middleware/auth');
const readonlyBlock = require('../middleware/readonlyBlock');

const router = express.Router();

function getUserId(req) {
  return req.user.role === 'admin'
    ? (req.query.client_id ? parseInt(req.query.client_id) : req.user.userId)
    : req.user.userId;
}

function getVendorTwilio(userId) {
  return db.prepare('SELECT twilio_account_sid, twilio_auth_token, twilio_phone_number FROM users WHERE id=?').get(userId);
}

// ── Public endpoints for VAPI tools (no auth) ─────────────────────────────────

// getInsuranceTypes — agent calls this to know what types vendor has
router.get('/public/:userId/types', (req, res) => {
  try {
    const userId = parseInt(req.params.userId);
    const types = db.prepare(
      "SELECT id, label, type_key, description FROM insurance_types WHERE user_id=? AND is_active=1 ORDER BY label"
    ).all(userId);

    if (!types.length) {
      return res.json({ result: 'No insurance types configured for this vendor.' });
    }

    const list = types.map(t => `${t.type_key}: ${t.label}${t.description ? ' (' + t.description + ')' : ''}`).join(', ');
    res.json({
      types,
      result: `Available insurance types: ${list}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Phone number normalizer + validator ───────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return { phone: raw, error: null };
  // Strip spaces, dashes, dots, parentheses, zero-width chars
  let p = String(raw).replace(/[\s\-\(\)\.​ ]/g, '');
  // Keep only digits and leading +
  p = p.replace(/[^\d+]/g, '');
  // Ensure starts with +
  if (!p.startsWith('+')) p = '+' + p;

  // ── Common LLM mistakes ──
  // Double Indian country code: +9191XXXXXXXXXX → +91XXXXXXXXXX
  if (/^\+9191[6-9]\d{9}$/.test(p)) p = '+91' + p.slice(4);
  // +191XXXXXXXXXX → +91XXXXXXXXXX
  if (/^\+191[6-9]\d{9}$/.test(p)) p = '+91' + p.slice(3);
  // +XXXXXXXXXX (10 digits, no country code) → +91XXXXXXXXXX
  if (/^\+[6-9]\d{9}$/.test(p)) p = '+91' + p.slice(1);

  console.log(`[Insurance] Phone normalized: ${raw} → ${p}`);

  // ── Validate ──
  // Indian mobile: +91 + exactly 10 digits starting with 6/7/8/9
  if (p.startsWith('+91')) {
    const mobile = p.slice(3); // digits after +91
    if (mobile.length !== 10) {
      return {
        phone: p,
        error: `PHONE NUMBER INCORRECT: "${p}" has ${mobile.length} digits after +91 but Indian mobile numbers have exactly 10 digits. Please say: "I need to correct your phone number — could you please say it again, one digit at a time?"`
      };
    }
    if (!/^[6-9]/.test(mobile)) {
      return {
        phone: p,
        error: `PHONE NUMBER INCORRECT: Indian mobile numbers must start with 6, 7, 8, or 9. Please ask the customer to repeat their number.`
      };
    }
  }

  return { phone: p, error: null };
}

// sendInsuranceLink — agent calls this after collecting customer info
router.post('/public/:userId/send-link', async (req, res) => {
  const userId = parseInt(req.params.userId);
  const { customer_name, customer_email, insurance_type, call_id, notes } = req.body;
  const { phone: customer_phone, error: phoneError } = normalizePhone(req.body.customer_phone);

  try {
    if (!customer_phone || !insurance_type) {
      return res.json({ result: 'Missing customer_phone or insurance_type. Please collect these first.' });
    }
    // Reject if phone number has wrong digit count — agent must re-collect
    if (phoneError) {
      console.warn(`[Insurance] Phone validation failed: ${phoneError}`);
      return res.json({ result: phoneError });
    }

    // Look up insurance type
    const insType = db.prepare(
      "SELECT * FROM insurance_types WHERE user_id=? AND type_key=? AND is_active=1"
    ).get(userId, insurance_type);

    if (!insType) {
      // Try label match (case-insensitive fallback)
      const byLabel = db.prepare(
        "SELECT * FROM insurance_types WHERE user_id=? AND is_active=1 AND LOWER(label) LIKE ?"
      ).get(userId, `%${insurance_type.toLowerCase()}%`);

      if (!byLabel) {
        const available = db.prepare("SELECT label FROM insurance_types WHERE user_id=? AND is_active=1").all(userId).map(t => t.label).join(', ');
        return res.json({ result: `Insurance type "${insurance_type}" not found. Available types: ${available || 'none configured'}` });
      }

      return processAndSend(userId, byLabel, customer_name, customer_phone, customer_email, call_id, notes, res);
    }

    return processAndSend(userId, insType, customer_name, customer_phone, customer_email, call_id, notes, res);

  } catch (err) {
    console.error('[Insurance] send-link error:', err.message);
    res.json({ result: 'Error sending insurance link. Please try again.' });
  }
});

async function processAndSend(userId, insType, customer_name, customer_phone, customer_email, call_id, notes, res) {
  let smsStatus = 'pending';
  let smsError = '';

  // Send SMS via Twilio
  const vendor = getVendorTwilio(userId);
  if (vendor?.twilio_account_sid && vendor?.twilio_auth_token && vendor?.twilio_phone_number) {
    try {
      const client = twilio(vendor.twilio_account_sid, vendor.twilio_auth_token);
      const smsBody = `Hi ${customer_name || 'there'}! Here's your ${insType.label} form link: ${insType.form_url}\n\nQuestions? Call us back anytime.`;
      await client.messages.create({
        body: smsBody,
        from: vendor.twilio_phone_number,
        to: customer_phone,
      });
      smsStatus = 'sent';
      console.log(`[Insurance] SMS sent to ${customer_phone} for ${insType.label}`);
    } catch (err) {
      smsStatus = 'failed';
      smsError = err.message;
      console.error('[Insurance] SMS failed:', err.message);
    }
  } else {
    smsStatus = 'no_twilio';
  }

  // Save enquiry
  const result = db.prepare(`
    INSERT INTO insurance_enquiries (user_id, call_id, customer_name, customer_phone, customer_email,
      insurance_type, insurance_label, form_url, sms_status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, call_id || null, customer_name || '', customer_phone, customer_email || '',
    insType.type_key, insType.label, insType.form_url, smsStatus, notes || '');

  const enquiryId = result.lastInsertRowid;

  let responseMsg;
  if (smsStatus === 'sent') {
    responseMsg = `Done! I've sent the ${insType.label} form link to ${customer_phone} via SMS. Enquiry #${enquiryId} has been saved. Our team will follow up with ${customer_name || 'the customer'} soon.`;
  } else if (smsStatus === 'no_twilio') {
    responseMsg = `Enquiry #${enquiryId} saved for ${insType.label}. Note: SMS could not be sent as Twilio is not configured — please have the team follow up manually with ${customer_phone}.`;
  } else {
    responseMsg = `Enquiry #${enquiryId} saved for ${insType.label}. SMS delivery failed (${smsError}) — please follow up manually with ${customer_phone}.`;
  }

  return res.json({ result: responseMsg, enquiry_id: enquiryId, sms_status: smsStatus });
}

// ── Authenticated routes ───────────────────────────────────────────────────────

router.use(authMiddleware);

// Insurance Types CRUD
router.get('/types', (req, res) => {
  try {
    const userId = getUserId(req);
    const types = db.prepare('SELECT * FROM insurance_types WHERE user_id=? ORDER BY label').all(userId);
    res.json({ types });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/types', readonlyBlock, (req, res) => {
  try {
    const userId = getUserId(req);
    const { label, type_key, form_url, description } = req.body;
    if (!label || !type_key || !form_url) return res.status(400).json({ error: 'label, type_key, and form_url are required' });

    const key = type_key.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const result = db.prepare(
      'INSERT INTO insurance_types (user_id, label, type_key, form_url, description) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, label, key, form_url, description || '');
    res.json({ id: result.lastInsertRowid, message: 'Insurance type added' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/types/:id', readonlyBlock, (req, res) => {
  try {
    const userId = getUserId(req);
    const { label, type_key, form_url, description, is_active } = req.body;
    const existing = db.prepare('SELECT * FROM insurance_types WHERE id=? AND user_id=?').get(req.params.id, userId);
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const key = (type_key || existing.type_key).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    db.prepare(`UPDATE insurance_types SET label=@label, type_key=@key, form_url=@url, description=@desc, is_active=@active WHERE id=@id`)
      .run({ label: label ?? existing.label, key, url: form_url ?? existing.form_url, desc: description ?? existing.description, active: is_active ?? existing.is_active, id: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/types/:id', readonlyBlock, (req, res) => {
  try {
    const userId = getUserId(req);
    db.prepare('DELETE FROM insurance_types WHERE id=? AND user_id=?').run(req.params.id, userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Enquiries
router.get('/enquiries', (req, res) => {
  try {
    const userId = getUserId(req);
    const { from_date, to_date, type } = req.query;
    let sql = 'SELECT * FROM insurance_enquiries WHERE user_id=?';
    const params = [userId];
    if (type && type !== 'all') { sql += ' AND insurance_type=?'; params.push(type); }
    if (from_date) { sql += ' AND DATE(created_at)>=?'; params.push(from_date); }
    if (to_date)   { sql += ' AND DATE(created_at)<=?'; params.push(to_date); }
    sql += ' ORDER BY created_at DESC';
    const enquiries = db.prepare(sql).all(...params);
    res.json({ enquiries });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit enquiry — fix wrong phone/name/email saved by agent
router.put('/enquiries/:id', readonlyBlock, (req, res) => {
  try {
    const userId = getUserId(req);
    const { customer_name, customer_phone, customer_email } = req.body;
    const { phone: cleanPhone } = normalizePhone(customer_phone);
    db.prepare(
      'UPDATE insurance_enquiries SET customer_name=COALESCE(?,customer_name), customer_phone=COALESCE(?,customer_phone), customer_email=COALESCE(?,customer_email) WHERE id=? AND user_id=?'
    ).run(customer_name || null, cleanPhone || null, customer_email || null, req.params.id, userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/enquiries/:id', readonlyBlock, (req, res) => {
  try {
    const userId = getUserId(req);
    db.prepare('DELETE FROM insurance_enquiries WHERE id=? AND user_id=?').run(req.params.id, userId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
