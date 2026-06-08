const express = require('express');
const authMiddleware = require('../middleware/auth');
const { db } = require('../database/db');

const router = express.Router();
router.use(authMiddleware);

function getUserId(req) {
  return req.user.role === 'admin'
    ? (req.query.client_id ? parseInt(req.query.client_id) : null)
    : req.user.userId;
}

function monthStart() {
  const d = new Date(); d.setDate(1); d.setHours(0,0,0,0); return d.getTime();
}

// ── GET /api/analytics/overview ─────────────────────────────────────────────
router.get('/overview', (req, res) => {
  try {
    const userId = getUserId(req);
    const uid    = userId;
    const base   = uid ? 'AND user_id=?' : '';
    const p      = uid ? [uid] : [];
    const ms     = monthStart();

    const totalCalls   = db.prepare(`SELECT COUNT(*) c FROM calls WHERE status='ended' AND start_timestamp>=? ${base}`).get(ms, ...p).c;
    const totalBookings= db.prepare(`SELECT COUNT(*) c FROM appointments WHERE status='confirmed' AND created_at >= datetime(${ms}/1000,'unixepoch') ${uid ? 'AND user_id=?' : ''}`).get(...(uid ? [uid] : [])).c;
    const convRate     = totalCalls > 0 ? ((totalBookings / totalCalls) * 100).toFixed(1) : '0.0';

    const avgDurRow    = db.prepare(`SELECT AVG(duration_seconds) v FROM calls WHERE status='ended' AND start_timestamp>=? ${base}`).get(ms, ...p);
    const avgDuration  = Math.round(avgDurRow?.v || 0);

    const prevMs       = ms - 30 * 86400000;
    const prevCalls    = db.prepare(`SELECT COUNT(*) c FROM calls WHERE status='ended' AND start_timestamp>=? AND start_timestamp<? ${base}`).get(prevMs, ms, ...p).c;
    const prevBookings = db.prepare(`SELECT COUNT(*) c FROM appointments WHERE status='confirmed' AND created_at >= datetime(${prevMs}/1000,'unixepoch') AND created_at < datetime(${ms}/1000,'unixepoch') ${uid ? 'AND user_id=?' : ''}`).get(...(uid ? [uid] : [])).c;
    const prevRate     = prevCalls > 0 ? ((prevBookings / prevCalls) * 100).toFixed(1) : '0.0';

    res.json({ totalCalls, totalBookings, convRate, avgDuration, prevCalls, prevBookings, prevRate });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/analytics/trend — last N days calls + bookings ─────────────────
router.get('/trend', (req, res) => {
  try {
    const userId = getUserId(req);
    const days   = parseInt(req.query.days) || 30;
    const base   = userId ? 'AND user_id=?' : '';
    const p      = userId ? [userId] : [];

    const trend = [];
    for (let i = days - 1; i >= 0; i--) {
      const d    = new Date(); d.setDate(d.getDate() - i); d.setHours(0,0,0,0);
      const dEnd = new Date(d); dEnd.setHours(23,59,59,999);
      const dateStr = d.toISOString().slice(0,10);

      const calls    = db.prepare(`SELECT COUNT(*) c FROM calls WHERE status='ended' AND start_timestamp>=? AND start_timestamp<=? ${base}`).get(d.getTime(), dEnd.getTime(), ...p).c;
      const bookings = db.prepare(`SELECT COUNT(*) c FROM appointments WHERE status='confirmed' AND date(created_at) = ? ${userId ? 'AND user_id=?' : ''}`).get(dateStr, ...(userId ? [userId] : [])).c;
      trend.push({ date: dateStr, calls, bookings });
    }
    res.json({ trend });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/analytics/by-agent ─────────────────────────────────────────────
router.get('/by-agent', (req, res) => {
  try {
    const userId = getUserId(req);
    const base   = userId ? 'AND user_id=?' : '';
    const p      = userId ? [userId] : [];
    const ms     = monthStart();

    const agents = db.prepare(`
      SELECT agent_name,
        COUNT(*) as total_calls,
        AVG(duration_seconds) as avg_duration,
        SUM(CASE WHEN duration_seconds > 30 THEN 1 ELSE 0 END) as answered
      FROM calls WHERE status='ended' AND start_timestamp>=? ${base}
      GROUP BY agent_name ORDER BY total_calls DESC
    `).all(ms, ...p);

    res.json({ agents });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/analytics/by-hour ───────────────────────────────────────────────
router.get('/by-hour', (req, res) => {
  try {
    const userId = getUserId(req);
    const base   = userId ? 'AND user_id=?' : '';
    const p      = userId ? [userId] : [];
    const ms     = monthStart();

    const rows = db.prepare(`
      SELECT CAST(strftime('%H', datetime(start_timestamp/1000,'unixepoch')) AS INTEGER) as hour,
        COUNT(*) as calls,
        AVG(duration_seconds) as avg_dur
      FROM calls WHERE status='ended' AND start_timestamp>=? ${base}
      GROUP BY hour ORDER BY hour
    `).all(ms, ...p);

    // Fill all 24 hours
    const byHour = Array.from({length:24}, (_,h) => {
      const r = rows.find(x => x.hour === h);
      return { hour: h, calls: r?.calls || 0, avg_dur: Math.round(r?.avg_dur || 0) };
    });
    res.json({ byHour });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/analytics/by-day ────────────────────────────────────────────────
router.get('/by-day', (req, res) => {
  try {
    const userId = getUserId(req);
    const base   = userId ? 'AND user_id=?' : '';
    const p      = userId ? [userId] : [];
    const ms     = monthStart();

    const rows = db.prepare(`
      SELECT CAST(strftime('%w', datetime(start_timestamp/1000,'unixepoch')) AS INTEGER) as dow,
        COUNT(*) as calls
      FROM calls WHERE status='ended' AND start_timestamp>=? ${base}
      GROUP BY dow ORDER BY dow
    `).all(ms, ...p);

    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const byDay = days.map((name, i) => {
      const r = rows.find(x => x.dow === i);
      return { day: name, calls: r?.calls || 0 };
    });
    res.json({ byDay });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
