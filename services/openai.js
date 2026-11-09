// OpenAI access for the AI pipeline. Every call goes through callOpenAI(), which turns failures into
// an AIError with a `kind` that decides what happens next:
//   config    — missing/invalid key, no credit, unknown model, rejected request: alert, pause calls
//   transient — OpenAI unreachable, timeout, rate limit, 5xx: the job queue retries with backoff
//   content   — this item cannot be processed (moderation refusal, unusable output, bad video)
// Whatever the kind, content left unprocessed is picked up again by the daily retry (ai_retry.js).
const config = require('../config');
const { alertOpenAIProblem } = require('./openai_alerts');

const PAUSE_AFTER_CONFIG_ERROR_MS = 60 * 60 * 1000;
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

class AIError extends Error {
  /** @param {'config'|'transient'|'content'} kind */
  constructor(kind, message, { operation, status, code, cause } = {}) {
    super(message, { cause });
    this.name = 'AIError';
    this.kind = kind;
    this.operation = operation;
    this.status = status;
    this.code = code;
  }
}

let client;
let pausedUntil = 0;
let pauseReason = '';

const getOpenAIClient = () => {
  if (!client) {
    const OpenAI = require('openai');
    // The SDK already retries connection errors, 408/409/429/5xx twice with backoff.
    client = new OpenAI({ apiKey: config.openai.apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 });
  }
  return client;
};

const errorCode = (error) =>
  error?.code ?? error?.error?.code ?? error?.response?.data?.error?.code ?? null;
const errorStatus = (error) => error?.status ?? error?.response?.status ?? null;

/**
 * Maps an OpenAI SDK / axios / network error to an AIError kind.
 * @returns {'config'|'transient'|'content'}
 */
const classifyError = (error) => {
  if (error instanceof AIError) return error.kind;
  const status = errorStatus(error);
  const code = String(errorCode(error) ?? '');
  if (!status) {
    // The SDK's APIConnectionError / APIConnectionTimeoutError keep the default Error name.
    const name = String(error?.constructor?.name ?? '');
    const causeCode = error?.cause?.code;
    if (
      name.startsWith('APIConnection') ||
      NETWORK_ERROR_CODES.has(code) ||
      NETWORK_ERROR_CODES.has(causeCode)
    ) {
      return 'transient';
    }
    return 'content'; // local failure on this item (e.g. ffmpeg on a corrupt video)
  }
  if (status === 429) return code === 'insufficient_quota' ? 'config' : 'transient';
  if (status === 408 || status === 409 || status >= 500) return 'transient';
  if (status === 400 || status === 422) {
    const text = `${code} ${error?.message ?? ''}`;
    return /content_policy|moderation|safety/i.test(text) ? 'content' : 'config';
  }
  if ([401, 403, 404].includes(status)) return 'config';
  return 'content';
};

const isOpenAIPaused = () => Date.now() < pausedUntil;

/** Lifts the pause set after a configuration error (e.g. once the key has been fixed). */
const resumeOpenAI = () => {
  pausedUntil = 0;
  pauseReason = '';
};

/**
 * Throws (config AIError) when OpenAI can't be called: no key, or paused after a config error.
 * Call it before expensive local work whose only purpose is an OpenAI request.
 */
const assertOpenAIAvailable = async (operation) => {
  if (!config.openai.apiKey) {
    const error = new AIError('config', 'OpenAI API key not configured (OPENAI_API_KEY).', {
      operation,
    });
    await alertOpenAIProblem(error);
    throw error;
  }
  if (isOpenAIPaused()) {
    throw new AIError('config', `OpenAI calls paused after an error: ${pauseReason}`, {
      operation,
    });
  }
};

/**
 * Runs `fn(client)` and normalizes failures to AIError. Configuration errors send an alert and
 * pause OpenAI calls for an hour, so a bad key doesn't make every queued item fail one by one.
 */
const callOpenAI = async (operation, fn) => {
  await assertOpenAIAvailable(operation);
  try {
    return await fn(getOpenAIClient());
  } catch (error) {
    const kind = classifyError(error);
    const status = errorStatus(error);
    const aiError = new AIError(
      kind,
      `${operation} failed${status ? ` (HTTP ${status})` : ''}: ${error?.message || error}`,
      { operation, status, code: errorCode(error), cause: error }
    );
    if (kind === 'config') {
      pausedUntil = Date.now() + PAUSE_AFTER_CONFIG_ERROR_MS;
      pauseReason = aiError.message;
      await alertOpenAIProblem(aiError);
    }
    throw aiError;
  }
};

module.exports = {
  AIError,
  assertOpenAIAvailable,
  callOpenAI,
  classifyError,
  getOpenAIClient,
  isOpenAIPaused,
  resumeOpenAI,
};
