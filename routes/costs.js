const express = require('express');
const { getMonthlySummary, getDailyCosts, getCostByClient } = require('../database/db');
const authMiddleware = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');

const router = express.Router();

router.use(authMiddleware);

router.get('/summary', (req, res) => {
  try {
    const userId = req.user.role === 'admin'
      ? (req.query.client_id ? parseInt(req.query.client_id) : null)
      : req.user.userId;
    const summary = getMonthlySummary(userId);
    res.json({ summary: summary || { total_calls: 0, total_minutes: 0, retell_cost: 0, twilio_cost: 0, llm_cost: 0, total_cost: 0 } });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/daily', (req, res) => {
  try {
    const userId = req.user.role === 'admin'
      ? (req.query.client_id ? parseInt(req.query.client_id) : null)
      : req.user.userId;
    const days = parseInt(req.query.days) || 30;
    const daily = getDailyCosts(userId, days);
    res.json({ daily });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/by-client', adminOnly, (req, res) => {
  try {
    const byClient = getCostByClient();
    res.json({ clients: byClient });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
