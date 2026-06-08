const express = require('express');
const authMiddleware = require('../middleware/auth');
const { getAuthUrl, handleCallback, disconnect, isConnected } = require('../services/google-calendar');

const router = express.Router();

// GET /api/google-auth/status — check if connected
router.get('/status', authMiddleware, (req, res) => {
  res.json({ connected: isConnected(req.user.userId) });
});

// GET /api/google-auth/connect — redirect to Google OAuth
router.get('/connect', authMiddleware, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(400).json({ error: 'Google credentials not configured on server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env' });
  }
  const url = getAuthUrl(req.user.userId);
  res.redirect(url);
});

// GET /api/google-auth/callback — Google redirects here
router.get('/callback', async (req, res) => {
  const { code, state: userId, error } = req.query;

  if (error) {
    return res.redirect('/settings?gcal=error&msg=' + encodeURIComponent(error));
  }
  if (!code || !userId) {
    return res.redirect('/settings?gcal=error&msg=missing_params');
  }

  try {
    await handleCallback(code, parseInt(userId));
    res.redirect('/settings?gcal=connected');
  } catch (err) {
    console.error('[GCal Auth]', err.message);
    res.redirect('/settings?gcal=error&msg=' + encodeURIComponent(err.message));
  }
});

// DELETE /api/google-auth/disconnect
router.delete('/disconnect', authMiddleware, (req, res) => {
  disconnect(req.user.userId);
  res.json({ success: true });
});

module.exports = router;
