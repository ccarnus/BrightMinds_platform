const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const User = require('../models/user_model.js');
const Cast = require('../models/cast_model.js');

jest.setTimeout(30000);

let mongoServer;
let app;

const waitForMongooseConnection = () => {
  if (mongoose.connection.readyState === 1) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    mongoose.connection.once('open', resolve);
    mongoose.connection.once('error', reject);
  });
};

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  if (!process.env.MONGODB_URI) {
    mongoServer = await MongoMemoryServer.create();
    process.env.MONGODB_URI = mongoServer.getUri();
  }

  app = require('../app');
  await waitForMongooseConnection();
});

afterEach(async () => {
  if (mongoose.connection.readyState === 1) {
    await mongoose.connection.db.dropDatabase();
  }
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

test('deleting a cast removes all user references', async () => {
  const user = await User.create({
    email: 'test.user@example.com',
    password: 'hashed-password',
    username: 'testuser',
    role: 'College Student',
    profilePictureUrl: 'http://example.com/profile.png'
  });

  const cast = await Cast.create({
    title: 'Test Cast',
    description: 'Test description',
    department: 'Physics',
    brightmindid: user._id.toString(),
    casturl: 'http://example.com/no-video',
    castimageurl: 'http://example.com/no-image',
    university: 'Test University',
    category: 'Test Category',
    visibility: 'public',
    duration: 120,
    topic: 'Test Topic'
  });

  user.evaluation_list.push({
    contentid: cast._id.toString(),
    type: 'cast',
    watched: true,
    answered: false
  });
  user.bookmarkedcontent.push({ contentid: cast._id.toString() });
  user.castPublications.push(cast._id);
  await user.save();

  await request(app)
    .delete(`/cast/${cast._id.toString()}`)
    .expect(200);

  const updatedUser = await User.findById(user._id).lean();
  expect(updatedUser).not.toBeNull();

  const castIdString = cast._id.toString();
  expect(updatedUser.evaluation_list.some(entry => entry.contentid === castIdString)).toBe(false);
  expect(updatedUser.bookmarkedcontent.some(entry => entry.contentid === castIdString)).toBe(false);
  expect(updatedUser.castPublications.map(id => id.toString())).not.toContain(castIdString);

  const deletedCast = await Cast.findById(cast._id);
  expect(deletedCast).toBeNull();
});
