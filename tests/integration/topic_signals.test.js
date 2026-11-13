const config = require('../../config');
const Topic = require('../../models/topic_model');
const { refreshSignals, selectTracked } = require('../../services/topic_signals');
const { useTestDatabase } = require('../helpers/db');
const { createCatalogTopic } = require('../helpers/fixtures');

useTestDatabase();

const NOW = new Date('2026-11-12T10:00:00Z');
const TRACKED = config.atlas.trackedPerLab;

beforeEach(() => {
  config.atlas.trackedPerLab = 4;
});
afterEach(() => {
  config.atlas.trackedPerLab = TRACKED;
});

const scored = (key, hotBase, overrides = {}) =>
  createCatalogTopic({
    name: `Topic ${key}`,
    openalexID: key,
    departmentName: 'Medicine',
    keywords: [{ id: 'k', name: `kw ${key}` }],
    ids: { wikipedia: `Page ${key}` },
    anchor: 'match',
    score: { hotBase, hot: hotBase, trend: 'rising' },
    ...overrides,
  });

const providers = (overrides = {}) => ({
  PUBMED_FIELDS: new Set([27]),
  ARXIV_ARCHIVES: { 17: ['cs.*'] },
  resolveWikidataId: jest.fn(async (title) => `Q-${title.replace(' ', '')}`),
  wikipediaSignal: jest.fn(async (title) => ({
    current: 100,
    previous: 100,
    ratio: title === 'Page A' ? 3 : 1,
  })),
  resolveMesh: jest.fn(async () => ({ id: 'D014376', label: 'Tuberculosis' })),
  pubmedSignal: jest.fn(async (topic) => ({
    current: 10,
    previous: 5,
    ratio: topic.openalexID === 'A' ? 2 : 1,
    query: `"${topic.ids.meshLabel}"[MeSH Terms]`,
  })),
  arxivSignal: jest.fn(),
  ...overrides,
});

describe('selectTracked', () => {
  test('the hottest topics of each lab, and every scored topic with casts', async () => {
    for (const [key, hot] of [
      ['A', 90],
      ['B', 80],
      ['C', 70],
      ['D', 60],
      ['E', 50],
      ['F', 40],
    ]) {
      await scored(key, hot);
    }
    await scored('G', 10, { castCount: 2 });
    await scored('H', null, { score: { hotBase: null } }); // too small to rank: never tracked
    await createCatalogTopic({
      openalexID: 'X',
      departmentName: 'Chemistry',
      retired: true,
      score: { hotBase: 99 },
    });

    const keys = (await selectTracked()).map((topic) => topic.openalexID).sort();
    expect(keys).toEqual(['A', 'B', 'C', 'D', 'G']);
  });
});

