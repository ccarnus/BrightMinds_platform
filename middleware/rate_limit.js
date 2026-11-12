const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const config = require('../config');

const MESSAGE = 'Too many attempts. Please wait a few minutes and try again.';
const MINUTES = 60 * 1000;

const build = ({ windowMs, limit, ...options }) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: () => config.isTest,
    message: { error: MESSAGE, message: MESSAGE },
    ...options,
  });

const clientKey = (req) => ipKeyGenerator(req.ip);

const loginEmail = (req) =>
  typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : '';

// Only failed logins count: a campus sharing one IP address can all log in, but guessing is slowed down.
const loginByAddress = build({
  windowMs: 15 * MINUTES,
  limit: 60,
  skipSuccessfulRequests: true,
  keyGenerator: clientKey,
});

// Guessing one account's password: few failures per address and email.
const loginByAccount = build({
  windowMs: 15 * MINUTES,
  limit: 8,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${clientKey(req)}|${loginEmail(req)}`,
});

const signup = build({ windowMs: 60 * MINUTES, limit: 10, keyGenerator: clientKey });

// Endpoints that send an email (reset request, resend): each user is also limited in services/account_email.js.
const sendsEmail = build({ windowMs: 15 * MINUTES, limit: 10, keyGenerator: clientKey });

const resetSubmit = build({ windowMs: 15 * MINUTES, limit: 20, keyGenerator: clientKey });

module.exports = {
  loginLimits: [loginByAddress, loginByAccount],
  signupLimit: signup,
  emailLimit: sendsEmail,
  resetSubmitLimit: resetSubmit,
};
