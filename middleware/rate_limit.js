const rateLimit = require('express-rate-limit');
const config = require('../config');

const MESSAGE = 'Too many attempts, please try again later.';

/** Throttles credential and email-sending endpoints (login, signup, password reset). */
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => config.isTest,
  message: { error: MESSAGE, message: MESSAGE },
});

module.exports = { authRateLimit };