describe('refreshSignals', () => {
  const seed = async () => {
    for (const [key, hot] of [
      ['A', 90],
      ['B', 80],
      ['C', 70],
      ['D', 60],
      ['E', 50],
    ])
      await scored(key, hot);
  };

  test('stores the signals, resolves cross-reference ids once and blends them into the hot score', async () => {
    await seed();
    const mock = providers();
    const result = await refreshSignals({ now: NOW, providers: mock });
    expect(result).toEqual({ tracked: 4, withSignals: 4 });

    const a = await Topic.findOne({ openalexID: 'A' }).lean();
    expect(a.signals.pubmed).toMatchObject({ current: 10, previous: 5, ratio: 2, level: 100 });
    expect(a.signals.pubmed.query).toBe('"Tuberculosis"[MeSH Terms]');
    expect(a.signals.wikipedia).toMatchObject({ ratio: 3, level: 100, query: 'Page A' });
    expect(a.ids).toMatchObject({
      wikidata: 'Q-PageA',
      mesh: 'D014376',
      meshLabel: 'Tuberculosis',
    });
    expect(a.signals.arxiv).toBeUndefined();
    expect(a.score.signalLevel).toBe(100);
    expect(a.score.hot).toBeCloseTo(0.75 * 90 + 25, 1);

    // The others tie at the bottom of their signals: the hot score is pulled down.
    const d = await Topic.findOne({ openalexID: 'D' }).lean();
    expect(d.score.signalLevel).toBeLessThan(50);
    expect(d.score.hot).toBeLessThan(60);
    // Not tracked: untouched.
    expect((await Topic.findOne({ openalexID: 'E' }).lean()).signals?.computedAt).toBeFalsy();

    // Ids are kept: a second run does not look them up again.
    await refreshSignals({ now: NOW, providers: mock });
    expect(mock.resolveMesh).toHaveBeenCalledTimes(4);
    expect(mock.resolveWikidataId).toHaveBeenCalledTimes(4);
  });

  test('a topic with no MeSH descriptor is remembered, and falls back to its keywords', async () => {
    await seed();
    const mock = providers({ resolveMesh: jest.fn(async () => null) });
    await refreshSignals({ now: NOW, providers: mock });
    const a = await Topic.findOne({ openalexID: 'A' }).lean();
    expect(a.ids.mesh).toBe('');
    expect(mock.pubmedSignal.mock.calls[0][0].ids.meshLabel).toBeUndefined();
    await refreshSignals({ now: NOW, providers: mock });
    expect(mock.resolveMesh).toHaveBeenCalledTimes(8);
  });

  test('a source that fails is left out, the others still count', async () => {
    await seed();
    const log = jest.fn();
    const mock = providers({
      pubmedSignal: jest.fn(async () => {
        throw new Error('NCBI is down');
      }),
    });
    const result = await refreshSignals({ now: NOW, providers: mock, log });
    expect(result.withSignals).toBe(4);
    const a = await Topic.findOne({ openalexID: 'A' }).lean();
    expect(a.signals.pubmed).toBeUndefined();
    expect(a.signals.wikipedia.ratio).toBe(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NCBI is down'));
  });

  test('topics whose page is only loosely related get no attention signal', async () => {
    await seed();
    await Topic.updateOne({ openalexID: 'A' }, { $set: { anchor: 'loose' } });
    const mock = providers();
    await refreshSignals({ now: NOW, providers: mock });
    expect((await Topic.findOne({ openalexID: 'A' })).signals.wikipedia).toBeUndefined();
    expect(mock.wikipediaSignal).not.toHaveBeenCalledWith('Page A', expect.anything());
  });

  test('a lab with fewer than three topics per source is not ranked: no level, hot score unchanged', async () => {
    await scored('A', 90);
    await scored('B', 80);
    await refreshSignals({ now: NOW, providers: providers() });
    const a = await Topic.findOne({ openalexID: 'A' }).lean();
    expect(a.signals.pubmed.level).toBeNull();
    expect(a.score.signalLevel).toBeNull();
    expect(a.score.hot).toBe(90);
  });

  test('a topic that is no longer tracked falls back to its OpenAlex score', async () => {
    await seed();
    await Topic.updateOne(
      { openalexID: 'E' },
      {
        $set: {
          'score.signalLevel': 100,
          'score.hot': 99,
          'signals.pubmed': { current: 1, previous: 1, ratio: 1 },
        },
      }
    );
    await refreshSignals({ now: NOW, providers: providers() });
    const e = await Topic.findOne({ openalexID: 'E' });
    expect(e.score.signalLevel).toBeNull();
    expect(e.score.hot).toBe(50);
    expect(e.signals.pubmed).toBeUndefined();
  });

  test('arXiv is used for the labs it covers', async () => {
    for (const [key, hot] of [
      ['A', 90],
      ['B', 80],
      ['C', 70],
    ]) {
      await scored(key, hot, { departmentName: 'ComputerScience' });
    }
    const arxivSignal = jest.fn(async (topic) => ({
      current: 20,
      previous: 10,
      ratio: topic.openalexID === 'C' ? 4 : 1,
      query: 'q',
    }));
    await refreshSignals({ now: NOW, providers: providers({ arxivSignal }) });
    expect(arxivSignal).toHaveBeenCalledTimes(3);
    expect(arxivSignal.mock.calls[0][2]).toBe(17);
    expect((await Topic.findOne({ openalexID: 'C' })).signals.arxiv.level).toBe(100);
  });
});
