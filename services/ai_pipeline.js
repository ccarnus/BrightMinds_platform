// Generative-AI processing of casts, run by the cast queue.
// Steps only run when their output is missing and are saved as soon as they succeed, so a job can
// be retried (by Bull, the daily retry or `node scripts/ai.js retry`) and resumes where it stopped:
//   1. transcript + subtitles   2. question, department   3. topic
// Images are never generated: a cast shows a frame of its video (services/thumbnail.js).
const fs = require('fs');
const config = require('../config');
const Cast = require('../models/cast_model');
const { analyzeContent } = require('./analyze_content');
const { chooseTopic } = require('./generate_topic');
const { AIError, classifyError } = require('./openai');
const { alertOpenAIProblem } = require('./openai_alerts');
const { PENDING_DEPARTMENT, PENDING_TOPIC, createTopicIfNotExist } = require('./topics');
const transcribeVideo = require('./transcription');
const {
  MEDIA_DIRS,
  ensureMediaDir,
  mediaFilePath,
  mediaPathFromUrl,
  mediaUrl,
} = require('./media');

const isEmpty = { $in: [null, ''] };

/** Mongo filter matching casts that still lack at least one AI output. */
const MISSING_OUTPUTS_FILTER = {
  $or: [
    { description: isEmpty },
    { 'evaluation.question': isEmpty },
    { department: PENDING_DEPARTMENT },
    { topic: PENDING_TOPIC },
  ],
};

const transcribeCast = async (cast) => {
  const videoPath = mediaPathFromUrl(cast.casturl, MEDIA_DIRS.castVideos);
  if (!videoPath || !fs.existsSync(videoPath)) {
    throw new AIError('content', `Video file not found for cast ${cast._id}.`, {
      operation: 'transcribeVideo',
    });
  }
  const { text, srt } = await transcribeVideo(videoPath, { title: cast.title });
  const update = { description: text };
  if (srt) {
    const filename = `${cast._id}.srt`;
    ensureMediaDir(MEDIA_DIRS.castSubtitles);
    await fs.promises.writeFile(mediaFilePath(MEDIA_DIRS.castSubtitles, filename), srt, 'utf8');
    update.subtitleurl = mediaUrl(MEDIA_DIRS.castSubtitles, filename);
  }
  return update;
};

/**
 * Runs the missing AI steps for one cast. Re-reads the document after each long step so edits or
 * deletions made meanwhile are respected.
 * @returns {Promise<boolean>} false if the cast no longer exists.
 * @throws {AIError|Error}
 */
const processCast = async (id) => {
  const save = (update) => Cast.findByIdAndUpdate(id, update, { new: true });

  let cast = await Cast.findById(id);
  if (!cast) return false;

  if (!cast.description) {
    cast = await save(await transcribeCast(cast));
    if (!cast) return false;
  }

  const needsDepartment = !cast.department || cast.department === PENDING_DEPARTMENT;
  const needsEvaluation = !cast.evaluation?.question;
  if (needsDepartment || needsEvaluation) {
    const analysis = await analyzeContent({ title: cast.title, description: cast.description });
    const update = {};
    if (needsEvaluation) update.evaluation = analysis.evaluation;
    if (needsDepartment) update.department = analysis.department;
    if (Object.keys(update).length) {
      cast = await save(update);
      if (!cast) return false;
    }
    // A topic chosen by the author can only be registered once the department is known.
    if (needsDepartment && cast.topic !== PENDING_TOPIC) {
      await createTopicIfNotExist({
        name: cast.topic,
        departmentName: cast.department,
        castId: cast._id,
      });
    }
  }

  if (cast.topic === PENDING_TOPIC) {
    const topic = await chooseTopic({
      title: cast.title,
      description: cast.description,
      department: cast.department,
    });
    // Conditional update: keeps a topic the author set while this job was running.
    const updated = await Cast.findOneAndUpdate(
      { _id: id, topic: PENDING_TOPIC },
      { topic: topic.name },
      { new: true }
    );
    if (updated) {
      cast = updated;
      await createTopicIfNotExist({
        name: topic.name,
        departmentName: cast.department,
        openalexID: topic.openalexID,
        castId: cast._id,
      });
    }
  }
  return true;
};

/** Records a failed run on the cast; marks it "failed" once content errors reach the limit. */
const recordFailure = async (id, error, { finalAttempt }) => {
  const kind = classifyError(error);
  const message = String(error?.message || error).slice(0, 500);
  const update = { $set: { 'processing.status': 'pending', 'processing.lastError': message } };
  if (kind === 'content' && finalAttempt) update.$inc = { 'processing.attempts': 1 };

  const cast = await Cast.findByIdAndUpdate(id, update, { new: true });
  if (!cast) return;
  if (kind === 'content' && cast.processing.attempts >= config.ai.maxAttempts) {
    await Cast.updateOne({ _id: id }, { 'processing.status': 'failed' });
    await alertOpenAIProblem(
      {
        kind: 'content',
        operation: error?.operation,
        message,
        status: error?.status,
        code: error?.code,
      },
      `Item: cast ${id} "${cast.title}" (${cast.processing.attempts} attempts)`
    );
  } else if (kind === 'transient' && finalAttempt) {
    await alertOpenAIProblem({
      kind,
      operation: error?.operation,
      message,
      status: error?.status,
      code: error?.code,
    });
  }
};

/**
 * Bull processor for cast jobs. Temporary errors are retried by Bull with backoff;
 * configuration and content errors are not (the daily retry picks the cast up again).
 */
const runAIJob = async (job) => {
  const id = job.data.castId;
  const exists = await Cast.findByIdAndUpdate(id, {
    'processing.status': 'processing',
    'processing.lastAttemptAt': new Date(),
  });
  if (!exists) {
    console.warn(`cast ${id} no longer exists, skipping AI job.`);
    return;
  }

  try {
    if (await processCast(id)) {
      await Cast.updateOne(
        { _id: id },
        { $set: { 'processing.status': 'done' }, $unset: { 'processing.lastError': 1 } }
      );
      console.log(`AI processing done for cast ${id}.`);
    }
  } catch (error) {
    const kind = classifyError(error);
    const maxBullAttempts = job.opts?.attempts || 1;
    const finalAttempt = kind !== 'transient' || (job.attemptsMade ?? 0) + 1 >= maxBullAttempts;
    if (kind !== 'transient' && typeof job.discard === 'function') job.discard();
    console.error(`AI processing failed for cast ${id} [${kind}]: ${error.message}`);
    await recordFailure(id, error, { finalAttempt });
    throw error;
  }
};

module.exports = { MISSING_OUTPUTS_FILTER, processCast, runAIJob };
