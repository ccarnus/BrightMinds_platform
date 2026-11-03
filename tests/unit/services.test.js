const computeDuration = require('../../services/compute_duration');
const isValidEmail = require('../../services/email_validator');
const { parseEvaluation } = require('../../services/generate_question');
const { toSRTTimestamp, buildSRTFromSegments } = require('../../services/transcription');
const { isAuthError, normalizeErrorInfo } = require('../../services/openai_alerts');
const { matchFromList, getFieldId } = require('../../services/generate_topic');
const { departments, departmentNames, departmentIdByName } = require('../../lists/departments');
const { escapeHtml, passwordResetEmail } = require('../../views/html');

describe('computeDuration', () => {
  test('is 150 words per minute, rounded up', () => {
    expect(computeDuration('word '.repeat(150))).toBe(1);
    expect(computeDuration('word '.repeat(151))).toBe(2);
  });

  test('is 0 for empty or whitespace-only text', () => {
    expect(computeDuration('')).toBe(0);
    expect(computeDuration('   \n ')).toBe(0);
    expect(computeDuration(undefined)).toBe(0);
  });
});

describe('isValidEmail', () => {
  test.each(['a@b.co', 'first.last@uni.edu'])('accepts %s', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });
  test.each(['a@b', 'a b@c.d', '@b.co', '', null, { $ne: null }])('rejects %p', (email) => {
    expect(isValidEmail(email)).toBe(false);
  });
});

describe('parseEvaluation', () => {
  test('extracts question, answers and the correct (first) answer', () => {
    const text = 'Question: What is H2O?\n\nA) Water\nB) Salt\nC) Sugar\nD) Iron';
    const evaluation = parseEvaluation(text);
    expect(evaluation.question).toBe('What is H2O?');
    expect(evaluation.correct).toBe('Water');
    expect(evaluation.responses.sort()).toEqual(['Iron', 'Salt', 'Sugar', 'Water']);
  });

  test('returns null when the output has no answers', () => {
    expect(parseEvaluation('Only a question?')).toBeNull();
    expect(parseEvaluation('')).toBeNull();
    expect(parseEvaluation(undefined)).toBeNull();
  });
});

describe('SRT helpers', () => {
  test('toSRTTimestamp formats HH:MM:SS,mmm', () => {
    expect(toSRTTimestamp(0)).toBe('00:00:00,000');
    expect(toSRTTimestamp(3723.456)).toBe('01:02:03,456');
    expect(toSRTTimestamp(59.9999)).toBe('00:01:00,000');
  });

  test('buildSRTFromSegments numbers and trims cues', () => {
    expect(
      buildSRTFromSegments([
        { start: 0, end: 1.5, text: ' Hello ' },
        { start: 1.5, end: 3, text: 'World' },
      ])
    ).toBe(
      '1\n00:00:00,000 --> 00:00:01,500\nHello\n\n2\n00:00:01,500 --> 00:00:03,000\nWorld\n\n'
    );
  });
});

describe('OpenAI alerts', () => {
  test.each([
    [{ status: 401 }],
    [{ response: { status: 403 } }],
    [{ code: 'invalid_api_key' }],
    [{ error: { type: 'authentication_error' } }],
    [{ message: 'Incorrect API key provided' }],
    [{ message: 'Your token has expired' }],
  ])('detects auth errors: %p', (error) => {
    expect(isAuthError(normalizeErrorInfo(error))).toBe(true);
  });

  test.each([[{ status: 500 }], [{ status: 429, message: 'Rate limit' }], [{}]])(
    'ignores other errors: %p',
    (error) => {
      expect(isAuthError(normalizeErrorInfo(error))).toBe(false);
    }
  );
});

describe('generate_topic helpers', () => {
  test('matchFromList is case and quote insensitive', () => {
    expect(matchFromList('"chemistry"', departmentNames)).toBe('Chemistry');
    expect(matchFromList('Alchemy', departmentNames)).toBeNull();
  });

  test('getFieldId maps department names to OpenAlex field ids', () => {
    expect(getFieldId('ComputerScience')).toBe(17);
    expect(getFieldId('Unknown')).toBeNull();
  });
});

describe('departments list', () => {
  test('names and ids are unique and indexed', () => {
    expect(new Set(departmentNames).size).toBe(departments.length);
    expect(new Set(departments.map((d) => d.id)).size).toBe(departments.length);
    departments.forEach((d) => expect(departmentIdByName[d.display_name]).toBe(d.id));
  });
});

describe('HTML views', () => {
  test('escapeHtml neutralises markup', () => {
    expect(escapeHtml('<script>"x"&\'y\'</script>')).toBe(
      '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;'
    );
  });

  test('user-controlled values are escaped in emails', () => {
    const html = passwordResetEmail({ username: '<img src=x onerror=alert(1)>', token: 'abc' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('http://api.test/user/reset-password/abc');
  });
});
