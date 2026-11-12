// Behaviour of the account flows when the email provider is down.
const request = require('supertest');

jest.mock('../../services/mailer', () => ({
  ...jest.requireActual('../../services/mailer'),
  sendMail: jest.fn(),
}));

const app = require('../../app');
const config = require('../../config');
const User = require('../../models/user_model');
const { sendMail, MailError } = require('../../services/mailer');
const { signToken } = require('../../middleware/auth');
const { useTestDatabase } = require('../helpers/db');
const { PNG_BYTES, createUser } = require('../helpers/fixtures');

useTestDatabase();

const signup = () =>
  request(app)
    .post('/user/signup')
    .field(
      'user',
      JSON.stringify({
        email: 'down@example.com',
        password: 'secret123',
        username: 'down',
        role: 'Researcher',
      })
    )
    .attach('image', PNG_BYTES, { filename: 'me.png', contentType: 'image/png' });

beforeEach(() => {
  sendMail.mockReset();
});

describe('when emails cannot be sent', () => {
  test('signup still creates a working account and tells the app the email failed', async () => {
    sendMail.mockRejectedValue(new MailError('transient', 'connection timeout'));
    const res = await signup().expect(201);
    expect(res.body).toMatchObject({ emailSent: false, emailStatus: 'failed', isVerified: false });
    expect(res.body.response).toMatch(/request it again/);
    expect(await User.countDocuments({ email: 'down@example.com' })).toBe(1);
    await request(app)
      .post('/user/login')
      .send({ email: 'down@example.com', password: 'secret123' })
      .expect(200);
  });

  test('a slow provider does not hold the signup back forever', async () => {
    config.account.sendWaitMs = 50;
    try {
      sendMail.mockReturnValue(new Promise(() => {}));
      const res = await signup().expect(201);
      expect(res.body.emailStatus).toBe('pending');
      expect(res.body.emailSent).toBe(true);
    } finally {
      config.account.sendWaitMs = 10000;
    }
  });

  test('resend answers 503 and does not use up the cooldown', async () => {
    const user = await createUser({ isVerified: false });
    const resend = () =>
      request(app)
        .post(`/user/${user._id}/verification/resend`)
        .set('Authorization', `Bearer ${signToken(user._id)}`);

    sendMail.mockRejectedValueOnce(new MailError('config', 'bad credentials'));
    await resend().expect(503);

    sendMail.mockResolvedValueOnce(undefined);
    await resend().expect(200);
  });

  test('a reset request still answers 200 and a later one can send', async () => {
    await createUser({ email: 'reset@example.com' });
    sendMail.mockRejectedValueOnce(new MailError('transient', 'down'));
    await request(app)
      .post('/user/reset-password-request')
      .send({ email: 'reset@example.com' })
      .expect(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    sendMail.mockResolvedValue(undefined);
    await request(app)
      .post('/user/reset-password-request')
      .send({ email: 'reset@example.com' })
      .expect(200);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendMail).toHaveBeenCalledTimes(2);
  });
});
