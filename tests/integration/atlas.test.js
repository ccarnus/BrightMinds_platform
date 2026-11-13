const request = require('supertest');
const axios = require('axios');
const app = require('../../app');
const config = require('../../config');
const Topic = require('../../models/topic_model');
const AtlasState = require('../../models/atlas_state_model');
const { refreshAtlas, needsRefresh, getStatus } = require('../../services/atlas');
const { useTestDatabase } = require('../helpers/db');
const { createCatalogTopic } = require('../helpers/fixtures');

jest.mock('axios');

useTestDatabase();

beforeEach(() => {
  axios.get.mockReset();
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

const NOW = new Date('2026-11-12T10:00:00Z');
const silent = () => {};

const scored = (overrides = {}) => ({
  score: {
    hot: 60,
    trend: 'rising',
    phase: 'growing',
    works12m: 500,
    yoy: 0.2,
    growth: { rate: 1.3, lower: 1.1, upper: 1.5 },
    acceleration: 0.1,
    computedAt: NOW,
    ...overrides.score,
  },
  ...overrides.rest,
});

const fakeSteps = () => ({
  syncCatalog: jest.fn().mockResolvedValue({ topics: 10, created: 3 }),
  refreshTopicMetrics: jest
    .fn()
    .mockResolvedValue({ topics: 10, featured: 4, endsOn: '2026-10-01' }),
  refreshSignals: jest.fn().mockResolvedValue({ tracked: 5 }),
});

describe('refreshAtlas', () => {
  test('runs the catalog, the scores and the signals, and remembers when', async () => {
    const steps = fakeSteps();
    const result = await refreshAtlas({ log: silent, overrides: steps });
    expect(result.catalog).toEqual({ topics: 10, created: 3 });
    expect(result.metrics.topics).toBe(10);
    expect(result.signals.tracked).toBe(5);
    const state = await AtlasState.get();
    expect(state.catalogSyncedAt).toBeInstanceOf(Date);
    expect(state.metricsAt).toBeInstanceOf(Date);
    expect(state.signalsAt).toBeInstanceOf(Date);
    expect(state).toMatchObject({ windowsEndOn: '2026-10-01', topics: 10, lastError: null });
  });

  test('"auto" skips a recent catalog, but not a missing or old one', async () => {
    await createCatalogTopic();
    const steps = fakeSteps();
    await AtlasState.get().then((state) => {
      state.catalogSyncedAt = new Date();
      return state.save();
    });
    const recent = await refreshAtlas({ log: silent, overrides: steps });
    expect(recent.catalog).toBeUndefined();
    expect(steps.syncCatalog).not.toHaveBeenCalled();

    await AtlasState.updateOne({ key: 'atlas' }, { catalogSyncedAt: new Date(2020, 1, 1) });
    await refreshAtlas({ log: silent, overrides: steps });
    expect(steps.syncCatalog).toHaveBeenCalledTimes(1);

    await Topic.deleteMany({});
    await AtlasState.updateOne({ key: 'atlas' }, { catalogSyncedAt: new Date() });
    await refreshAtlas({ log: silent, overrides: steps });
    expect(steps.syncCatalog).toHaveBeenCalledTimes(2);
  });

  test('steps can be turned off, and signals need scored topics', async () => {
    const steps = fakeSteps();
    await refreshAtlas({
      catalog: false,
      metrics: false,
      signals: false,
      log: silent,
      overrides: steps,
    });
    expect(steps.syncCatalog).not.toHaveBeenCalled();
    expect(steps.refreshTopicMetrics).not.toHaveBeenCalled();
    expect(steps.refreshSignals).not.toHaveBeenCalled();

    steps.refreshTopicMetrics.mockResolvedValueOnce({ topics: 0, featured: 0, endsOn: null });
    const empty = await refreshAtlas({ catalog: false, log: silent, overrides: steps });
    expect(empty.signals).toBeUndefined();
    expect(steps.refreshSignals).not.toHaveBeenCalled();
  });

  test('a failure is recorded, rethrown and does not erase the earlier dates', async () => {
    const steps = fakeSteps();
    await refreshAtlas({ log: silent, overrides: steps });
    const before = await AtlasState.get();
    steps.refreshTopicMetrics.mockRejectedValueOnce(new Error('OpenAlex is down'));
    await expect(refreshAtlas({ catalog: false, log: silent, overrides: steps })).rejects.toThrow(
      'OpenAlex is down'
    );
    const state = await AtlasState.get();
    expect(state.lastError).toBe('OpenAlex is down');
    expect(state.lastErrorAt).toBeInstanceOf(Date);
    expect(state.metricsAt.getTime()).toBe(before.metricsAt.getTime());
    expect(steps.refreshSignals).toHaveBeenCalledTimes(1);

    await refreshAtlas({ catalog: false, log: silent, overrides: steps });
    expect((await AtlasState.get()).lastError).toBeNull();
  });

  test('two calls at the same time share one run', async () => {
    const steps = fakeSteps();
    const [first, second] = await Promise.all([
      refreshAtlas({ log: silent, overrides: steps }),
      refreshAtlas({ log: silent, overrides: steps }),
    ]);
    expect(first).toBe(second);
    expect(steps.refreshTopicMetrics).toHaveBeenCalledTimes(1);
  });
});

describe('needsRefresh and getStatus', () => {
  test('stale without a catalog, fresh right after a run, stale a week later', async () => {
    expect(await needsRefresh()).toBe(true);
    await createCatalogTopic();
    await refreshAtlas({ log: silent, overrides: fakeSteps() });
    expect(await needsRefresh()).toBe(false);
    expect(await needsRefresh(Date.now() + config.atlas.metricsMaxAgeMs + 60000)).toBe(true);
  });

  test('the status counts what the atlas holds', async () => {
    await createCatalogTopic(scored({ rest: { featured: true } }));
    await createCatalogTopic();
    await createCatalogTopic({ retired: true });
    await Topic.create({ name: 'Mine', departmentName: 'Chemistry' });
    const status = await getStatus();
    expect(status.topics).toEqual({
      catalog: 2,
      scored: 1,
      featured: 1,
      withCasts: 0,
      authored: 1,
    });
    expect(status.lastError).toBeNull();
    expect(status.openalexKey).toBe(false);
  });
});

describe('GET /atlas/status and /atlas', () => {
  test('status is public and small', async () => {
    const res = await request(app).get('/atlas/status').expect(200);
    expect(res.body.topics.catalog).toBe(0);
  });

  test('lists the domains with their labs, topics and hot topics', async () => {
    await createCatalogTopic(scored());
    await createCatalogTopic(scored({ score: { trend: 'steady' } }));
    await createCatalogTopic({ departmentName: 'Mathematics', castCount: 2 });
    const res = await request(app).get('/atlas').expect(200);
    const labs = res.body.domains.flatMap((domain) => domain.labs);
    expect(res.body.domains).toHaveLength(4);
    expect(labs).toHaveLength(26);
    expect(labs.find((lab) => lab.name === 'Chemistry')).toEqual({
      name: 'Chemistry',
      topics: 2,
      hot: 1,
      casts: 0,
    });
    expect(labs.find((lab) => lab.name === 'Mathematics')).toMatchObject({ topics: 1, casts: 2 });
    expect(labs.find((lab) => lab.name === 'PhysicsandAstronomy')).toMatchObject({ topics: 0 });
  });
});

describe('GET /atlas/hot', () => {
  beforeEach(async () => {
    await createCatalogTopic({
      name: 'Surge',
      ...scored({ score: { hot: 90, trend: 'surging' } }),
    });
    await createCatalogTopic({ name: 'Rise', ...scored({ score: { hot: 70 } }) });
    await createCatalogTopic({ name: 'Calm', ...scored({ score: { hot: 95, trend: 'steady' } }) });
    await createCatalogTopic({
      name: 'Other lab',
      departmentName: 'Mathematics',
      ...scored({ score: { hot: 80, trend: 'rising' } }),
    });
    await createCatalogTopic({ name: 'Unscored' });
    await createCatalogTopic({ name: 'Gone', retired: true, ...scored({ score: { hot: 99 } }) });
  });

  test('only rising and surging topics, hottest first, as light cards', async () => {
    const res = await request(app).get('/atlas/hot').expect(200);
    expect(res.body.topics.map((topic) => topic.name)).toEqual(['Surge', 'Other lab', 'Rise']);
    expect(res.body.topics[0]).toMatchObject({
      name: 'Surge',
      lab: 'Chemistry',
      area: 'Area',
      hot: 90,
      trend: 'surging',
      phase: 'growing',
      works12m: 500,
      change: 0.2,
      versusArea: 1.3,
    });
    expect(res.body.topics[0].keywords).toEqual([]);
  });

  test('filters by lab and area, takes any trend on request and limits', async () => {
    const lab = await request(app).get('/atlas/hot').query({ lab: 'Mathematics' }).expect(200);
    expect(lab.body.topics.map((topic) => topic.name)).toEqual(['Other lab']);

    const any = await request(app).get('/atlas/hot').query({ trend: 'any' }).expect(200);
    expect(any.body.topics.map((topic) => topic.name)).toEqual([
      'Calm',
      'Surge',
      'Other lab',
      'Rise',
    ]);

    const limited = await request(app).get('/atlas/hot').query({ limit: 1 }).expect(200);
    expect(limited.body.topics).toHaveLength(1);

    const area = await request(app).get('/atlas/hot').query({ area: 999 }).expect(200);
    expect(area.body.topics).toEqual([]);
  });

  test('rejects an unknown lab or a bad area', async () => {
    await request(app).get('/atlas/hot').query({ lab: 'Alchemy' }).expect(400);
    await request(app).get('/atlas/hot').query({ area: 'x' }).expect(400);
  });
});

describe('GET /atlas/lab/:name', () => {
  test('the areas, the hot topics and the emerging ones of a lab', async () => {
    await createCatalogTopic({ name: 'A', ...scored({ score: { hot: 80, trend: 'surging' } }) });
    await createCatalogTopic({
      name: 'B',
      subfield: { id: 2, name: 'Second area' },
      ...scored({ score: { hot: 50, trend: 'steady', phase: 'emerging' } }),
    });
    await createCatalogTopic({ name: 'Elsewhere', departmentName: 'Mathematics', ...scored() });
    const res = await request(app).get('/atlas/lab/Chemistry').expect(200);
    expect(res.body).toMatchObject({ lab: 'Chemistry', topics: 2 });
    expect(typeof res.body.domain).toBe('string');
    expect(res.body.areas.map((area) => area.name)).toEqual(['Area', 'Second area']);
    expect(res.body.areas[0]).toMatchObject({ id: 1, topics: 1, hot: 1, works12m: 500 });
    expect(res.body.hot.map((topic) => topic.name)).toEqual(['A']);
    expect(res.body.emerging.map((topic) => topic.name)).toEqual(['B']);
  });

  test('an unknown lab is a 400', async () => {
    await request(app).get('/atlas/lab/Alchemy').expect(400);
  });
});

describe('GET /atlas/topics', () => {
  beforeEach(async () => {
    await createCatalogTopic({
      name: 'Graphene Synthesis',
      keywords: [{ name: 'carbon' }],
      ...scored({ score: { hot: 40, works12m: 900 } }),
    });
    await createCatalogTopic({
      name: 'Perovskite Solar Cells',
      keywords: [{ name: 'photovoltaics' }],
      subfield: { id: 2, name: 'Energy' },
      ...scored({ score: { hot: 80, works12m: 300, phase: 'emerging' } }),
    });
    await createCatalogTopic({
      name: 'Polymer Chemistry',
      ...scored({ score: { hot: 10, trend: 'cooling', phase: 'mature', works12m: 1200 } }),
    });
  });

  test('sorts by hot score by default and pages', async () => {
    const res = await request(app).get('/atlas/topics').expect(200);
    expect(res.body).toMatchObject({ total: 3, page: 1, limit: 20 });
    expect(res.body.topics.map((topic) => topic.name)).toEqual([
      'Perovskite Solar Cells',
      'Graphene Synthesis',
      'Polymer Chemistry',
    ]);
    const page2 = await request(app).get('/atlas/topics').query({ limit: 2, page: 2 }).expect(200);
    expect(page2.body.topics.map((topic) => topic.name)).toEqual(['Polymer Chemistry']);
    expect(page2.body.total).toBe(3);
  });

  test('other sorts', async () => {
    const volume = await request(app).get('/atlas/topics').query({ sort: 'volume' }).expect(200);
    expect(volume.body.topics[0].name).toBe('Polymer Chemistry');
    const name = await request(app).get('/atlas/topics').query({ sort: 'name' }).expect(200);
    expect(name.body.topics[0].name).toBe('Graphene Synthesis');
  });

  test('every word of the search must be in the name, a keyword or the area', async () => {
    const byName = await request(app).get('/atlas/topics').query({ q: 'solar cells' }).expect(200);
    expect(byName.body.topics.map((topic) => topic.name)).toEqual(['Perovskite Solar Cells']);
    const byKeyword = await request(app).get('/atlas/topics').query({ q: 'carbon' }).expect(200);
    expect(byKeyword.body.topics.map((topic) => topic.name)).toEqual(['Graphene Synthesis']);
    const byArea = await request(app).get('/atlas/topics').query({ q: 'energy' }).expect(200);
    expect(byArea.body.total).toBe(1);
    const none = await request(app).get('/atlas/topics').query({ q: 'solar carbon' }).expect(200);
    expect(none.body.total).toBe(0);
  });

  test('regex characters in the search are plain text', async () => {
    const res = await request(app).get('/atlas/topics').query({ q: '.*(' }).expect(200);
    expect(res.body.total).toBe(0);
  });

  test('filters by trend, phase, lab and area', async () => {
    const trend = await request(app).get('/atlas/topics').query({ trend: 'cooling' }).expect(200);
    expect(trend.body.topics.map((topic) => topic.name)).toEqual(['Polymer Chemistry']);
    const phase = await request(app).get('/atlas/topics').query({ phase: 'emerging' }).expect(200);
    expect(phase.body.total).toBe(1);
    const area = await request(app).get('/atlas/topics').query({ area: 2 }).expect(200);
    expect(area.body.total).toBe(1);
    const lab = await request(app).get('/atlas/topics').query({ lab: 'Mathematics' }).expect(200);
    expect(lab.body.total).toBe(0);
  });

  test('validates the filters, and clamps the paging', async () => {
    await request(app).get('/atlas/topics').query({ trend: 'wild' }).expect(400);
    await request(app).get('/atlas/topics').query({ phase: 'wild' }).expect(400);
    await request(app).get('/atlas/topics').query({ lab: 'Alchemy' }).expect(400);
    const res = await request(app)
      .get('/atlas/topics')
      .query({ limit: 9999, page: -4 })
      .expect(200);
    expect(res.body).toMatchObject({ limit: 50, page: 1 });
  });
});

describe('/topic listing rules', () => {
  test('lists topics with casts, featured ones and author ones, hottest first', async () => {
    await createCatalogTopic({ name: 'Hidden' });
    await createCatalogTopic({
      name: 'Featured',
      featured: true,
      ...scored({ score: { hot: 70 } }),
    });
    await createCatalogTopic({ name: 'With casts', castCount: 3 });
    await createCatalogTopic({ name: 'Retired', retired: true, featured: true });
    await Topic.create({ name: 'Authored', departmentName: 'Chemistry' });
    const res = await request(app).get('/topic/department/Chemistry').expect(200);
    expect(res.body.map((topic) => topic.name)).toEqual(['Featured', 'With casts', 'Authored']);
    expect(res.body[0].keywords).toBeUndefined();
    expect(res.body[0].series).toBeUndefined();
    const all = await request(app).get('/topic').expect(200);
    expect(all.body).toHaveLength(3);
  });

  test('the full topic is still available by id', async () => {
    const topic = await createCatalogTopic({ keywords: [{ name: 'carbon' }] });
    const res = await request(app).get(`/topic/${topic._id}`).expect(200);
    expect(res.body.keywords[0].name).toBe('carbon');
  });
});

describe('GET /topic/:id/progress', () => {
  test('answers with the trend, the yearly output and the signals', async () => {
    const topic = await createCatalogTopic({
      ...scored({
        score: {
          windows: { c0: 500, c1: 400 },
          impact: { share: 0.12 },
          levels: { volume: 55, impact: 66 },
          endsOn: '2026-10-01',
        },
      }),
      signals: { pubmed: { current: 12, previous: 10, ratio: 1.1, fetchedAt: NOW } },
    });
    axios.get.mockResolvedValueOnce({
      data: {
        group_by: [
          { key: '2025', count: 400 },
          { key: '2026', count: 300 },
        ],
      },
    });
    const res = await request(app).get(`/topic/${topic._id}/progress`).expect(200);
    expect(res.body).toMatchObject({
      name: topic.name,
      lab: 'Chemistry',
      scored: true,
      ranked: true,
      trend: 'rising',
      phase: 'growing',
      hot: 60,
      works12m: 500,
      previous12m: 400,
      change: 0.2,
      versusArea: 1.3,
      versusAreaRange: [1.1, 1.5],
      topCitedShare: 0.12,
      levels: { volume: 55, impact: 66, attention: null },
      windowsEndOn: '2026-10-01',
    });
    expect(res.body.signals).toEqual([{ source: 'pubmed', current: 12, previous: 10, ratio: 1.1 }]);
    expect(res.body.yearly).toEqual([
      { year: 2025, works: 400, partial: false },
      { year: 2026, works: 300, partial: true },
    ]);
  });

  test('still answers when OpenAlex cannot be reached', async () => {
    const topic = await createCatalogTopic(scored());
    axios.get.mockRejectedValue(new Error('network'));
    const res = await request(app).get(`/topic/${topic._id}/progress`).expect(200);
    expect(res.body).toMatchObject({ trend: 'rising', yearly: [] });
  });

  test('a topic never scored is not ranked, an author topic has no series', async () => {
    const authored = await Topic.create({ name: 'Mine', departmentName: 'Chemistry' });
    const res = await request(app).get(`/topic/${authored._id}/progress`).expect(200);
    expect(res.body).toMatchObject({ scored: false, ranked: false, trend: null, yearly: [] });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('a bad id is a 400 and an unknown topic a 404', async () => {
    await request(app).get('/topic/nope/progress').expect(400);
    await request(app).get('/topic/507f1f77bcf86cd799439011/progress').expect(404);
  });
});
