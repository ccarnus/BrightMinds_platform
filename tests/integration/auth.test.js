const request = require('supertest');
const bcrypt = require('bcrypt');
const app = require('../../app');
const config = require('../../config');
const User = require('../../models/user_model');
const { sentMessages } = require('../../services/mailer');
const { hashToken } = require('../../services/email_tokens');
const { signToken } = require('../../middleware/auth');
const { useTestDatabase } = require('../helpers/db');
const { PNG_BYTES, MEDIA_DIRS, createUser, mediaFileExists } = require('../helpers/fixtures');

useTestDatabase();

const ACCOUNT_CONFIG = { ...config.account };

beforeEach(() => {
  sentMessages.length = 0;
  Object.assign(config.account, ACCOUNT_CONFIG);
});

// Some emails (notices, reset links) are sent after the response: let them finish before the next test.
afterEach(() => new Promise((resolve) => setTimeout(resolve, 100)));

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
  path: 'deep_learner',
  focusField: 'Chemistry',
};

// The send of a reset email is not awaited by the request.
const waitFor = async (condition) => {
  for (let i = 0; i < 100; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Condition not met in time.');
};

const linkToken = (message, route) =>
  new RegExp(`/user/${route}/([A-Za-z0-9_-]+)`).exec(message.text)[1];

const login = (email, password) => request(app).post('/user/login').send({ email, password });

describe('POST /user/signup', () => {
  test('creates an account that is usable at once and emails a confirmation link', async () => {
    const res = await signup(validSignup).expect(201);
    expect(res.body).toMatchObject({
      email: 'new.user@example.com',
      isVerified: false,
      emailSent: true,
      emailStatus: 'sent',
    });
    expect(res.body.response).toMatch(/already use BrightMinds/);
    expect(res.body.token).toEqual(expect.any(String));

    const user = await User.findOne({ email: 'new.user@example.com' });
    expect(res.body.userId).toBe(user._id.toString());
    expect(user.isVerified).toBe(false);
    expect(user.university).toBe('MIT');
    expect(user.learning).toMatchObject({
      version: 1,
      path: 'deep_learner',
      focusField: 'Chemistry',
    });
    expect(user.learning.startedAt).toBeInstanceOf(Date);
    expect(await bcrypt.compare('secret123', user.password)).toBe(true);
    expect(user.profilePictureUrl).toMatch(
      /^http:\/\/api\.test\/backend\/media\/profile_pictures\/me_.*\.png$/
    );
    expect(
      mediaFileExists(MEDIA_DIRS.profilePictures, user.profilePictureUrl.split('/').pop())
    ).toBe(true);

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].to).toBe('new.user@example.com');
    const token = linkToken(sentMessages[0], 'confirmation');
    expect(sentMessages[0].html).toContain(`/user/confirmation/${token}`);
    // Only a hash of the link token is stored.
    expect(user.verificationToken).toBe(hashToken(token));
    expect(user.verificationExpires.getTime()).toBeGreaterThan(Date.now());
  });

  test('the returned token works while the email is still unconfirmed', async () => {
    const previous = config.auth.required;
    config.auth.required = true;
    try {
      const res = await signup(validSignup).expect(201);
      await request(app)
        .get(`/user/${res.body.userId}`)
        .set('Authorization', `Bearer ${res.body.token}`)
        .expect(200);
    } finally {
      config.auth.required = previous;
    }
  });

  test('ignores university for roles that do not have one', async () => {
    await signup({ ...validSignup, role: 'College Student' }).expect(201);
    const user = await User.findOne({ email: 'new.user@example.com' });
    expect(user.university).toBeUndefined();
  });

  test('cleans the display name', async () => {
    await signup({ ...validSignup, username: '  Ada \n  Lovelace\u200B ' }).expect(201);
    expect((await User.findOne()).username).toBe('Ada Lovelace');
  });

  test('the learning path is optional; legacy and retired objectives are handled', async () => {
    await signup({ ...validSignup, email: 'a@example.com', path: undefined }).expect(201);
    await signup({
      ...validSignup,
      email: 'b@example.com',
      path: undefined,
      objective: 'DeepLearner',
    }).expect(201);
    await signup({
      ...validSignup,
      email: 'c@example.com',
      path: undefined,
      objective: 'Career',
    }).expect(201);
    const [a, b, c] = await Promise.all(
      ['a', 'b', 'c'].map((name) => User.findOne({ email: `${name}@example.com` }))
    );
    expect(a.learning).toMatchObject({ version: 1, path: null });
    expect(b.learning).toMatchObject({ path: 'deep_learner', focusField: 'Chemistry' });
    // Career was retired: the user picks a path during onboarding.
    expect(c.learning.path).toBeNull();
  });

  test('rejects a duplicate email (case-insensitive) with 409', async () => {
    await createUser({ email: 'new.user@example.com' });
    await signup(validSignup).expect(409);
    expect(sentMessages).toHaveLength(0);
  });

  test('two simultaneous signups with one email create a single account', async () => {
    await User.init();
    const results = await Promise.all([signup(validSignup), signup(validSignup)]);
    expect(results.map((res) => res.status).sort()).toEqual([201, 409]);
    expect(await User.countDocuments()).toBe(1);
  });

  test.each([
    ['invalid email', { email: 'nope' }],
    ['email without a real domain', { email: 'me@localhost' }],
    ['missing password', { password: '' }],
    ['password that is too short', { password: 'abc123' }],
    ['password of spaces', { password: '          ' }],
    ['common password', { password: 'password123' }],
    ['password equal to the email', { email: 'me@example.com', password: 'me@example.com' }],
    ['password longer than bcrypt reads', { password: 'a1'.repeat(40) }],
    ['missing name', { username: ' ' }],
    ['one-letter name', { username: 'A' }],
    ['too long name', { username: 'x'.repeat(51) }],
    ['invalid role', { role: 'Wizard' }],
    ['non-string password', { password: 12345678 }],
  ])('rejects %s with 400', async (_label, override) => {
    await signup({ ...validSignup, ...override }).expect(400);
    expect(await User.countDocuments()).toBe(0);
    expect(sentMessages).toHaveLength(0);
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
  const createPending = async (extra = {}) => {
    const token = 'a1b2c3d4e5f6';
    const user = await createUser({
      isVerified: false,
      verificationToken: hashToken(token),
      verificationExpires: new Date(Date.now() + 60000),
      ...extra,
    });
    return { user, token };
  };

  test('confirms the account; opening the link again says it is already confirmed', async () => {
    const { user, token } = await createPending();

    const first = await request(app).get(`/user/confirmation/${token}`).expect(200);
    expect(first.text).toContain('Email confirmed');
    expect(first.headers['cache-control']).toBe('no-store');
    const confirmed = await User.findById(user._id);
    expect(confirmed.isVerified).toBe(true);
    expect(confirmed.verifiedAt).toBeInstanceOf(Date);

    const second = await request(app).get(`/user/confirmation/${token}`).expect(200);
    expect(second.text).toContain('Already confirmed');
  });

  test('refuses an expired link and leaves the account unconfirmed', async () => {
    const { user, token } = await createPending({ verificationExpires: new Date(Date.now() - 1) });
    const res = await request(app).get(`/user/confirmation/${token}`).expect(400);
    expect(res.text).toContain('Link expired');
    expect((await User.findById(user._id)).isVerified).toBe(false);
  });

  test('still accepts a link sent before tokens were hashed', async () => {
    const user = await createUser({ isVerified: false, verificationToken: 'tok123' });
    await request(app).get('/user/confirmation/tok123').expect(200);
    expect((await User.findById(user._id)).isVerified).toBe(true);
  });

  test.each(['unknown', 'not.a.token', '%24ne'])('shows a failure page for %s', async (token) => {
    const res = await request(app).get(`/user/confirmation/${token}`).expect(400);
    expect(res.text).toContain('Link not valid');
  });
});

describe('POST /user/login', () => {
  test('returns the session for valid credentials (email is case-insensitive)', async () => {
    const user = await createUser({ email: 'login@example.com', password: 'pw1234' });
    const res = await login('  LOGIN@example.com ', 'pw1234').expect(200);
    expect(res.body).toMatchObject({
      userId: user._id.toString(),
      email: 'login@example.com',
      isVerified: true,
    });
    expect(res.body.token).toEqual(expect.any(String));
    expect((await User.findById(user._id)).lastLoginAt).toBeInstanceOf(Date);
  });

  test('an unconfirmed account can log in', async () => {
    await createUser({ email: 'pending@example.com', password: 'pw1234', isVerified: false });
    const res = await login('pending@example.com', 'pw1234').expect(200);
    expect(res.body.isVerified).toBe(false);
  });

  test('accounts saved with capital letters before emails were normalized still log in', async () => {
    const user = await createUser({ email: 'legacy@example.com', password: 'pw1234' });
    await User.collection.updateOne({ _id: user._id }, { $set: { email: 'Legacy@Example.com' } });
    await login('legacy@example.com', 'pw1234').expect(200);
  });

  test('an unknown email and a wrong password look the same', async () => {
    await createUser({ email: 'login@example.com', password: 'pw1234' });
    const unknown = await login('x@example.com', 'pw1234').expect(401);
    const wrong = await login('login@example.com', 'bad').expect(401);
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.body.message).toBe('Incorrect email or password.');
  });

  test('a huge password is refused without being hashed', async () => {
    await createUser({ email: 'login@example.com', password: 'pw1234' });
    await login('login@example.com', 'a'.repeat(5000)).expect(401);
  });

  test.each([
    ['missing password', { email: 'a@example.com' }],
    ['missing email', { password: 'pw1234' }],
    ['blank email', { email: '  ', password: 'pw1234' }],
    ['malformed email', { email: 'not-an-email', password: 'pw1234' }],
    ['operator injection in the email', { email: { $ne: null }, password: 'pw1234' }],
    ['operator injection in the password', { email: 'a@example.com', password: { $ne: null } }],
  ])('rejects %s with 400', async (_label, body) => {
    await request(app).post('/user/login').send(body).expect(400);
  });

  test('rejects an empty body with 400', async () => {
    await request(app).post('/user/login').expect(400);
  });
});

