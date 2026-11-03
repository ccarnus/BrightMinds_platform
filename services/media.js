// Uploaded and generated files live under config.mediaRoot/<dir>/ and are served at /backend/media/<dir>/.
const fs = require('fs');
const path = require('path');
const config = require('../config');

const MEDIA_DIRS = Object.freeze({
  castVideos: 'cast_videos',
  castImages: 'cast_images',
  castSubtitles: 'cast_subtitles',
  articleImages: 'article_images',
  profilePictures: 'profile_pictures',
  universityIcons: 'university_icon',
  virtualLabIcons: 'virtuallab_icon',
  emailAssets: 'verification_email',
});

const MEDIA_URL_PREFIX = '/backend/media';

const mediaDirPath = (dir) => path.join(config.mediaRoot, dir);

const ensureMediaDir = (dir) => {
  const dirPath = mediaDirPath(dir);
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
};

const mediaFilePath = (dir, filename) => path.join(mediaDirPath(dir), path.basename(filename));

const mediaUrl = (dir, filename) => `${config.publicUrl}${MEDIA_URL_PREFIX}/${dir}/${filename}`;

/**
 * Resolves a stored media URL back to a file path inside `dir`.
 * Returns null for foreign URLs. Only the basename is kept, so crafted URLs
 * (e.g. ".../cast_images/../../app.js") can never escape the media directory.
 */
const mediaPathFromUrl = (url, dir) => {
  if (typeof url !== 'string') return null;
  const marker = `/media/${dir}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  let name = url.slice(index + marker.length).split(/[?#]/)[0];
  try {
    name = decodeURIComponent(name);
  } catch {
    return null;
  }
  name = path.basename(name.replace(/\\/g, '/'));
  if (!name || name === '.' || name === '..') return null;
  return path.join(mediaDirPath(dir), name);
};

/** Deletes a file, ignoring missing files. Returns false if deletion failed. */
const deleteFile = async (filePath) => {
  if (!filePath) return true;
  try {
    await fs.promises.unlink(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    console.error(`Error deleting file ${filePath}:`, error);
    return false;
  }
};

/** Deletes the file referenced by a stored media URL. Returns false if deletion failed. */
const deleteMediaByUrl = (url, dir) => deleteFile(mediaPathFromUrl(url, dir));

module.exports = {
  MEDIA_DIRS,
  MEDIA_URL_PREFIX,
  ensureMediaDir,
  mediaDirPath,
  mediaFilePath,
  mediaUrl,
  mediaPathFromUrl,
  deleteFile,
  deleteMediaByUrl,
};
