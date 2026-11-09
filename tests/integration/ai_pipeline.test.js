// AI pipeline end to end (production code paths) with a fake OpenAI client, mocked OpenAlex,
// mocked transcription (ffmpeg) and mocked mail. No network.
jest.mock('axios');
jest.mock('../../services/transcription', () => jest.fn());
jest.mock('../../services/mailer', () => ({ sendMail: jest.fn(), sentMessages: [] }));
jest.mock('openai', () => {
  const actual = jest.requireActual('openai');
  const client = {
    chat: { completions: { create: jest.fn() } },
    images: { generate: jest.fn() },
    models: { retrieve: jest.fn() },
  };
  const OpenAI = jest.fn(() => client);
  Object.assign(OpenAI, {
    client,
    toFile: jest.fn(async (buffer) => buffer),
    APIError: actual.APIError,
    APIConnectionError: actual.APIConnectionError,
  });
  return OpenAI;
});

const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const OpenAI = require('openai');
const config = require('../../config');
const Article = require('../../models/article_model');
const Cast = require('../../models/cast_model');
const Topic = require('../../models/topic_model');
const transcribeVideo = require('../../services/transcription');
const { sendMail } = require('../../services/mailer');
const { resumeOpenAI } = require('../../services/openai');
const { topicsCache } = require('../../services/generate_topic');
const { resetAlertThrottle } = require('../../services/openai_alerts');
const { enqueueRetries } = require('../../services/ai_retry');
const { castQueue, processCastJob } = require('../../queues/cast_queue');
const { processArticleJob } = require('../../queues/article_queue');
const { mediaPathFromUrl } = require('../../services/media');
const { useTestDatabase } = require('../helpers/db');
const {
  MEDIA_DIRS,
  createArticle,
  createCast,
  createMediaFile,
  mediaFileExists,
} = require('../helpers/fixtures');

useTestDatabase();

const { client } = OpenAI;
const ANALYSIS = {
  question: 'In research on zinc and bacteria, how does zinc stop infections?',
  correct_answer: 'It starves bacteria of manganese',
  distractors: ['It raises body temperature', 'It feeds immune cells', 'It dissolves cell walls'],
  department: 'Chemistry',
  image_brief: 'A petri dish with metallic particles.',
};
const chatReply = (object) => ({
  choices: [{ message: { content: JSON.stringify(object) }, finish_reason: 'stop' }],
});
const apiError = (status, code) =>
  OpenAI.APIError.generate(status, { error: { code, message: `${code} message` } }, code, {});

/** Bull-like job: `attemptsMade` failed attempts so far, out of 4. */
const job = (data, attemptsMade = 0) => ({
  data,
  opts: { attempts: 4 },
  attemptsMade,
  discard: jest.fn(),
});

let jpegBase64;

beforeAll(async () => {
  jpegBase64 = (
    await sharp({ create: { width: 30, height: 20, channels: 3, background: '#888' } })
      .jpeg()
      .toBuffer()
  ).toString('base64');
});

beforeEach(() => {
  config.isTest = false; // run the production code paths
  config.openai.apiKey = 'sk-test';
  config.alerts.to = 'ops@example.com';
  config.mail.password = 'mail-password';
  config.ai.maxAttempts = 2;
  resumeOpenAI();
  resetAlertThrottle();
  topicsCache.clear();
  jest.clearAllMocks();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  castQueue.jobs.length = 0;
  axios.get.mockResolvedValue({
    data: {
      results: [
        { id: 'https://openalex.org/T10', display_name: 'Organic Chemistry' },
        { id: 'https://openalex.org/T11', display_name: 'Metal Ions in Biology' },
      ],
    },
  });
  client.chat.completions.create
    .mockReset()
    .mockImplementation(async ({ response_format: format }) =>
      format.json_schema.name === 'topic_choice'
        ? chatReply({ topic_id: 'T11' })
        : chatReply(ANALYSIS)
    );
  client.images.generate.mockReset().mockResolvedValue({ data: [{ b64_json: jpegBase64 }] });
});

afterEach(() => {
  jest.restoreAllMocks();
  config.isTest = true;
  config.openai.apiKey = undefined;
  config.alerts.to = undefined;
  config.mail.password = undefined;
});

