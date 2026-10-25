// ─────────────────────────────────────────────────────────
// SUPABASE DATABASE CONNECTOR (Dual-Mode Architecture)
//
// Matches PPT specification: "Firebase + Supabase - Firebase manages auth,
// while Supabase stores structured application data."
//
// Dual-mode:
// 1. If SUPABASE_URL and SUPABASE_ANON_KEY (or SERVICE_ROLE_KEY) are provided,
//    interacts directly with the Supabase PostgreSQL REST client.
// 2. If keys are omitted (e.g. local evaluation / offline mode), gracefully
//    routes to the unified local JSON database engine in db.js.
// ─────────────────────────────────────────────────────────

const localDb = require('./db');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || '';

const isEnabled = Boolean(SUPABASE_URL && SUPABASE_KEY);

if (isEnabled) {
  console.log(`[supabase] Connected to Supabase Cloud Instance: ${SUPABASE_URL}`);
} else {
  console.log('[supabase] No Supabase credentials provided — transparently running in local persistent dual-store mode.');
}

/**
 * Executes a structured query or falls back to local data store.
 */
async function queryTable(tableName, options = {}) {
  if (!isEnabled) {
    // Local fallback emulation
    const col = localDb.db.collection(tableName);
    let q = col;
    if (options.limit) q = q.limit(options.limit);
    const snap = await q.get();
    return snap.docs ? snap.docs.map(d => ({ id: d.id, ...d.data() })) : [];
  }

  try {
    const url = new URL(`/rest/v1/${tableName}`, SUPABASE_URL);
    if (options.select) url.searchParams.set('select', options.select);
    if (options.limit) url.searchParams.set('limit', String(options.limit));
    if (options.order) url.searchParams.set('order', options.order);

    const res = await fetch(url.toString(), {
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      console.warn(`[supabase] Query failed with status ${res.status}, falling back to local.`);
      const snap = await localDb.db.collection(tableName).get();
      return snap.docs ? snap.docs.map(d => ({ id: d.id, ...d.data() })) : [];
    }

    return await res.json();
  } catch (err) {
    console.warn(`[supabase] Fetch error: ${err.message}, falling back to local.`);
    const snap = await localDb.db.collection(tableName).get();
    return snap.docs ? snap.docs.map(d => ({ id: d.id, ...d.data() })) : [];
  }
}

/**
 * Inserts or updates a record in Supabase / Local DB
 */
async function upsertRecord(tableName, record) {
  if (!isEnabled) {
    const id = record.id || record._id || Date.now().toString();
    await localDb.db.collection(tableName).doc(id).set(record, { merge: true });
    return { status: 'ok', id, storage: 'local' };
  }

  try {
    const url = new URL(`/rest/v1/${tableName}`, SUPABASE_URL);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates',
      },
      body: JSON.stringify(record),
    });

    if (!res.ok) {
      console.warn(`[supabase] Upsert failed with status ${res.status}, using local store.`);
      const id = record.id || Date.now().toString();
      await localDb.db.collection(tableName).doc(id).set(record, { merge: true });
      return { status: 'ok', id, storage: 'local-fallback' };
    }

    return { status: 'ok', storage: 'supabase' };
  } catch (err) {
    console.warn(`[supabase] Upsert exception: ${err.message}, saving locally.`);
    const id = record.id || Date.now().toString();
    await localDb.db.collection(tableName).doc(id).set(record, { merge: true });
    return { status: 'ok', id, storage: 'local-fallback' };
  }
}

module.exports = {
  isEnabled,
  queryTable,
  upsertRecord,
  SUPABASE_URL,
};
