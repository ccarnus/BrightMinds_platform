/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.js'],
  globalSetup: '<rootDir>/tests/helpers/global_setup.js',
  globalTeardown: '<rootDir>/tests/helpers/global_teardown.js',
  setupFiles: ['<rootDir>/tests/helpers/setup_env.js'],
  testTimeout: 30000,
  collectCoverageFrom: [
    'app.js',
    'config/**/*.js',
    'controllers/**/*.js',
    'middleware/**/*.js',
    'models/**/*.js',
    'queues/**/*.js',
    'routes/**/*.js',
    'services/**/*.js',
    'utils/**/*.js',
    'views/**/*.js',
  ],
};
