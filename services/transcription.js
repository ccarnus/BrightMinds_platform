// Extracts a cast's audio with ffmpeg and transcribes it with Whisper (plain text + SRT subtitles).
const { PassThrough } = require('stream');
const FormData = require('form-data');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const config = require('../config');
const { reportOpenAIAuthError, reportOpenAIMissingApiKey } = require('./openai_alerts');

ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path);

const OPENAI_TRANSCRIPTION_URL = 'https://api.openai.com/v1/audio/transcriptions';

/** Formats seconds as an SRT timestamp "HH:MM:SS,mmm". */
const toSRTTimestamp = (seconds) => {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, length = 2) => String(value).padStart(length, '0');
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(totalMs % 1000, 3)}`;
};

const buildSRTFromSegments = (segments = []) =>
  segments
    .map(
      (segment, index) =>
        `${index + 1}\n${toSRTTimestamp(segment.start)} --> ${toSRTTimestamp(segment.end)}\n` +
        `${segment.text.trim()}\n\n`
    )
    .join('');

/** Mono 64 kbps MP3 keeps ~50 minutes of audio under Whisper's 25 MB upload limit. */
const extractAudio = (videoPath) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const output = new PassThrough();
    output.on('data', (chunk) => chunks.push(chunk));
    output.on('error', reject);
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioChannels(1)
      .audioBitrate('64k')
      .format('mp3')
      .on('error', (error) => reject(new Error(`Error extracting audio: ${error.message}`)))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .pipe(output);
  });

/**
 * @param {string} videoPath Absolute path of the uploaded video.
 * @returns {Promise<{ text: string, srt: string }>}
 */
const transcribeVideo = async (videoPath) => {
  if (!config.openai.apiKey) {
    await reportOpenAIMissingApiKey({ operation: 'transcribeVideo' });
    throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY.');
  }

  const audio = await extractAudio(videoPath);
  const form = new FormData();
  form.append('file', audio, { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  form.append('model', config.openai.transcriptionModel);
  form.append('response_format', 'verbose_json');

  try {
    const { data } = await axios.post(OPENAI_TRANSCRIPTION_URL, form, {
      headers: { Authorization: `Bearer ${config.openai.apiKey}`, ...form.getHeaders() },
      maxBodyLength: Infinity,
      timeout: 10 * 60 * 1000,
    });
    return { text: data.text, srt: buildSRTFromSegments(data.segments) };
  } catch (error) {
    await reportOpenAIAuthError(error, { operation: 'transcribeVideo' });
    throw new Error(`Error transcribing audio: ${error.message}`, { cause: error });
  }
};

module.exports = transcribeVideo;
module.exports.toSRTTimestamp = toSRTTimestamp;
module.exports.buildSRTFromSegments = buildSRTFromSegments;
