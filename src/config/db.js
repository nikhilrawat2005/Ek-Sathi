const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─────────────────────────────────────────────────────────
// LOCAL JSON-FILE STORE (Firestore-compatible subset)
// Replaces firebase-admin for 100% localhost operation.
// Persists a JSON tree under data/ and mimics the Firestore
// API surface used across this codebase:
//   collection().doc().get/set/update/delete
//   collection().add(), .doc() auto-id, .ref, .parent
//   where(== ,in, <=), orderBy asc/desc, limit, limitToLast, startAfter
//   collectionGroup(), db.batch(), db.runTransaction()
//   FieldValue.arrayUnion(...)
// ─────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadTree() {
  ensureDir();
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return {};
  }
}

let tree = loadTree();

// Tree shape: { [collectionPath]: { [docId]: docData } }
// collectionPath is like "users/UID/sessions" — segments joined with "/".

function persist() {
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  const payload = JSON.stringify(tree, null, 0);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.writeFileSync(tmp, payload);
      try {
        fs.renameSync(tmp, DB_FILE);
      } catch (renameErr) {
        // rename can fail on Windows when the target is briefly locked
        // (editors, antivirus, OneDrive) — fall back to direct write.
        fs.writeFileSync(DB_FILE, payload);
      }
      return;
    } catch (err) {
      const busy = err && /EPERM|EBUSY|EACCES/i.test(String(err.message || err.code));
      if (!busy || attempt === 3) throw err;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 70 + attempt * 70); } catch (_) { /* ignore */ }
    }
  }
}

function genId() {
  return crypto.randomBytes(12).toString('hex');
}

function refId(parentPath, id) {
  return parentPath ? `${parentPath}/${id}` : id;
}

// ── Document helpers ─────────────────────────────────────

function getCol(pathStr) {
  return tree[pathStr] || null;
}

function getDoc(pathStr, id) {
  const col = tree[pathStr];
  if (!col) return null;
  return Object.prototype.hasOwnProperty.call(col, id) ? col[id] : null;
}

function applyFieldValue(target, field, value) {
  // Handle FieldValue.arrayUnion markers
  if (value && typeof value === 'object' && value.__type === 'arrayUnion') {
    const cur = Array.isArray(target[field]) ? target[field] : [];
    const merged = cur.slice();
    for (const v of value.values) {
      if (!merged.some(x => JSON.stringify(x) === JSON.stringify(v))) merged.push(v);
    }
    target[field] = merged;
    return;
  }
  target[field] = value;
}

function mergeSet(existing, data, merge) {
  const result = existing && typeof existing === 'object' && !Array.isArray(existing) && existing !== null
    ? JSON.parse(JSON.stringify(existing))
    : {};
  if (merge) {
    for (const [k, v] of Object.entries(data)) applyFieldValue(result, k, v);
  } else {
    // Full replace, but keep nothing from old doc in the new object.
    const fresh = {};
    for (const [k, v] of Object.entries(data)) applyFieldValue(fresh, k, v);
    return fresh;
  }
  return result;
}

function updateDoc(existing, data) {
  const result = existing && typeof existing === 'object' && !Array.isArray(existing) && existing !== null
    ? JSON.parse(JSON.stringify(existing))
    : {};
  for (const [k, v] of Object.entries(data)) applyFieldValue(result, k, v);
  return result;
}

// ── Firestore value move helpers ────────────────────────

const FieldValue = {
  arrayUnion: (...values) => ({ __type: 'arrayUnion', values }),
};

// ── Collection reference ─────────────────────────────────

class CollectionRef {
  constructor(pathSegments) {
    this._segs = pathSegments;
  }

  get id() {
    return this._segs[this._segs.length - 1];
  }

  get path() {
    return this._segs.join('/');
  }

  get parent() {
    if (this._segs.length < 2) return new DocRef([], null);
    return new DocRef(this._segs.slice(0, -1), this._segs[this._segs.length - 1]);
  }

