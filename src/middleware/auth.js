// ─────────────────────────────────────────────────────────
// USER & EMAIL-BASED MULTI-TENANT AUTH MIDDLEWARE
//
// Every user has their own isolated workspace partition based on their email.
// In Firestore / Data Store:
//   users/{userId}/sessions/...
//   users/{userId}/hackathons/...
//   users/{userId}/facts/...
//
// If the client sends an 'x-user-email' header or an email Bearer token,
// we compute a safe, clean, deterministic userId (e.g. 'nikhil_gmail_com').
// If Firebase Auth ID token is provided and Firebase Admin is live, it verifies
// the cryptographic token and extracts user.email & user.uid.
// ─────────────────────────────────────────────────────────

const crypto = require('crypto');
const { firebaseAdmin } = require('../config/firebase');

function sanitizeEmailToUserId(email) {
  if (!email || typeof email !== 'string') return null;
  const clean = email.toLowerCase().trim();
  // Safe document ID format: 'john_doe_example_com'
  const safeId = clean.replace(/[^a-z0-9]/g, '_').slice(0, 64);
  return safeId || null;
}

async function requireAuth(req, res, next) {
  let userEmail = null;
  let userId = null;

  // 1. Check explicit client email headers
  const headerEmail = req.headers['x-user-email'] || req.headers['x-student-email'];
  if (headerEmail && typeof headerEmail === 'string' && headerEmail.includes('@')) {
    userEmail = headerEmail.toLowerCase().trim();
  }

  // 2. Check Authorization header
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();

    // Check if token itself is an email
    if (token.includes('@')) {
      userEmail = userEmail || token.toLowerCase().trim();
    } else if (token.startsWith('email:')) {
      userEmail = userEmail || token.slice(6).toLowerCase().trim();
    } else if (firebaseAdmin && typeof firebaseAdmin.auth === 'function' && token.length > 50) {
      // Live Firebase Auth token verification
      try {
        const decoded = await firebaseAdmin.auth().verifyIdToken(token);
        if (decoded) {
          userEmail = decoded.email || userEmail;
          userId = decoded.uid;
        }
      } catch (_) {
        // Token was not a Firebase JWT, continue with fallback
      }
    }
  }

  // 3. Fallback to query param or default
  if (!userEmail && req.query && req.query.email && String(req.query.email).includes('@')) {
    userEmail = String(req.query.email).toLowerCase().trim();
  }

  // Fallback to configured default if completely unauthenticated
  if (!userEmail) {
    userEmail = process.env.DEFAULT_USER_EMAIL || 'student@eksathi.ai';
  }

  if (!userId) {
    userId = sanitizeEmailToUserId(userEmail);
  }

  req.userId = userId;
  req.userEmail = userEmail;
  req.user = { uid: userId, email: userEmail };

  next();
}

module.exports = { requireAuth, sanitizeEmailToUserId };
