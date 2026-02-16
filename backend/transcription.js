// transcription.js
const fs = require('fs').promises;
const FormData = require('form-data');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_API_URL = 'https://api.openai.com/v1/audio/transcriptions';
const { reportOpenAIAuthError, reportOpenAIMissingApiKey } = require('./openai_alerts');

function buildSRTFromSegments(segments) {
  return segments
    .map((segment, index) => {
      const start = toSRTTimestamp(segment.start);
      const end = toSRTTimestamp(segment.end);
      const text = segment.text.trim();
      return `${index + 1}\n${start} --> ${end}\n${text}\n\n`;
    })
    .join('');
}

function toSRTTimestamp(seconds) {
  // Convert seconds to "HH:MM:SS,mmm"
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds - Math.floor(seconds)) * 1000);

  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  const mmm = String(ms).padStart(3, '0');

  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Extracts audio from the video, calls Whisper once, and returns both
 * the full transcript and the SRT string.
 *
 * @param {string} videoPath - Path to the video file
 * @returns {Promise<{ text: string, srt: string }>}
 */
const transcribeVideo = (videoPath) => {
  if (!OPENAI_API_KEY) {
    reportOpenAIMissingApiKey({ operation: 'transcribeVideo' });
    return Promise.reject('OpenAI API key not configured. Set OPENAI_API_KEY.');
  }

  return new Promise((resolve, reject) => {
    const { PassThrough } = require('stream');
    const audioStream = new PassThrough();
    const chunks = [];

    ffmpeg(videoPath)
      .noVideo()
      .format('mp3')
      .audioCodec('libmp3lame')
      .on('error', (err) => reject(`Error extracting audio: ${err.message}`))
      .on('end', async () => {
        try {
          // Once ffmpeg finishes, we have all audio data in `chunks`.
          const audioBuffer = Buffer.concat(chunks);

          const formData = new FormData();
          formData.append('file', audioBuffer, {
            filename: 'audio.mp3',
            contentType: 'audio/mpeg',
          });
          formData.append('model', 'whisper-1');

          // Single request in verbose_json
          formData.append('response_format', 'verbose_json');

          const response = await axios.post(OPENAI_API_URL, formData, {
            headers: {
              Authorization: `Bearer ${OPENAI_API_KEY}`,
              ...formData.getHeaders(),
            },
          });

          const data = response.data;  // This is the entire JSON
          const fullTranscript = data.text;  // plain text
          const srtContent = buildSRTFromSegments(data.segments); // build SRT

          // Return both the plain text and the SRT
          resolve({ text: fullTranscript, srt: srtContent });
        } catch (err) {
          await reportOpenAIAuthError(err, { operation: 'transcribeVideo' });
          reject(`Error transcribing audio: ${err.message}`);
        }
      })
      .pipe(audioStream);

    audioStream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    audioStream.on('error', (err) => reject(`Error reading audio stream: ${err.message}`));
  });
};

module.exports = transcribeVideo;
