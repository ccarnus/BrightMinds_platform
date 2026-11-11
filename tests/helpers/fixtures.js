// Factories for test data. Each returns a saved mongoose document.
const fs = require('fs');
const bcrypt = require('bcrypt');
const User = require('../../models/user_model');
const Cast = require('../../models/cast_model');
const { signToken } = require('../../middleware/auth');
const { MEDIA_DIRS, ensureMediaDir, mediaFilePath, mediaUrl } = require('../../services/media');

// Smallest valid PNG (1x1 transparent pixel).
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

let counter = 0;
const unique = () => `${Date.now()}_${++counter}`;

const createUser = async (overrides = {}) => {
  const { password = 'password123', ...rest } = overrides;
  return User.create({
    email: `user_${unique()}@example.com`,
    password: await bcrypt.hash(password, 4),
    username: 'testuser',
    role: 'College Student',
    profilePictureUrl: 'http://api.test/backend/media/profile_pictures/none.png',
    isVerified: true,
    ...rest,
  });
};

const createCast = (overrides = {}) =>
  Cast.create({
    title: `Cast ${unique()}`,
    description: 'A cast about physics',
    department: 'PhysicsandAstronomy',
    brightmindid: 'author-id',
    casturl: 'http://api.test/backend/media/cast_videos/none.mp4',
    university: 'Test University',
    category: 'Science',
    visibility: 'public',
    duration: 2,
    topic: 'Quantum Mechanics',
    ...overrides,
  });

/** Writes a file in a media directory and returns its public URL. */
const createMediaFile = (dir, filename, content = 'data') => {
  ensureMediaDir(dir);
  fs.writeFileSync(mediaFilePath(dir, filename), content);
  return mediaUrl(dir, filename);
};

const mediaFileExists = (dir, filename) => fs.existsSync(mediaFilePath(dir, filename));

const authHeader = (user) => ({ Authorization: `Bearer ${signToken(user._id)}` });

module.exports = {
  PNG_BYTES,
  MEDIA_DIRS,
  createUser,
  createCast,
  createMediaFile,
  mediaFileExists,
  authHeader,
};
