// Transcribes a cast: extracts speech-optimized audio with ffmpeg and sends it to the OpenAI
// transcription model. With whisper-1 it also returns SRT subtitles built from segment timestamps.
const { PassThrough } = require('stream');
const ffmpeg = require('fluent-ffmpeg');
const config = require('../config');
const { AIError, assertOpenAIAvailable, callOpenAI } = require('./openai');
const { getVideoDurationInSeconds } = require('./video');

ffmpeg.setFfmpegPath(require('@ffmpeg-installer/ffmpeg').path);

// Speech models work on 16 kHz mono: 48 kbps MP3 keeps full quality at ~0.36 MB per minute,
// so 20-minute chunks (~7 MB) stay far below the 25 MB upload limit.
const CHUNK_SECONDS = 20 * 60;
// whisper-1 only reads the last 224 tokens of the prompt.
const PROMPT_MAX_CHARS = 800;
// Whisper's own thresholds for "this segment is silence the model hallucinated text into".
const NO_SPEECH_PROB = 0.6;
const LOW_AVG_LOGPROB = -1;

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

const isSpeech = (segment) =>
  Boolean(segment.text?.trim()) &&
  !(segment.no_speech_prob > NO_SPEECH_PROB && segment.avg_logprob < LOW_AVG_LOGPROB);

/**
 * Context for the model: the title gives it the subject's vocabulary (names, jargon), and the end
 * of the previous chunk keeps spelling and style consistent across chunks.
 */
const buildPrompt = (title, previousText = '') => {
  const context = `${title ? `Research talk: ${title.trim()}.` : ''} ${previousText}`.trim();
  return context.slice(-PROMPT_MAX_CHARS);
};

const extractAudio = (videoPath, startSeconds, durationSeconds) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const output = new PassThrough();
    output.on('data', (chunk) => chunks.push(chunk));
    output.on('error', reject);
    const command = ffmpeg(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate('48k')
      .format('mp3');
    if (startSeconds) command.setStartTime(startSeconds);
    if (durationSeconds) command.setDuration(durationSeconds);
    command
      .on('error', (error) => reject(new Error(`Error extracting audio: ${error.message}`)))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .pipe(output);
  });

const transcribeChunk = async (audio, prompt) => {
  const { toFile } = require('openai');
  const model = config.openai.transcriptionModel;
  const withTimestamps = model === 'whisper-1';
  const result = await callOpenAI('transcribeVideo', async (client) =>
    client.audio.transcriptions.create({
      file: await toFile(audio, 'audio.mp3', { type: 'audio/mpeg' }),
      model,
      prompt: prompt || undefined,
      response_format: withTimestamps ? 'verbose_json' : 'json',
      ...(withTimestamps && { timestamp_granularities: ['segment'], temperature: 0 }),
    })
  );
  return { text: String(result?.text ?? '').trim(), segments: result?.segments ?? null };
};

/**
 * @param {string} videoPath Absolute path of the uploaded video.
 * @param {{ title?: string }} [context]
 * @returns {Promise<{ text: string, srt: string|null }>} `srt` is null when the model gives no timestamps.
 */
const transcribeVideo = async (videoPath, { title } = {}) => {
  await assertOpenAIAvailable('transcribeVideo'); // before spending time on ffmpeg
  const duration = await getVideoDurationInSeconds(videoPath);
  const chunkCount = Math.max(1, Math.ceil(duration / CHUNK_SECONDS));
  const texts = [];
  const segments = [];
  let timestamped = true;

  for (let index = 0; index < chunkCount; index++) {
    const offset = index * CHUNK_SECONDS;
    const audio = await extractAudio(videoPath, offset, chunkCount > 1 ? CHUNK_SECONDS : undefined);
    const chunk = await transcribeChunk(audio, buildPrompt(title, texts.join(' ')));
    if (!chunk.segments) {
      timestamped = false;
      texts.push(chunk.text);
      continue;
    }
    const kept = chunk.segments
      .filter(isSpeech)
      .map((segment) => ({ ...segment, start: segment.start + offset, end: segment.end + offset }));
    segments.push(...kept);
    texts.push(kept.map((segment) => segment.text.trim()).join(' '));
  }

  const text = texts.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) {
    throw new AIError('content', 'No speech detected in the video.', {
      operation: 'transcribeVideo',
    });
  }
  return { text, srt: timestamped && segments.length ? buildSRTFromSegments(segments) : null };
};

module.exports = transcribeVideo;
module.exports.toSRTTimestamp = toSRTTimestamp;
module.exports.buildSRTFromSegments = buildSRTFromSegments;
module.exports.buildPrompt = buildPrompt;
module.exports.isSpeech = isSpeech;
