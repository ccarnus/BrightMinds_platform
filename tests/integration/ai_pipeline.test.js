// Exercises the real AI orchestration code with a fake OpenAI client and mocked HTTP.
jest.mock('axios');
jest.mock('../../services/openai', () => ({ getOpenAIClient: jest.fn() }));

const axios = require('axios');
const { getOpenAIClient } = require('../../services/openai');
const config = require('../../config');
const Cast = require('../../models/cast_model');
const Topic = require('../../models/topic_model');
const generateEvaluation = require('../../services/generate_question');
const { generateTopicForCast } = require('../../services/generate_topic');
const {
  reportOpenAIAuthError,
  reportOpenAIMissingApiKey,
} = require('../../services/openai_alerts');
const { sentMessages } = require('../../services/mailer');
const { useTestDatabase } = require('../helpers/db');
const { createCast } = require('../helpers/fixtures');

useTestDatabase();

/** Fake client whose chat completions return `answers` in order. */
const fakeClient = (...answers) => {
  const create = jest.fn();
  answers.forEach((content) =>
    create.mockResolvedValueOnce({ choices: [{ message: { content } }] })
  );
  return { chat: { completions: { create } } };
};

beforeEach(() => {
  config.isTest = false; // run the production code paths
  sentMessages.length = 0;
  axios.get.mockReset();
  getOpenAIClient.mockReset();
});

afterEach(() => {
  config.isTest = true;
});

describe('generateTopicForCast', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({
      data: {
        results: [
          { id: 'https://openalex.org/T10', display_name: 'Organic Chemistry' },
          { id: 'https://openalex.org/T11', display_name: 'Polymers' },
        ],
      },
    });
  });

  test('resolves a pending department, picks a topic and registers it', async () => {
    getOpenAIClient.mockReturnValue(fakeClient('chemistry', '1. organic chemistry'));
    const cast = await createCast({ department: 'Pending Department', topic: 'Pending Topic' });

    await expect(generateTopicForCast(cast)).resolves.toBe('Organic Chemistry');

    const updated = await Cast.findById(cast._id);
    expect(updated.department).toBe('Chemistry');
    expect(updated.topic).toBe('Organic Chemistry');
    expect(axios.get).toHaveBeenCalledWith(
      'https://api.openalex.org/topics',
      expect.objectContaining({ params: expect.objectContaining({ filter: 'field.id:16' }) })
    );
    const topic = await Topic.findOne({ name: 'Organic Chemistry', departmentName: 'Chemistry' });
    expect(topic.openalexID).toBe('T10');
    expect(topic.castIDs.map(String)).toEqual([cast._id.toString()]);
  });

  test('leaves content pending when the model invents a department', async () => {
    getOpenAIClient.mockReturnValue(fakeClient('Astrology'));
    const cast = await createCast({ department: 'Pending Department', topic: 'Pending Topic' });

    await expect(generateTopicForCast(cast)).resolves.toBeNull();
    expect((await Cast.findById(cast._id)).department).toBe('Pending Department');
    expect(await Topic.countDocuments()).toBe(0);
  });

  test('returns null when no OpenAI key is configured', async () => {
    getOpenAIClient.mockReturnValue(null);
    const cast = await createCast({ department: 'Chemistry', topic: 'Pending Topic' });
    await expect(generateTopicForCast(cast)).resolves.toBeNull();
  });
});

describe('generateEvaluation', () => {
  test('parses the model output', async () => {
    const client = fakeClient('What is 2+2?\nA) 4\nB) 3\nC) 5');
    getOpenAIClient.mockReturnValue(client);
    const evaluation = await generateEvaluation('arithmetic');
    expect(evaluation.correct).toBe('4');
    expect(evaluation.responses).toHaveLength(3);
    expect(client.chat.completions.create).toHaveBeenCalledWith(
      expect.objectContaining({ model: config.openai.chatModel })
    );
  });

  test('returns null on API errors', async () => {
    getOpenAIClient.mockReturnValue({
      chat: { completions: { create: jest.fn().mockRejectedValue(new Error('boom')) } },
    });
    await expect(generateEvaluation('x')).resolves.toBeNull();
  });
});

describe('OpenAI alerts', () => {
  beforeEach(() => {
    config.isTest = true; // capture emails instead of sending
    config.alerts.to = 'ops@example.com';
  });

  afterEach(() => {
    config.alerts.to = undefined;
  });

  test('auth errors send one throttled alert per operation', async () => {
    const error = { status: 401, message: 'Incorrect API key provided' };
    await expect(reportOpenAIAuthError(error, { operation: 'opA' })).resolves.toBe(true);
    await expect(reportOpenAIAuthError(error, { operation: 'opA' })).resolves.toBe(false);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ to: 'ops@example.com' });
    expect(sentMessages[0].text).toContain('Operation: opA');
  });

  test('non-auth errors do not alert', async () => {
    await expect(reportOpenAIAuthError({ status: 500 }, { operation: 'opB' })).resolves.toBe(false);
    expect(sentMessages).toHaveLength(0);
  });

  test('missing API key alerts', async () => {
    await expect(reportOpenAIMissingApiKey({ operation: 'opC' })).resolves.toBe(true);
    expect(sentMessages[0].subject).toBe('OpenAI API key missing');
  });
});
