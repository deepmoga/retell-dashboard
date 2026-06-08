const express = require('express');
const authMiddleware = require('../middleware/auth');
const adminOnly = require('../middleware/adminOnly');
const { planQueries, getPlanUsage, userQueries } = require('../database/db');

const router = express.Router();
router.use(authMiddleware);

// GET /api/plans — list all plans (any authenticated user)
router.get('/', (req, res) => {
  try {
    res.json({ plans: planQueries.findAll.all() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/plans/usage — current user's plan usage
router.get('/usage', (req, res) => {
  try {
    const userId = req.user.userId;
    res.json(getPlanUsage(userId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin only below
router.use(adminOnly);

// POST /api/plans — create plan
router.post('/', (req, res) => {
  try {
    const { name, call_limit, price_aud, overage_rate, features } = req.body;
    if (!name || !call_limit) return res.status(400).json({ error: 'name and call_limit required' });
    const result = planQueries.create.run({ name, call_limit: parseInt(call_limit), price_aud: parseFloat(price_aud) || 0, overage_rate: parseFloat(overage_rate) || 0.50, features: features || '' });
    res.json({ id: result.lastInsertRowid, message: 'Plan created' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/plans/:id — update plan
router.put('/:id', (req, res) => {
  try {
    const { name, call_limit, price_aud, overage_rate, features } = req.body;
    planQueries.update.run({ name, call_limit: parseInt(call_limit), price_aud: parseFloat(price_aud) || 0, overage_rate: parseFloat(overage_rate) || 0.50, features: features || '', id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/plans/:id — delete plan
router.delete('/:id', (req, res) => {
  try {
    planQueries.delete.run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/plans/assign/:userId — assign plan to client
router.put('/assign/:userId', (req, res) => {
  try {
    const { plan_id } = req.body;
    const user = userQueries.findById.get(req.params.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });
    planQueries.assignToUser.run(plan_id || null, req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/plans/usage/:userId — admin view client usage
router.get('/usage/:userId', (req, res) => {
  try {
    res.json(getPlanUsage(parseInt(req.params.userId)));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
