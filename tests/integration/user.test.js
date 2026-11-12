const request = require('supertest');
const app = require('../../app');
const User = require('../../models/user_model');
const { useTestDatabase } = require('../helpers/db');
const {
  PNG_BYTES,
  MEDIA_DIRS,
  createUser,
  createMediaFile,
  mediaFileExists,
} = require('../helpers/fixtures');

useTestDatabase();

const SECRET_FIELDS = [
  'password',
  'verificationToken',
  'verificationExpires',
  'resetPasswordToken',
  'resetPasswordExpires',
  'mailThrottle',
];

describe('reading users', () => {
  test('GET /user/:id never exposes secrets', async () => {
    const user = await createUser({
      verificationToken: 'secret-token',
      resetPasswordToken: 'reset',
    });
    const res = await request(app).get(`/user/${user._id}`).expect(200);
    expect(res.body.email).toBe(user.email);
    SECRET_FIELDS.forEach((field) => expect(res.body).not.toHaveProperty(field));
  });

  test('GET /user never exposes secrets', async () => {
    await createUser({ verificationToken: 'secret-token' });
    const res = await request(app).get('/user').expect(200);
    expect(res.body).toHaveLength(1);
    SECRET_FIELDS.forEach((field) => expect(res.body[0]).not.toHaveProperty(field));
  });

  test('returns 404 for an unknown id and 400 for a malformed id', async () => {
    await request(app).get('/user/507f1f77bcf86cd799439011').expect(404);
    await request(app).get('/user/not-an-id').expect(400);
  });
});

describe('PUT /user/:id', () => {
  test('updates whitelisted fields only and never returns the password', async () => {
    const user = await createUser();
    const res = await request(app)
      .put(`/user/${user._id}`)
      .send({ user: { username: 'renamed', isVerified: false, password: 'hacked' } })
      .expect(200);
    expect(res.body.user.username).toBe('renamed');
    expect(res.body.user).not.toHaveProperty('password');

    const updated = await User.findById(user._id);
    expect(updated.isVerified).toBe(true);
    expect(updated.password).toBe(user.password);
  });

  test('replaces the profile picture and deletes the old file', async () => {
    const oldUrl = createMediaFile(MEDIA_DIRS.profilePictures, 'old.png');
    const user = await createUser({ profilePictureUrl: oldUrl });
    await request(app)
      .put(`/user/${user._id}`)
      .field('user', JSON.stringify({ username: 'pic' }))
      .attach('image', PNG_BYTES, { filename: 'new.png', contentType: 'image/png' })
      .expect(200);

    const updated = await User.findById(user._id);
    expect(updated.profilePictureUrl).not.toBe(oldUrl);
    expect(mediaFileExists(MEDIA_DIRS.profilePictures, 'old.png')).toBe(false);
  });

  test('rejects an invalid email', async () => {
    const user = await createUser();
    await request(app)
      .put(`/user/${user._id}`)
      .send({ user: { email: 'nope' } })
      .expect(400);
  });
});

describe('DELETE /user/:id', () => {
  test('deletes the user and the profile picture', async () => {
    const url = createMediaFile(MEDIA_DIRS.profilePictures, 'del.png');
    const user = await createUser({ profilePictureUrl: url });
    await request(app).delete(`/user/${user._id}`).expect(200);
    expect(await User.findById(user._id)).toBeNull();
    expect(mediaFileExists(MEDIA_DIRS.profilePictures, 'del.png')).toBe(false);
  });

  test('returns 404 for an unknown user (used to crash the process)', async () => {
    await request(app).delete('/user/507f1f77bcf86cd799439011').expect(404);
  });
});
