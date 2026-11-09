const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfprobePath(require('@ffprobe-installer/ffprobe').path);

/**
 * Reads a video's duration in seconds (0 if unknown).
 * @param {string} videoFilePath
 * @returns {Promise<number>}
 */
const getVideoDurationInSeconds = (videoFilePath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoFilePath, (error, metadata) => {
      if (error) return reject(error);
      return resolve(Number(metadata.format.duration) || 0);
    });
  });

/** Durations are stored in minutes (same unit as articles). */
const getVideoDurationInMinutes = async (videoFilePath) =>
  (await getVideoDurationInSeconds(videoFilePath)) / 60;

module.exports = { getVideoDurationInMinutes, getVideoDurationInSeconds };
