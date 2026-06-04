const jwt = require('jsonwebtoken');

module.exports = function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    // Also check cookie for browser-based requests
    const cookieToken = req.cookies && req.cookies.token;
    if (!cookieToken) {
      return res.status(401).json({ error: 'No token provided' });
    }
    try {
      req.user = jwt.verify(cookieToken, process.env.JWT_SECRET);
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};
