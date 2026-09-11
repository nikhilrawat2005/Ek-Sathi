const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, uploadsDir, ensureUploadsDir } = require('../config/db');
const documentReader = require('./documentReaderService');

ensureUploadsDir();

const extFromName = (name) => (path.extname(name || '').slice(1) || '').toLowerCase();

function filePathFor(userId, fileId) {
  const dir = path.join(uploadsDir, String(userId));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, fileId);
}

async function uploadFile(userId, file) {
  // Compute SHA-256 hash of file buffer for exact deduplication
  const fileHash = crypto.createHash('sha256').update(file.buffer).digest('hex');

  // Check if this user already uploaded the exact same file
  const existingSnap = await db.collection('users').doc(userId).collection('files')
    .where('fileHash', '==', fileHash)
    .limit(1)
    .get();

  if (!existingSnap.empty) {
    const existingDoc = existingSnap.docs[0];
    console.log(`[fileService] Deduplication match! Reusing file ${existingDoc.id} for "${file.originalname}"`);
    return { id: existingDoc.id, ...existingDoc.data(), deduplicated: true };
  }

  const ref = db.collection('users').doc(userId).collection('files').doc();
  const storedPath = filePathFor(userId, ref.id);
  fs.writeFileSync(storedPath, file.buffer);

  // Actually read the file's content for text-bearing formats
  const extraction = await documentReader.extractText(file.buffer, file.originalname);

  const record = {
    url: `/api/files/${ref.id}/view`,
    localPath: storedPath,
    resourceType: 'local',
    originalName: file.originalname,
    mimeType: file.mimetype || null,
    sizeBytes: file.size,
    fileHash,
    createdAt: Date.now(),
    extractedText: extraction.supported ? extraction.text : '',
    textExtracted: extraction.supported,
    extractionError: extraction.supported ? null : extraction.error,
  };

  await ref.set(record);

  return { id: ref.id, ...record };
}

// How many chars of extractedText the LIST endpoint returns per file.
const LIST_SNIPPET_CHARS = 4000;
const LIST_MAX_FILES = 300;

async function listFiles(userId) {
  const snap = await db.collection('users').doc(userId).collection('files')
    .orderBy('createdAt', 'desc')
    .limit(LIST_MAX_FILES)
    .get();

  return snap.docs.map(d => {
    const data = d.data();
    const full = typeof data.extractedText === 'string' ? data.extractedText : '';
    return {
      id: d.id,
      ...data,
      extractedText: full.slice(0, LIST_SNIPPET_CHARS),
      extractedTextLength: full.length,
      extractedTextTruncated: full.length > LIST_SNIPPET_CHARS,
    };
  });
}

async function getFile(userId, fileId) {
  const doc = await db.collection('users').doc(userId).collection('files').doc(fileId).get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function deleteFile(userId, fileId) {
  const ref = db.collection('users').doc(userId).collection('files').doc(fileId);
  const snap = await ref.get();
  if (!snap.exists) return false;

  const record = snap.data();

  // Remove the local file from disk; the DB pointer is only deleted afterwards.
  if (record.localPath) {
    try {
      if (fs.existsSync(record.localPath)) {
        fs.unlinkSync(record.localPath);
      }
    } catch (err) {
      console.error(`[fileService] local file delete failed for ${fileId}: ${err.message}`);
      const e = new Error(`Stored file could not be removed from disk (${err.message}). Nothing was deleted — please retry.`);
      e.code = 'ASSET_DELETE_FAILED';
      throw e;
    }
  }

  await ref.delete();
  return true;
}

async function saveGeneratedFile(userId, buffer, filename, mimeType) {
  const ref = db.collection('users').doc(userId).collection('files').doc();
  const storedPath = filePathFor(userId, ref.id);
  fs.writeFileSync(storedPath, buffer);

  const record = {
    url: `/api/files/${ref.id}/view`,
    localPath: storedPath,
    resourceType: 'local',
    originalName: filename,
    mimeType,
    sizeBytes: buffer.length,
    generated: true,
    createdAt: Date.now(),
  };

  await ref.set(record);

  return { id: ref.id, ...record };
}

module.exports = { uploadFile, listFiles, getFile, deleteFile, saveGeneratedFile, extFromName };