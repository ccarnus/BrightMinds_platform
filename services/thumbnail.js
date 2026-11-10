// Cast thumbnails: a frame of the cast's video, chosen by the author (`time`) or picked automatically.
// No image is ever generated.
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const { MEDIA_DIRS, ensureMediaDir, mediaFilePath } = require('./media');

ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path);

// Card size used by the app.
const THUMBNAIL_WIDTH = 980;
const THUMBNAIL_HEIGHT = 560;
// Thumbnails are named `thumb_*.jpg`; any other cast image predates them (former AI illustrations).
const THUMBNAIL_PREFIX = 'thumb';
// Automatic choice: ffmpeg's `thumbnail` filter keeps the most representative of AUTO_FRAMES
// consecutive frames (it skips black, blurry or flash frames), starting AUTO_START into the video
// so title cards and fade-ins are skipped.
const AUTO_FRAMES = 120;
const AUTO_START = 0.15;
const FFMPEG_TIMEOUT_SECONDS = 60;

/** Where the automatic search starts (seconds). */
const automaticStart = (duration) =>
  duration > 0 ? Math.min(duration * AUTO_START, Math.max(duration - 1, 0)) : 0;

/** The author's moment, kept inside the video (the last frame at most). */
const clampTime = (time, duration) =>
  Math.max(0, duration > 0 ? Math.min(time, Math.max(duration - 0.1, 0)) : time);

/** One PNG frame read from `start` seconds (the most representative of the next frames if `automatic`). */
const readFrame = (videoPath, { start, automatic }) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let commandEnded = false;
    let streamEnded = false;
    const finish = () => {
      if (commandEnded && streamEnded) resolve(Buffer.concat(chunks));
    };
    const command = ffmpeg(videoPath, { timeout: FFMPEG_TIMEOUT_SECONDS })
      .seekInput(start)
      .noAudio()
      .frames(1)
      .videoCodec('png')
      .format('image2pipe')
      .on('error', reject)
      .on('end', () => {
        commandEnded = true;
        finish();
      });
    if (automatic) command.videoFilters(`thumbnail=${AUTO_FRAMES}`);
    const stream = command.pipe();
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      streamEnded = true;
      finish();
    });
  });

/**
 * Saves a card-sized JPEG thumbnail (`thumb_<timestamp>_<random>.jpg` in the cast images dir).
 * @param {string} videoPath
 * @param {{ duration?: number, time?: number }} [options] `duration` in seconds; `time` is the
 *   moment chosen by the author (seconds). Without it, the frame is picked automatically.
 * @returns {Promise<string>} The saved filename.
 */
const createCastThumbnail = async (videoPath, { duration = 0, time } = {}) => {
  const automatic = time === undefined || time === null;
  const start = automatic ? automaticStart(duration) : clampTime(time, duration);
  let lastError;
  const read = (options) =>
    readFrame(videoPath, options).catch((error) => {
      lastError = error;
      return null;
    });
  let frame = await read({ start, automatic });
  // Unknown or wrong duration (seek past the end): fall back to the first frame.
  if (!frame?.length && start > 0) frame = await read({ start: 0, automatic: false });
  if (!frame?.length) {
    const reason = lastError ? ` (${String(lastError.message).trim().split('\n').pop()})` : '';
    throw new Error(`No frame could be read from the video${reason}.`);
  }

  ensureMediaDir(MEDIA_DIRS.castImages);
  const filename = `${THUMBNAIL_PREFIX}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.jpg`;
  await sharp(frame)
    .resize(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT, {
      fit: 'cover',
      // The author saw the centered frame in the app; automatic picks keep the salient region.
      position: automatic ? sharp.strategy.attention : 'centre',
    })
    .jpeg({ quality: 82 })
    .toFile(mediaFilePath(MEDIA_DIRS.castImages, filename));
  return filename;
};

module.exports = {
  THUMBNAIL_WIDTH,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_PREFIX,
  createCastThumbnail,
  automaticStart,
  clampTime,
};
