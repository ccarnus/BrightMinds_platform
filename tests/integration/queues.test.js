// Queue processors in test mode (stubbed AI outputs), with transcription (ffmpeg + OpenAI) mocked.
jest.mock('../../services/transcription', () => jest.fn());
const transcribeVideo = require('../../services/transcription');

const Article = require('../../models/article_model');
const Cast = require('../../models/cast_model');
const { processCastJob } = require('../../queues/cast_queue');
const { processArticleJob } = require('../../queues/article_queue');
const { useTestDatabase } = require('../helpers/db');
const {
  MEDIA_DIRS,
  createArticle,
  createCast,
  createMediaFile,
  mediaFileExists,
} = require('../helpers/fixtures');

useTestDatabase();

const job = (data) => ({ data, opts: { attempts: 4 }, attemptsMade: 0, discard: jest.fn() });

let casturl;

beforeEach(() => {
  casturl = createMediaFile(MEDIA_DIRS.castVideos, 'video.mp4');
  transcribeVideo.mockReset().mockResolvedValue({
    text: 'Transcript text',
    srt: '1\n00:00:00,000 --> 00:00:01,000\nHi\n\n',
  });
});

test('cast job stores transcript, subtitles, evaluation and image', async () => {
  const cast = await createCast({ description: '', casturl });
  const castId = cast._id.toString();

  await processCastJob(job({ castId }));

  const updated = await Cast.findById(castId);
  expect(updated.description).toBe('Transcript text');
  expect(updated.subtitleurl).toBe(`http://api.test/backend/media/cast_subtitles/${castId}.srt`);
  expect(mediaFileExists(MEDIA_DIRS.castSubtitles, `${castId}.srt`)).toBe(true);
  expect(updated.evaluation.question).toBe('Mock question?');
  expect(updated.castimageurl).toBe('http://api.test/backend/media/cast_images/cast_test.jpg');
  expect(updated.topic).toBe('Quantum Mechanics'); // chosen by the author: untouched
  expect(updated.processing.status).toBe('done');
});

test('cast job skips casts deleted before processing', async () => {
  await processCastJob(job({ castId: '507f1f77bcf86cd799439011' }));
  expect(transcribeVideo).not.toHaveBeenCalled();
});

test('cast job fails (for Bull to record) when transcription fails', async () => {
  transcribeVideo.mockRejectedValue(new Error('Whisper down'));
  const cast = await createCast({ description: '', casturl });
  await expect(processCastJob(job({ castId: cast._id.toString() }))).rejects.toThrow(
    'Whisper down'
  );
  expect((await Cast.findById(cast._id)).processing.lastError).toContain('Whisper down');
});

test('cast job keeps results consistent if the cast is deleted during transcription', async () => {
  const cast = await createCast({ description: '', casturl });
  const castId = cast._id.toString();
  transcribeVideo.mockImplementation(async () => {
    await Cast.deleteOne({ _id: castId });
    return { text: 'late', srt: '' };
  });

  await processCastJob(job({ castId }));
  expect(await Cast.findById(castId)).toBeNull();
});

test('cast job keeps a topic the author set during transcription', async () => {
  const cast = await createCast({ description: '', casturl, topic: 'Pending Topic' });
  const castId = cast._id.toString();
  transcribeVideo.mockImplementation(async () => {
    await Cast.updateOne({ _id: castId }, { topic: 'Chosen by author' });
    return { text: 'Transcript', srt: null };
  });

  await processCastJob(job({ castId }));
  const updated = await Cast.findById(castId);
  expect(updated.topic).toBe('Chosen by author');
  expect(updated.description).toBe('Transcript');
  expect(updated.subtitleurl).toBeUndefined(); // model without timestamps: no subtitles
});

test('cast job assigns a topic when none was given', async () => {
  const cast = await createCast({ description: '', casturl, topic: 'Pending Topic' });
  await processCastJob(job({ castId: cast._id.toString() }));
  expect((await Cast.findById(cast._id)).topic).toBe('Mock Topic');
});

test('article job tolerates deleted articles and completes the others', async () => {
  await expect(
    processArticleJob(job({ articleId: '507f1f77bcf86cd799439011' }))
  ).resolves.toBeUndefined();

  const article = await createArticle({ articleimageurl: undefined, topic: 'Pending Topic' });
  await processArticleJob(job({ articleId: article._id.toString() }));
  const updated = await Article.findById(article._id);
  expect(updated.evaluation.question).toBe('Mock question?');
  expect(updated.articleimageurl).toBe(
    'http://api.test/backend/media/article_images/article_test.jpg'
  );
  expect(updated.topic).toBe('Mock Topic');
  expect(updated.processing.status).toBe('done');
});
