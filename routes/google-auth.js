const express = require('express');
const { getAuthUrl, getTokensFromCode, listCalendars } = require('../services/google-calendar');
const authMiddleware = require('../middleware/auth');
const { db, userQueries } = require('../database/db');

const router = express.Router();

// Start OAuth — redirect to Google
router.get('/connect', authMiddleware, (req, res) => {
  try {
    const url = getAuthUrl(req.user.userId);
    res.redirect(url);
  } catch (err) {
    res.status(500).send('Google Calendar not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env');
  }
});

// OAuth callback — Google redirects here
router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.redirect('/settings?gcal=error');

    const userId = parseInt(state);
    const tokens = await getTokensFromCode(code);

    db.prepare(`UPDATE users SET google_access_token=?, google_refresh_token=? WHERE id=?`)
      .run(tokens.access_token, tokens.refresh_token || '', userId);

    res.redirect('/settings?gcal=success');
  } catch (err) {
    console.error('[Google Auth] callback error:', err.message);
    res.redirect('/settings?gcal=error');
  }
});

// Disconnect
router.post('/disconnect', authMiddleware, (req, res) => {
  try {
    db.prepare(`UPDATE users SET google_access_token=NULL, google_refresh_token=NULL WHERE id=?`)
      .run(req.user.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get status + calendars
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const user = userQueries.findById.get(req.user.userId);
    if (!user?.google_access_token) {
      return res.json({ connected: false });
    }
    const calendars = await listCalendars(user.google_access_token, user.google_refresh_token);
    res.json({
      connected: true,
      calendar_id: user.google_calendar_id || 'primary',
      calendars: calendars.map(c => ({ id: c.id, name: c.summary })),
    });
  } catch (err) {
    res.json({ connected: false, error: err.message });
  }
});

// Save selected calendar
router.post('/calendar', authMiddleware, (req, res) => {
  try {
    const { calendar_id } = req.body;
    db.prepare(`UPDATE users SET google_calendar_id=? WHERE id=?`).run(calendar_id, req.user.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
