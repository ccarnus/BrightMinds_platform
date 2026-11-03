const {
  HttpError,
  assertObjectId,
  isValidObjectId,
  parseJsonField,
  pick,
} = require('../../utils/http');

describe('isValidObjectId / assertObjectId', () => {
  test('accepts 24-char hex ids only', () => {
    expect(isValidObjectId('507f1f77bcf86cd799439011')).toBe(true);
    expect(isValidObjectId('123456789012')).toBe(false); // 12-byte strings are not ids here
    expect(isValidObjectId('not-an-id')).toBe(false);
    expect(isValidObjectId(undefined)).toBe(false);
  });

  test('assertObjectId throws a 400 HttpError', () => {
    expect(() => assertObjectId('bad', 'userId')).toThrow(HttpError);
    try {
      assertObjectId('bad', 'userId');
    } catch (error) {
      expect(error.status).toBe(400);
      expect(error.message).toBe('Invalid userId.');
    }
  });
});

describe('parseJsonField', () => {
  test('parses a JSON string field', () => {
    expect(parseJsonField({ cast: '{"title":"x"}' }, 'cast')).toEqual({ title: 'x' });
  });

  test('accepts an already-parsed object', () => {
    expect(parseJsonField({ cast: { title: 'x' } }, 'cast')).toEqual({ title: 'x' });
  });

  test('returns {} when the field is missing', () => {
    expect(parseJsonField({}, 'cast')).toEqual({});
    expect(parseJsonField(undefined, 'cast')).toEqual({});
  });

  test.each(['{bad json', '[1,2]', '"string"', 'null'])('rejects %s with 400', (raw) => {
    expect(() => parseJsonField({ cast: raw }, 'cast')).toThrow(
      expect.objectContaining({ status: 400 })
    );
  });
});

describe('pick', () => {
  test('keeps only listed, defined keys', () => {
    expect(pick({ a: 1, b: undefined, c: 3, rating: 10 }, ['a', 'b', 'c'])).toEqual({ a: 1, c: 3 });
  });
});
