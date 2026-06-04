const express = require('express');
const path = require('path');
const { callQueries, buildCallsQuery } = require('../database/db');
const { syncAllCalls } = require('../services/sync');
const authMiddleware = require('../middleware/auth');

const router = express.Router();

// All call routes require auth
router.use(authMiddleware);

router.get('/', (req, res) => {
  try {
    const userId = req.user.role === 'admin'
      ? (req.query.client_id ? parseInt(req.query.client_id) : null)
      : req.user.userId;

    const result = buildCallsQuery(userId, {
      page: req.query.page,
      limit: req.query.limit,
      type: req.query.type,
      status: req.query.status,
      from_date: req.query.from_date,
      to_date: req.query.to_date,
      search: req.query.search,
    });

    res.json({
      calls: result.rows,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        pages: Math.ceil(result.total / result.limit),
      },
    });
  } catch (err) {
    console.error('[Calls] List error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', (req, res) => {
  try {
    const call = callQueries.findById.get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });

    if (req.user.role !== 'admin' && call.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({ call });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id/recording', (req, res) => {
  try {
    const call = callQueries.findById.get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });

    if (req.user.role !== 'admin' && call.user_id !== req.user.userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (call.recording_local_path) {
      return res.sendFile(path.join(__dirname, '../public', call.recording_local_path));
    }
    if (call.recording_url) {
      return res.redirect(call.recording_url);
    }
    res.status(404).json({ error: 'Recording not available' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/:id/outcome', (req, res) => {
  try {
    const { outcome } = req.body;
    const valid = ['qualified', 'not_interested', 'callback', 'no_answer', null, ''];
    if (!valid.includes(outcome)) {
      return res.status(400).json({ error: 'Invalid outcome' });
    }

    const userId = req.user.role === 'admin' ? null : req.user.userId;
    const call = callQueries.findById.get(req.params.id);
    if (!call) return res.status(404).json({ error: 'Call not found' });

    if (userId && call.user_id !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    callQueries.updateOutcome.run(outcome || null, req.params.id, call.user_id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/sync', async (req, res) => {
  try {
    syncAllCalls().catch(err => console.error('[Calls] Manual sync error:', err.message));
    res.json({ message: 'Sync started' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
