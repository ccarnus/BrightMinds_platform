const config = require('../../config');
const Topic = require('../../models/topic_model');
const { buildWindows } = require('../../services/topic_scoring');
const {
  refreshTopicMetrics,
  rankLabs,
  ensureSeries,
  buildProgress,
} = require('../../services/topic_metrics');
const { useTestDatabase } = require('../helpers/db');
const { createCatalogTopic } = require('../helpers/fixtures');

useTestDatabase();

const NOW = new Date('2026-11-12T10:00:00Z');
const windows = buildWindows(NOW, config.atlas.lagDays);
const FEATURED = config.atlas.featuredPerLab;

beforeEach(() => {
  config.atlas.featuredPerLab = 3;
});
afterEach(() => {
  config.atlas.featuredPerLab = FEATURED;
});

// 12 chemistry topics that grow ~10% a year, one that surges and one tiny one.
const SPECS = [
  ...Array.from({ length: 12 }, (_, i) => {
    const c1 = 400 + i * 20;
    return {
      key: `S${i}`,
      c0: Math.round(c1 * 1.1),
      c1,
      c2: Math.round(c1 / 1.1),
      top: Math.round(c1 * 0.2),
    };
  }),
  { key: 'SURGE', c0: 3000, c1: 1500, c2: 1200, top: 500 },
  { key: 'TINY', c0: 8, c1: 3, c2: 2, top: 0 },
];

const countsFor = (specs) => async (ids, window) => {
  const key = window.topTenPercent
    ? 'top'
    : window.to === windows.w0.to
      ? 'c0'
      : window.to === windows.w1.to
        ? 'c1'
        : 'c2';
  return new Map(
    ids
      .map((id) => [id, specs.find((spec) => spec.key === id)?.[key]])
      .filter(([, count]) => count !== undefined)
  );
};

const seed = async (specs = SPECS) => {
  for (const spec of specs) {
    await createCatalogTopic({ name: `Topic ${spec.key}`, openalexID: spec.key });
  }
};

describe('refreshTopicMetrics', () => {
  test('counts the three windows and the top-cited works, then scores and stores every topic', async () => {
    await seed();
    const countByTopic = jest.fn(countsFor(SPECS));
    const result = await refreshTopicMetrics({ now: NOW, countByTopic });

    expect(result).toMatchObject({ topics: 14, endsOn: windows.endsOn, featured: 3 });
    // One pass per window, and one for the top-cited works of the matured window.
    expect(countByTopic.mock.calls.map(([, window]) => window)).toEqual([
      windows.w0,
      windows.w1,
      windows.w2,
      { ...windows.matured, topTenPercent: true },
    ]);

    const surge = await Topic.findOne({ openalexID: 'SURGE' });
    expect(surge.score).toMatchObject({ trend: 'surging', works12m: 3000, endsOn: windows.endsOn });
    expect(surge.score.windows).toMatchObject({ c0: 3000, c1: 1500, c2: 1200, top: 500 });
    expect(surge.score.yoy).toBeCloseTo(1, 2);
    expect(surge.score.hot).toBeGreaterThan(80);
    expect(surge.score.growth.lower).toBeGreaterThan(1.2);
    expect(surge.score.computedAt).toBeInstanceOf(Date);

    const tiny = await Topic.findOne({ openalexID: 'TINY' });
    expect(tiny.score).toMatchObject({ trend: 'niche', hot: null, phase: null });

    // Fields older app versions read.
    expect(surge.metrics.openalex.worksLast12Months).toBe(3000);
    expect(surge.activity).toBeGreaterThan(90);
    expect(surge.impact).toBeGreaterThanOrEqual(0);
    expect(tiny.activity).toBe(0);
  });

  test('features the hottest topics of each lab', async () => {
    await seed();
    await createCatalogTopic({ name: 'Medical one', openalexID: 'M1', departmentName: 'Medicine' });
    const specs = [...SPECS, { key: 'M1', c0: 900, c1: 600, c2: 500, top: 100 }];
    await refreshTopicMetrics({ now: NOW, countByTopic: countsFor(specs) });

    const featured = await Topic.find({ featured: true }).sort({ 'score.hot': -1 });
    expect(featured).toHaveLength(4); // 3 in Chemistry (the limit) + the only ranked one in Medicine
    expect(featured.filter((t) => t.departmentName === 'Chemistry')).toHaveLength(3);
    expect(featured.map((t) => t.openalexID)).toContain('SURGE');
    expect(featured.map((t) => t.openalexID)).not.toContain('TINY');
  });

  test('a topic with casts stays listed even when it is not featured', async () => {
    await seed();
    await Topic.updateOne({ openalexID: 'TINY' }, { $set: { castCount: 1 } });
    await refreshTopicMetrics({ now: NOW, countByTopic: countsFor(SPECS) });
    const listed = await Topic.find({ departmentName: 'Chemistry', ...Topic.listedFilter() });
    const keys = listed.map((t) => t.openalexID);
    expect(keys).toContain('TINY');
    expect(keys).toContain('SURGE');
    expect(listed.length).toBeLessThan(14);
  });

  test('keeps the last independent signal in the hot score', async () => {
    await seed();
    await refreshTopicMetrics({ now: NOW, countByTopic: countsFor(SPECS) });
    const before = await Topic.findOne({ openalexID: 'S5' });
    await Topic.updateOne({ openalexID: 'S5' }, { $set: { 'score.signalLevel': 100 } });

    await refreshTopicMetrics({ now: NOW, countByTopic: countsFor(SPECS) });
    const after = await Topic.findOne({ openalexID: 'S5' });
    expect(after.score.signalLevel).toBe(100);
    expect(after.score.hotBase).toBeCloseTo(before.score.hotBase, 1);
    expect(after.score.hot).toBeCloseTo(0.75 * after.score.hotBase + 25, 0);
  });

  test('either all the counts arrive or nothing changes', async () => {
    await seed();
    await refreshTopicMetrics({ now: NOW, countByTopic: countsFor(SPECS) });
    const before = await Topic.findOne({ openalexID: 'SURGE' }).lean();

    let calls = 0;
    const flaky = async (ids, window) => {
      calls += 1;
      if (calls === 3) throw new Error('OpenAlex timeout');
      return countsFor(SPECS.map((spec) => ({ ...spec, c0: 1 })))(ids, window);
    };
    await expect(refreshTopicMetrics({ now: NOW, countByTopic: flaky })).rejects.toThrow('timeout');
    const after = await Topic.findOne({ openalexID: 'SURGE' }).lean();
    expect(after.score).toEqual(before.score);
  });

  test('skips retired topics and authors topics, and copes with an empty catalog', async () => {
    expect(await refreshTopicMetrics({ now: NOW, countByTopic: countsFor([]) })).toMatchObject({
      topics: 0,
    });
    await createCatalogTopic({ openalexID: 'GONE', retired: true });
    await Topic.create({ name: 'Typed', departmentName: 'Chemistry' });
    const countByTopic = jest.fn(countsFor([]));
    await refreshTopicMetrics({ now: NOW, countByTopic });
    expect(countByTopic).not.toHaveBeenCalled();
  });
});

