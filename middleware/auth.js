// middleware/auth.js
// Server-side session is the ONLY authentication authority.
// Frontend hiding a menu is UX only; every protected route re-checks here.

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.accepts('html')) {
    return res.redirect('/login.html');
  }
  return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Login required.' });
}

function requireApiAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Login required.' });
}

module.exports = { requireAuth, requireApiAuth };
