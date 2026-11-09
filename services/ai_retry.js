// Daily safety net: re-queues casts/articles whose AI outputs are still missing (OpenAI down, wrong
// key, server restarted mid-job...). Items marked "failed" are skipped until retried explicitly.
const cron = require('node-cron');
const config = require('../config');
const { CONTENT_TYPES, missingOutputsFilter } = require('./ai_pipeline');
const { AIError, resumeOpenAI } = require('./openai');
const { alertOpenAIProblem } = require('./openai_alerts');

// A job marked "processing" for longer than this is assumed to have died with the server.
const STALE_PROCESSING_MS = 2 * 60 * 60 * 1000;

const QUEUES = {
  cast: () => require('../queues/cast_queue').castQueue,
  article: () => require('../queues/article_queue').articleQueue,
};

/** Content of `type` that should be (re)processed now. */
const findRetryable = (type, { includeFailed = false } = {}) => {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const excluded = [
    { 'processing.status': 'processing', 'processing.lastAttemptAt': { $gt: staleBefore } },
  ];
  if (!includeFailed) excluded.push({ 'processing.status': 'failed' });
  return CONTENT_TYPES[type].Model.find(
    { $and: [missingOutputsFilter(type), { $nor: excluded }] },
    '_id title processing'
  ).sort({ _id: 1 });
};

/**
 * Queues every retryable cast/article.
 * @param {{ includeFailed?: boolean }} [options] includeFailed also resets items marked "failed".
 * @returns {Promise<{ cast: number, article: number }>} Number of items queued per type.
 */
const enqueueRetries = async ({ includeFailed = false } = {}) => {
  const queued = { cast: 0, article: 0 };
  if (!config.openai.apiKey) {
    await alertOpenAIProblem(
      new AIError('config', 'OpenAI API key not configured (OPENAI_API_KEY).', {
        operation: 'dailyRetry',
      })
    );
    return queued;
  }
  // A new run is the moment to try again after a configuration error.
  resumeOpenAI();

  for (const type of Object.keys(CONTENT_TYPES)) {
    const { Model, idField } = CONTENT_TYPES[type];
    const items = await findRetryable(type, { includeFailed });
    for (const item of items) {
      if (item.processing?.status === 'failed') {
        await Model.updateOne(
          { _id: item._id },
          { 'processing.status': 'pending', 'processing.attempts': 0 }
        );
      }
      await QUEUES[type]().add({ [idField]: item._id.toString() });
      queued[type] += 1;
    }
  }
  console.log(`AI retry: queued ${queued.cast} cast(s) and ${queued.article} article(s).`);
  return queued;
};

/** Per-type counts of content still missing AI outputs, by processing status. */
const getAIStatus = async () => {
  const status = {};
  for (const type of Object.keys(CONTENT_TYPES)) {
    const items = await CONTENT_TYPES[type].Model.find(
      missingOutputsFilter(type),
      '_id title processing'
    ).lean();
    status[type] = {
      total: await CONTENT_TYPES[type].Model.countDocuments(),
      unprocessed: items.map((item) => ({
        id: item._id.toString(),
        title: item.title,
        status: item.processing?.status ?? 'pending',
        attempts: item.processing?.attempts ?? 0,
        lastError: item.processing?.lastError ?? null,
        lastAttemptAt: item.processing?.lastAttemptAt ?? null,
      })),
    };
  }
  return status;
};

/** @returns {import('node-cron').ScheduledTask | null} */
const scheduleDailyAIRetry = () => {
  if (config.isTest) return null;
  const task = cron.schedule(config.ai.retryCron, () => {
    enqueueRetries().catch((error) => console.error('AI retry failed:', error));
  });
  console.log(`AI retry scheduled (${config.ai.retryCron}).`);
  return task;
};

module.exports = { enqueueRetries, findRetryable, getAIStatus, scheduleDailyAIRetry };
