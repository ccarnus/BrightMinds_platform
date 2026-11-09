const config = require('../config');

/**
 * Retries for temporary failures (OpenAI unreachable, rate limits): 4 attempts, 2/4/8 minutes
 * apart. Anything still unprocessed afterwards is picked up by the daily retry (ai_retry.js).
 */
const DEFAULT_JOB_OPTIONS = {
  attempts: 4,
  backoff: { type: 'exponential', delay: 2 * 60 * 1000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

/**
 * Creates a Bull queue backed by Redis. In tests, returns an in-memory stub that
 * records jobs without processing them, so no Redis is needed.
 */
const createQueue = (name) => {
  if (config.isTest) {
    const jobs = [];
    return {
      jobs,
      add: async (data) => {
        jobs.push(data);
        return { data };
      },
      process: () => {},
      close: async () => {},
    };
  }
  const Queue = require('bull');
  return new Queue(name, config.redisUrl, { defaultJobOptions: DEFAULT_JOB_OPTIONS });
};

/** Enqueues a job without blocking the request; failures are logged, never thrown. */
const enqueue = (queue, data) => {
  Promise.resolve(queue.add(data)).catch((error) => {
    console.error('Failed to enqueue job:', error);
  });
};

module.exports = { createQueue, enqueue, DEFAULT_JOB_OPTIONS };
