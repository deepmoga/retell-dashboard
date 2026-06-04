const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const { leadQueries, userQueries } = require('../database/db');
const { createOutboundCall, listAgents, listPhoneNumbers } = require('../services/retell');
const authMiddleware = require('../middleware/auth');

const router = express.Router();
const upload = multer({ dest: 'uploads/' });

router.use(authMiddleware);

function formatPhone(phone) {
  if (!phone) return null;
  let p = phone.toString().replace(/\D/g, '');
  if (p.startsWith('0') && p.length === 10) p = '61' + p.slice(1);
  if (!p.startsWith('61') && p.length === 9) p = '61' + p;
  return '+' + p;
}

router.get('/', (req, res) => {
  try {
    const userId = req.user.role === 'admin'
      ? (req.query.client_id ? parseInt(req.query.client_id) : null)
      : req.user.userId;
    const leads = leadQueries.findAll(userId, req.query.status);
    res.json({ leads });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', (req, res) => {
  try {
    const userId = req.user.role === 'admin' && req.body.user_id
      ? parseInt(req.body.user_id)
      : req.user.userId;
    const { name, phone, email, city, notes } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    const formatted = formatPhone(phone);
    if (!formatted) return res.status(400).json({ error: 'Invalid phone number' });

    const result = leadQueries.create.run({ user_id: userId, name: name || '', phone: formatted, email: email || '', city: city || '', notes: notes || '' });
    res.json({ id: result.lastInsertRowid, message: 'Lead created' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const userId = req.user.role === 'admin' && req.body.user_id
      ? parseInt(req.body.user_id)
      : req.user.userId;

    const content = fs.readFileSync(req.file.path, 'utf8');
    const records = parse(content, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    fs.unlinkSync(req.file.path);

    let imported = 0;
    let skipped = 0;
    const errors = [];

    for (const row of records) {
      // Case-insensitive header matching
      const normalized = {};
      for (const key of Object.keys(row)) {
        normalized[key.toLowerCase().replace(/\s+/g, '_')] = row[key];
      }

      const phone = normalized.phone || normalized.phone_number || normalized.mobile || normalized.number;
      if (!phone) { skipped++; continue; }

      const formatted = formatPhone(phone);
      if (!formatted) { skipped++; errors.push(`Invalid phone: ${phone}`); continue; }

      try {
        leadQueries.create.run({
          user_id: userId,
          name: normalized.name || normalized.full_name || '',
          phone: formatted,
          email: normalized.email || normalized.email_address || '',
          city: normalized.city || normalized.suburb || normalized.location || '',
          notes: normalized.notes || normalized.note || normalized.comments || '',
        });
        imported++;
      } catch {
        skipped++;
      }
    }

    res.json({ imported, skipped, errors: errors.slice(0, 10), message: `Imported ${imported} leads` });
  } catch (err) {
    console.error('[Leads] CSV upload error:', err.message);
    res.status(500).json({ error: 'Failed to process CSV: ' + err.message });
  }
});

router.put('/:id', (req, res) => {
  try {
    const userId = req.user.role === 'admin' ? null : req.user.userId;
    const lead = leadQueries.findById.get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (userId && lead.user_id !== userId) return res.status(403).json({ error: 'Access denied' });

    const { name, phone, email, city, notes, status } = req.body;
    const formatted = phone ? formatPhone(phone) : lead.phone;
    leadQueries.update.run({
      name: name ?? lead.name,
      phone: formatted || lead.phone,
      email: email ?? lead.email,
      city: city ?? lead.city,
      notes: notes ?? lead.notes,
      status: status ?? lead.status,
      id: lead.id,
      user_id: lead.user_id,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const userId = req.user.role === 'admin' ? null : req.user.userId;
    const lead = leadQueries.findById.get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (userId && lead.user_id !== userId) return res.status(403).json({ error: 'Access denied' });
    leadQueries.delete.run(lead.id, lead.user_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/:id/call', async (req, res) => {
  try {
    const lead = leadQueries.findById.get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const userId = lead.user_id;
    if (req.user.role !== 'admin' && userId !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const user = userQueries.findByEmail.get(
      require('../database/db').db.prepare('SELECT email FROM users WHERE id=?').get(userId)?.email
    );
    const actualUser = require('../database/db').db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!actualUser?.retell_api_key) {
      return res.status(400).json({ error: 'No Retell API key configured for this account' });
    }

    const { agent_id, from_number } = req.body;
    if (!agent_id || !from_number) {
      return res.status(400).json({ error: 'agent_id and from_number required' });
    }

    const result = await createOutboundCall(
      actualUser.retell_api_key,
      from_number,
      lead.phone,
      agent_id,
      { lead_name: lead.name || '', lead_city: lead.city || '' }
    );

    leadQueries.updateStatus.run('called', new Date().toISOString(), lead.id);
    res.json({ success: true, call_id: result.call_id });
  } catch (err) {
    console.error('[Leads] Call error:', err.message);
    res.status(500).json({ error: err.response?.data?.message || err.message });
  }
});

router.post('/bulk-call', async (req, res) => {
  try {
    const { lead_ids, agent_id, from_number } = req.body;
    if (!lead_ids?.length || !agent_id || !from_number) {
      return res.status(400).json({ error: 'lead_ids, agent_id, and from_number required' });
    }

    const userId = req.user.userId;
    const actualUser = require('../database/db').db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!actualUser?.retell_api_key) {
      return res.status(400).json({ error: 'No Retell API key configured' });
    }

    const results = { success: 0, failed: 0, errors: [] };
    for (const leadId of lead_ids) {
      try {
        const lead = leadQueries.findById.get(leadId);
        if (!lead) { results.failed++; continue; }
        if (req.user.role !== 'admin' && lead.user_id !== userId) { results.failed++; continue; }

        await createOutboundCall(actualUser.retell_api_key, from_number, lead.phone, agent_id, { lead_name: lead.name || '' });
        leadQueries.updateStatus.run('called', new Date().toISOString(), lead.id);
        results.success++;
        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
      } catch (err) {
        results.failed++;
        results.errors.push(`Lead ${leadId}: ${err.message}`);
      }
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/agents', async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = require('../database/db').db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!user?.retell_api_key) return res.json({ agents: [] });
    const agents = await listAgents(user.retell_api_key);
    res.json({ agents: Array.isArray(agents) ? agents : [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

router.get('/phone-numbers', async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = require('../database/db').db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!user?.retell_api_key) return res.json({ phone_numbers: [] });
    const numbers = await listPhoneNumbers(user.retell_api_key);
    res.json({ phone_numbers: Array.isArray(numbers) ? numbers : [] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch phone numbers' });
  }
});

module.exports = router;