  doc(id) {
    id = id || genId();
    return new DocRef(this._segs, id);
  }

  add(data) {
    const ref = this.doc();
    ref.set(data);
    return ref;
  }

  _raw() {
    return getCol(this.path) || {};
  }

  get() {
    const col = this._raw();
    const docs = Object.keys(col).map(id => new DocSnapshot(new DocRef(this._segs, id), col[id]));
    return Promise.resolve(new QuerySnapshot(docs));
  }

  where(field, op, value) {
    return new Query(this, { field, op, value });
  }

  orderBy(field, dir = 'asc') {
    return new Query(this, null, field, dir);
  }

  limit(n) {
    return new Query(this, null, null, null, n);
  }

  limitToLast(n) {
    return new Query(this, null, null, null, null, n);
  }

  startAfter(value) {
    return new Query(this, null, null, null, null, null, value);
  }
}

// ── Document reference ───────────────────────────────────

class DocRef {
  constructor(parentSegs, id) {
    this._parentSegs = parentSegs; // collection segments
    this._id = id;
  }

  get id() {
    return this._id;
  }

  get path() {
    return this._parentSegs.length ? `${this._parentSegs.join('/')}/${this._id}` : this._id;
  }

  get ref() {
    return this;
  }

  get parent() {
    return new CollectionRef(this._parentSegs);
  }

  collection(name) {
    return new CollectionRef(this._parentSegs.concat(this._id, name));
  }

  async get() {
    const data = getDoc(this._parentSegs.join('/'), this._id);
    return Promise.resolve(new DocSnapshot(this, data));
  }

  async set(data, opts = {}) {
    const pathStr = this._parentSegs.join('/');
    if (!tree[pathStr]) tree[pathStr] = {};
    const existing = getDoc(pathStr, this._id);
    tree[pathStr][this._id] = mergeSet(existing, data, !!opts.merge);
    persist();
  }

  async update(data) {
    const pathStr = this._parentSegs.join('/');
    if (!tree[pathStr]) tree[pathStr] = {};
    const existing = getDoc(pathStr, this._id);
    tree[pathStr][this._id] = updateDoc(existing, data);
    persist();
  }

  async delete() {
    const pathStr = this._parentSegs.join('/');
    if (tree[pathStr] && Object.prototype.hasOwnProperty.call(tree[pathStr], this._id)) {
      delete tree[pathStr][this._id];
      persist();
    }
  }
}

// ── Snapshots ────────────────────────────────────────────

class DocSnapshot {
  constructor(ref, data) {
    this.ref = ref;
    this._data = data;
    this.exists = data !== null && data !== undefined;
  }
  get id() {
    return this.ref.id;
  }
  data() {
    return this._data ? JSON.parse(JSON.stringify(this._data)) : undefined;
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.empty = docs.length === 0;
    this.size = docs.length;
  }
  forEach(cb) {
    this.docs.forEach(cb);
  }
}

// ── Query (chained where/orderBy/limit...) ───────────────

class Query {
  constructor(collRef, whereClause, orderByField, orderByDir, limit, limitToLast, startAfter) {
    this._collRef = collRef;
    this._wheres = whereClause ? [whereClause] : [];
    this._orderBy = orderByField ? { field: orderByField, dir: orderByDir || 'asc' } : null;
    this._limit = limit || null;
    this._limitToLast = limitToLast || null;
    this._startAfter = startAfter ?? null;
  }

  where(field, op, value) {
    const q = this._clone();
    q._wheres.push({ field, op, value });
    return q;
  }

  orderBy(field, dir = 'asc') {
    const q = this._clone();
    q._orderBy = { field, dir };
    return q;
  }

  limit(n) {
    const q = this._clone();
    q._limit = n;
    return q;
  }

  limitToLast(n) {
    const q = this._clone();
    q._limitToLast = n;
    return q;
  }

  startAfter(value) {
    const q = this._clone();
    q._startAfter = value;
    return q;
  }

