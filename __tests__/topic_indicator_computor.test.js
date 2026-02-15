const axios = require('axios');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Topic = require('../models/topic_model.js');

jest.mock('axios');

jest.setTimeout(30000);

let mongoServer;
let originalNodeEnv;
let originalMongoUri;

const loadComputor = () => {
  let moduleExports;
  jest.isolateModules(() => {
    moduleExports = require('../backend/topic_indicator_computor.js');
  });
  return moduleExports;
};

const log10p = (value) => Math.log10(value + 1);

const buildAxiosMock = ({ openAlexById, wikiViewsByTitle, wikiSearchResults }) => {
  axios.get.mockImplementation((url, options = {}) => {
    if (url.startsWith('https://api.openalex.org/topics/')) {
      const id = url.split('/').pop();
      const metrics = openAlexById[id];
      if (!metrics) {
        return Promise.reject(new Error(`Missing OpenAlex metrics for ${id}`));
      }
      return Promise.resolve({
        data: {
          cited_by_count: metrics.citedByCount,
          works_count: metrics.worksCount,
        },
      });
    }

    if (url === 'https://api.openalex.org/works') {
      const filter = options.params?.filter || '';
      const match = filter.match(/topics\.id:([^,]+)/);
      const id = match ? match[1] : null;
      const metrics = openAlexById[id];
      if (!metrics) {
        return Promise.reject(new Error(`Missing OpenAlex works metrics for ${id}`));
      }
      return Promise.resolve({
        data: {
          meta: {
            count: metrics.works12m,
          },
        },
      });
    }

    if (url === 'https://en.wikipedia.org/w/api.php') {
      const topicName = options.params?.srsearch;
      if (wikiSearchResults && Object.prototype.hasOwnProperty.call(wikiSearchResults, topicName)) {
        return Promise.resolve({ data: { query: { search: wikiSearchResults[topicName] } } });
      }
      return Promise.resolve({ data: { query: { search: [{ title: topicName }] } } });
    }

    if (
      url.startsWith(
        'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/'
      )
    ) {
      const titleSegment = url.split('/user/')[1].split('/daily/')[0];
      const title = decodeURIComponent(titleSegment).replace(/_/g, ' ');
      const views = wikiViewsByTitle[title] || 0;
      return Promise.resolve({ data: { items: [{ views }] } });
    }

    return Promise.reject(new Error(`Unhandled axios url: ${url}`));
  });
};

beforeAll(async () => {
  originalNodeEnv = process.env.NODE_ENV;
  originalMongoUri = process.env.MONGODB_URI;
  process.env.NODE_ENV = 'development';

  mongoServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongoServer.getUri();

  await mongoose.connect(process.env.MONGODB_URI);
});

afterEach(async () => {
  axios.get.mockReset();
  await Topic.deleteMany({});
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongoServer) {
    await mongoServer.stop();
  }

  process.env.NODE_ENV = originalNodeEnv;
  if (originalMongoUri) {
    process.env.MONGODB_URI = originalMongoUri;
  } else {
    delete process.env.MONGODB_URI;
  }

  jest.resetModules();
});

test('computeImpactForTopic uses OpenAlex and Wikipedia data to compute raw scores', async () => {
  const topic = await Topic.create({
    name: 'Quantum Mechanics',
    departmentName: 'Physics',
    openalexID: 'T123',
  });

  buildAxiosMock({
    openAlexById: {
      T123: {
        citedByCount: 1000,
        worksCount: 100,
        works12m: 20,
      },
    },
    wikiViewsByTitle: {
      'Quantum Mechanics': 1500,
    },
  });

  const { computeImpactForTopic } = loadComputor();
  await computeImpactForTopic(topic);

  const updated = await Topic.findById(topic._id).lean();
  const estimatedCitations12m = (1000 / 100) * 20;
  const expectedImpact =
    0.55 * log10p(1000) + 0.25 * log10p(100) + 0.2 * log10p(1500);
  const expectedActivity =
    0.45 * log10p(20) + 0.35 * log10p(estimatedCitations12m) + 0.2 * log10p(1500);

  expect(updated.impact).toBeCloseTo(expectedImpact, 6);
  expect(updated.activity).toBeCloseTo(expectedActivity, 6);
  expect(axios.get).toHaveBeenCalled();
});

