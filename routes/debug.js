// Comprehensive debug logging — captures ALL incoming VAPI events
const express = require('express');
const authMiddleware = require('../middleware/auth');
const { db } = require('../database/db');

const router = express.Router();

// Create debug_logs table
try {
  db.exec(`CREATE TABLE IF NOT EXISTS debug_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT,
    event_type TEXT,
    user_id INTEGER,
    call_id TEXT,
    payload TEXT,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
} catch(e) {}

// Save a debug log entry
function debugLog(source, eventType, userId, callId, payload, notes = '') {
  try {
    db.prepare(`INSERT INTO debug_logs (source, event_type, user_id, call_id, payload, notes)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      source,
      eventType,
      userId || null,
      callId || '',
      typeof payload === 'string' ? payload : JSON.stringify(payload),
      notes
    );
  } catch(e) { console.error('[DebugLog] Failed:', e.message); }
}

// GET /api/debug — view all logs
router.get('/', authMiddleware, (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const source = req.query.source || null;
    const logs = source
      ? db.prepare(`SELECT * FROM debug_logs WHERE source = ? ORDER BY created_at DESC LIMIT ?`).all(source, limit)
      : db.prepare(`SELECT * FROM debug_logs ORDER BY created_at DESC LIMIT ?`).all(limit);
    res.json({ logs });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/debug/clear
router.delete('/clear', authMiddleware, (req, res) => {
  try {
    db.prepare(`DELETE FROM debug_logs`).run();
    res.json({ success: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = { router, debugLog };
