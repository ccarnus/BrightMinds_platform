// Background processing for new casts: transcription, subtitles, topic, evaluation and cover image.
const fs = require('fs').promises;
const { createQueue } = require('./create_queue');
const Cast = require('../models/cast_model');
const transcribeVideo = require('../services/transcription');
const generateEvaluation = require('../services/generate_question');
const { generateImage } = require('../services/generate_image');
const { generateTopicForCast } = require('../services/generate_topic');
const { PENDING_TOPIC } = require('../services/topics');
const { MEDIA_DIRS, ensureMediaDir, mediaFilePath, mediaUrl } = require('../services/media');

// Queue name is persisted in Redis: do not rename.
const castQueue = createQueue('castQueue');

/**
 * Transcription takes minutes: every write re-reads the cast so edits or deletions made
 * meanwhile are respected.
 * @param {{ data: { castId: string, videoFilePath: string, generateTopic: boolean } }} job
 */
const processCastJob = async (job) => {
  const { castId, videoFilePath, generateTopic } = job.data;

  if (!(await Cast.exists({ _id: castId }))) {
    console.warn(`Cast ${castId} no longer exists, skipping job.`);
    return;
  }

  const { text: transcript, srt } = await transcribeVideo(videoFilePath);

  const srtFilename = `${castId}.srt`;
  const cast = await Cast.findByIdAndUpdate(
    castId,
    { description: transcript, subtitleurl: mediaUrl(MEDIA_DIRS.castSubtitles, srtFilename) },
    { new: true }
  );
  if (!cast) {
    console.warn(`Cast ${castId} was deleted during transcription, discarding results.`);
    return;
  }
  ensureMediaDir(MEDIA_DIRS.castSubtitles);
  await fs.writeFile(mediaFilePath(MEDIA_DIRS.castSubtitles, srtFilename), srt, 'utf8');

  // Skip if the author set a topic while the video was being transcribed.
  if (generateTopic && cast.topic === PENDING_TOPIC) {
    await generateTopicForCast(cast);
  }

  const [evaluation, imageFilename] = await Promise.all([
    generateEvaluation(transcript),
    generateImage(transcript, { dir: MEDIA_DIRS.castImages, prefix: 'cast' }),
  ]);
  const update = {};
  if (evaluation) update.evaluation = evaluation;
  if (imageFilename) update.castimageurl = mediaUrl(MEDIA_DIRS.castImages, imageFilename);
  if (Object.keys(update).length) {
    await Cast.updateOne({ _id: castId }, update);
  }
};

const startCastWorker = () => castQueue.process(processCastJob);

module.exports = { castQueue, processCastJob, startCastWorker };
