const jwt = require('jsonwebtoken');
const config = require('../../config');
const { signToken, authenticate, requireSelf } = require('../../middleware/auth');

const run = (middleware, req) => {
  const next = jest.fn();
  middleware(req, {}, next);
  return next;
};

const bearer = (token) => ({ headers: { authorization: `Bearer ${token}` }, params: {} });

afterEach(() => {
  config.auth.required = false;
});

describe('signToken', () => {
  test('signs the user id with the configured secret', () => {
    const payload = jwt.verify(signToken('abc'), config.auth.jwtSecret);
    expect(payload.userId).toBe('abc');
    expect(payload.exp).toBeGreaterThan(payload.iat);
  });
});

describe('authenticate', () => {
  test('sets req.auth from a valid token', () => {
    const req = bearer(signToken('user-1'));
    const next = run(authenticate, req);
    expect(next).toHaveBeenCalledWith();
    expect(req.auth).toEqual({ userId: 'user-1' });
  });

  test('lets anonymous requests through when auth is not required', () => {
    const req = { headers: {}, params: {} };
    expect(run(authenticate, req)).toHaveBeenCalledWith();
    expect(req.auth).toBeUndefined();
  });

  test('ignores invalid tokens when auth is not required', () => {
    expect(run(authenticate, bearer('garbage'))).toHaveBeenCalledWith();
  });

  test('rejects missing tokens with 401 when auth is required', () => {
    config.auth.required = true;
    const next = run(authenticate, { headers: {}, params: {} });
    expect(next.mock.calls[0][0]).toMatchObject({ status: 401 });
  });

  test('rejects tokens signed with another secret when auth is required', () => {
    config.auth.required = true;
    const forged = jwt.sign({ userId: 'x' }, 'not-the-secret');
    expect(run(authenticate, bearer(forged)).mock.calls[0][0]).toMatchObject({ status: 401 });
  });

  test('rejects expired tokens when auth is required', () => {
    config.auth.required = true;
    const expired = jwt.sign({ userId: 'x' }, config.auth.jwtSecret, { expiresIn: -10 });
    expect(run(authenticate, bearer(expired)).mock.calls[0][0]).toMatchObject({ status: 401 });
  });
});

describe('requireSelf', () => {
  test('is a no-op when auth is not required', () => {
    expect(run(requireSelf('id'), { params: { id: 'a' } })).toHaveBeenCalledWith();
  });

  test('allows the owner and rejects others with 403 when auth is required', () => {
    config.auth.required = true;
    expect(
      run(requireSelf('id'), { params: { id: 'a' }, auth: { userId: 'a' } })
    ).toHaveBeenCalledWith();
    const next = run(requireSelf('id'), { params: { id: 'b' }, auth: { userId: 'a' } });
    expect(next.mock.calls[0][0]).toMatchObject({ status: 403 });
  });
});
