// Process entry point: validates config, connects to MongoDB, starts workers/cron, then listens.
const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');
const { scheduleWeeklyImpactUpdate } = require('./services/topic_indicator_computor');
const { scheduleDailyAIRetry } = require('./services/ai_retry');
const { migrateLearningProfiles } = require('./services/learning_migration');
const { castQueue, startCastWorker } = require('./queues/cast_queue');
const { articleQueue, startArticleWorker } = require('./queues/article_queue');

const start = async () => {
  config.validate();
  if (!config.auth.required) {
    console.warn('AUTH_REQUIRED is not "true": protected routes accept unauthenticated requests.');
  }

  await mongoose.connect(config.mongoUri);
  console.log('Connected to MongoDB.');

  // A failed migration leaves the remaining accounts for the next start; the API still works.
  try {
    const migrated = await migrateLearningProfiles();
    if (migrated > 0) console.log(`Migrated ${migrated} learning profile(s).`);
  } catch (error) {
    console.error('Learning profile migration failed:', error);
  }

  startCastWorker();
  startArticleWorker();
  const impactTask = scheduleWeeklyImpactUpdate();
  const retryTask = scheduleDailyAIRetry();
  if (!config.openai.apiKey) {
    console.warn('OPENAI_API_KEY is not set: new content stays unprocessed until it is.');
  }

  const server = app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port} (${config.env}).`);
  });

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down.`);
    server.close();
    impactTask?.stop();
    retryTask?.stop();
    await Promise.allSettled([castQueue.close(), articleQueue.close()]);
    await mongoose.disconnect();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
