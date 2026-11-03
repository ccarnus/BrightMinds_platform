const crypto = require('crypto');
const mongoose = require('mongoose');

/** Connects mongoose to a fresh database for the current test file and wipes it between tests. */
const useTestDatabase = () => {
  beforeAll(async () => {
    const dbName = `test_${crypto.randomBytes(6).toString('hex')}`;
    await mongoose.connect(process.env.TEST_MONGODB_URI, { dbName });
  });

  afterEach(async () => {
    const collections = Object.values(mongoose.connection.collections);
    await Promise.all(collections.map((collection) => collection.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
};

module.exports = { useTestDatabase };
