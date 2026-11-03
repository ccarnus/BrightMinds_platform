const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../../app');
const User = require('../../models/user_model');
const { sentMessages } = require('../../services/mailer');
const { useTestDatabase } = require('../helpers/db');
const {
  PNG_BYTES,
  MEDIA_DIRS,
  createUser,
  createMediaFile,
  mediaFileExists,
} = require('../helpers/fixtures');

useTestDatabase();

beforeEach(() => {
  sentMessages.length = 0;
});

const SECRET_FIELDS = [
  'password',
  'verificationToken',
  'resetPasswordToken',
  'resetPasswordExpires',
];

const signup = (user, { withImage = true } = {}) => {
  const req = request(app).post('/user/signup').field('user', JSON.stringify(user));
  return withImage
    ? req.attach('image', PNG_BYTES, { filename: 'me.png', contentType: 'image/png' })
    : req;
};

const validSignup = {
  email: 'New.User@Example.com',
  password: 'secret123',
  username: 'newuser',
  role: 'Professor',
  university: 'MIT',
  objective: 'Career',
};

describe('POST /user/signup', () => {
  test('creates an unverified user, stores the picture and sends a verification email', async () => {
    const res = await signup(validSignup).expect(201);
    expect(res.body.response).toMatch(/check your email/);

    const user = await User.findOne({ email: 'new.user@example.com' });
    expect(user.isVerified).toBe(false);
    expect(user.university).toBe('MIT');
    expect(user.tracking.objective).toBe('Career');
    expect(user.tracking.target).toBe(50);
    expect(await bcrypt.compare('secret123', user.password)).toBe(true);
    expect(user.profilePictureUrl).toMatch(
      /^http:\/\/api\.test\/backend\/media\/profile_pictures\/me_.*\.png$/
    );
    expect(
      mediaFileExists(MEDIA_DIRS.profilePictures, user.profilePictureUrl.split('/').pop())
    ).toBe(true);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('new.user@example.com');
    expect(sentMessages[0].html).toContain(`/user/confirmation/${user.verificationToken}`);
  });

  test('ignores university for roles that do not have one', async () => {
    await signup({ ...validSignup, role: 'College Student' }).expect(201);
    const user = await User.findOne({ email: 'new.user@example.com' });
    expect(user.university).toBeUndefined();
  });

  test('rejects a duplicate email (case-insensitive) with 409', async () => {
    await createUser({ email: 'new.user@example.com' });
    await signup(validSignup).expect(409);
    expect(sentMessages).toHaveLength(0);
  });

  test.each([
    ['invalid email', { email: 'nope' }],
    ['missing password', { password: '' }],
    ['invalid role', { role: 'Wizard' }],
  ])('rejects %s with 400', async (_label, override) => {
    await signup({ ...validSignup, ...override }).expect(400);
    expect(await User.countDocuments()).toBe(0);
  });

  test('requires a profile picture', async () => {
    await signup(validSignup, { withImage: false }).expect(400);
  });

  test('rejects non-image uploads', async () => {
    await request(app)
      .post('/user/signup')
      .field('user', JSON.stringify(validSignup))
      .attach('image', Buffer.from('<html>'), { filename: 'x.html', contentType: 'text/html' })
      .expect(400);
  });

  test('rejects malformed user JSON with 400', async () => {
    await request(app)
      .post('/user/signup')
      .field('user', '{not json')
      .attach('image', PNG_BYTES, { filename: 'me.png', contentType: 'image/png' })
      .expect(400);
  });
});

describe('GET /user/confirmation/:token', () => {
  test('verifies the account once', async () => {
    const user = await createUser({ isVerified: false, verificationToken: 'tok123' });

    const first = await request(app).get('/user/confirmation/tok123').expect(200);
    expect(first.text).toContain('Verification Successful');
    expect((await User.findById(user._id)).isVerified).toBe(true);

    const second = await request(app).get('/user/confirmation/tok123').expect(400);
    expect(second.text).toContain('Already Verified');
  });

  test('shows a failure page for unknown tokens', async () => {
    const res = await request(app).get('/user/confirmation/unknown').expect(400);
    expect(res.text).toContain('Verification Failed');
  });
});

describe('POST /user/login', () => {
  test('returns a token for valid credentials (email is case-insensitive)', async () => {
    const user = await createUser({ email: 'login@example.com', password: 'pw1234' });
    const res = await request(app)
      .post('/user/login')
      .send({ email: '  LOGIN@example.com ', password: 'pw1234' })
      .expect(200);
    expect(res.body.userId).toBe(user._id.toString());
    expect(res.body.token).toEqual(expect.any(String));
  });

  test('rejects unknown users and wrong passwords with 401', async () => {
    await createUser({ email: 'login@example.com', password: 'pw1234' });
    await request(app)
      .post('/user/login')
      .send({ email: 'x@example.com', password: 'pw1234' })
      .expect(401);
    await request(app)
      .post('/user/login')
      .send({ email: 'login@example.com', password: 'bad' })
      .expect(401);
  });

  test('rejects operator injection in the email field', async () => {
    await createUser({ password: 'pw1234' });
    await request(app)
      .post('/user/login')
      .send({ email: { $ne: null }, password: 'pw1234' })
      .expect(400);
  });
});

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

describe('password reset', () => {
  test('full flow: request email, open form, submit new password', async () => {
    const user = await createUser({ email: 'reset@example.com', password: 'old-password' });

    await request(app)
      .post('/user/reset-password-request')
      .send({ email: 'Reset@Example.com' })
      .expect(200);
    const { resetPasswordToken } = await User.findById(user._id);
    expect(sentMessages[0].html).toContain(`/user/reset-password/${resetPasswordToken}`);

    const form = await request(app).get(`/user/reset-password/${resetPasswordToken}`).expect(200);
    expect(form.text).toContain(`action="/user/reset-password/${resetPasswordToken}"`);

    await request(app)
      .post(`/user/reset-password/${resetPasswordToken}`)
      .type('form')
      .send({ password: 'new-password', confirmPassword: 'new-password' })
      .expect(200);

    const updated = await User.findById(user._id);
    expect(await bcrypt.compare('new-password', updated.password)).toBe(true);
    expect(updated.resetPasswordToken).toBeUndefined();

    // The token is single-use.
    await request(app).get(`/user/reset-password/${resetPasswordToken}`).expect(400);
  });

  test('request: 404 for unknown email, 400 for unverified account', async () => {
    await createUser({ email: 'unverified@example.com', isVerified: false });
    await request(app)
      .post('/user/reset-password-request')
      .send({ email: 'none@example.com' })
      .expect(404);
    await request(app)
      .post('/user/reset-password-request')
      .send({ email: 'unverified@example.com' })
      .expect(400);
  });

  test('rejects expired tokens', async () => {
    await createUser({ resetPasswordToken: 'expired', resetPasswordExpires: Date.now() - 1000 });
    const res = await request(app).get('/user/reset-password/expired').expect(400);
    expect(res.text).toContain('Invalid or Expired Link');
  });

  test.each([
    ['missing fields', {}, 'Invalid Submission'],
    ['mismatch', { password: 'abcd', confirmPassword: 'abce' }, 'Passwords Do Not Match'],
    ['too short', { password: 'abc', confirmPassword: 'abc' }, 'Password Too Short'],
  ])('rejects %s', async (_label, body, expected) => {
    await createUser({ resetPasswordToken: 'tok', resetPasswordExpires: Date.now() + 60000 });
    const res = await request(app)
      .post('/user/reset-password/tok')
      .type('form')
      .send(body)
      .expect(400);
    expect(res.text).toContain(expected);
  });
});
