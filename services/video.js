const ffmpeg = require('fluent-ffmpeg');

ffmpeg.setFfprobePath(require('@ffprobe-installer/ffprobe').path);

/**
 * Reads a video's duration. Durations are stored in minutes (same unit as articles).
 * @param {string} videoFilePath
 * @returns {Promise<number>}
 */
const getVideoDurationInMinutes = (videoFilePath) =>
  new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoFilePath, (error, metadata) => {
      if (error) return reject(error);
      return resolve((metadata.format.duration || 0) / 60);
    });
  });

module.exports = { getVideoDurationInMinutes };
