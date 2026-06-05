const express = require('express');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const { leadQueries, userQueries } = require('../database/db');
const { createOutboundCall: retellOutboundCall, listAgents: retellListAgents, listPhoneNumbers: retellListNumbers } = require('../services/retell');
const { createOutboundCall: vapiOutboundCall, listAssistants: vapiListAssistants, listPhoneNumbers: vapiListNumbers } = require('../services/vapi');
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

    // Detect provider from agent_id prefix or request body
    const provider = req.body.provider || (agent_id.includes('-') && agent_id.length === 36 ? 'vapi' : 'retell');
    let result;

    if (provider === 'vapi' && actualUser.vapi_api_key) {
      result = await vapiOutboundCall(
        actualUser.vapi_api_key,
        from_number,   // phoneNumberId for VAPI
        lead.phone,
        agent_id,
        { lead_name: lead.name || '', lead_city: lead.city || '' }
      );
    } else {
      result = await retellOutboundCall(
        actualUser.retell_api_key,
        from_number,
        lead.phone,
        agent_id,
        { lead_name: lead.name || '', lead_city: lead.city || '' }
      );
    }

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
    let agents = [];

    // Retell agents
    if (user?.retell_api_key) {
      const ra = await retellListAgents(user.retell_api_key).catch(() => []);
      const retellAgents = (Array.isArray(ra) ? ra : []).map(a => ({
        id: a.agent_id, name: a.agent_name, provider: 'retell',
      }));
      agents = agents.concat(retellAgents);
    }

    // VAPI assistants
    if (user?.vapi_api_key) {
      const va = await vapiListAssistants(user.vapi_api_key).catch(() => []);
      const vapiAgents = (Array.isArray(va) ? va : []).map(a => ({
        id: a.id, name: a.name || 'VAPI Assistant', provider: 'vapi',
      }));
      agents = agents.concat(vapiAgents);
    }

    res.json({ agents });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

router.get('/phone-numbers', async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = require('../database/db').db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    let numbers = [];

    // Retell numbers
    if (user?.retell_api_key) {
      const rn = await retellListNumbers(user.retell_api_key).catch(() => []);
      const retellNums = (Array.isArray(rn) ? rn : []).map(n => ({
        number: n.phone_number, nickname: n.nickname || '', provider: 'retell', id: n.phone_number,
      }));
      numbers = numbers.concat(retellNums);
    }

    // VAPI numbers
    if (user?.vapi_api_key) {
      const vn = await vapiListNumbers(user.vapi_api_key).catch(() => []);
      const vapiNums = (Array.isArray(vn) ? vn : []).map(n => ({
        number: n.number, nickname: n.name || '', provider: 'vapi', id: n.id,
      }));
      numbers = numbers.concat(vapiNums);
    }

    res.json({ phone_numbers: numbers });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch phone numbers' });
  }
});

module.exports = router;
