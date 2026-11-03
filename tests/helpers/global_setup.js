// Starts one in-memory MongoDB for the whole test run. Each test file uses its own database.
const { MongoMemoryServer } = require('mongodb-memory-server');

module.exports = async () => {
  const mongoServer = await MongoMemoryServer.create();
  globalThis.__MONGO_SERVER__ = mongoServer;
  process.env.TEST_MONGODB_URI = mongoServer.getUri();
};
