// ─────────────────────────────────────────────────────────
// DUAL-MODE MEDIA & DOCUMENT STORAGE (Cloudinary OR Local Disk)
//
// If CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET
// are set in environment variables, file uploads stream directly to Cloudinary
// with secure public CDN URLs.
//
// Otherwise, it transparently stores files in the local/temporary uploads folder.
// ─────────────────────────────────────────────────────────

const cloudinary = require('cloudinary').v2;

const hasCloudinaryKeys = !!(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
);

if (hasCloudinaryKeys) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  console.log(`[cloudinary] Connected to Cloudinary storage (cloud: ${process.env.CLOUDINARY_CLOUD_NAME})`);
}

/**
 * Uploads a buffer to Cloudinary
 * @param {Buffer} buffer 
 * @param {Object} options 
 * @returns {Promise<Object>}
 */
function uploadBufferToCloudinary(buffer, options = {}) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder: options.folder || 'ek-sathi-docs',
        resource_type: options.resourceType || 'auto',
        public_id: options.publicId,
        ...options,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
}

/**
 * Deletes an asset from Cloudinary
 * @param {string} publicId 
 * @param {string} resourceType 
 */
async function deleteFromCloudinary(publicId, resourceType = 'image') {
  if (!hasCloudinaryKeys || !publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err) {
    console.error(`[cloudinary] Failed to delete asset ${publicId}:`, err.message);
  }
}

module.exports = {
  cloudinary,
  hasCloudinaryKeys,
  uploadBufferToCloudinary,
  deleteFromCloudinary,
};
