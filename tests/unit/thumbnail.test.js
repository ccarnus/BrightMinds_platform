// Real ffmpeg + sharp: thumbnails are taken from a generated test video (no network, no AI).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sharp = require('sharp');
const {
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  automaticStart,
  clampTime,
  createCastThumbnail,
} = require('../../services/thumbnail');
const { MEDIA_DIRS, mediaFilePath } = require('../../services/media');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-thumbnail-'));
const video = path.join(workDir, 'talk.mp4');

beforeAll(() => {
  // 4 s, 10 fps test pattern with a burnt-in timer; mpeg4 is built into every ffmpeg.
  execFileSync(
    require('@ffmpeg-installer/ffmpeg').path,
    ['-y', '-f', 'lavfi', '-i', 'testsrc=duration=4:size=320x240:rate=10', '-c:v', 'mpeg4', video],
    { stdio: 'ignore' }
  );
});

afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

const metadataOf = (filename) => sharp(mediaFilePath(MEDIA_DIRS.castImages, filename)).metadata();

describe('createCastThumbnail', () => {
  test('saves a card-sized JPEG from the automatically picked frame', async () => {
    const filename = await createCastThumbnail(video, { duration: 4 });
    expect(filename).toMatch(/^thumb_\d+_[0-9a-f]{6}\.jpg$/);
    expect(await metadataOf(filename)).toMatchObject({
      format: 'jpeg',
      width: THUMBNAIL_WIDTH,
      height: THUMBNAIL_HEIGHT,
    });
  });

  test('takes the frame at the moment chosen by the author', async () => {
    const early = await createCastThumbnail(video, { duration: 4, time: 0.5 });
    const late = await createCastThumbnail(video, { duration: 4, time: 3.5 });
    const pixels = async (filename) =>
      sharp(mediaFilePath(MEDIA_DIRS.castImages, filename)).raw().toBuffer();
    // The test pattern moves over time: different moments give different images.
    expect((await pixels(early)).equals(await pixels(late))).toBe(false);
  });

  test('a moment or duration past the end of the video still gives a frame', async () => {
    await expect(createCastThumbnail(video, { duration: 4, time: 99 })).resolves.toMatch(/^thumb_/);
    await expect(createCastThumbnail(video, { duration: 600 })).resolves.toMatch(/^thumb_/);
  });

  test('fails when no frame can be read', async () => {
    const notAVideo = path.join(workDir, 'notes.mp4');
    fs.writeFileSync(notAVideo, 'not a video');
    await expect(createCastThumbnail(notAVideo, { duration: 4 })).rejects.toThrow(
      'No frame could be read'
    );
  });
});

test('automatic search starts after the intro, and chosen moments stay inside the video', () => {
  expect(automaticStart(0)).toBe(0);
  expect(automaticStart(100)).toBe(15);
  expect(automaticStart(0.5)).toBe(0);
  expect(clampTime(-3, 10)).toBe(0);
  expect(clampTime(4, 10)).toBe(4);
  expect(clampTime(42, 10)).toBeCloseTo(9.9);
  expect(clampTime(42, 0)).toBe(42); // unknown duration: ffmpeg falls back to the first frame
});