test('computeImpactForTopic uses cached metrics when fresh and skips external calls', async () => {
  const now = new Date();
  const topic = await Topic.create({
    name: 'Cached Topic',
    departmentName: 'Physics',
    openalexID: 'T-CACHED',
    metrics: {
      openalex: {
        citedByCount: 500,
        worksCount: 50,
        worksLast12Months: 5,
        lastFetchedAt: now,
        lastWorksFetchedAt: now,
      },
      wikipedia: {
        title: 'Cached Topic',
        views12Months: 2500,
        lastFetchedAt: now,
      },
    },
  });

  axios.get.mockImplementation(() => {
    throw new Error('External call should not happen');
  });

  const { computeImpactForTopic } = loadComputor();
  await computeImpactForTopic(topic);

  expect(axios.get).not.toHaveBeenCalled();

  const updated = await Topic.findById(topic._id).lean();
  const estimatedCitations12m = (500 / 50) * 5;
  const expectedImpact =
    0.55 * log10p(500) + 0.25 * log10p(50) + 0.2 * log10p(2500);
  const expectedActivity =
    0.45 * log10p(5) + 0.35 * log10p(estimatedCitations12m) + 0.2 * log10p(2500);

  expect(updated.impact).toBeCloseTo(expectedImpact, 6);
  expect(updated.activity).toBeCloseTo(expectedActivity, 6);
});

test('computeImpactForTopic without openalexID uses Wikipedia only and handles no results', async () => {
  const topic = await Topic.create({
    name: 'Obscure Topic',
    departmentName: 'Physics',
  });

  buildAxiosMock({
    openAlexById: {},
    wikiViewsByTitle: {},
    wikiSearchResults: {
      'Obscure Topic': [],
    },
  });

  const { computeImpactForTopic } = loadComputor();
  await computeImpactForTopic(topic);

  const updated = await Topic.findById(topic._id).lean();
  expect(updated.impact).toBe(0);
  expect(updated.activity).toBe(0);
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('computeImpactForAllTopics normalizes to percentiles', async () => {
  await Topic.create([
    {
      name: 'Topic A',
      departmentName: 'Physics',
      openalexID: 'T-A',
    },
    {
      name: 'Topic B',
      departmentName: 'Physics',
      openalexID: 'T-B',
    },
    {
      name: 'Topic C',
      departmentName: 'Physics',
      openalexID: 'T-C',
    },
  ]);

  buildAxiosMock({
    openAlexById: {
      'T-A': { citedByCount: 10, worksCount: 5, works12m: 1 },
      'T-B': { citedByCount: 100, worksCount: 50, works12m: 10 },
      'T-C': { citedByCount: 1000, worksCount: 500, works12m: 100 },
    },
    wikiViewsByTitle: {
      'Topic A': 100,
      'Topic B': 1000,
      'Topic C': 10000,
    },
  });

  const { computeImpactForAllTopics } = loadComputor();
  await computeImpactForAllTopics();

  const updatedTopics = await Topic.find().lean();
  const impactByName = updatedTopics.reduce((acc, item) => {
    acc[item.name] = item.impact;
    return acc;
  }, {});
  const activityByName = updatedTopics.reduce((acc, item) => {
    acc[item.name] = item.activity;
    return acc;
  }, {});

  expect(impactByName['Topic A']).toBeCloseTo(0, 2);
  expect(impactByName['Topic B']).toBeCloseTo(50, 2);
  expect(impactByName['Topic C']).toBeCloseTo(100, 2);

  expect(activityByName['Topic A']).toBeCloseTo(0, 2);
  expect(activityByName['Topic B']).toBeCloseTo(50, 2);
  expect(activityByName['Topic C']).toBeCloseTo(100, 2);
});
