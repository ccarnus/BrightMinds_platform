const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../../app');
const { useTestDatabase } = require('../helpers/db');
const { MEDIA_DIRS, createMediaFile } = require('../helpers/fixtures');

describe('with a database', () => {
  useTestDatabase();

  test('GET /health reports ok when MongoDB is connected', async () => {
    const res = await request(app).get('/health').expect(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/does/not/exist').expect(404);
    expect(res.body.error).toMatch(/Route not found/);
  });

  test('malformed JSON bodies return 400, not 500', async () => {
    await request(app)
      .post('/user/login')
      .set('Content-Type', 'application/json')
      .send('{"email":')
      .expect(400);
  });

  test('CORS preflight is answered with 204', async () => {
    const res = await request(app).options('/cast').expect(204);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-headers']).toMatch(/Authorization/);
  });

  test('security headers are set and x-powered-by is hidden', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('media files are served statically', async () => {
    createMediaFile(MEDIA_DIRS.castImages, 'served.jpg', 'image-bytes');
    const res = await request(app).get('/backend/media/cast_images/served.jpg').expect(200);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });

  test('static media cannot be used to read files outside the media root', async () => {
    await request(app).get('/backend/media/..%2F..%2Fpackage.json').expect(404);
    await request(app).get('/backend/media/cast_images/..%2F..%2F..%2Fpackage.json').expect(404);
  });
});

describe('without a database', () => {
  test('GET /health returns 503 when MongoDB is down', async () => {
    expect(mongoose.connection.readyState).toBe(0);
    const res = await request(app).get('/health').expect(503);
    expect(res.body.db).toBe('down');
  });
});
