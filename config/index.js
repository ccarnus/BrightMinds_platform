// Single source of truth for runtime configuration. Never read process.env elsewhere.
const path = require('path');

// Tests must never pick up a developer's local .env (real DB, API keys).
if (process.env.NODE_ENV !== 'test' && !process.env.JEST_WORKER_ID) {
  require('dotenv').config();
}

const env = process.env.NODE_ENV || 'development';
const isTest = env === 'test';
const isProduction = env === 'production';
const port = Number(process.env.PORT) || 3000;

const stripTrailingSlash = (value) => value.replace(/\/+$/, '');

const config = {
  env,
  isTest,
  isProduction,
  port,
  mongoUri: process.env.MONGODB_URI,
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  // Public base URL used to build media links stored in the database.
  publicUrl: stripTrailingSlash(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`),
  websiteUrl: process.env.WEBSITE_URL || 'https://greenlights.us',
  mediaRoot: path.resolve(process.env.MEDIA_ROOT || path.join(__dirname, '..', 'backend', 'media')),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  // Number of reverse proxies in front of the app (needed for correct client IPs).
  trustProxy: Number(process.env.TRUST_PROXY) || 0,
  auth: {
    jwtSecret: process.env.JWT_SECRET || (isProduction ? undefined : 'dev-only-insecure-secret'),
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    // When false, auth middleware only decodes tokens; it does not reject requests.
    required: process.env.AUTH_REQUIRED === 'true',
    bcryptRounds: Number(process.env.BCRYPT_ROUNDS) || 12,
  },
  mail: {
    user: process.env.EMAIL_USER?.trim(),
    // Google shows app passwords in groups ("abcd efgh ijkl mnop"): the spaces are not part of it.
    password: process.env.EMAIL_PWD?.replace(/\s+/g, ''),
    fromName: process.env.EMAIL_FROM_NAME || 'BrightMinds Research',
    // Pause between the attempts at sending one email (only temporary failures are retried).
    retryDelayMs: 750,
  },
  // Account emails (verification link, password reset link).
  account: {
    // A user can use the app right away, so a verification link stays valid for a few days.
    verificationTtlMs: 72 * 60 * 60 * 1000,
    resetTtlMs: 60 * 60 * 1000,
    // Between two emails of the same kind to the same user, and at most this many per hour.
    emailCooldownMs: 60 * 1000,
    emailMaxPerHour: 5,
    // How long a request waits for the email to be handed to the provider before answering anyway.
    sendWaitMs: 10000,
  },
  alerts: {
    to: process.env.OPENAI_ALERT_EMAIL_TO || process.env.ALERT_EMAIL_TO,
    throttleMs: Number(process.env.OPENAI_ALERT_THROTTLE_MS) || 60 * 60 * 1000,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    // Quiz question, department and topic (structured outputs).
    chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-6.1-terra',
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'low',
    // whisper-1 is the only model returning timestamps (needed for subtitles). Others give text only.
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
  },
  ai: {
    // Daily re-run of the AI pipeline for content still missing outputs (cron syntax, server time).
    retryCron: process.env.AI_RETRY_CRON || '0 3 * * *',
    // Content-related failures (e.g. moderation) tolerated before an item is marked "failed".
    maxAttempts: Number(process.env.AI_MAX_ATTEMPTS) || 5,
  },
  // OpenAlex is the backbone of the research atlas. A free key (openalex.org/settings/api) lifts the
  // shared daily budget of keyless clients (one budget per IP address).
  openalex: {
    apiKey: process.env.OPENALEX_API_KEY?.trim(),
    // OR-filters over more than 10 topic ids are limited to one request per second.
    requestDelayMs:
      process.env.OPENALEX_REQUEST_DELAY_MS !== undefined
        ? Number(process.env.OPENALEX_REQUEST_DELAY_MS)
        : 1100,
  },
  // Research atlas: the topic catalog, its scores and the independent signals.
  atlas: {
    // Weekly refresh of the scores (cron syntax, server time).
    refreshCron: process.env.ATLAS_REFRESH_CRON || '0 2 * * 1',
    // The catalog (names, keywords, hierarchy) changes rarely.
    catalogMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
    metricsMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
    // Windows end on the first of a month at least this many days ago: recent works are still being indexed.
    lagDays: 30,
    // Topics per lab that are listed in the app besides the ones with casts.
    featuredPerLab: 12,
    // Topics per lab that also get the independent signals (PubMed, arXiv, Wikipedia).
    trackedPerLab: 15,
    // Contact sent to the free public APIs (Wikimedia and NCBI ask for one).
    contact: process.env.ATLAS_CONTACT || process.env.EMAIL_USER?.trim() || 'brightminds-app',
    ncbiApiKey: process.env.NCBI_API_KEY?.trim(),
  },
};

/** Throws if configuration required to boot the server is missing. */
config.validate = () => {
  const missing = [];
  if (!config.mongoUri) missing.push('MONGODB_URI');
  if (!config.auth.jwtSecret) missing.push('JWT_SECRET');
  if (isProduction && !process.env.PUBLIC_BASE_URL) missing.push('PUBLIC_BASE_URL');
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
};

module.exports = config;
