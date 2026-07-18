const crypto = require('crypto');

// Constant-time string comparison. Hashing both sides to a fixed-length digest
// first (rather than comparing raw buffers) avoids timingSafeEqual's length
// check ever short-circuiting, which would otherwise leak the token's length.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const hashA = crypto.createHash('sha256').update(a).digest();
  const hashB = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

// Fail-closed: DEBUG_TOKEN must be set AND match. An unset env var denies
// access rather than granting it — the opposite of the old per-endpoint checks.
//
// allowQuery defaults to true for endpoints meant for quick manual/browser-bar
// checks (debug-thread, test-credentials). Endpoints only ever called
// programmatically (conversation, settings, the sms-reply demo bypass) pass
// { allowQuery: false } so the token can't end up in a URL — and therefore in
// browser history, server access logs, or a Referer header.
function checkAdminToken(req, { allowQuery = true } = {}) {
  const expected = process.env.DEBUG_TOKEN;
  const provided = req.header('x-debug-token') || (allowQuery ? req.query.token : undefined);
  if (!expected || !provided) return false;
  return safeEqual(expected, String(provided));
}

function requireAdminToken(req, res, options) {
  if (!checkAdminToken(req, options)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

module.exports = { checkAdminToken, requireAdminToken };
