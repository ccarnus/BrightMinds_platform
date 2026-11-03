const jwt = require('jsonwebtoken');
const config = require('../config');
const { HttpError } = require('../utils/http');

const signToken = (userId) =>
  jwt.sign({ userId: String(userId) }, config.auth.jwtSecret, {
    expiresIn: config.auth.jwtExpiresIn,
  });

const readBearerToken = (req) => {
  const [scheme, token] = (req.headers.authorization || '').split(' ');
  return scheme === 'Bearer' && token ? token : null;
};

/**
 * Decodes the Bearer token into `req.auth = { userId }`.
 * Rejects with 401 only when AUTH_REQUIRED=true, so clients can migrate gradually.
 */
const authenticate = (req, res, next) => {
  const token = readBearerToken(req);
  if (token) {
    try {
      req.auth = { userId: jwt.verify(token, config.auth.jwtSecret).userId };
    } catch {
      if (config.auth.required) return next(new HttpError(401, 'Invalid or expired token.'));
    }
  }
  if (config.auth.required && !req.auth) {
    return next(new HttpError(401, 'Authentication required.'));
  }
  return next();
};

/** Ensures the authenticated user matches `req.params[param]` (only enforced when AUTH_REQUIRED=true). */
const requireSelf =
  (param = 'id') =>
  (req, res, next) => {
    if (config.auth.required && req.auth?.userId !== req.params[param]) {
      return next(new HttpError(403, 'You can only access your own account.'));
    }
    return next();
  };

module.exports = { signToken, authenticate, requireSelf };
