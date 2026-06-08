const express = require('express');
const authMiddleware = require('../middleware/auth');
const { db } = require('../database/db');

const router = express.Router();
router.use(authMiddleware);

// ── Function Logs ─────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  try {
    const userId = req.user.role === 'admin'
      ? (req.query.user_id ? parseInt(req.query.user_id) : null)
      : req.user.userId;

    const limit  = Math.min(parseInt(req.query.limit) || 100, 500);
    const fn     = req.query.fn;     // filter by function name
    const status = req.query.status; // filter by status

    const conds  = [];
    const params = [];

    if (userId)  { conds.push('user_id = ?');      params.push(userId); }
    if (fn)      { conds.push('function_name = ?'); params.push(fn); }
    if (status)  { conds.push('status = ?');        params.push(status); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const logs = db.prepare(`SELECT * FROM function_logs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit);

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

// ── Webhook Logs ──────────────────────────────────────────────────────────────

router.get('/webhooks', (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 100, 500);
    const source = req.query.source;
    const type   = req.query.type;

    const conds  = [];
    const params = [];
    if (source) { conds.push('source = ?');     params.push(source); }
    if (type)   { conds.push('event_type = ?'); params.push(type); }

    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const logs = db.prepare(`SELECT * FROM webhook_logs ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit);

    res.json({ logs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/webhooks/clear', (req, res) => {
  try {
    db.prepare(`DELETE FROM webhook_logs`).run();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
