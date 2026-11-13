// OpenAlex client shared by the research atlas: API key, spacing between requests (OR-lists longer
// than 10 topics are limited to one request per second), retries on rate limits and server errors.
const axios = require('axios');
const config = require('../config');

const BASE_URL = 'https://api.openalex.org';
const TIMEOUT_MS = 30000;
const MAX_ATTEMPTS = 4;
// OpenAlex accepts at most this many values in one OR filter; more than 10 are paced at 1 request/s.
const MAX_TOPICS_PER_REQUEST = 50;
// Articles and reviews only: datasets, specimens and other records would swamp some topics.
const WORK_TYPES = 'article|review';

class OpenAlexError extends Error {
  constructor(message, { status, cause } = {}) {
    super(message);
    this.name = 'OpenAlexError';
    this.status = status;
    this.cause = cause;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const delayMs = () => (config.isTest ? 0 : config.openalex.requestDelayMs);

// Requests go one after the other, at least `delayMs` apart.
let queue = Promise.resolve();
let lastRequestAt = 0;
const scheduled = (task) => {
  const run = queue.then(async () => {
    const wait = lastRequestAt + delayMs() - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      return await task();
    } finally {
      lastRequestAt = Date.now();
    }
  });
  queue = run.catch(() => {});
  return run;
};

const retryable = (error) => {
  const status = error.response?.status;
  return !status || status === 429 || status >= 500;
};

/** GET on the OpenAlex API. Returns the response body. @throws {OpenAlexError} */
const get = async (path, params = {}) => {
  const query = { ...params };
  if (config.openalex.apiKey) query.api_key = config.openalex.apiKey;

  for (let attempt = 1; ; attempt += 1) {
    try {
      const { data } = await scheduled(() =>
        axios.get(`${BASE_URL}${path}`, { params: query, timeout: TIMEOUT_MS })
      );
      return data;
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !retryable(error)) {
        const detail = error.response?.data?.message || error.message;
        throw new OpenAlexError(`OpenAlex ${path} failed: ${detail}`, {
          status: error.response?.status,
          cause: error,
        });
      }
      const retryAfter = Number(error.response?.headers?.['retry-after']);
      // No spacing configured (tests): no waiting either.
      const wait = retryAfter ? retryAfter * 1000 : 1000 * 2 ** attempt;
      await sleep(delayMs() === 0 ? 0 : Math.min(wait, 30000));
    }
  }
};

const shortId = (id) => (id ? String(id).split('/').pop() : null);

const chunk = (items, size) => {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
};

/** One page (up to 200) of the topic catalog, with what the atlas keeps of each topic. */
const fetchTopicsPage = async (page) => {
  const data = await get('/topics', {
    per_page: 200,
    page,
    select:
      'id,display_name,description,keywords,ids,subfield,field,domain,works_count,cited_by_count',
    sort: 'id',
  });
  return data?.results || [];
};

/**
 * Number of articles and reviews published in [from, to] (YYYY-MM-DD, inclusive) per primary topic.
 * `topTenPercent` only counts the works in the top 10% most cited of their year, field and type.
 * @returns {Promise<Map<string, number>>} topic id (T123) -> count; absent topics have none.
 */
const countWorksByTopic = async (topicIds, { from, to, topTenPercent = false }) => {
  const counts = new Map();
  for (const ids of chunk(topicIds, MAX_TOPICS_PER_REQUEST)) {
    const filters = [
      `primary_topic.id:${ids.join('|')}`,
      `type:${WORK_TYPES}`,
      `from_publication_date:${from}`,
      `to_publication_date:${to}`,
    ];
    if (topTenPercent) filters.push('citation_normalized_percentile.is_in_top_10_percent:true');
    const data = await get('/works', {
      filter: filters.join(','),
      group_by: 'primary_topic.id',
      per_page: 200,
    });
    for (const group of data?.group_by || [])
      counts.set(shortId(group.key), Number(group.count) || 0);
  }
  return counts;
};

/** Articles and reviews per publication year for one topic (or several: the counts are added). */
const countWorksByYear = async (topicIds, fromYear) => {
  const data = await get('/works', {
    filter: [
      `primary_topic.id:${[].concat(topicIds).join('|')}`,
      `type:${WORK_TYPES}`,
      `publication_year:>${fromYear - 1}`,
    ].join(','),
    group_by: 'publication_year',
    per_page: 200,
  });
  return (data?.group_by || [])
    .map((group) => ({ year: Number(group.key), works: Number(group.count) || 0 }))
    .filter((entry) => Number.isFinite(entry.year))
    .sort((a, b) => a.year - b.year);
};

module.exports = {
  OpenAlexError,
  MAX_TOPICS_PER_REQUEST,
  WORK_TYPES,
  get,
  shortId,
  chunk,
  fetchTopicsPage,
  countWorksByTopic,
  countWorksByYear,
};
