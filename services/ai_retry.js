// Daily safety net: re-queues casts whose AI outputs are still missing (OpenAI down, wrong key,
// server restarted mid-job...). Casts marked "failed" are skipped until retried explicitly.
const cron = require('node-cron');
const config = require('../config');
const Cast = require('../models/cast_model');
const { MISSING_OUTPUTS_FILTER } = require('./ai_pipeline');
const { AIError, resumeOpenAI } = require('./openai');
const { alertOpenAIProblem } = require('./openai_alerts');

// A job marked "processing" for longer than this is assumed to have died with the server.
const STALE_PROCESSING_MS = 2 * 60 * 60 * 1000;

/** Casts that should be (re)processed now. */
const findRetryable = ({ includeFailed = false } = {}) => {
  const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
  const excluded = [
    { 'processing.status': 'processing', 'processing.lastAttemptAt': { $gt: staleBefore } },
  ];
  if (!includeFailed) excluded.push({ 'processing.status': 'failed' });
  return Cast.find(
    { $and: [MISSING_OUTPUTS_FILTER, { $nor: excluded }] },
    '_id title processing'
  ).sort({ _id: 1 });
};

/**
 * Queues every retryable cast.
 * @param {{ includeFailed?: boolean }} [options] includeFailed also resets casts marked "failed".
 * @returns {Promise<number>} Number of casts queued.
 */
const enqueueRetries = async ({ includeFailed = false } = {}) => {
  if (!config.openai.apiKey) {
    await alertOpenAIProblem(
      new AIError('config', 'OpenAI API key not configured (OPENAI_API_KEY).', {
        operation: 'dailyRetry',
      })
    );
    return 0;
  }
  // A new run is the moment to try again after a configuration error.
  resumeOpenAI();

  const { castQueue } = require('../queues/cast_queue');
  const casts = await findRetryable({ includeFailed });
  for (const cast of casts) {
    if (cast.processing?.status === 'failed') {
      await Cast.updateOne(
        { _id: cast._id },
        { 'processing.status': 'pending', 'processing.attempts': 0 }
      );
    }
    await castQueue.add({ castId: cast._id.toString() });
  }
  console.log(`AI retry: queued ${casts.length} cast(s).`);
  return casts.length;
};

/** Count of casts, and the ones still missing AI outputs with their processing status. */
const getAIStatus = async () => {
  const casts = await Cast.find(MISSING_OUTPUTS_FILTER, '_id title processing').lean();
  return {
    total: await Cast.countDocuments(),
    unprocessed: casts.map((cast) => ({
      id: cast._id.toString(),
      title: cast.title,
      status: cast.processing?.status ?? 'pending',
      attempts: cast.processing?.attempts ?? 0,
      lastError: cast.processing?.lastError ?? null,
      lastAttemptAt: cast.processing?.lastAttemptAt ?? null,
    })),
  };
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
