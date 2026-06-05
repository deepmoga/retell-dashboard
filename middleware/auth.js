const jwt = require('jsonwebtoken');

module.exports = function authMiddleware(req, res, next) {
  // 1. Authorization header (API calls)
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  // 2. Query param ?token=xxx (for audio/video elements in browser)
  if (!token && req.query.token) {
    token = req.query.token;
  }

  // 3. Cookie fallback
  if (!token) {
    const cookieToken = req.cookies && req.cookies.token;
    if (!cookieToken) {
      return res.status(401).json({ error: 'No token provided' });
    }
    token = cookieToken;
  }

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
};