  _clone() {
    const q = new Query(this._collRef, null);
    q._wheres = this._wheres.slice();
    q._orderBy = this._orderBy;
    q._limit = this._limit;
    q._limitToLast = this._limitToLast;
    q._startAfter = this._startAfter;
    return q;
  }

  _matches(docData) {
    return this._wheres.every(w => {
      const val = docData ? docData[w.field] : undefined;
      switch (w.op) {
        case '==': return val === w.value;
        case '!=': return val !== w.value;
        case '>': return val > w.value;
        case '>=': return val >= w.value;
        case '<': return val < w.value;
        case '<=': return val <= w.value;
        case 'in':
          return Array.isArray(w.value) && w.value.some(v => val === v);
        case 'not-in':
          return Array.isArray(w.value) && !w.value.some(v => val === v);
        case 'array-contains':
          return Array.isArray(val) && val.includes(w.value);
        case 'array-contains-any':
          return Array.isArray(w.value) && Array.isArray(val) && w.value.some(v => val.includes(v));
        default: return false;
      }
    });
  }

  get() {
    const col = this._collRef._raw();
    let docs = Object.keys(col)
      .map(id => new DocSnapshot(new DocRef(this._collRef._segs, id), col[id]));

    docs = docs.filter(d => this._matches(d.data()));

    if (this._orderBy) {
      const { field, dir } = this._orderBy;
      docs.sort((a, b) => {
        const av = a.data() ? a.data()[field] : undefined;
        const bv = b.data() ? b.data()[field] : undefined;
        if (av === bv) return 0;
        const cmp = av < bv ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      });
    }

    if (this._startAfter !== null && this._startAfter !== undefined) {
      const field = this._orderBy ? this._orderBy.field : null;
      const dir = this._orderBy ? this._orderBy.dir : 'asc';
      docs = docs.filter(d => {
        const val = field && d.data() ? d.data()[field] : undefined;
        if (val === undefined) return false;
        return dir === 'desc' ? val < this._startAfter : val > this._startAfter;
      });
    }

    if (this._limitToLast) {
      docs = docs.slice(-this._limitToLast);
    }
    if (this._limit) {
      docs = docs.slice(0, this._limit);
    }

    return Promise.resolve(new QuerySnapshot(docs));
  }
}

// ── collectionGroup ──────────────────────────────────────

function collectionGroup(name) {
  const allCols = Object.keys(tree).filter(p => {
    const segs = p.split('/');
    return segs[segs.length - 1] === name;
  });

  const docs = [];
  for (const colPath of allCols) {
    const col = tree[colPath] || {};
    for (const [id, data] of Object.entries(col)) {
      docs.push(new DocSnapshot(new DocRef(colPath.split('/').slice(0, -1), id), data));
    }
  }
  return new CollectionGroupQuery(docs);
}

class CollectionGroupQuery {
  constructor(allDocs) {
    this._docs = allDocs;
    this._wheres = [];
    this._orderBy = null;
    this._limit = null;
    this._startAfter = null;
  }
  where(field, op, value) {
    this._wheres.push({ field, op, value });
    return this;
  }
  orderBy(field, dir = 'asc') {
    this._orderBy = { field, dir };
    return this;
  }
  limit(n) {
    this._limit = n;
    return this;
  }
  limitToLast(n) {
    this._limit = n; // approximation
    return this;
  }
  get() {
    let docs = this._docs.filter(d => {
      return this._wheres.every(w => {
        const val = d.data() ? d.data()[w.field] : undefined;
        switch (w.op) {
          case '==': return val === w.value;
          case 'in': return Array.isArray(w.value) && w.value.some(v => val === v);
          case '<=': return val <= w.value;
          case '>=': return val >= w.value;
          default: return false;
        }
      });
    });
    if (this._orderBy) {
      const { field, dir } = this._orderBy;
      docs.sort((a, b) => {
        const av = a.data() ? a.data()[field] : undefined;
        const bv = b.data() ? b.data()[field] : undefined;
        if (av === bv) return 0;
        const cmp = av < bv ? -1 : 1;
        return dir === 'desc' ? -cmp : cmp;
      });
    }
    if (this._startAfter !== null && this._startAfter !== undefined) {
      const field = this._orderBy ? this._orderBy.field : null;
      docs = docs.filter(d => {
        const val = field && d.data() ? d.data()[field] : undefined;
        return val === undefined ? false : val > this._startAfter;
      });
    }
    if (this._limit) docs = docs.slice(0, this._limit);
    return Promise.resolve(new QuerySnapshot(docs));
  }
}

