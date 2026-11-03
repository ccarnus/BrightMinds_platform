const mongoose = require('mongoose');
const { HttpError } = require('../utils/http');
const { deleteFile } = require('../services/media');

const notFoundHandler = (req, res) => {
  const message = `Route not found: ${req.method} ${req.path}`;
  res.status(404).json({ error: message, message });
};

const toHttpError = (error) => {
  if (error instanceof HttpError) return error;
  if (error instanceof mongoose.Error.ValidationError) return new HttpError(400, error.message);
  if (error instanceof mongoose.Error.CastError)
    return new HttpError(400, `Invalid ${error.path}.`);
  if (error?.code === 11000) return new HttpError(409, 'Resource already exists.');
  // body-parser errors (malformed JSON, payload too large) carry their own status.
  if (error?.type && Number.isInteger(error.status) && error.status < 500) {
    return new HttpError(error.status, error.message);
  }
  return null;
};

// Express recognises error handlers by their 4-argument signature.
const errorHandler = async (error, req, res, next) => {
  // Never keep an upload whose request failed.
  if (req.file?.path) {
    await deleteFile(req.file.path);
  }

  const httpError = toHttpError(error);
  if (!httpError) {
    console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, error);
  }
  if (res.headersSent) return;

  const status = httpError?.status ?? 500;
  const message = httpError?.message ?? 'Internal server error.';
  // Both keys: legacy endpoints returned errors as `error` or `message`, clients read either.
  res.status(status).json({ error: message, message });
};

module.exports = { notFoundHandler, errorHandler };
