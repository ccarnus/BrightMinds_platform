// Images uploaded by authors (article covers): re-encoded to a bounded JPEG. Re-encoding applies the
// EXIF orientation and drops the metadata (e.g. the GPS position of phone photos).
const crypto = require('crypto');
const sharp = require('sharp');
const { deleteFile, ensureMediaDir, mediaFilePath } = require('./media');
const { badRequest } = require('../utils/http');

const MAX_IMAGE_SIZE = 1600;

/**
 * Saves the uploaded image at `filePath` as `<prefix>_<timestamp>_<random>.jpg` in media `dir`, then
 * deletes the original upload.
 * @returns {Promise<string>} The saved filename.
 * @throws {HttpError} 400 when the file is not a readable image.
 */
const saveUploadedImage = async (filePath, { dir, prefix }) => {
  ensureMediaDir(dir);
  const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.jpg`;
  const output = mediaFilePath(dir, filename);
  try {
    await sharp(filePath)
      .rotate()
      .resize({
        width: MAX_IMAGE_SIZE,
        height: MAX_IMAGE_SIZE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85 })
      .toFile(output);
  } catch {
    await deleteFile(output);
    throw badRequest('The image could not be read. Use a JPEG, PNG or WebP file.');
  } finally {
    await deleteFile(filePath);
  }
  return filename;
};

module.exports = { MAX_IMAGE_SIZE, saveUploadedImage };