describe('rankLabs', () => {
  test('a topic that drops out of the top loses its featured flag', async () => {
    await seed();
    await refreshTopicMetrics({ now: NOW, countByTopic: countsFor(SPECS) });
    const featured = await Topic.findOne({ openalexID: 'SURGE' });
    expect(featured.featured).toBe(true);
    await Topic.updateOne({ openalexID: 'SURGE' }, { $set: { 'score.hot': 0 } });
    await rankLabs();
    expect((await Topic.findOne({ openalexID: 'SURGE' })).featured).toBe(false);
  });
});

describe('progress', () => {
  test('the yearly series is fetched once a week and read back as progress', async () => {
    const topic = await createCatalogTopic({ openalexID: 'T77', name: 'Zinc and bacteria' });
    const countByYear = jest.fn(async () => [
      { year: 2024, works: 90 },
      { year: 2025, works: 120 },
      { year: 2026, works: 80 },
    ]);

    await ensureSeries(topic, { now: NOW, countByYear });
    await ensureSeries(topic, { now: new Date(NOW.getTime() + 3 * 24 * 3600 * 1000), countByYear });
    expect(countByYear).toHaveBeenCalledTimes(1);
    expect(countByYear).toHaveBeenCalledWith('T77', 2020);

    await ensureSeries(topic, { now: new Date(NOW.getTime() + 8 * 24 * 3600 * 1000), countByYear });
    expect(countByYear).toHaveBeenCalledTimes(2);

    const progress = buildProgress(await Topic.findById(topic._id), { now: NOW });
    expect(progress.yearly).toEqual([
      { year: 2024, works: 90, partial: false },
      { year: 2025, works: 120, partial: false },
      { year: 2026, works: 80, partial: true },
    ]);
    expect(progress).toMatchObject({
      name: 'Zinc and bacteria',
      lab: 'Chemistry',
      scored: false,
      ranked: false,
      trend: null,
    });
  });

  test('a scored topic reports its trend, growth and levels', async () => {
    await seed();
    await refreshTopicMetrics({ now: NOW, countByTopic: countsFor(SPECS) });
    const progress = buildProgress(await Topic.findOne({ openalexID: 'SURGE' }), { now: NOW });
    expect(progress).toMatchObject({
      scored: true,
      ranked: true,
      trend: 'surging',
      works12m: 3000,
      previous12m: 1500,
      windowsEndOn: windows.endsOn,
    });
    expect(progress.change).toBeCloseTo(1, 2);
    expect(progress.versusArea).toBeGreaterThan(1.5);
    expect(progress.versusAreaRange[0]).toBeLessThan(progress.versusAreaRange[1]);
    expect(progress.levels.volume).toBe(100);
  });

  test('topics without an OpenAlex id have no series to fetch', async () => {
    const author = await Topic.create({ name: 'Typed', departmentName: 'Chemistry' });
    const countByYear = jest.fn();
    await ensureSeries(author, { now: NOW, countByYear });
    expect(countByYear).not.toHaveBeenCalled();
  });
});