describe('POST /user/:id/verification/resend', () => {
  const authed = (req, user) => req.set('Authorization', `Bearer ${signToken(user._id)}`);

  test('sends a new link and replaces the previous one', async () => {
    const user = await createUser({ isVerified: false });
    const res = await authed(
      request(app).post(`/user/${user._id}/verification/resend`),
      user
    ).expect(200);
    expect(res.body).toMatchObject({ emailStatus: 'sent', isVerified: false });
    expect(sentMessages).toHaveLength(1);
    const token = linkToken(sentMessages[0], 'confirmation');
    expect((await User.findById(user._id)).verificationToken).toBe(hashToken(token));
  });

  test('asks to wait when requested again too soon', async () => {
    const user = await createUser({ isVerified: false });
    const url = `/user/${user._id}/verification/resend`;
    await authed(request(app).post(url), user).expect(200);
    const res = await authed(request(app).post(url), user).expect(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBe(String(res.body.retryAfterSeconds));
    expect(sentMessages).toHaveLength(1);
  });

  test('is limited per hour even without a cooldown', async () => {
    config.account.emailCooldownMs = 0;
    config.account.emailMaxPerHour = 2;
    const user = await createUser({ isVerified: false });
    const url = `/user/${user._id}/verification/resend`;
    await authed(request(app).post(url), user).expect(200);
    await authed(request(app).post(url), user).expect(200);
    await authed(request(app).post(url), user).expect(429);
    expect(sentMessages).toHaveLength(2);
  });

  test('sends nothing for a confirmed account', async () => {
    const user = await createUser();
    const res = await authed(
      request(app).post(`/user/${user._id}/verification/resend`),
      user
    ).expect(200);
    expect(res.body.isVerified).toBe(true);
    expect(sentMessages).toHaveLength(0);
  });

  test("cannot be used for someone else's account", async () => {
    const previous = config.auth.required;
    config.auth.required = true;
    try {
      const user = await createUser({ isVerified: false });
      const other = await createUser({ email: 'other@example.com' });
      await authed(request(app).post(`/user/${user._id}/verification/resend`), other).expect(403);
      await request(app).post(`/user/${user._id}/verification/resend`).expect(401);
    } finally {
      config.auth.required = previous;
    }
  });
});

describe('password reset', () => {
  const requestReset = (email) => request(app).post('/user/reset-password-request').send({ email });
  const submit = (token, body) =>
    request(app).post(`/user/reset-password/${token}`).type('form').send(body);

  test('full flow: request email, open form, submit new password', async () => {
    const user = await createUser({ email: 'reset@example.com', password: 'old-password' });

    const res = await requestReset('Reset@Example.com').expect(200);
    expect(res.body.message).toMatch(/If an account exists/);
    await waitFor(() => sentMessages.length === 1);
    expect(sentMessages[0].to).toBe('reset@example.com');
    const token = linkToken(sentMessages[0], 'reset-password');
    expect((await User.findById(user._id)).resetPasswordToken).toBe(hashToken(token));

    const form = await request(app).get(`/user/reset-password/${token}`).expect(200);
    expect(form.text).toContain(`action="/user/reset-password/${token}"`);
    expect(form.headers['cache-control']).toBe('no-store');

    await submit(token, { password: 'new-password', confirmPassword: 'new-password' }).expect(200);

    const updated = await User.findById(user._id);
    expect(await bcrypt.compare('new-password', updated.password)).toBe(true);
    expect(updated.resetPasswordToken).toBeUndefined();
    expect(updated.passwordChangedAt).toBeInstanceOf(Date);
    await login('reset@example.com', 'new-password').expect(200);
    await login('reset@example.com', 'old-password').expect(401);

    // The user is told, and the link is single-use.
    await waitFor(() => sentMessages.length === 2);
    expect(sentMessages[1].subject).toMatch(/password was changed/);
    await request(app).get(`/user/reset-password/${token}`).expect(400);
  });

  test('answers the same for unknown emails and sends nothing', async () => {
    await createUser({ email: 'known@example.com' });
    const known = await requestReset('known@example.com').expect(200);
    const unknown = await requestReset('none@example.com').expect(200);
    expect(unknown.body).toEqual(known.body);
    await waitFor(() => sentMessages.length === 1);
    expect(sentMessages.map((message) => message.to)).toEqual(['known@example.com']);
  });

  test('works for an account whose email was never confirmed, and confirms it', async () => {
    const user = await createUser({ email: 'pending@example.com', isVerified: false });
    await requestReset('pending@example.com').expect(200);
    await waitFor(() => sentMessages.length === 1);
    const token = linkToken(sentMessages[0], 'reset-password');
    await submit(token, { password: 'new-password', confirmPassword: 'new-password' }).expect(200);
    expect((await User.findById(user._id)).isVerified).toBe(true);
  });

  test('sends a single email for repeated requests', async () => {
    await createUser({ email: 'twice@example.com' });
    await requestReset('twice@example.com').expect(200);
    await requestReset('twice@example.com').expect(200);
    await waitFor(() => sentMessages.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sentMessages).toHaveLength(1);
  });

  test.each([
    ['a malformed email', { email: 'nope' }],
    ['a missing email', {}],
    ['an operator injection', { email: { $ne: null } }],
  ])('rejects %s with 400', async (_label, body) => {
    await request(app).post('/user/reset-password-request').send(body).expect(400);
  });

  test('rejects expired, unknown and malformed links', async () => {
    await createUser({
      resetPasswordToken: hashToken('expired'),
      resetPasswordExpires: Date.now() - 1000,
    });
    for (const token of ['expired', 'unknown', 'bad.token']) {
      const res = await request(app).get(`/user/reset-password/${token}`).expect(400);
      expect(res.text).toContain('Link expired');
    }
  });

  test('still accepts a link sent before tokens were hashed', async () => {
    await createUser({ resetPasswordToken: 'legacy', resetPasswordExpires: Date.now() + 60000 });
    await request(app).get('/user/reset-password/legacy').expect(200);
  });

  test.each([
    ['missing fields', {}, 'fill in both'],
    ['mismatch', { password: 'abcd1234', confirmPassword: 'abcd1235' }, 'do not match'],
    ['too short', { password: 'abc', confirmPassword: 'abc' }, 'at least 8'],
    ['too easy', { password: 'password', confirmPassword: 'password' }, 'too easy to guess'],
  ])('re-displays the form for %s', async (_label, body, expected) => {
    const user = await createUser({
      resetPasswordToken: hashToken('tok'),
      resetPasswordExpires: Date.now() + 60000,
    });
    const res = await submit('tok', body).expect(400);
    expect(res.text).toContain(expected);
    expect(res.text).toContain('action="/user/reset-password/tok"');
    // The link stays usable after a refused attempt.
    expect((await User.findById(user._id)).resetPasswordToken).toBe(hashToken('tok'));
  });

  test('two simultaneous submissions with one link: only one wins', async () => {
    await createUser({
      resetPasswordToken: hashToken('race'),
      resetPasswordExpires: Date.now() + 60000,
    });
    const body = { password: 'new-password', confirmPassword: 'new-password' };
    const results = await Promise.all([submit('race', body), submit('race', body)]);
    expect(results.map((res) => res.status).sort()).toEqual([200, 400]);
  });
});

describe('changing the email address', () => {
  test('requires confirming the new address and keeps the account usable', async () => {
    const user = await createUser({ email: 'old@example.com' });
    await request(app)
      .put(`/user/${user._id}`)
      .send({ user: { email: 'New@Example.com' } })
      .expect(200);
    const updated = await User.findById(user._id);
    expect(updated.email).toBe('new@example.com');
    expect(updated.isVerified).toBe(false);
    await waitFor(() => sentMessages.length === 1);
    expect(sentMessages[0].to).toBe('new@example.com');
  });

  test('refuses an address that belongs to another account', async () => {
    await createUser({ email: 'taken@example.com' });
    const user = await createUser({ email: 'mine@example.com' });
    await request(app)
      .put(`/user/${user._id}`)
      .send({ user: { email: 'taken@example.com' } })
      .expect(409);
  });

  test('keeping the same address changes nothing', async () => {
    const user = await createUser({ email: 'same@example.com' });
    await request(app)
      .put(`/user/${user._id}`)
      .send({ user: { email: 'SAME@example.com' } })
      .expect(200);
    expect((await User.findById(user._id)).isVerified).toBe(true);
    expect(sentMessages).toHaveLength(0);
  });
});

describe('rate limits', () => {
  test('repeated failed logins for one account are slowed down, other accounts are not', async () => {
    config.isTest = false;
    try {
      await createUser({ email: 'victim@example.com', password: 'pw1234' });
      await createUser({ email: 'other@example.com', password: 'pw1234' });
      for (let i = 0; i < 8; i += 1) {
        await login('victim@example.com', 'wrong').expect(401);
      }
      const blocked = await login('victim@example.com', 'pw1234').expect(429);
      expect(blocked.body.message).toMatch(/Too many attempts/);
      await login('other@example.com', 'pw1234').expect(200);
    } finally {
      config.isTest = true;
    }
  });
});
