// Generative-AI processing of casts and articles, run by the cast/article queues.
// Steps only run when their output is missing and are saved as soon as they succeed, so a job can
// be retried (by Bull, the daily retry or `node scripts/ai.js retry`) and resumes where it stopped:
//   1. transcript + subtitles (casts)   2. question, department   3. topic
// Images are never generated: casts show a frame of their video (services/thumbnail.js), articles
// the cover uploaded by their author.
const fs = require('fs');
const config = require('../config');
const Article = require('../models/article_model');
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

const CONTENT_TYPES = {
  cast: { Model: Cast, idField: 'castId' },
  article: { Model: Article, idField: 'articleId' },
};

const isEmpty = { $in: [null, ''] };

/** Mongo filter matching content of `type` that still lacks at least one AI output. */
const missingOutputsFilter = (type) => ({
  $or: [
    ...(type === 'cast' ? [{ description: isEmpty }] : []),
    { 'evaluation.question': isEmpty },
    { department: PENDING_DEPARTMENT },
    { topic: PENDING_TOPIC },
  ],
});

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
 * Runs the missing AI steps for one cast/article. Re-reads the document after each long step so
 * edits or deletions made meanwhile are respected.
 * @returns {Promise<boolean>} false if the content no longer exists.
 * @throws {AIError|Error}
 */
const processContent = async (type, id) => {
  const { Model } = CONTENT_TYPES[type];
  const save = (update) => Model.findByIdAndUpdate(id, update, { new: true });

  let content = await Model.findById(id);
  if (!content) return false;

  if (type === 'cast' && !content.description) {
    content = await save(await transcribeCast(content));
    if (!content) return false;
  }

  const needsDepartment = !content.department || content.department === PENDING_DEPARTMENT;
  const needsEvaluation = !content.evaluation?.question;
  if (needsDepartment || needsEvaluation) {
    const analysis = await analyzeContent({
      title: content.title,
      description: content.description,
      contentType: type,
    });
    const update = {};
    if (needsEvaluation) update.evaluation = analysis.evaluation;
    if (needsDepartment) update.department = analysis.department;
    if (Object.keys(update).length) {
      content = await save(update);
      if (!content) return false;
    }
    // A topic chosen by the author can only be registered once the department is known.
    if (needsDepartment && content.topic !== PENDING_TOPIC) {
      await createTopicIfNotExist({
        name: content.topic,
        departmentName: content.department,
        contentId: content._id,
        contentType: type,
      });
    }
  }

  if (content.topic === PENDING_TOPIC) {
    const topic = await chooseTopic({
      title: content.title,
      description: content.description,
      department: content.department,
    });
    // Conditional update: keeps a topic the author set while this job was running.
    const updated = await Model.findOneAndUpdate(
      { _id: id, topic: PENDING_TOPIC },
      { topic: topic.name },
      { new: true }
    );
    if (updated) {
      content = updated;
      await createTopicIfNotExist({
        name: topic.name,
        departmentName: content.department,
        openalexID: topic.openalexID,
        contentId: content._id,
        contentType: type,
      });
    }
  }
  return true;
};

/** Records a failed run on the document; marks it "failed" once content errors reach the limit. */
const recordFailure = async (type, id, error, { finalAttempt }) => {
  const { Model } = CONTENT_TYPES[type];
  const kind = classifyError(error);
  const message = String(error?.message || error).slice(0, 500);
  const update = { $set: { 'processing.status': 'pending', 'processing.lastError': message } };
  if (kind === 'content' && finalAttempt) update.$inc = { 'processing.attempts': 1 };

  const content = await Model.findByIdAndUpdate(id, update, { new: true });
  if (!content) return;
  if (kind === 'content' && content.processing.attempts >= config.ai.maxAttempts) {
    await Model.updateOne({ _id: id }, { 'processing.status': 'failed' });
    await alertOpenAIProblem(
      {
        kind: 'content',
        operation: error?.operation,
        message,
        status: error?.status,
        code: error?.code,
      },
      `Item: ${type} ${id} "${content.title}" (${content.processing.attempts} attempts)`
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
 * Bull processor for cast/article jobs. Temporary errors are retried by Bull with backoff;
 * configuration and content errors are not (the daily retry picks the item up again).
 */
const runAIJob = async (type, job) => {
  const { Model, idField } = CONTENT_TYPES[type];
  const id = job.data[idField];
  const exists = await Model.findByIdAndUpdate(id, {
    'processing.status': 'processing',
    'processing.lastAttemptAt': new Date(),
  });
  if (!exists) {
    console.warn(`${type} ${id} no longer exists, skipping AI job.`);
    return;
  }

  try {
    if (await processContent(type, id)) {
      await Model.updateOne(
        { _id: id },
        { $set: { 'processing.status': 'done' }, $unset: { 'processing.lastError': 1 } }
      );
      console.log(`AI processing done for ${type} ${id}.`);
    }
  } catch (error) {
    const kind = classifyError(error);
    const maxBullAttempts = job.opts?.attempts || 1;
    const finalAttempt = kind !== 'transient' || (job.attemptsMade ?? 0) + 1 >= maxBullAttempts;
    if (kind !== 'transient' && typeof job.discard === 'function') job.discard();
    console.error(`AI processing failed for ${type} ${id} [${kind}]: ${error.message}`);
    await recordFailure(type, id, error, { finalAttempt });
    throw error;
  }
};

module.exports = { CONTENT_TYPES, missingOutputsFilter, processContent, runAIJob };
