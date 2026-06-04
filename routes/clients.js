const express = require('express');
const bcrypt = require('bcryptjs');
const { userQueries, db } = require('../database/db');
const authMiddleware = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');

const router = express.Router();

router.use(authMiddleware, adminOnly);

router.get('/', (req, res) => {
  try {
    const clients = userQueries.findAll.all().filter(u => u.role === 'client');
    res.json({ clients });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/all', (req, res) => {
  try {
    const users = userQueries.findAll.all();
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, email, password, company_name, retell_api_key, twilio_account_sid, twilio_auth_token } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password required' });
    }

    const hash = await bcrypt.hash(password, 10);
    const result = userQueries.create.run({
      name,
      email: email.toLowerCase().trim(),
      password: hash,
      role: 'client',
      company_name: company_name || '',
      retell_api_key: retell_api_key || '',
      twilio_account_sid: twilio_account_sid || '',
      twilio_auth_token: twilio_auth_token || '',
    });

    res.json({ id: result.lastInsertRowid, message: 'Client created' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { name, company_name, retell_api_key, twilio_account_sid, twilio_auth_token, password } = req.body;
    const user = userQueries.findById.get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Client not found' });

    userQueries.update.run({
      name: name || user.name,
      company_name: company_name ?? user.company_name,
      retell_api_key: retell_api_key ?? '',
      twilio_account_sid: twilio_account_sid ?? '',
      twilio_auth_token: twilio_auth_token ?? '',
      id: req.params.id,
    });

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      userQueries.updatePassword.run(hash, req.params.id);
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const user = userQueries.findById.get(req.params.id);
    if (!user) return res.status(404).json({ error: 'Client not found' });
    if (user.role === 'admin') return res.status(400).json({ error: 'Cannot delete admin' });
    userQueries.delete.run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
