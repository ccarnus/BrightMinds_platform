const isValidEmail = require('../../services/email_validator');
const OpenAI = require('openai');
const { toEvaluation } = require('../../services/analyze_content');
const {
  toSRTTimestamp,
  buildSRTFromSegments,
  buildPrompt,
  isSpeech,
} = require('../../services/transcription');
const { AIError, classifyError } = require('../../services/openai');
const { getFieldId } = require('../../services/generate_topic');
const { departments, departmentNames, departmentIdByName } = require('../../lists/departments');
const { escapeHtml, passwordResetEmail } = require('../../views/html');

describe('isValidEmail', () => {
  test.each(['a@b.co', 'first.last@uni.edu'])('accepts %s', (email) => {
    expect(isValidEmail(email)).toBe(true);
  });
  test.each(['a@b', 'a b@c.d', '@b.co', '', null, { $ne: null }])('rejects %p', (email) => {
    expect(isValidEmail(email)).toBe(false);
  });
});

describe('toEvaluation', () => {
  const output = {
    question: ' Why does zinc starve bacteria? ',
    correct_answer: 'It binds the metals they need',
    distractors: ['It heats them', 'It feeds the immune system', 'It dissolves their wall'],
  };

  test('returns the stored shape with the correct answer among shuffled responses', () => {
    const evaluation = toEvaluation(output);
    expect(evaluation.question).toBe('Why does zinc starve bacteria?');
    expect(evaluation.correct).toBe('It binds the metals they need');
    expect([...evaluation.responses].sort()).toEqual(
      [output.correct_answer, ...output.distractors].sort()
    );
  });

  test('drops duplicate or empty distractors and rejects incomplete output', () => {
    expect(
      toEvaluation({ ...output, distractors: ['It heats them', 'it heats them', '', 'X'] })
    ).toBeNull();
    expect(
      toEvaluation({ ...output, distractors: [output.correct_answer, 'A', 'B', 'C'] }).responses
    ).toHaveLength(4);
    expect(toEvaluation({ ...output, question: ' ' })).toBeNull();
    expect(toEvaluation(null)).toBeNull();
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

describe('transcription helpers', () => {
  test('buildPrompt gives the title and keeps the end of the previous text', () => {
    expect(buildPrompt('Zinc mattress')).toBe('Research talk: Zinc mattress.');
    const prompt = buildPrompt('T', 'x'.repeat(2000) + ' last words');
    expect(prompt).toHaveLength(800);
    expect(prompt.endsWith('last words')).toBe(true);
  });

  test('isSpeech drops segments Whisper hallucinated over silence', () => {
    expect(isSpeech({ text: 'Hello', no_speech_prob: 0.1, avg_logprob: -0.2 })).toBe(true);
    expect(isSpeech({ text: 'Thank you.', no_speech_prob: 0.9, avg_logprob: -1.5 })).toBe(false);
    expect(isSpeech({ text: ' ', no_speech_prob: 0, avg_logprob: 0 })).toBe(false);
  });
});

describe('classifyError', () => {
  const apiError = (status, code) =>
    OpenAI.APIError.generate(status, { error: { code, message: code } }, code, {});

  test.each([
    ['bad key', apiError(401, 'invalid_api_key'), 'config'],
    ['no credit', apiError(429, 'insufficient_quota'), 'config'],
    ['unknown model', apiError(404, 'model_not_found'), 'config'],
    ['rejected parameter', apiError(400, 'unsupported_parameter'), 'config'],
    ['rate limit', apiError(429, 'rate_limit_exceeded'), 'transient'],
    ['server error', apiError(503, null), 'transient'],
    ['no network', new OpenAI.APIConnectionError({ message: 'down' }), 'transient'],
    ['timeout', new OpenAI.APIConnectionTimeoutError(), 'transient'],
    ['DNS failure', Object.assign(new Error('x'), { code: 'ENOTFOUND' }), 'transient'],
    ['moderation', apiError(400, 'content_policy_violation'), 'content'],
    ['local failure', new Error('ffmpeg exited'), 'content'],
    ['AIError', new AIError('transient', 'x'), 'transient'],
  ])('%s -> %s', (label, error, kind) => {
    expect(classifyError(error)).toBe(kind);
  });
});

describe('generate_topic helpers', () => {
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
