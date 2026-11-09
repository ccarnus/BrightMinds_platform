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
  },
  mail: {
    user: process.env.EMAIL_USER,
    password: process.env.EMAIL_PWD,
  },
  alerts: {
    to: process.env.OPENAI_ALERT_EMAIL_TO || process.env.ALERT_EMAIL_TO,
    throttleMs: Number(process.env.OPENAI_ALERT_THROTTLE_MS) || 60 * 60 * 1000,
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    // Quiz, department, topic and image brief (structured outputs).
    chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-6.1-terra',
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT || 'low',
    imageModel: process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2.6-flare',
    imageQuality: process.env.OPENAI_IMAGE_QUALITY || 'medium',
    // whisper-1 is the only model returning timestamps (needed for subtitles). Others give text only.
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
  },
  ai: {
    // Daily re-run of the AI pipeline for content still missing outputs (cron syntax, server time).
    retryCron: process.env.AI_RETRY_CRON || '0 3 * * *',
    // Content-related failures (e.g. moderation) tolerated before an item is marked "failed".
    maxAttempts: Number(process.env.AI_MAX_ATTEMPTS) || 5,
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
