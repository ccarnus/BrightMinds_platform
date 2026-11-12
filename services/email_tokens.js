// Random tokens for the links sent by email. Only their SHA-256 is stored, so a leaked database
// does not leak usable links.
const crypto = require('crypto');

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/** @returns {{ token: string, hash: string }} the token to email and the value to store. */
const generateToken = () => {
  const token = crypto.randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
};

/** Tokens in links are hex, but anything URL-safe and short is read (accounts from before hashing). */
const isWellFormedToken = (token) =>
  typeof token === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(token);

/**
 * Stored values a link token can match: its hash, or itself for links sent before tokens were hashed.
 */
const tokenCandidates = (token) => [hashToken(token), String(token)];

module.exports = { generateToken, hashToken, isWellFormedToken, tokenCandidates };
