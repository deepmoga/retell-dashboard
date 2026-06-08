const { db } = require('../database/db');

module.exports = function readonlyBlock(req, res, next) {
  if (req.user?.role === 'admin') return next();
  const user = db.prepare('SELECT is_readonly FROM users WHERE id=?').get(req.user?.userId);
  if (user?.is_readonly) {
    return res.status(403).json({ error: 'Read-only account — changes not allowed. Contact your account manager.' });
  }
  next();
};
