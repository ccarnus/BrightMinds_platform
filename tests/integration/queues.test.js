// Background job processors, with transcription (ffmpeg + Whisper) mocked.
jest.mock('../../services/transcription', () => jest.fn());
const transcribeVideo = require('../../services/transcription');

const fs = require('fs');
const Cast = require('../../models/cast_model');
const { processCastJob } = require('../../queues/cast_queue');
const { processArticleJob } = require('../../queues/article_queue');
const { mediaFilePath } = require('../../services/media');
const { useTestDatabase } = require('../helpers/db');
const { MEDIA_DIRS, createCast, createArticle } = require('../helpers/fixtures');

useTestDatabase();

beforeEach(() => {
  transcribeVideo.mockReset().mockResolvedValue({
    text: 'Transcript text',
    srt: '1\n00:00:00,000 --> 00:00:01,000\nHi\n\n',
  });
});

test('cast job stores transcript, subtitles, evaluation and image', async () => {
  const cast = await createCast({ description: '' });
  const castId = cast._id.toString();

  await processCastJob({ data: { castId, videoFilePath: '/videos/x.mp4', generateTopic: false } });

  expect(transcribeVideo).toHaveBeenCalledWith('/videos/x.mp4');
  const updated = await Cast.findById(castId);
  expect(updated.description).toBe('Transcript text');
  expect(updated.subtitleurl).toBe(`http://api.test/backend/media/cast_subtitles/${castId}.srt`);
  expect(updated.evaluation.question).toBe('Mock question?');
  expect(updated.castimageurl).toBe('http://api.test/backend/media/cast_images/cast_test.jpg');
  expect(
    fs.readFileSync(mediaFilePath(MEDIA_DIRS.castSubtitles, `${castId}.srt`), 'utf8')
  ).toContain('Hi');
});

test('cast job skips casts deleted before processing', async () => {
  await processCastJob({
    data: { castId: '507f1f77bcf86cd799439011', videoFilePath: 'x', generateTopic: false },
  });
  expect(transcribeVideo).not.toHaveBeenCalled();
});

test('cast job fails (for Bull to record) when transcription fails', async () => {
  transcribeVideo.mockRejectedValue(new Error('Whisper down'));
  const cast = await createCast();
  await expect(
    processCastJob({
      data: { castId: cast._id.toString(), videoFilePath: 'x', generateTopic: false },
    })
  ).rejects.toThrow('Whisper down');
});

test('article job tolerates deleted articles', async () => {
  await expect(
    processArticleJob({ data: { articleId: '507f1f77bcf86cd799439011', generateTopic: true } })
  ).resolves.toBeUndefined();
  const article = await createArticle();
  await expect(
    processArticleJob({ data: { articleId: article._id, generateTopic: true } })
  ).resolves.toBeUndefined();
});

test('cast job discards results if the cast is deleted during transcription', async () => {
  const cast = await createCast();
  const castId = cast._id.toString();
  transcribeVideo.mockImplementation(async () => {
    await Cast.deleteOne({ _id: castId });
    return { text: 'late', srt: '' };
  });

  await processCastJob({ data: { castId, videoFilePath: 'x', generateTopic: true } });
  expect(fs.existsSync(mediaFilePath(MEDIA_DIRS.castSubtitles, `${castId}.srt`))).toBe(false);
});

test('cast job keeps a topic the author set during transcription', async () => {
  const cast = await createCast({ topic: 'Pending Topic' });
  const castId = cast._id.toString();
  transcribeVideo.mockImplementation(async () => {
    await Cast.updateOne({ _id: castId }, { topic: 'Chosen by author' });
    return { text: 'Transcript', srt: '' };
  });

  await processCastJob({ data: { castId, videoFilePath: 'x', generateTopic: true } });
  const updated = await Cast.findById(castId);
  expect(updated.topic).toBe('Chosen by author');
  expect(updated.description).toBe('Transcript');
});
