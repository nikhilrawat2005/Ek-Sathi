// ─────────────────────────────────────────────────────────
// LOCAL-ONLY DATA LAYER (no Firebase, no cloud storage).
// The whole backend runs 100% on localhost and persists to a
// single JSON file (data/store.json). This module keeps the same
// export shape the rest of the codebase expects:
//   db            → Firestore-compatible local store
//   firebaseAdmin → minimal shim exposing FieldValue helpers
//   auth          → null (auth middleware no longer uses Firebase)
// ─────────────────────────────────────────────────────────
const { db, FieldValue } = require('./db');

const firebaseAdmin = {
  firestore: { FieldValue },
};

const auth = null;

module.exports = { firebaseAdmin, db, auth };