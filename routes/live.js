const express = require('express');
const { callQueries } = require('../database/db');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

router.use(authMiddleware);

router.get('/calls', (req, res) => {
  try {
    const userId = req.user.role === 'admin'
      ? (req.query.client_id ? parseInt(req.query.client_id) : null)
      : req.user.userId;

    const calls = userId
      ? callQueries.getActiveCallsForUser.all(userId)
      : callQueries.getActiveCalls.all();

    const enriched = calls.map(call => ({
      ...call,
      elapsed_seconds: call.start_timestamp
        ? Math.round((Date.now() - call.start_timestamp) / 1000)
        : 0,
    }));

    res.json({ calls: enriched, count: enriched.length });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
