const config = require('../../config');
const credentials = require('../../services/credentials');
const { generateToken, hashToken, isWellFormedToken } = require('../../services/email_tokens');
const emails = require('../../views/emails');

describe('credentials', () => {
  test('normalizeEmail trims, lowercases and drops invisible characters', () => {
    expect(credentials.normalizeEmail('  Me\u200B@Example.COM ')).toBe('me@example.com');
    expect(credentials.normalizeEmail({ $ne: 1 })).toBe('');
  });

  test.each([
    ['good1234', null],
    ['short1', /at least 8/],
    ['        ', /only spaces/],
    ['password123', /too easy/],
    ['aaaaaaaaaaaa', /too easy/],
    ['x'.repeat(73), /too long/],
    ['é'.repeat(37), /too long/],
    ['me@example.com', /email/],
    ['Ada Lovelace', /your name/],
  ])('passwordProblem(%j)', (password, expected) => {
    const problem = credentials.passwordProblem(password, {
      email: 'me@example.com',
      username: 'Ada Lovelace',
    });
    if (expected) expect(problem).toMatch(expected);
    else expect(problem).toBeNull();
  });

  test('verifyPassword compares hashes and is false without an account', async () => {
    const hash = await credentials.hashPassword('right-one');
    expect(await credentials.verifyPassword(hash, 'right-one')).toBe(true);
    expect(await credentials.verifyPassword(hash, 'wrong')).toBe(false);
    expect(await credentials.verifyPassword(undefined, 'right-one')).toBe(false);
  });
});

describe('email tokens', () => {
  test('only the hash is meant to be stored', () => {
    const { token, hash } = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashToken(token));
    expect(hash).not.toBe(token);
  });

  test('isWellFormedToken accepts url-safe tokens only', () => {
    expect(isWellFormedToken('abc-DEF_123')).toBe(true);
    ['', 'a.b', 'a b', '$ne', 'x'.repeat(129), undefined].forEach((token) =>
      expect(isWellFormedToken(token)).toBe(false)
    );
  });
});

describe('account emails', () => {
  test('the confirmation email has a link, a text part, the validity and the usable-now promise', () => {
    const { subject, html, text } = emails.verificationEmail({ username: 'Ada L', token: 'tok' });
    expect(subject).toMatch(/Confirm your email/);
    expect(html).toContain('http://api.test/user/confirmation/tok');
    expect(text).toContain('http://api.test/user/confirmation/tok');
    expect(html).toMatch(/already use BrightMinds/);
    expect(html).toContain('3 days');
    expect(html).toContain('Welcome to BrightMinds, Ada!');
  });

  test('the reset email states it is valid 1 hour and single-use', () => {
    const { html } = emails.passwordResetEmail({ username: '', token: 'tok' });
    expect(html).toContain('1 hour');
    expect(html).toContain('can be used once');
    expect(html).toContain('Hi there,');
  });
});

describe('mailer', () => {
  const loadMailer = (sendMail, mail = { user: 'bm@example.com', password: 'secret' }) => {
    jest.resetModules();
    jest.doMock('nodemailer', () => ({
      createTransport: () => ({ sendMail, verify: sendMail }),
    }));
    const cfg = require('../../config');
    cfg.isTest = false;
    Object.assign(cfg.mail, mail, { retryDelayMs: 1 });
    return require('../../services/mailer');
  };

  afterEach(() => {
    jest.dontMock('nodemailer');
    jest.resetModules();
    config.isTest = true;
  });

  const error = (props) => Object.assign(new Error('boom'), props);

  test('retries one temporary failure', async () => {
    const send = jest
      .fn()
      .mockRejectedValueOnce(error({ code: 'ETIMEDOUT' }))
      .mockResolvedValue({});
    const { sendMail } = loadMailer(send);
    await sendMail({ to: 'a@b.co', subject: 's', html: 'h', text: 't' });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0].from).toEqual({
      name: 'BrightMinds Research',
      address: 'bm@example.com',
    });
  });

  test.each([
    [{ code: 'EAUTH' }, 'config'],
    [{ code: 'EENVELOPE' }, 'recipient'],
    [{ responseCode: 550 }, 'recipient'],
    [{ code: 'ETIMEDOUT' }, 'transient'],
    [{}, 'unknown'],
  ])('classifies %j as %s', async (props, kind) => {
    const send = jest.fn().mockRejectedValue(error(props));
    const { sendMail, MailError } = loadMailer(send);
    await expect(sendMail({ to: 'a@b.co', subject: 's' })).rejects.toMatchObject({ kind });
    await expect(sendMail({ to: 'a@b.co', subject: 's' })).rejects.toBeInstanceOf(MailError);
    // Only temporary failures are tried twice.
    expect(send).toHaveBeenCalledTimes(kind === 'transient' ? 4 : 2);
  });

  test('without credentials nothing is sent and the problem is a config one', async () => {
    const send = jest.fn();
    const { sendMail, verifyMail } = loadMailer(send, { user: undefined, password: undefined });
    await expect(sendMail({ to: 'a@b.co', subject: 's' })).rejects.toMatchObject({
      kind: 'config',
    });
    expect(await verifyMail()).toMatchObject({ ok: false, kind: 'config' });
    expect(send).not.toHaveBeenCalled();
  });

  test('Google app passwords are read without their spaces', () => {
    jest.resetModules();
    const before = process.env.EMAIL_PWD;
    process.env.EMAIL_PWD = 'abcd efgh ijkl mnop';
    try {
      expect(require('../../config').mail.password).toBe('abcdefghijklmnop');
    } finally {
      if (before === undefined) delete process.env.EMAIL_PWD;
      else process.env.EMAIL_PWD = before;
    }
  });
});
