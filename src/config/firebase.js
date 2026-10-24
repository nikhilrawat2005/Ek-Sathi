// ─────────────────────────────────────────────────────────
// DUAL-MODE DATA LAYER (Firebase Cloud Firestore OR Local Store)
//
// If FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY
// are provided in environment variables (local .env or Vercel config),
// the backend connects to Google Cloud Firebase Admin & Firestore.
//
// Otherwise, it transparently falls back to our local file store (data/store.json),
// ensuring zero friction in local development or key-less demos.
// ─────────────────────────────────────────────────────────

const admin = require('firebase-admin');
const localDb = require('./db');

let firebaseAdmin = null;
let db = null;
let FieldValue = null;

const hasFirebaseKeys = !!(
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
);

if (hasFirebaseKeys) {
  try {
    if (admin.apps.length > 0) {
      firebaseAdmin = admin.app();
    } else {
      const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
      firebaseAdmin = admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey,
        }),
      });
    }

    db = firebaseAdmin.firestore();
    FieldValue = admin.firestore.FieldValue;
    console.log(`[firebase] Connected to Cloud Firestore (project: ${process.env.FIREBASE_PROJECT_ID})`);
  } catch (err) {
    console.warn(`[firebase] Initialization error: ${err.message}. Falling back to local store.`);
    firebaseAdmin = { firestore: { FieldValue: localDb.FieldValue } };
    db = localDb.db;
    FieldValue = localDb.FieldValue;
  }
} else {
  // Graceful fallback to local store
  firebaseAdmin = { firestore: { FieldValue: localDb.FieldValue } };
  db = localDb.db;
  FieldValue = localDb.FieldValue;
}

const auth = (hasFirebaseKeys && firebaseAdmin && typeof firebaseAdmin.auth === 'function')
  ? firebaseAdmin.auth()
  : null;

module.exports = {
  firebaseAdmin,
  db,
  auth,
  FieldValue,
  isCloudFirebase: hasFirebaseKeys && !!db && db !== localDb.db,
};
