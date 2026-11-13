// Independent signals about a topic, from sources other than OpenAlex. They do not add to its works:
// they say whether another view of the literature agrees that the topic is moving (PubMed for the
// life and health sciences, arXiv for computing, maths and physics) and whether the public is
// paying attention (Wikipedia page views). Every call fails soft: a missing signal is just absent.
const axios = require('axios');
const config = require('../config');

const TIMEOUT_MS = 20000;
const userAgent = () => `BrightMinds/1.0 (research topics; ${config.atlas.contact})`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Spaces the calls of one source (their terms ask for it); no waiting in tests. */
const spacer = (gapMs) => {
  let last = 0;
  return async () => {
    const wait = last + (config.isTest ? 0 : gapMs) - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
};

const pad = (n) => String(n).padStart(2, '0');
const compact = (isoDate) => isoDate.replace(/-/g, '');
const slashed = (isoDate) => isoDate.replace(/-/g, '/');

/** Smoothed ratio: a handful of events more or less must not swing it. */
const smoothedRatio = (current, previous, k) => (current + k) / (previous + k);

const quoted = (text) => `"${String(text).replace(/["\\]/g, ' ').replace(/\s+/g, ' ').trim()}"`;
const topKeywords = (topic, count) =>
  (topic.keywords || [])
    .map((keyword) => keyword.name)
    .filter(Boolean)
    .slice(0, count);

// ---------------------------------------------------------------- PubMed

// Labs whose research PubMed covers well (OpenAlex field ids).
const PUBMED_FIELDS = new Set([27, 28, 24, 13, 30, 29, 35, 34, 36, 11, 32]);
const NCBI_GAP_MS = 400;
const ncbiWait = spacer(NCBI_GAP_MS);

/** The PubMed query of a topic: its MeSH descriptor when known, else its main keywords. */
const pubmedTerm = (topic) => {
  if (topic.ids?.meshLabel) return `${quoted(topic.ids.meshLabel)}[MeSH Terms]`;
  const keywords = topKeywords(topic, 4);
  return keywords.length
    ? `(${keywords.map((k) => `${quoted(k)}[Title/Abstract]`).join(' OR ')})`
    : null;
};

const pubmedCount = async (term, window) => {
  await ncbiWait();
  const params = {
    db: 'pubmed',
    term,
    datetype: 'edat',
    mindate: slashed(window.from),
    maxdate: slashed(window.to),
    rettype: 'count',
    retmode: 'json',
    tool: 'brightminds',
    email: config.atlas.contact,
  };
  if (config.atlas.ncbiApiKey) params.api_key = config.atlas.ncbiApiKey;
  const { data } = await axios.get('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi', {
    params,
    timeout: TIMEOUT_MS,
  });
  const count = Number(data?.esearchresult?.count);
  if (!Number.isFinite(count)) throw new Error('PubMed returned no count.');
  return count;
};

/** MeSH descriptor with exactly this label: { id: 'D014376', label: 'Tuberculosis' } or null. */
const resolveMesh = async (label) => {
  await ncbiWait();
  const { data } = await axios.get('https://id.nlm.nih.gov/mesh/lookup/descriptor', {
    params: { label, match: 'exact', limit: 1 },
    timeout: TIMEOUT_MS,
  });
  const hit = Array.isArray(data) ? data[0] : null;
  if (!hit?.resource) return null;
  return { id: String(hit.resource).split('/').pop(), label: hit.label };
};

const pubmedSignal = async (topic, windows) => {
  const term = pubmedTerm(topic);
  if (!term) return null;
  const current = await pubmedCount(term, windows.w0);
  const previous = await pubmedCount(term, windows.w1);
  return { current, previous, ratio: smoothedRatio(current, previous, 5), query: term };
};

// ---------------------------------------------------------------- arXiv

// arXiv archives of the labs it covers (OpenAlex field id: Computer Science, Mathematics, Physics).
const ARXIV_ARCHIVES = {
  17: ['cs.*', 'stat.ML', 'eess.*'],
  26: ['math.*', 'stat.*'],
  31: [
    'astro-ph.*',
    'cond-mat.*',
    'physics.*',
    'nlin.*',
    'hep-ex',
    'hep-lat',
    'hep-ph',
    'hep-th',
    'gr-qc',
    'quant-ph',
    'nucl-ex',
    'nucl-th',
    'math-ph',
  ],
};
const ARXIV_GAP_MS = 3200; // their terms: one request every three seconds
const arxivWait = spacer(ARXIV_GAP_MS);

const arxivQuery = (topic, archives) => {
  const keywords = topKeywords(topic, 4);
  if (!keywords.length || !archives?.length) return null;
  const categories = archives.map((archive) => `cat:${archive}`).join(' OR ');
  const terms = keywords.map((keyword) => `abs:${quoted(keyword)}`).join(' OR ');
  return `(${categories}) AND (${terms})`;
};

const arxivCount = async (query, window) => {
  await arxivWait();
  const range = `submittedDate:[${compact(window.from)}0000 TO ${compact(window.to)}2359]`;
  let lastError;
  // arXiv answers 5xx now and then.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { data } = await axios.get('http://export.arxiv.org/api/query', {
        params: { search_query: `${query} AND ${range}`, max_results: 1 },
        headers: { 'User-Agent': userAgent() },
        timeout: TIMEOUT_MS,
        responseType: 'text',
      });
      const match = /<opensearch:totalResults[^>]*>(\d+)</.exec(String(data));
      if (!match) throw new Error('arXiv returned no total.');
      return Number(match[1]);
    } catch (error) {
      lastError = error;
      if (!config.isTest) await sleep(ARXIV_GAP_MS * attempt);
    }
  }
  throw lastError;
};

