const express = require('express');
const authMiddleware = require('../middleware/auth');
const { db } = require('../database/db');

const router = express.Router();
router.use(authMiddleware);

router.get('/', (req, res) => {
  try {
    const userId = req.user.role === 'admin'
      ? (req.query.user_id ? parseInt(req.query.user_id) : null)
      : req.user.userId;

    const limit = parseInt(req.query.limit) || 50;

    let logs;
    if (userId) {
      logs = db.prepare(`SELECT * FROM function_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).all(userId, limit);
    } else {
      logs = db.prepare(`SELECT * FROM function_logs ORDER BY created_at DESC LIMIT ?`).all(limit);
    }
    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/clear', (req, res) => {
  try {
    const userId = req.user.role === 'admin' ? null : req.user.userId;
    if (userId) {
      db.prepare(`DELETE FROM function_logs WHERE user_id = ?`).run(userId);
    } else {
      db.prepare(`DELETE FROM function_logs`).run();
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
