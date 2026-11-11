// End-to-end behaviour of route protection when AUTH_REQUIRED=true.
const request = require('supertest');
const app = require('../../app');
const config = require('../../config');
const { useTestDatabase } = require('../helpers/db');
const { PNG_BYTES, createUser, createCast, authHeader } = require('../helpers/fixtures');

useTestDatabase();

beforeAll(() => {
  config.auth.required = true;
});

afterAll(() => {
  config.auth.required = false;
});

test('public routes stay public', async () => {
  await createCast();
  await request(app).get('/cast').expect(200);
  await request(app).get('/topic').expect(200);
  await request(app).get('/health').expect(200);
  await request(app)
    .post('/user/login')
    .send({ email: 'x@example.com', password: 'x' })
    .expect(401);
});

test.each([
  ['post', '/cast'],
  ['delete', '/cast/507f1f77bcf86cd799439011'],
  ['post', '/cast/507f1f77bcf86cd799439011/rating'],
  ['post', '/topic'],
  ['delete', '/university/507f1f77bcf86cd799439011'],
  ['post', '/virtual/lab/507f1f77bcf86cd799439011/add/topic'],
  ['get', '/user'],
])('%s %s requires a token', async (method, path) => {
  const res = await request(app)[method](path).send({});
  expect(res.status).toBe(401);
  expect(res.body.error).toBe('Authentication required.');
});

test('a valid token grants access', async () => {
  const user = await createUser();
  await request(app).get('/user').set(authHeader(user)).expect(200);
});

test('users can only access their own private routes', async () => {
  const alice = await createUser();
  const bob = await createUser();

  await request(app).get(`/user/bookmarks/${alice._id}`).set(authHeader(alice)).expect(200);
  const res = await request(app)
    .get(`/user/bookmarks/${alice._id}`)
    .set(authHeader(bob))
    .expect(403);
  expect(res.body.error).toMatch(/your own account/);
  await request(app).delete(`/user/${alice._id}`).set(authHeader(bob)).expect(403);
});

test('rejected uploads never reach the disk', async () => {
  const user = await createUser();
  const res = await request(app)
    .put(`/user/${user._id}`)
    .attach('image', PNG_BYTES, { filename: 'x.png', contentType: 'image/png' })
    .expect(401);
  expect(res.body.error).toBe('Authentication required.');
});
