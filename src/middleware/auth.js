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

  // 1. Check if client explicitly flags anonymous / guest session
  const isGuestHeader = req.headers['x-is-guest'] === 'true' || req.headers['x-guest-session'] === 'true';

  // 2. Check explicit client email headers
  const headerEmail = req.headers['x-user-email'] || req.headers['x-student-email'];
  if (headerEmail && typeof headerEmail === 'string' && headerEmail.includes('@') && !isGuestHeader) {
    userEmail = headerEmail.toLowerCase().trim();
  }

  let isVerifiedFirebase = false;

  // 3. Check Authorization header
  const authHeader = req.headers.authorization || '';
  if (authHeader.startsWith('Bearer ') && !isGuestHeader) {
    const token = authHeader.slice(7).trim();

    if (firebaseAdmin && typeof firebaseAdmin.auth === 'function' && token.length > 50 && !token.startsWith('email:')) {
      // Live Firebase Auth token verification
      try {
        const decoded = await firebaseAdmin.auth().verifyIdToken(token);
        if (decoded) {
          userEmail = decoded.email || userEmail;
          userId = decoded.uid;
          isVerifiedFirebase = true;
        }
      } catch (_) {
        // Token was not a Firebase JWT, continue with fallback
      }
    }

    if (!userEmail) {
      if (token.includes('@')) {
        userEmail = token.toLowerCase().trim();
      } else if (token.startsWith('email:')) {
        userEmail = token.slice(6).toLowerCase().trim();
      }
    }
  }

  // 4. Fallback to query param
  if (!userEmail && req.query && req.query.email && String(req.query.email).includes('@') && !isGuestHeader) {
    userEmail = String(req.query.email).toLowerCase().trim();
  }

  const isGuest = isGuestHeader || !userEmail;

  if (isGuest) {
    userEmail = 'guest@eksathi.local';
    userId = 'guest_ephemeral';
  } else if (!userId) {
    userId = sanitizeEmailToUserId(userEmail);
  }

  req.userId = userId;
  req.userEmail = userEmail;
  req.isGuest = isGuest;
  req.isVerifiedFirebase = isVerifiedFirebase;
  req.user = { uid: userId, email: userEmail, isGuest };

  next();
}

module.exports = { requireAuth, sanitizeEmailToUserId };
