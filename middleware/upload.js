const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const { MEDIA_DIRS, ensureMediaDir } = require('../services/media');
const { HttpError } = require('../utils/http');

// MIME type -> stored extension. Includes iOS/Android formats (mov, heic, 3gp) sent by the app.
const IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};
const VIDEO_TYPES = {
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-m4v': 'm4v',
  'video/3gpp': '3gp',
};
// Article covers are re-encoded with sharp, which cannot read HEIC: the app sends JPEG.
const COVER_IMAGE_TYPES = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const MB = 1024 * 1024;

/**
 * Resolves the stored extension from the MIME type or, when the client sends a generic type
 * (React Native often uses application/octet-stream), from the original file extension.
 * Returns null if the file type is not allowed.
 */
const resolveExtension = (file, mimeTypes) => {
  if (mimeTypes[file.mimetype]) return mimeTypes[file.mimetype];
  const extension = path
    .extname(file.originalname || '')
    .slice(1)
    .toLowerCase();
  const allowed = new Set(Object.values(mimeTypes));
  if (extension === 'jpeg') return 'jpg';
  return allowed.has(extension) ? extension : null;
};

/**
 * Builds a single-file multer middleware. Files get a random name (the client
 * name is never used on disk) and unsupported types are rejected with 400.
 */
const createUpload = ({ dir, field, mimeTypes, maxSizeMb }) => {
  const storage = multer.diskStorage({
    destination: (req, file, callback) => callback(null, ensureMediaDir(dir)),
    filename: (req, file, callback) => {
      const base = path
        .parse(file.originalname)
        .name.replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 40);
      const suffix = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      callback(null, `${base || 'file'}_${suffix}.${resolveExtension(file, mimeTypes)}`);
    },
  });

  const upload = multer({
    storage,
    limits: { fileSize: maxSizeMb * MB, files: 1 },
    fileFilter: (req, file, callback) => {
      if (!resolveExtension(file, mimeTypes)) {
        return callback(new HttpError(400, `Unsupported file type: ${file.mimetype}`));
      }
      return callback(null, true);
    },
  }).single(field);

  return (req, res, next) =>
    upload(req, res, (error) => {
      if (error instanceof multer.MulterError) {
        const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
        return next(new HttpError(status, error.message));
      }
      return next(error);
    });
};

module.exports = {
  castVideo: createUpload({
    dir: MEDIA_DIRS.castVideos,
    field: 'video',
    mimeTypes: VIDEO_TYPES,
    maxSizeMb: 1024,
  }),
  profilePicture: createUpload({
    dir: MEDIA_DIRS.profilePictures,
    field: 'image',
    mimeTypes: IMAGE_TYPES,
    maxSizeMb: 10,
  }),
  articleImage: createUpload({
    dir: MEDIA_DIRS.articleImages,
    field: 'image',
    mimeTypes: COVER_IMAGE_TYPES,
    maxSizeMb: 10,
  }),
  universityIcon: createUpload({
    dir: MEDIA_DIRS.universityIcons,
    field: 'icon',
    mimeTypes: IMAGE_TYPES,
    maxSizeMb: 10,
  }),
  virtualLabIcon: createUpload({
    dir: MEDIA_DIRS.virtualLabIcons,
    field: 'icon',
    mimeTypes: IMAGE_TYPES,
    maxSizeMb: 10,
  }),
};
