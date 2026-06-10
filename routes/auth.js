const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { userQueries } = require('../database/db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = userQueries.findByEmail.get(email.toLowerCase().trim());
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role, email: user.email, is_readonly: !!user.is_readonly },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        company_name: user.company_name,
        is_readonly: !!user.is_readonly,
      },
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out' });
});

router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = userQueries.findById.get(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update own profile + API keys — saves to DB directly
router.put('/profile', authMiddleware, async (req, res) => {
  try {
    const { name, company_name, retell_api_key, vapi_api_key, vapi_public_key, twilio_account_sid, twilio_auth_token, twilio_phone_number, timezone, current_password, new_password } = req.body;
    const { db } = require('../database/db');

    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Update API keys + profile info
    db.prepare(`
      UPDATE users SET
        name = COALESCE(@name, name),
        company_name = COALESCE(@company_name, company_name),
        retell_api_key = @retell_api_key,
        vapi_api_key = @vapi_api_key,
        vapi_public_key = @vapi_public_key,
        twilio_account_sid = @twilio_account_sid,
        twilio_auth_token = @twilio_auth_token,
        twilio_phone_number = @twilio_phone_number,
        timezone = @timezone
      WHERE id = @id
    `).run({
      name: name || user.name,
      company_name: company_name || user.company_name,
      retell_api_key: retell_api_key ?? user.retell_api_key ?? '',
      vapi_api_key: vapi_api_key ?? user.vapi_api_key ?? '',
      vapi_public_key: vapi_public_key || user.vapi_public_key || '',
      twilio_account_sid: twilio_account_sid ?? user.twilio_account_sid ?? '',
      twilio_auth_token: twilio_auth_token ?? user.twilio_auth_token ?? '',
      twilio_phone_number: twilio_phone_number || user.twilio_phone_number || '',
      timezone: timezone || user.timezone || 'Australia/Sydney',
      id: req.user.userId,
    });

    // Update password if provided
    if (new_password) {
      if (!current_password) return res.status(400).json({ error: 'Current password required' });
      const valid = await bcrypt.compare(current_password, user.password);
      if (!valid) return res.status(401).json({ error: 'Current password is wrong' });
      const hash = await bcrypt.hash(new_password, 10);
      userQueries.updatePassword.run(hash, req.user.userId);
    }

    res.json({ success: true, message: 'Profile saved successfully' });
  } catch (err) {
    console.error('[Profile] Update error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
