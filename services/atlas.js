// The research atlas: catalog of topics, scores from OpenAlex, independent signals. One entry point
// to refresh it all, run at server start when stale and every Monday, or by hand (`npm run atlas`).
const cron = require('node-cron');
const config = require('../config');
const Topic = require('../models/topic_model');
const AtlasState = require('../models/atlas_state_model');
const { syncCatalog } = require('./atlas_sync');
const { refreshTopicMetrics } = require('./topic_metrics');
const { refreshSignals } = require('./topic_signals');

// A failed refresh is not retried by the start-up check for this long.
const RETRY_AFTER_MS = 60 * 60 * 1000;

let running = null;
let lastFailureAt = 0;

const isOlderThan = (date, ms, now = Date.now()) => !date || now - new Date(date).getTime() > ms;

/**
 * Refreshes the atlas. `catalog: 'auto'` syncs the catalog only when it is missing or old.
 * Steps run in order and a failure stops the run (what was stored before stays); it is recorded in the state.
 * @returns {Promise<object>} what each step did
 */
const refreshAtlas = async ({
  catalog = 'auto',
  metrics = true,
  signals = true,
  log = (message) => console.log(message),
  overrides = {},
} = {}) => {
  if (running) return running;
  running = (async () => {
    const state = await AtlasState.get();
    const result = {};
    try {
      const hasCatalog = (await Topic.countDocuments({ source: 'openalex' })) > 0;
      const needsCatalog =
        catalog === true ||
        (catalog === 'auto' &&
          (!hasCatalog || isOlderThan(state.catalogSyncedAt, config.atlas.catalogMaxAgeMs)));
      if (needsCatalog) {
        result.catalog = await (overrides.syncCatalog || syncCatalog)();
        state.catalogSyncedAt = new Date();
        log(
          `atlas: catalog synced (${result.catalog.topics} topics, ${result.catalog.created} new)`
        );
      }
      if (metrics) {
        result.metrics = await (overrides.refreshTopicMetrics || refreshTopicMetrics)({ log });
        state.metricsAt = new Date();
        state.windowsEndOn = result.metrics.endsOn;
        state.topics = result.metrics.topics;
        log(`atlas: scored ${result.metrics.topics} topics, ${result.metrics.featured} featured`);
      }
      if (signals && (result.metrics?.topics || !metrics)) {
        result.signals = await (overrides.refreshSignals || refreshSignals)({ log });
        state.signalsAt = new Date();
        log(`atlas: signals for ${result.signals.tracked} tracked topics`);
      }
      state.lastError = null;
      state.lastErrorAt = null;
    } catch (error) {
      state.lastError = String(error.message || error).slice(0, 500);
      state.lastErrorAt = new Date();
      lastFailureAt = Date.now();
      await state.save();
      throw error;
    }
    await state.save();
    return result;
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
};

/** Whether the catalog or the scores are missing or old. */
const needsRefresh = async (now = Date.now()) => {
  const state = await AtlasState.get();
  const hasCatalog = (await Topic.countDocuments({ source: 'openalex' })) > 0;
  return (
    !hasCatalog ||
    isOlderThan(state.catalogSyncedAt, config.atlas.catalogMaxAgeMs, now) ||
    isOlderThan(state.metricsAt, config.atlas.metricsMaxAgeMs, now)
  );
};

/** In the background, when needed; never throws, never overlaps, never hammers after a failure. */
const refreshIfStale = () => {
  if (config.isTest || running || Date.now() - lastFailureAt < RETRY_AFTER_MS) return running;
  needsRefresh()
    .then((stale) => (stale ? refreshAtlas() : null))
    .catch((error) => console.error('Atlas refresh failed:', error.message));
  return running;
};

/** Weekly refresh; null in tests. */
const scheduleWeeklyAtlas = () => {
  if (config.isTest) return null;
  return cron.schedule(config.atlas.refreshCron, () => {
    refreshAtlas().catch((error) => console.error('Atlas refresh failed:', error.message));
  });
};

/** What the ops script and the status endpoint show. */
const getStatus = async () => {
  const state = await AtlasState.get();
  const [catalog, scored, featured, withCasts, authored] = await Promise.all([
    Topic.countDocuments({ source: 'openalex', retired: { $ne: true } }),
    Topic.countDocuments({ source: 'openalex', 'score.computedAt': { $ne: null } }),
    Topic.countDocuments({ featured: true }),
    Topic.countDocuments({ castCount: { $gt: 0 } }),
    Topic.countDocuments({ source: 'author' }),
  ]);
  return {
    catalogSyncedAt: state.catalogSyncedAt,
    metricsAt: state.metricsAt,
    signalsAt: state.signalsAt,
    windowsEndOn: state.windowsEndOn,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt,
    topics: { catalog, scored, featured, withCasts, authored },
    openalexKey: Boolean(config.openalex.apiKey),
  };
};

module.exports = {
  refreshAtlas,
  refreshIfStale,
  scheduleWeeklyAtlas,
  needsRefresh,
  getStatus,
};