const pendingArticle = () =>
  createArticle({
    department: 'Pending Department',
    topic: 'Pending Topic',
    articleimageurl: undefined,
  });

describe('article pipeline', () => {
  test('generates question, department, topic and image', async () => {
    const article = await pendingArticle();

    await processArticleJob(job({ articleId: article._id.toString() }));

    const updated = await Article.findById(article._id);
    expect(updated.evaluation.question).toBe(ANALYSIS.question);
    expect(updated.evaluation.correct).toBe(ANALYSIS.correct_answer);
    expect([...updated.evaluation.responses].sort()).toEqual(
      [ANALYSIS.correct_answer, ...ANALYSIS.distractors].sort()
    );
    expect(updated.department).toBe('Chemistry');
    expect(updated.topic).toBe('Metal Ions in Biology');
    expect(updated.processing.status).toBe('done');
    expect(fs.existsSync(mediaPathFromUrl(updated.articleimageurl, MEDIA_DIRS.articleImages))).toBe(
      true
    );
    const topic = await Topic.findOne({
      name: 'Metal Ions in Biology',
      departmentName: 'Chemistry',
    });
    expect(topic.openalexID).toBe('T11');
    expect(topic.articleIDs.map(String)).toEqual([article._id.toString()]);

    const analysisCall = client.chat.completions.create.mock.calls[0][0];
    expect(analysisCall).toMatchObject({
      model: config.openai.chatModel,
      reasoning_effort: config.openai.reasoningEffort,
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    expect(analysisCall.messages[1].content).toContain(article.title);
    expect(client.images.generate.mock.calls[0][0].prompt).toContain(ANALYSIS.image_brief);
  });

  test('a bad API key alerts once, pauses OpenAI calls and leaves the item pending', async () => {
    client.chat.completions.create.mockRejectedValue(apiError(401, 'invalid_api_key'));
    const [first, second] = [await pendingArticle(), await pendingArticle()];

    const firstJob = job({ articleId: first._id.toString() });
    await expect(processArticleJob(firstJob)).rejects.toMatchObject({ kind: 'config' });
    await expect(processArticleJob(job({ articleId: second._id.toString() }))).rejects.toThrow(
      'paused'
    );

    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
    expect(firstJob.discard).toHaveBeenCalled(); // no Bull retries: the daily retry handles it
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].subject).toContain('configuration');
    const stored = await Article.findById(first._id);
    expect(stored.processing).toMatchObject({ status: 'pending', attempts: 0 });
    expect(stored.processing.lastError).toContain('HTTP 401');
  });

  test('a missing API key fails without calling OpenAI', async () => {
    config.openai.apiKey = undefined;
    const article = await pendingArticle();
    await expect(
      processArticleJob(job({ articleId: article._id.toString() }))
    ).rejects.toMatchObject({ kind: 'config' });
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  test('network errors are left to Bull retries, with an alert on the last one', async () => {
    client.chat.completions.create.mockRejectedValue(
      new OpenAI.APIConnectionError({ message: 'Connection error.' })
    );
    const article = await pendingArticle();
    const id = article._id.toString();

    const early = job({ articleId: id }, 0);
    await expect(processArticleJob(early)).rejects.toMatchObject({ kind: 'transient' });
    expect(early.discard).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();

    await expect(processArticleJob(job({ articleId: id }, 3))).rejects.toThrow();
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect((await Article.findById(id)).processing).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  test('keeps partial progress and gives up after repeated content errors', async () => {
    client.images.generate.mockRejectedValue(apiError(400, 'moderation_blocked'));
    const article = await pendingArticle();
    const id = article._id.toString();

    await expect(processArticleJob(job({ articleId: id }))).rejects.toMatchObject({
      kind: 'content',
    });
    let stored = await Article.findById(id);
    expect(stored.evaluation.question).toBe(ANALYSIS.question); // saved before the image step
    expect(stored.topic).toBe('Metal Ions in Biology');
    expect(stored.processing).toMatchObject({ status: 'pending', attempts: 1 });

    await expect(processArticleJob(job({ articleId: id }))).rejects.toThrow();
    stored = await Article.findById(id);
    expect(stored.processing).toMatchObject({ status: 'failed', attempts: 2 });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].text).toContain(stored.title);
  });

  test('a retry only runs the missing steps', async () => {
    const article = await createArticle({ articleimageurl: undefined }); // has topic & department
    article.evaluation = { question: 'Existing?', responses: ['a', 'b'], correct: 'a' };
    await article.save();

    await processArticleJob(job({ articleId: article._id.toString() }));

    const updated = await Article.findById(article._id);
    expect(updated.evaluation.question).toBe('Existing?');
    expect(updated.articleimageurl).toBeTruthy();
    expect(axios.get).not.toHaveBeenCalled(); // topic already set: no OpenAlex/topic call
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1); // image brief only
  });
});

describe('cast pipeline', () => {
  test('transcribes the video with its title as context, then runs the other steps', async () => {
    transcribeVideo.mockResolvedValue({ text: 'Zinc starves bacteria.', srt: '1\n...\n\n' });
    const casturl = createMediaFile(MEDIA_DIRS.castVideos, 'talk.mp4');
    const cast = await createCast({ description: '', casturl, topic: 'Pending Topic' });

    await processCastJob(job({ castId: cast._id.toString() }));

    expect(transcribeVideo).toHaveBeenCalledWith(expect.stringContaining('talk.mp4'), {
      title: cast.title,
    });
    const updated = await Cast.findById(cast._id);
    expect(updated.description).toBe('Zinc starves bacteria.');
    expect(mediaFileExists(MEDIA_DIRS.castSubtitles, `${cast._id}.srt`)).toBe(true);
    expect(updated.evaluation.question).toBe(ANALYSIS.question);
    expect(updated.department).toBe('PhysicsandAstronomy'); // set by the author: kept
    expect(updated.topic).toBe('Metal Ions in Biology');
    expect(updated.castimageurl).toBeTruthy();
    expect(updated.processing.status).toBe('done');
  });

  test('a missing video is a content error', async () => {
    const cast = await createCast({ description: '' });
    await expect(processCastJob(job({ castId: cast._id.toString() }))).rejects.toMatchObject({
      kind: 'content',
    });
    expect(transcribeVideo).not.toHaveBeenCalled();
    expect((await Cast.findById(cast._id)).processing.attempts).toBe(1);
  });
});

describe('daily retry', () => {
  const complete = {
    castimageurl: 'http://api.test/backend/media/cast_images/x.jpg',
    evaluation: { question: 'Q?', responses: ['a', 'b'], correct: 'a' },
  };

  test('queues unprocessed content, skipping failed and in-progress items', async () => {
    const done = await createCast(complete);
    const pending = await createCast();
    const failed = await createCast({ processing: { status: 'failed', attempts: 2 } });
    const busy = await createCast({
      processing: { status: 'processing', lastAttemptAt: new Date() },
    });
    const stale = await createCast({
      processing: { status: 'processing', lastAttemptAt: new Date(Date.now() - 3 * 3600e3) },
    });

    await expect(enqueueRetries()).resolves.toEqual({ cast: 2, article: 0 });
    const queued = castQueue.jobs.map((data) => data.castId);
    expect(queued.sort()).toEqual([pending._id.toString(), stale._id.toString()].sort());
    expect(queued).not.toContain(done._id.toString());
    expect(queued).not.toContain(failed._id.toString());
    expect(queued).not.toContain(busy._id.toString());
  });

  test('--failed resets items that gave up', async () => {
    const failed = await createCast({ processing: { status: 'failed', attempts: 2 } });
    await expect(enqueueRetries({ includeFailed: true })).resolves.toEqual({ cast: 1, article: 0 });
    expect((await Cast.findById(failed._id)).processing).toMatchObject({
      status: 'pending',
      attempts: 0,
    });
  });

  test('does nothing but alert while no API key is configured', async () => {
    config.openai.apiKey = undefined;
    await createCast();
    await expect(enqueueRetries()).resolves.toEqual({ cast: 0, article: 0 });
    expect(castQueue.jobs).toHaveLength(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
