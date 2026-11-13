// Process entry point: validates config, connects to MongoDB, starts workers/cron, then listens.
const mongoose = require('mongoose');
const config = require('./config');
const app = require('./app');
const { scheduleDailyAIRetry } = require('./services/ai_retry');
const { migrateLearningProfiles } = require('./services/learning_migration');
const { migrateToCastOnly } = require('./services/cast_only_migration');
const { backfillCastThumbnails } = require('./services/thumbnail_backfill');
const { castQueue, startCastWorker } = require('./queues/cast_queue');
const { verifyMail } = require('./services/mailer');
const { scheduleWeeklyLabResearch, refreshIfStale } = require('./services/lab_research');
const { migrateLegacyTopics } = require('./services/atlas_sync');
const { scheduleWeeklyAtlas, refreshIfStale: refreshAtlasIfStale } = require('./services/atlas');

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
  try {
    const result = await migrateToCastOnly();
    const changed =
      result.users.references + result.users.stats + result.topics.deleted + result.topics.updated;
    if (changed > 0 || result.articlesCollection === 'dropped') {
      console.log('Removed article data:', JSON.stringify(result));
    }
  } catch (error) {
    console.error('Article data cleanup failed:', error);
  }

  // Topics created before the research atlas get their origin (catalog or author).
  try {
    const topics = await migrateLegacyTopics();
    if (topics.catalog || topics.authored || topics.detached) {
      console.log('Topics migrated:', JSON.stringify(topics));
    }
  } catch (error) {
    console.error('Topic migration failed:', error);
  }

  startCastWorker();
  // Not awaited: a mail problem must not delay or stop the API (users can still log in and use the app).
  verifyMail().then((mail) => {
    if (mail.ok) console.log('Email: the SMTP account accepted the credentials.');
    else console.error(`Email is NOT working (${mail.kind}): ${mail.message}`);
  });
  const atlasTask = scheduleWeeklyAtlas();
  const labResearchTask = scheduleWeeklyLabResearch();
  // Fills in (or renews) the research volume that sizes the labs; the API works without it.
  refreshIfStale();
  // Syncs the topic catalog and scores it, in the background, when missing or older than a week.
  refreshAtlasIfStale();
  const retryTask = scheduleDailyAIRetry();
  if (!config.openai.apiKey) {
    console.warn('OPENAI_API_KEY is not set: new casts stay unprocessed until it is.');
  }

  const server = app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port} (${config.env}).`);
  });

  // Casts whose image is not a frame of their video (former AI illustrations) get an automatic
  // thumbnail, in the background; already converted casts are skipped.
  backfillCastThumbnails()
    .then(({ replaced, failed }) => {
      if (replaced || failed) {
        console.log(`Cast thumbnails: ${replaced} replaced, ${failed} could not be extracted.`);
      }
    })
    .catch((error) => console.error('Cast thumbnail backfill failed:', error));

  const shutdown = async (signal) => {
    console.log(`${signal} received, shutting down.`);
    server.close();
    atlasTask?.stop();
    labResearchTask?.stop();
    retryTask?.stop();
    await Promise.allSettled([castQueue.close()]);
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
