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
    chatModel: process.env.OPENAI_CHAT_MODEL || 'gpt-4',
    imageModel: process.env.OPENAI_IMAGE_MODEL || 'dall-e-3',
    transcriptionModel: process.env.OPENAI_TRANSCRIPTION_MODEL || 'whisper-1',
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
