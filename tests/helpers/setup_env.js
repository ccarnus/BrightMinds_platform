// Runs before each test file, before any app module is required.
const os = require('os');
const path = require('path');

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.BCRYPT_ROUNDS = '4';
process.env.OPENALEX_REQUEST_DELAY_MS = '0';
delete process.env.OPENALEX_API_KEY;
process.env.PUBLIC_BASE_URL = 'http://api.test';
process.env.AUTH_REQUIRED = 'false';
process.env.MEDIA_ROOT = path.join(
  os.tmpdir(),
  'brightminds-test-media',
  String(process.env.JEST_WORKER_ID || 0)
);
delete process.env.OPENAI_API_KEY;
delete process.env.MONGODB_URI;

// Keep test output readable; set VERBOSE_TESTS=1 to see application logs.
if (!process.env.VERBOSE_TESTS) {
  console.log = () => {};
  console.info = () => {};
}