// ── Batch ────────────────────────────────────────────────

class WriteBatch {
  constructor() {
    this._ops = [];
  }
  set(ref, data, opts = {}) {
    this._ops.push({ type: 'set', segs: ref._parentSegs, id: ref.id, data, merge: !!opts.merge });
    return this;
  }
  update(ref, data) {
    this._ops.push({ type: 'update', segs: ref._parentSegs, id: ref.id, data });
    return this;
  }
  delete(ref) {
    this._ops.push({ type: 'delete', segs: ref._parentSegs, id: ref.id });
    return this;
  }
  async commit() {
    for (const op of this._ops) {
      const pathStr = op.segs.join('/');
      if (!tree[pathStr]) tree[pathStr] = {};
      const existing = getDoc(pathStr, op.id);
      if (op.type === 'set') {
        tree[pathStr][op.id] = mergeSet(existing, op.data, op.merge);
      } else if (op.type === 'update') {
        tree[pathStr][op.id] = updateDoc(existing, op.data);
      } else if (op.type === 'delete') {
        delete tree[pathStr][op.id];
      }
    }
    if (this._ops.length) persist();
    return Promise.resolve();
  }
}

// ── Transaction (simple serial) ──────────────────────────

class Transaction {
  constructor() {
    this._ops = [];
  }
  async get(ref) {
    const data = getDoc(ref._parentSegs.join('/'), ref.id);
    return Promise.resolve(new DocSnapshot(ref, data));
  }
  set(ref, data, opts = {}) {
    this._ops.push({ type: 'set', segs: ref._parentSegs, id: ref.id, data, merge: !!opts.merge });
    return this;
  }
  update(ref, data) {
    this._ops.push({ type: 'update', segs: ref._parentSegs, id: ref.id, data });
    return this;
  }
  delete(ref) {
    this._ops.push({ type: 'delete', segs: ref._parentSegs, id: ref.id });
    return this;
  }
  async _commit() {
    for (const op of this._ops) {
      const pathStr = op.segs.join('/');
      if (!tree[pathStr]) tree[pathStr] = {};
      const existing = getDoc(pathStr, op.id);
      if (op.type === 'set') {
        tree[pathStr][op.id] = mergeSet(existing, op.data, op.merge);
      } else if (op.type === 'update') {
        tree[pathStr][op.id] = updateDoc(existing, op.data);
      } else if (op.type === 'delete') {
        delete tree[pathStr][op.id];
      }
    }
    if (this._ops.length) persist();
  }
}

// ── Root database object ─────────────────────────────────

const db = {
  collection(name) {
    return new CollectionRef([name]);
  },
  collectionGroup(name) {
    return collectionGroup(name);
  },
  batch() {
    return new WriteBatch();
  },
  async runTransaction(fn) {
    const txn = new Transaction();
    const result = await fn(txn);
    await txn._commit();
    return result;
  },
  FieldValue,
};

// Replace-in-place helper used by generated docs that store buffers on disk
const uploadsDir = path.join(DATA_DIR, 'uploads');

module.exports = {
  db,
  Firestore: { FieldValue },
  FieldValue,
  _tree: () => tree,
  _persist: persist,
  DATA_DIR,
  uploadsDir,
  ensureUploadsDir: () => fs.mkdirSync(uploadsDir, { recursive: true }),
};