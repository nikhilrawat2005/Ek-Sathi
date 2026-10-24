const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../config/firebase');
const { uploadsDir, ensureUploadsDir } = require('../config/db');
const { hasCloudinaryKeys, uploadBufferToCloudinary, deleteFromCloudinary } = require('../config/cloudinary');
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

  let fileUrl = `/api/files/${ref.id}/view`;
  let storedPath = null;
  let cloudinaryPublicId = null;
  let resourceType = 'local';

  // If Cloudinary keys are configured, upload to Cloudinary CDN
  if (hasCloudinaryKeys) {
    try {
      const ext = extFromName(file.originalname);
      const isRaw = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'md', 'json', 'zip'].includes(ext);
      const cRes = await uploadBufferToCloudinary(file.buffer, {
        publicId: `${userId}_${ref.id}`,
        folder: 'ek-sathi-docs',
        resourceType: isRaw ? 'raw' : 'auto',
      });
      fileUrl = cRes.secure_url || cRes.url;
      cloudinaryPublicId = cRes.public_id;
      resourceType = 'cloudinary';
    } catch (cErr) {
      console.warn(`[fileService] Cloudinary upload failed: ${cErr.message}. Falling back to local storage.`);
    }
  }

  // Local fallback or local storage
  if (resourceType === 'local') {
    storedPath = filePathFor(userId, ref.id);
    fs.writeFileSync(storedPath, file.buffer);
  }

  // Actually read the file's content for text-bearing formats
  const extraction = await documentReader.extractText(file.buffer, file.originalname);

  const record = {
    url: fileUrl,
    localPath: storedPath,
    cloudinaryPublicId,
    resourceType,
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

  // If stored on Cloudinary, delete from Cloudinary
  if (record.cloudinaryPublicId) {
    try {
      const isRaw = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt'].includes(extFromName(record.originalName));
      await deleteFromCloudinary(record.cloudinaryPublicId, isRaw ? 'raw' : 'image');
    } catch (err) {
      console.warn(`[fileService] Cloudinary delete failed: ${err.message}`);
    }
  }

  // Remove the local file from disk if present
  if (record.localPath) {
    try {
      if (fs.existsSync(record.localPath)) {
        fs.unlinkSync(record.localPath);
      }
    } catch (err) {
      console.error(`[fileService] local file delete failed for ${fileId}: ${err.message}`);
    }
  }

  await ref.delete();
  return true;
}

async function saveGeneratedFile(userId, buffer, filename, mimeType) {
  const ref = db.collection('users').doc(userId).collection('files').doc();

  let fileUrl = `/api/files/${ref.id}/view`;
  let storedPath = null;
  let cloudinaryPublicId = null;
  let resourceType = 'local';

  if (hasCloudinaryKeys) {
    try {
      const ext = extFromName(filename);
      const isRaw = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext);
      const cRes = await uploadBufferToCloudinary(buffer, {
        publicId: `${userId}_${ref.id}`,
        folder: 'ek-sathi-generated',
        resourceType: isRaw ? 'raw' : 'auto',
      });
      fileUrl = cRes.secure_url || cRes.url;
      cloudinaryPublicId = cRes.public_id;
      resourceType = 'cloudinary';
    } catch (cErr) {
      console.warn(`[fileService] Cloudinary generated upload failed: ${cErr.message}`);
    }
  }

  if (resourceType === 'local') {
    storedPath = filePathFor(userId, ref.id);
    fs.writeFileSync(storedPath, buffer);
  }

  const record = {
    url: fileUrl,
    localPath: storedPath,
    cloudinaryPublicId,
    resourceType,
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
