// topic_indicator_computor.js

const axios = require('axios');
const cron = require('node-cron');
const Topic = require('../models/topic_model.js');

const isTestEnv = process.env.NODE_ENV === 'test';

const OPENALEX_BASE_URL = 'https://api.openalex.org';
const WIKIPEDIA_SEARCH_URL = 'https://en.wikipedia.org/w/api.php';
const WIKIMEDIA_PAGEVIEWS_BASE_URL =
  'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';

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

const fetchOpenAlexTopicMetrics = async (openalexID) => {
  if (!openalexID || isTestEnv) {
    return { citedByCount: 0, worksCount: 0 };
  }

  const openAlexUrl = `${OPENALEX_BASE_URL}/topics/${openalexID}`;
  const response = await axios.get(openAlexUrl);
  const data = response.data || {};
  return {
    citedByCount: data.cited_by_count || 0,
    worksCount: data.works_count || 0,
  };
};

const fetchOpenAlexWorksCountLast12Months = async (openalexID, startDate, endDate) => {
  if (!openalexID || isTestEnv) {
    return 0;
  }

  const filter = `topics.id:${openalexID},from_publication_date:${startDate},to_publication_date:${endDate}`;
  const response = await axios.get(`${OPENALEX_BASE_URL}/works`, {
    params: {
      filter,
      per_page: 1,
    },
  });

  return response.data?.meta?.count || 0;
};

const fetchWikipediaViews12Months = async (topicName, startCompact, endCompact) => {
  if (!topicName || isTestEnv) {
    return 0;
  }

  try {
    const searchResponse = await axios.get(WIKIPEDIA_SEARCH_URL, {
      params: {
        action: 'query',
        list: 'search',
        srsearch: topicName,
        srlimit: 1,
        format: 'json',
      },
    });

    const title = searchResponse.data?.query?.search?.[0]?.title;
    if (!title) {
      return 0;
    }

    const encodedTitle = encodeURIComponent(title.replace(/ /g, '_'));
    const pageviewsUrl = `${WIKIMEDIA_PAGEVIEWS_BASE_URL}/${encodedTitle}/daily/${startCompact}/${endCompact}`;
    const pageviewsResponse = await axios.get(pageviewsUrl);

    const items = pageviewsResponse.data?.items || [];
    return items.reduce((sum, item) => sum + (item.views || 0), 0);
  } catch (error) {
    console.warn(`Wikipedia pageviews not available for "${topicName}": ${error.message}`);
    return 0;
  }
};

const computeRawIndicatorsForTopic = async (topic) => {
  const { startDate, endDate, startCompact, endCompact } = getLast12MonthsRange();

  let citedByCount = 0;
  let worksCount = 0;
  let worksLast12Months = 0;

  if (topic.openalexID) {
    try {
      const openAlexMetrics = await fetchOpenAlexTopicMetrics(topic.openalexID);
      citedByCount = openAlexMetrics.citedByCount;
      worksCount = openAlexMetrics.worksCount;
    } catch (error) {
      console.error(`Error fetching OpenAlex metrics for "${topic.name}":`, error.message);
    }

    try {
      worksLast12Months = await fetchOpenAlexWorksCountLast12Months(
        topic.openalexID,
        startDate,
        endDate
      );
    } catch (error) {
      console.error(`Error fetching OpenAlex 12-month works for "${topic.name}":`, error.message);
    }
  } else {
    console.warn(`No openalexID for topic "${topic.name}". Falling back to Wikipedia only.`);
  }

  const wikiViews12Months = await fetchWikipediaViews12Months(
    topic.name,
    startCompact,
    endCompact
  );
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
    for (const topic of topics) {
      const rawIndicators = await computeRawIndicatorsForTopic(topic);
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
