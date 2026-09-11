// ─────────────────────────────────────────────────────────
// LOCAL-ONLY AUTH (no Firebase, no email whitelist).
// The app runs 100% on localhost and is single-user by design:
// every authenticated request maps to the shared master workspace ID.
// ─────────────────────────────────────────────────────────

const SHARED_ADMIN_ID = process.env.SHARED_ADMIN_ID || 'nikhil_master_workspace';

async function requireAuth(req, res, next) {
  // Frontend still sends "Authorization: Bearer <token>"; we accept anything
  // (or even nothing) and bind the request to the single local workspace.
  req.userId = SHARED_ADMIN_ID;
  req.userEmail = 'local@localhost';
  next();
}

module.exports = { requireAuth };