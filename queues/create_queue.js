const config = require('../config');

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
  return new Queue(name, config.redisUrl, {
    defaultJobOptions: { removeOnComplete: 100, removeOnFail: 500 },
  });
};

/** Enqueues a job without blocking the request; failures are logged, never thrown. */
const enqueue = (queue, data) => {
  Promise.resolve(queue.add(data)).catch((error) => {
    console.error('Failed to enqueue job:', error);
  });
};

module.exports = { createQueue, enqueue };
