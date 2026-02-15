// topic_indicator_computor.js

const axios = require('axios');
const cron = require('node-cron');
const Topic = require('../models/topic_model.js');

const isTestEnv = process.env.NODE_ENV === 'test';

const OPENALEX_BASE_URL = 'https://api.openalex.org';
const WIKIPEDIA_SEARCH_URL = 'https://en.wikipedia.org/w/api.php';
const WIKIMEDIA_PAGEVIEWS_BASE_URL =
  'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';

const CACHE_TTL_MS = {
  openalexAllTime: 30 * 24 * 60 * 60 * 1000,
  openalexWorks12m: 7 * 24 * 60 * 60 * 1000,
  wikipediaViews: 7 * 24 * 60 * 60 * 1000,
};

const BACKOFF_MS = 24 * 60 * 60 * 1000;

const INDICATOR_WEIGHTS = {
  impact: { citations: 0.55, works: 0.25, wikiViews: 0.2 },
  activity: { works12m: 0.45, citations12m: 0.35, wikiViews: 0.2 },
};

const log10p = (value) => Math.log10(value + 1);

const formatDateYYYYMMDD = (date) => {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}${month}${day}`;
};

const formatDateISO = (date) => date.toISOString().slice(0, 10);

const getLast12MonthsRange = () => {
  const end = new Date();
  const start = new Date(end);
  start.setUTCFullYear(end.getUTCFullYear() - 1);
  return {
    startDate: formatDateISO(start),
    endDate: formatDateISO(end),
    startCompact: formatDateYYYYMMDD(start),
    endCompact: formatDateYYYYMMDD(end),
  };
};

const estimateCitations12m = (citedByCount, worksCount, works12m) => {
  if (!worksCount || !citedByCount || !works12m) {
    return 0;
  }
  const averageCitationsPerWork = citedByCount / worksCount;
  return works12m * averageCitationsPerWork;
};

const percentileRank = (sortedValues, value) => {
  if (!sortedValues.length) {
    return 0;
  }
  if (sortedValues.length === 1) {
    return 100;
  }

  const firstIndex = sortedValues.findIndex((item) => item === value);
  const lastIndex = sortedValues.findLastIndex((item) => item === value);
  const rank = (firstIndex + lastIndex) / 2;
  return (rank / (sortedValues.length - 1)) * 100;
};

const createRunCache = () => ({
  openalex: new Map(),
  openalexWorks12m: new Map(),
  wikiTitle: new Map(),
  wikiViews: new Map(),
});

const ensureTopicMetrics = (topic) => {
  if (!topic.metrics) {
    topic.metrics = {};
  }
  if (!topic.metrics.openalex) {
    topic.metrics.openalex = {};
  }
  if (!topic.metrics.wikipedia) {
    topic.metrics.wikipedia = {};
  }
  return topic.metrics;
};

const isFresh = (lastFetchedAt, ttlMs, now) => {
  if (!lastFetchedAt) {
    return false;
  }
  return now - new Date(lastFetchedAt) < ttlMs;
};

const setBackoff = (metrics, error, now) => {
  metrics.lastError = error;
  metrics.backoffUntil = new Date(now.getTime() + BACKOFF_MS);
};

const fetchOpenAlexTopicMetrics = async (openalexID) => {
  const openAlexUrl = `${OPENALEX_BASE_URL}/topics/${openalexID}`;
  const response = await axios.get(openAlexUrl);
  const data = response.data || {};
  return {
    citedByCount: data.cited_by_count || 0,
    worksCount: data.works_count || 0,
  };
};

const fetchOpenAlexWorksCountLast12Months = async (openalexID, startDate, endDate) => {
  const filter = `topics.id:${openalexID},from_publication_date:${startDate},to_publication_date:${endDate}`;
  const response = await axios.get(`${OPENALEX_BASE_URL}/works`, {
    params: {
      filter,
      per_page: 1,
    },
  });

  return response.data?.meta?.count || 0;
};

const fetchWikipediaTitle = async (topicName) => {
  const searchResponse = await axios.get(WIKIPEDIA_SEARCH_URL, {
    params: {
      action: 'query',
      list: 'search',
      srsearch: topicName,
      srlimit: 1,
      format: 'json',
    },
  });
  return searchResponse.data?.query?.search?.[0]?.title || null;
};

const fetchWikipediaViews12Months = async (title, startCompact, endCompact) => {
  const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));
  const pageviewsUrl = `${WIKIMEDIA_PAGEVIEWS_BASE_URL}/${encodedTitle}/daily/${startCompact}/${endCompact}`;
  const pageviewsResponse = await axios.get(pageviewsUrl);

  const items = pageviewsResponse.data?.items || [];
  return items.reduce((sum, item) => sum + (item.views || 0), 0);
};

const computeRawIndicatorsForTopic = async (topic, runCache = createRunCache()) => {
  const { startDate, endDate, startCompact, endCompact } = getLast12MonthsRange();
  const now = new Date();
  const metrics = ensureTopicMetrics(topic);

  let citedByCount = metrics.openalex.citedByCount || 0;
  let worksCount = metrics.openalex.worksCount || 0;
  let worksLast12Months = metrics.openalex.worksLast12Months || 0;
  let wikiViews12Months = metrics.wikipedia.views12Months || 0;

  const backoffActive =
    metrics.backoffUntil && new Date(metrics.backoffUntil).getTime() > now.getTime();

  if (!isTestEnv && !backoffActive && topic.openalexID) {
    const openalexCacheKey = topic.openalexID;
    const openalexCached = runCache.openalex.get(openalexCacheKey);
    if (openalexCached) {
      citedByCount = openalexCached.citedByCount;
      worksCount = openalexCached.worksCount;
    } else if (isFresh(metrics.openalex.lastFetchedAt, CACHE_TTL_MS.openalexAllTime, now)) {
      citedByCount = metrics.openalex.citedByCount || 0;
      worksCount = metrics.openalex.worksCount || 0;
    } else {
      try {
        const openAlexMetrics = await fetchOpenAlexTopicMetrics(topic.openalexID);
        citedByCount = openAlexMetrics.citedByCount;
        worksCount = openAlexMetrics.worksCount;
        metrics.openalex.citedByCount = citedByCount;
        metrics.openalex.worksCount = worksCount;
        metrics.openalex.lastFetchedAt = now;
        metrics.lastError = null;
        runCache.openalex.set(openalexCacheKey, openAlexMetrics);
      } catch (error) {
        console.error(`Error fetching OpenAlex metrics for "${topic.name}":`, error.message);
        setBackoff(metrics, `openalex: ${error.message}`, now);
      }
    }

    const worksCacheKey = `${topic.openalexID}:${startDate}:${endDate}`;
    const worksCached = runCache.openalexWorks12m.get(worksCacheKey);
    if (worksCached !== undefined) {
      worksLast12Months = worksCached;
    } else if (isFresh(metrics.openalex.lastWorksFetchedAt, CACHE_TTL_MS.openalexWorks12m, now)) {
      worksLast12Months = metrics.openalex.worksLast12Months || 0;
    } else {
      try {
        worksLast12Months = await fetchOpenAlexWorksCountLast12Months(
          topic.openalexID,
          startDate,
          endDate
        );
        metrics.openalex.worksLast12Months = worksLast12Months;
        metrics.openalex.lastWorksFetchedAt = now;
        metrics.lastError = null;
        runCache.openalexWorks12m.set(worksCacheKey, worksLast12Months);
      } catch (error) {
        console.error(`Error fetching OpenAlex 12-month works for "${topic.name}":`, error.message);
        setBackoff(metrics, `openalex-works: ${error.message}`, now);
      }
    }
  } else if (!topic.openalexID) {
    console.warn(`No openalexID for topic "${topic.name}". Falling back to Wikipedia only.`);
  }

  if (!isTestEnv && !backoffActive) {
    let wikiTitle = metrics.wikipedia.title;
    if (!wikiTitle) {
      const cachedTitle = runCache.wikiTitle.get(topic.name);
      if (cachedTitle) {
        wikiTitle = cachedTitle;
      } else if (!isFresh(metrics.wikipedia.lastFetchedAt, CACHE_TTL_MS.wikipediaViews, now)) {
        try {
          wikiTitle = await fetchWikipediaTitle(topic.name);
          metrics.wikipedia.title = wikiTitle;
          runCache.wikiTitle.set(topic.name, wikiTitle);
          metrics.lastError = null;
        } catch (error) {
          console.warn(`Wikipedia lookup failed for "${topic.name}": ${error.message}`);
          setBackoff(metrics, `wikipedia-search: ${error.message}`, now);
        }
      }
    }

    if (!wikiTitle && isFresh(metrics.wikipedia.lastFetchedAt, CACHE_TTL_MS.wikipediaViews, now)) {
      wikiViews12Months = metrics.wikipedia.views12Months || 0;
    }

    if (wikiTitle) {
      const cachedViews = runCache.wikiViews.get(wikiTitle);
      if (cachedViews !== undefined) {
        wikiViews12Months = cachedViews;
      } else if (isFresh(metrics.wikipedia.lastFetchedAt, CACHE_TTL_MS.wikipediaViews, now)) {
        wikiViews12Months = metrics.wikipedia.views12Months || 0;
      } else {
        try {
          wikiViews12Months = await fetchWikipediaViews12Months(
            wikiTitle,
            startCompact,
            endCompact
          );
          metrics.wikipedia.views12Months = wikiViews12Months;
          metrics.wikipedia.lastFetchedAt = now;
          metrics.lastError = null;
          runCache.wikiViews.set(wikiTitle, wikiViews12Months);
        } catch (error) {
          console.warn(`Wikipedia pageviews not available for "${wikiTitle}": ${error.message}`);
          setBackoff(metrics, `wikipedia-views: ${error.message}`, now);
        }
      }
    } else if (metrics.wikipedia.lastFetchedAt === null) {
      metrics.wikipedia.lastFetchedAt = now;
      metrics.wikipedia.views12Months = 0;
    }
  }

  const estimatedCitations12Months = estimateCitations12m(
    citedByCount,
    worksCount,
    worksLast12Months
  );

  const impactRaw =
    INDICATOR_WEIGHTS.impact.citations * log10p(citedByCount) +
    INDICATOR_WEIGHTS.impact.works * log10p(worksCount) +
    INDICATOR_WEIGHTS.impact.wikiViews * log10p(wikiViews12Months);

  const activityRaw =
    INDICATOR_WEIGHTS.activity.works12m * log10p(worksLast12Months) +
    INDICATOR_WEIGHTS.activity.citations12m * log10p(estimatedCitations12Months) +
    INDICATOR_WEIGHTS.activity.wikiViews * log10p(wikiViews12Months);

  return {
    impactRaw,
    activityRaw,
    metrics: {
      citedByCount,
      worksCount,
      worksLast12Months,
      wikiViews12Months,
      estimatedCitations12Months,
      backoffActive,
    },
  };
};

/**
 * Computes and updates the impact and activity for a single topic.
 * Uses OpenAlex (citations, works, works last 12 months) and Wikipedia pageviews.
 * Then it computes:
 *   impact_raw = 0.55 * log10(citations_all_time + 1)
 *             + 0.25 * log10(works_all_time + 1)
 *             + 0.20 * log10(wikipedia_views_12m + 1)
 *   activity_raw = 0.45 * log10(works_12m + 1)
 *               + 0.35 * log10(estimated_citations_12m + 1)
 *               + 0.20 * log10(wikipedia_views_12m + 1)
 *
 * Note: estimated_citations_12m is derived from the average citations per work.
 * This function saves the raw scores; percentile normalization is applied in batch.
 *
 * @param {Object} topic - A Mongoose Topic document.
 * @returns {Promise<Object>} The updated topic document.
 */
async function computeImpactForTopic(topic) {
  try {
    const { impactRaw, activityRaw } = await computeRawIndicatorsForTopic(topic);

    topic.impact = impactRaw;
    topic.activity = activityRaw;
    if (topic.metrics) {
      topic.metrics.lastComputedAt = new Date();
    }
    await topic.save();

    console.log(`Updated topic "${topic.name}": impact = ${topic.impact}, activity = ${topic.activity}`);
    return topic;
  } catch (error) {
    console.error(`Error computing impact for topic "${topic.name}":`, error.message);
    return null;
  }
}

/**
 * Finds all topics and computes their impact value.
 *
 * @returns {Promise<void>}
 */
async function computeImpactForAllTopics() {
  try {
    const topics = await Topic.find();
    console.log(`Found ${topics.length} topic(s) for impact update.`);

    const rawResults = [];
    const runCache = createRunCache();
    for (const topic of topics) {
      const rawIndicators = await computeRawIndicatorsForTopic(topic, runCache);
      rawResults.push({
        topic,
        impactRaw: rawIndicators.impactRaw,
        activityRaw: rawIndicators.activityRaw,
      });
    }

    const impactValues = rawResults.map((entry) => entry.impactRaw).sort((a, b) => a - b);
    const activityValues = rawResults.map((entry) => entry.activityRaw).sort((a, b) => a - b);

    for (const entry of rawResults) {
      const impactPercentile = percentileRank(impactValues, entry.impactRaw);
      const activityPercentile = percentileRank(activityValues, entry.activityRaw);

      entry.topic.impact = Number(impactPercentile.toFixed(2));
      entry.topic.activity = Number(activityPercentile.toFixed(2));
      if (entry.topic.metrics) {
        entry.topic.metrics.lastComputedAt = new Date();
      }
      await entry.topic.save();
    }

    console.log("Completed updating impact for all topics.");
  } catch (error) {
    console.error("Error computing impact for all topics:", error.message);
  }
}

/**
 * Schedules a job to update the impact value for all topics every Monday at midnight.
 * The cron pattern "0 0 * * 1" corresponds to "At 00:00 on Monday."
 */
function scheduleWeeklyImpactUpdate() {
  if (isTestEnv) {
    return;
  }
  cron.schedule('0 0 * * 1', () => {
    console.log("Scheduled weekly impact update started...");
    computeImpactForAllTopics();
  });
  console.log("Weekly impact update scheduled for every Monday at midnight.");
}

module.exports = {
  computeImpactForTopic,
  computeImpactForAllTopics,
  scheduleWeeklyImpactUpdate,
};