const arxivSignal = async (topic, windows, fieldId) => {
  const query = arxivQuery(topic, ARXIV_ARCHIVES[fieldId]);
  if (!query) return null;
  const current = await arxivCount(query, windows.w0);
  const previous = await arxivCount(query, windows.w1);
  return { current, previous, ratio: smoothedRatio(current, previous, 5), query };
};

// ---------------------------------------------------------------- Wikipedia

const WIKI_GAP_MS = 350; // well under 200 requests a minute
const wikiWait = spacer(WIKI_GAP_MS);

const monthStamp = (year, month) => `${year}${pad(month)}01`;

/** Wikidata item (Q-id) of an English Wikipedia page, following redirects. */
const resolveWikidataId = async (title) => {
  await wikiWait();
  const { data } = await axios.get('https://en.wikipedia.org/w/api.php', {
    params: {
      action: 'query',
      prop: 'pageprops',
      ppprop: 'wikibase_item',
      titles: title,
      redirects: 1,
      format: 'json',
    },
    headers: { 'User-Agent': userAgent() },
    timeout: TIMEOUT_MS,
  });
  const pages = Object.values(data?.query?.pages || {});
  return pages[0]?.pageprops?.wikibase_item || null;
};

/**
 * Page views of the last 3 complete months against the 12 months before them (monthly means).
 * @returns {Promise<{ current: number, previous: number, ratio: number }|null>} null without a page or history
 */
const wikipediaSignal = async (title, now = new Date()) => {
  if (!title) return null;
  await wikiWait();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)); // last complete month
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 14, 1));
  const article = encodeURIComponent(String(title).replace(/ /g, '_'));
  const url =
    `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/` +
    `${article}/monthly/${monthStamp(start.getUTCFullYear(), start.getUTCMonth() + 1)}/` +
    `${monthStamp(end.getUTCFullYear(), end.getUTCMonth() + 1)}`;
  let data;
  try {
    ({ data } = await axios.get(url, {
      headers: { 'User-Agent': userAgent() },
      timeout: TIMEOUT_MS,
    }));
  } catch (error) {
    if (error.response?.status === 404) return null;
    throw error;
  }
  const views = (data?.items || []).map((item) => Number(item.views) || 0);
  if (views.length < 15) return null;
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const current = mean(views.slice(-3));
  const previous = mean(views.slice(-15, -3));
  return {
    current: Math.round(current),
    previous: Math.round(previous),
    ratio: smoothedRatio(current, previous, 50),
  };
};

module.exports = {
  PUBMED_FIELDS,
  ARXIV_ARCHIVES,
  pubmedTerm,
  pubmedCount,
  resolveMesh,
  pubmedSignal,
  arxivQuery,
  arxivCount,
  arxivSignal,
  resolveWikidataId,
  wikipediaSignal,
  smoothedRatio,
};
