// Replacement of former AI illustrations by video thumbnails (extraction itself is mocked here).
jest.mock('../../services/thumbnail', () => ({
  ...jest.requireActual('../../services/thumbnail'),
  createCastThumbnail: jest.fn(),
}));
const { createCastThumbnail } = require('../../services/thumbnail');

const Cast = require('../../models/cast_model');
const { backfillCastThumbnails } = require('../../services/thumbnail_backfill');
const { useTestDatabase } = require('../helpers/db');
const { MEDIA_DIRS, createCast, createMediaFile, mediaFileExists } = require('../helpers/fixtures');

useTestDatabase();

let thumbnails = 0;

beforeEach(() => {
  createCastThumbnail.mockReset().mockImplementation(async () => {
    thumbnails += 1;
    const filename = `thumb_backfill_${thumbnails}.jpg`;
    createMediaFile(MEDIA_DIRS.castImages, filename);
    return filename;
  });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

test('replaces AI illustrations and missing images with automatic video thumbnails, once', async () => {
  const video = createMediaFile(MEDIA_DIRS.castVideos, 'talk.mp4');
  const illustrated = await createCast({
    casturl: video,
    duration: 2,
    castimageurl: createMediaFile(MEDIA_DIRS.castImages, 'cast_1794313824272_5d29e2.jpg'),
  });
  const imageless = await createCast({ casturl: video, title: 'No image' });
  const converted = await createCast({
    casturl: video,
    title: 'Already a thumbnail',
    castimageurl: createMediaFile(MEDIA_DIRS.castImages, 'thumb_123_abcdef.jpg'),
  });

  await expect(backfillCastThumbnails()).resolves.toEqual({ replaced: 2, failed: 0 });

  expect(createCastThumbnail).toHaveBeenCalledWith(expect.stringContaining('talk.mp4'), {
    duration: 120,
  });
  const after = await Cast.findById(illustrated._id);
  expect(after.castimageurl).toMatch(/\/cast_images\/thumb_backfill_\d+\.jpg$/);
  expect(mediaFileExists(MEDIA_DIRS.castImages, 'cast_1794313824272_5d29e2.jpg')).toBe(false);
  expect((await Cast.findById(imageless._id)).castimageurl).toMatch(/thumb_backfill_/);
  expect((await Cast.findById(converted._id)).castimageurl).toMatch(/thumb_123_abcdef\.jpg$/);

  // Idempotent: nothing left to convert.
  createCastThumbnail.mockClear();
  await expect(backfillCastThumbnails()).resolves.toEqual({ replaced: 0, failed: 0 });
  expect(createCastThumbnail).not.toHaveBeenCalled();
});

test('keeps the current image when the video is missing or unreadable', async () => {
  const oldImage = createMediaFile(MEDIA_DIRS.castImages, 'cast_old.jpg');
  const missingVideo = await createCast({ castimageurl: oldImage });
  createCastThumbnail.mockRejectedValue(new Error('No frame could be read from the video.'));
  const unreadable = await createCast({
    title: 'Audio only',
    casturl: createMediaFile(MEDIA_DIRS.castVideos, 'audio.mp4'),
    castimageurl: oldImage,
  });

  await expect(backfillCastThumbnails()).resolves.toEqual({ replaced: 0, failed: 2 });
  expect((await Cast.findById(missingVideo._id)).castimageurl).toBe(oldImage);
  expect((await Cast.findById(unreadable._id)).castimageurl).toBe(oldImage);
  expect(mediaFileExists(MEDIA_DIRS.castImages, 'cast_old.jpg')).toBe(true);
});
