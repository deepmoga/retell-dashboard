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
      { userId: user.id, role: user.role, email: user.email },
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

module.exports = router;
