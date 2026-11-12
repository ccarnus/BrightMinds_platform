const bcrypt = require('bcrypt');
const config = require('../config');
const User = require('../models/user_model');
const isValidEmail = require('./email_validator');
const { badRequest } = require('../utils/http');

const MIN_PASSWORD_LENGTH = 8;
// bcrypt only reads the first 72 bytes: a longer password would silently be cut.
const MAX_PASSWORD_BYTES = 72;
// Login never hashes more than this (a huge "password" is only a way to slow the server down).
const MAX_LOGIN_PASSWORD_LENGTH = 1024;
const MIN_USERNAME_LENGTH = 2;
const MAX_USERNAME_LENGTH = 50;
const MAX_UNIVERSITY_LENGTH = 120;

const COMMON_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  '11111111',
  '00000000',
  'password',
  'password1',
  'password123',
  'passw0rd',
  'qwertyui',
  'qwerty123',
  'azertyui',
  'iloveyou',
  'abc12345',
  'admin123',
  'letmein1',
  'brightminds',
]);

// Zero-width characters and the byte-order mark slip in with copy-paste and some keyboards.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F]/g;

/** Lowercased, trimmed email without invisible characters ('' when it is not a string). */
const normalizeEmail = (value) =>
  typeof value === 'string' ? value.replace(INVISIBLE, '').trim().toLowerCase() : '';

/** Why an (already normalized) email is refused, or null when it is fine. */
const emailProblem = (email) => {
  if (!email) return 'Please enter your email address.';
  if (!isValidEmail(email)) {
    return "That email address doesn't look right. Please check it for typos.";
  }
  return null;
};

/** Why a new password is refused, or null when it is fine. */
const passwordProblem = (password, { email, username } = {}) => {
  if (typeof password !== 'string' || password.length === 0) return 'Please enter a password.';
  if (password.trim().length === 0) return 'Your password cannot be only spaces.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Your password must be at least ${MIN_PASSWORD_LENGTH} characters long.`;
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    return `Your password is too long (at most ${MAX_PASSWORD_BYTES} characters).`;
  }
  const lowered = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lowered) || /^(.)\1+$/.test(password)) {
    return 'That password is too easy to guess. Please choose another one.';
  }
  const mailbox = normalizeEmail(email);
  if (mailbox && (lowered === mailbox || lowered === mailbox.split('@')[0])) {
    return 'Your password cannot be your email address.';
  }
  const name = cleanUsername(username);
  if (name && lowered === name.toLowerCase()) return 'Your password cannot be your name.';
  return null;
};

/** Display name without control characters, with single spaces ('' when it is not a string). */
function cleanUsername(value) {
  if (typeof value !== 'string') return '';
  return value.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

const usernameProblem = (username) => {
  if (!username) return 'Please enter your name.';
  if (username.length < MIN_USERNAME_LENGTH) {
    return `Your name must be at least ${MIN_USERNAME_LENGTH} characters long.`;
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    return `Your name must be ${MAX_USERNAME_LENGTH} characters or less.`;
  }
  return null;
};

const cleanUniversity = (value) =>
  typeof value === 'string'
    ? value.replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
    : '';

const assertValid = (problem) => {
  if (problem) throw badRequest(problem);
};

const hashPassword = (password) => bcrypt.hash(password, config.auth.bcryptRounds);

let dummyHash;
/**
 * Compares `password` with a stored hash. With no hash (unknown email) it still does the same
 * amount of work, so the response time does not reveal whether an account exists.
 */
const verifyPassword = async (hash, password) => {
  if (!dummyHash) dummyHash = bcrypt.hash('not-a-real-password', config.auth.bcryptRounds);
  try {
    const result = await bcrypt.compare(password, hash || (await dummyHash));
    return Boolean(hash) && result;
  } catch {
    return false;
  }
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Finds an account by normalized email (older accounts may still have capital letters). */
const findUserByEmail = async (email, projection) => {
  if (!email) return null;
  const exact = await User.findOne({ email }, projection);
  if (exact) return exact;
  return User.findOne({ email: new RegExp(`^${escapeRegex(email)}$`, 'i') }, projection);
};

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_BYTES,
  MAX_LOGIN_PASSWORD_LENGTH,
  MAX_UNIVERSITY_LENGTH,
  normalizeEmail,
  emailProblem,
  passwordProblem,
  cleanUsername,
  cleanUniversity,
  usernameProblem,
  assertValid,
  hashPassword,
  verifyPassword,
  findUserByEmail,
};
