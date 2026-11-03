/** Error carrying an HTTP status; thrown from controllers and rendered by the error handler. */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const badRequest = (message) => new HttpError(400, message);
const notFound = (message) => new HttpError(404, message);

const isValidObjectId = (value) =>
  value !== null && value !== undefined && /^[a-f\d]{24}$/i.test(String(value));

/** Throws 400 unless `value` is a 24-char hex ObjectId. */
const assertObjectId = (value, label = 'id') => {
  if (!isValidObjectId(value)) {
    throw badRequest(`Invalid ${label}.`);
  }
};

/**
 * Multipart endpoints receive their payload as a JSON string in one form field
 * (e.g. `cast`, `user`). JSON requests may send it as an object. Returns {} if absent.
 */
const parseJsonField = (body, field) => {
  const raw = body?.[field];
  if (raw === undefined || raw === null || raw === '') {
    return {};
  }
  if (typeof raw === 'object') {
    return raw;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw badRequest(`Field "${field}" must be a JSON object.`);
  }
};

/** Returns a copy of `source` containing only `keys` that are not undefined. */
const pick = (source, keys) =>
  keys.reduce((acc, key) => {
    if (source?.[key] !== undefined) {
      acc[key] = source[key];
    }
    return acc;
  }, {});

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

module.exports = {
  HttpError,
  badRequest,
  notFound,
  isValidObjectId,
  assertObjectId,
  parseJsonField,
  pick,
  isNonEmptyString,
};
