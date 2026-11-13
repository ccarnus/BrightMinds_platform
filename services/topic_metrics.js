// Scores every catalog topic from OpenAlex counts (see services/topic_scoring.js) and picks the
// hottest topics of each lab. Counts come in batches of 50 topics per request, one pass per window.
const config = require('../config');
const Topic = require('../models/topic_model');
const openalex = require('./openalex');
const { buildWindows, scoreTopics, hotScore } = require('./topic_scoring');

const SERIES_YEARS = 7;
const SERIES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const round = (value, digits = 3) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 10 ** digits) / 10 ** digits
    : null;

/** The fields of a topic document that one score fills in. */
const scoreFields = (row, score, { signalLevel = null, now, endsOn }) => {
  const hot = hotScore(score.hotBase, signalLevel);
  return {
    'score.hot': round(hot, 1),
    'score.hotBase': round(score.hotBase, 1),
    'score.trend': score.trend,
    'score.phase': score.phase,
    'score.works12m': row.c0,
    'score.windows': { c0: row.c0, c1: row.c1, c2: row.c2, top: row.top },
    'score.yoy': round(score.yoy),
    'score.growth': {
      rate: round(score.growth.rate),
      lower: round(score.growth.lower),
      upper: round(score.growth.upper),
      expected: round(score.growth.expected, 1),
    },
    'score.acceleration': round(score.acceleration),
    'score.impact': {
      share: round(score.impact.share, 4),
      lower: round(score.impact.lower, 4),
      level: round(score.levels.impact, 1),
    },
    'score.levels': {
      growth: round(score.levels.growth, 1),
      acceleration: round(score.levels.acceleration, 1),
      impact: round(score.levels.impact, 1),
      volume: round(score.levels.volume, 1),
    },
    'score.signalLevel': signalLevel,
    'score.endsOn': endsOn,
    'score.computedAt': now,
    // Older app versions read these two (0-100).
    activity: round(score.levels.volume, 1) ?? 0,
    impact: round(score.levels.impact, 1) ?? 0,
    'metrics.openalex.worksLast12Months': row.c0,
    'metrics.openalex.lastFetchedAt': now,
  };
};

/**
 * Marks the hottest topics of each lab as featured (listed in the app besides the ones with casts).
 * @returns {Promise<number>} number of featured topics
 */
const rankLabs = async () => {
  const ranked = await Topic.find(
    { source: 'openalex', retired: { $ne: true }, 'score.hot': { $ne: null } },
    'departmentName score.hot score.growth.lower'
  ).lean();
  const labs = new Map();
  for (const topic of ranked) {
    if (!labs.has(topic.departmentName)) labs.set(topic.departmentName, []);
    labs.get(topic.departmentName).push(topic);
  }
  const featured = [];
  for (const topics of labs.values()) {
    topics.sort(
      (a, b) =>
        b.score.hot - a.score.hot || (b.score.growth?.lower ?? 0) - (a.score.growth?.lower ?? 0)
    );
    featured.push(...topics.slice(0, config.atlas.featuredPerLab).map((topic) => topic._id));
  }
  await Topic.updateMany(
    { source: 'openalex', featured: true, _id: { $nin: featured } },
    { $set: { featured: false } }
  );
  await Topic.updateMany(
    { _id: { $in: featured }, featured: { $ne: true } },
    { $set: { featured: true } }
  );
  return featured.length;
};

/**
 * Counts the works of every catalog topic in the three windows, scores them and ranks the labs.
 * Either all the counts arrive or nothing changes: a growth ratio needs consistent windows.
 * @param {{ now?: Date, countByTopic?: Function, log?: Function }} [options]
 */
