/* =========================================================================
   Project Clarity — endpoint auth for the planner API

   Who may call /api/mcp and /api/backup. Two rules:

   1. The secret travels in a header, not a query string.
      `Authorization: Bearer <token>` is the supported way in, and the way
      Agent Board already sends it. A secret in ?k= lands in server logs,
      browser history and referrer headers — that is exactly how the old
      token leaked, so query-string auth is now legacy: still accepted
      while the Claude connector URL is updated, refused the moment
      PLANNER_MCP_ALLOW_QUERY_TOKEN is set to "false".

   2. More than one token is valid at a time.
      Rotation is: add the new secret alongside the old, deploy, move the
      callers over (Agent Board's PLANNER_MCP_TOKEN in Railway, the Claude
      connector), then drop the old one and deploy again. A hard swap would
      silently break Reid's planner tools mid-flight.

   Tokens come from the environment, never from the repository:

     PLANNER_MCP_TOKEN            the current secret
     PLANNER_MCP_TOKEN_PREVIOUS   the outgoing secret, during a rotation
     PLANNER_MCP_ALLOW_LEGACY     "false" retires the hard-coded token below
     PLANNER_MCP_ALLOW_QUERY_TOKEN "false" refuses ?k= entirely

   LEGACY_TOKEN is the pre-rotation secret, kept only so the deploy that
   introduces this file cannot lock anything out. Step (d) of the rotation
   deletes the constant.
   ========================================================================= */

const crypto = require('crypto');

const LEGACY_TOKEN = 'vpm-cal-7f3a9c2e5b18d4';

function envToken(name) {
  const v = process.env[name];
  return v && String(v).trim() ? String(v).trim() : '';
}
function acceptedTokens() {
  const out = [];
  [envToken('PLANNER_MCP_TOKEN'), envToken('PLANNER_MCP_TOKEN_PREVIOUS')].forEach((t) => { if (t) out.push(t); });
  if (process.env.PLANNER_MCP_ALLOW_LEGACY !== 'false') out.push(LEGACY_TOKEN);
  return out;
}
function allowQueryToken() {
  return process.env.PLANNER_MCP_ALLOW_QUERY_TOKEN !== 'false';
}

// Constant-time compare, so a wrong token cannot be found a byte at a time.
function sameToken(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (!x.length || x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/* Where the caller put its secret, and whether it is one we accept.
   Returns { ok, via: 'header' | 'query' | null, reason }. Never returns,
   logs or echoes the token itself. */
function authenticate(req) {
  const headers = (req && req.headers) || {};
  const header = String(headers.authorization || headers.Authorization || '').replace(/^Bearer\s+/i, '').trim();
  const query = String((req && req.query && (req.query.k || req.query.token)) || '').trim();
  const accepted = acceptedTokens();

  if (header) {
    if (accepted.some((t) => sameToken(header, t))) return { ok: true, via: 'header' };
    return { ok: false, via: 'header', reason: 'Unauthorized — bad token' };
  }
  if (query) {
    if (!allowQueryToken()) {
      return { ok: false, via: 'query', reason: 'Unauthorized — pass the token as "Authorization: Bearer <token>". Query-string tokens are no longer accepted.' };
    }
    if (accepted.some((t) => sameToken(query, t))) return { ok: true, via: 'query' };
    return { ok: false, via: 'query', reason: 'Unauthorized — bad token' };
  }
  return { ok: false, via: null, reason: 'Unauthorized — missing token. Send "Authorization: Bearer <token>".' };
}

module.exports = { authenticate, acceptedTokens, allowQueryToken, sameToken, LEGACY_TOKEN };