const refreshTopicMetrics = async ({
  now = new Date(),
  countByTopic = openalex.countWorksByTopic,
  log = () => {},
} = {}) => {
  const windows = buildWindows(now, config.atlas.lagDays);
  const topics = await Topic.find(
    { source: 'openalex', retired: { $ne: true }, openalexID: { $type: 'string' } },
    'openalexID departmentName subfield.id score.signalLevel'
  ).lean();
  if (!topics.length) return { topics: 0, endsOn: windows.endsOn, featured: 0 };

  const ids = topics.map((topic) => topic.openalexID);
  log(`atlas: counting works of ${ids.length} topics (windows end ${windows.endsOn})`);
  const c0 = await countByTopic(ids, windows.w0);
  const c1 = await countByTopic(ids, windows.w1);
  const c2 = await countByTopic(ids, windows.w2);
  const top = await countByTopic(ids, { ...windows.matured, topTenPercent: true });

  const rows = topics.map((topic) => ({
    id: topic.openalexID,
    lab: topic.departmentName,
    subfield: topic.subfield?.id ?? 0,
    c0: c0.get(topic.openalexID) || 0,
    c1: c1.get(topic.openalexID) || 0,
    c2: c2.get(topic.openalexID) || 0,
    top: top.get(topic.openalexID) || 0,
  }));
  const scores = scoreTopics(rows);

  const signalLevels = new Map(
    topics.map((topic) => [topic.openalexID, topic.score?.signalLevel ?? null])
  );
  await Topic.bulkWrite(
    rows.map((row) => ({
      updateOne: {
        filter: { openalexID: row.id },
        update: {
          $set: scoreFields(row, scores.get(row.id), {
            signalLevel: signalLevels.get(row.id),
            now,
            endsOn: windows.endsOn,
          }),
        },
      },
    })),
    { ordered: false }
  );
  const featured = await rankLabs();
  return { topics: rows.length, endsOn: windows.endsOn, featured };
};

/** Works per year of a topic, refreshed at most weekly. */
const ensureSeries = async (
  topic,
  { now = new Date(), countByYear = openalex.countWorksByYear } = {}
) => {
  if (!topic.openalexID) return topic;
  const fetchedAt = topic.series?.fetchedAt;
  if (fetchedAt && now - fetchedAt < SERIES_MAX_AGE_MS && topic.series.yearly?.length) return topic;
  const yearly = await countByYear(topic.openalexID, now.getUTCFullYear() - SERIES_YEARS + 1);
  topic.series = { yearly, fetchedAt: now };
  await Topic.updateOne({ _id: topic._id }, { $set: { series: topic.series } });
  return topic;
};

/** What the app shows to answer "what is the progress on this topic". */
const buildProgress = (topic, { now = new Date() } = {}) => {
  const score = topic.score || {};
  const ranked = score.hot !== null && score.hot !== undefined;
  const currentYear = now.getUTCFullYear();
  return {
    id: topic._id,
    name: topic.name,
    lab: topic.departmentName,
    area: topic.subfield?.name || null,
    scored: Boolean(score.computedAt),
    ranked,
    trend: score.trend || null,
    phase: score.phase || null,
    hot: ranked ? score.hot : null,
    works12m: score.works12m ?? topic.metrics?.openalex?.worksLast12Months ?? 0,
    previous12m: score.windows?.c1 ?? null,
    // Change over the previous 12 months, and how much faster than the topic's area the topic grows
    // (1 = like its area; shrunk, so small topics are not over-read).
    change: score.yoy ?? null,
    versusArea: score.growth?.rate ?? null,
    versusAreaRange: score.growth ? [score.growth.lower, score.growth.upper] : null,
    acceleration: score.acceleration ?? null,
    topCitedShare: score.impact?.share ?? null,
    levels: {
      volume: score.levels?.volume ?? null,
      impact: score.levels?.impact ?? null,
      attention: topic.signals?.wikipedia?.level ?? null,
    },
    yearly: (topic.series?.yearly || []).map((entry) => ({
      year: entry.year,
      works: entry.works,
      partial: entry.year >= currentYear,
    })),
    signals: ['pubmed', 'arxiv', 'wikipedia']
      .filter((name) => topic.signals?.[name]?.fetchedAt)
      .map((name) => ({
        source: name,
        current: topic.signals[name].current,
        previous: topic.signals[name].previous,
        ratio: topic.signals[name].ratio,
      })),
    windowsEndOn: score.endsOn || null,
    computedAt: score.computedAt || null,
  };
};

module.exports = { scoreFields, rankLabs, refreshTopicMetrics, ensureSeries, buildProgress, round };
