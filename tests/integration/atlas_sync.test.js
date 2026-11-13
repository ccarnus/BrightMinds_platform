const Topic = require('../../models/topic_model');
const {
  parseWikipediaUrl,
  normalizeCatalogTopic,
  anchorQuality,
  syncCatalog,
  migrateLegacyTopics,
} = require('../../services/atlas_sync');
const { useTestDatabase } = require('../helpers/db');

useTestDatabase();

const raw = (n, overrides = {}) => ({
  id: `https://openalex.org/T${n}`,
  display_name: `Topic ${n}`,
  description: `About topic ${n}`,
  keywords: [
    { id: 'https://openalex.org/keywords/alpha', display_name: 'alpha', score: 0.2 },
    { id: 'https://openalex.org/keywords/beta', display_name: 'beta', score: 0.9 },
  ],
  ids: { wikipedia: `https://en.wikipedia.org/wiki/Page_${n}` },
  subfield: { id: 'https://openalex.org/subfields/1605', display_name: 'Organic Chemistry' },
  field: { id: 'https://openalex.org/fields/16', display_name: 'Chemistry' },
  domain: { id: 'https://openalex.org/domains/3', display_name: 'Physical Sciences' },
  works_count: 1000 + n,
  cited_by_count: 5000 + n,
  ...overrides,
});

describe('parseWikipediaUrl', () => {
  test('reads the title, decodes it and notices a section', () => {
    expect(parseWikipediaUrl('https://en.wikipedia.org/wiki/Cat_health')).toEqual({
      title: 'Cat health',
      section: false,
    });
    expect(parseWikipediaUrl('https://en.wikipedia.org/wiki/Reading#Habits_and_effects')).toEqual({
      title: 'Reading',
      section: true,
    });
    expect(parseWikipediaUrl('https://en.wikipedia.org/wiki/Caf%C3%A9').title).toBe('Café');
    expect(parseWikipediaUrl(undefined)).toEqual({ title: null, section: false });
  });
});

describe('normalizeCatalogTopic', () => {
  test('keeps the hierarchy, the best keywords and the Wikipedia title', () => {
    const topic = normalizeCatalogTopic(raw(7));
    expect(topic).toMatchObject({
      openalexID: 'T7',
      name: 'Topic 7',
      departmentName: 'Chemistry',
      subfield: { id: 1605, name: 'Organic Chemistry' },
      wikipedia: 'Page 7',
      worksCount: 1007,
      citedByCount: 5007,
    });
    expect(topic.keywords.map((keyword) => keyword.name)).toEqual(['beta', 'alpha']);
    expect(topic.keywords[0]).toEqual({ id: 'beta', name: 'beta', score: 0.9 });
  });

  test('reads the keywords of older payloads (plain strings) and drops unknown fields', () => {
    const legacy = normalizeCatalogTopic(raw(8, { keywords: ['x', 'y'] }));
    expect(legacy.keywords.map((keyword) => keyword.name)).toEqual(['x', 'y']);
    expect(
      normalizeCatalogTopic(raw(9, { field: { id: 'https://openalex.org/fields/99' } }))
    ).toBeNull();
    expect(normalizeCatalogTopic({})).toBeNull();
  });

  test('keeps at most 12 keywords', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `https://openalex.org/keywords/k${i}`,
      display_name: `k${i}`,
      score: i / 100,
    }));
    expect(normalizeCatalogTopic(raw(10, { keywords: many })).keywords).toHaveLength(12);
  });
});

describe('anchorQuality', () => {
  const topic = (name, keywords, wikipedia, section = false) => ({
    name,
    keywords: keywords.map((keyword) => ({ name: keyword })),
    wikipedia,
    wikipediaSection: section,
  });

  test('a page whose words all appear in the topic is a match', () => {
    expect(
      anchorQuality(topic('Tuberculosis Research', ['tuberculosis'], 'Tuberculosis'), new Set())
    ).toBe('match');
    expect(anchorQuality(topic('Cell biology', ['stem cells'], 'Stem cell'), new Set())).toBe(
      'match'
    );
  });

  test('a page about something else is loose, a page of many topics is shared', () => {
    expect(
      anchorQuality(
        topic('Veterinary Medicine and Surgery', ['dogs', 'surgery'], 'Cat health'),
        new Set()
      )
    ).toBe('loose');
    expect(
      anchorQuality(
        topic('Education Methods', ['teaching'], 'Educational technology'),
        new Set(['Educational technology'])
      )
    ).toBe('shared');
    expect(anchorQuality(topic('Reading', ['reading'], 'Reading', true), new Set())).toBe('loose');
    expect(anchorQuality(topic('X', [], null), new Set())).toBeUndefined();
  });
});

describe('syncCatalog', () => {
  const pages = (count) => async (page) => {
    const all = Array.from({ length: count }, (_, i) => raw(i + 1));
    return all.slice((page - 1) * 200, page * 200);
  };

  test('downloads every page, stores the topics and is repeatable', async () => {
    const first = await syncCatalog({ fetchPage: pages(250) });
    expect(first).toEqual({ topics: 250, created: 250, retired: 0 });
    expect(await Topic.countDocuments({ source: 'openalex' })).toBe(250);

    const stored = await Topic.findOne({ openalexID: 'T3' });
    expect(stored).toMatchObject({
      name: 'Topic 3',
      departmentName: 'Chemistry',
      source: 'openalex',
      castCount: 0,
      retired: false,
      anchor: 'loose',
    });
    expect(stored.subfield.id).toBe(1605);
    expect(stored.ids.wikipedia).toBe('Page 3');
    expect(stored.metrics.openalex.worksCount).toBe(1003);

    const second = await syncCatalog({ fetchPage: pages(250) });
    expect(second).toEqual({ topics: 250, created: 0, retired: 0 });
    expect(await Topic.countDocuments()).toBe(250);
  });

  test('a topic stored before the atlas is completed in place: same id, name and casts', async () => {
    const castId = '64d000000000000000000001';
    const legacy = await Topic.create({
      name: 'Old Name',
      departmentName: 'Chemistry',
      openalexID: 'T5',
      castIDs: [castId],
      castCount: 1,
      source: 'author',
    });
    await syncCatalog({ fetchPage: pages(10) });

    const migrated = await Topic.findOne({ openalexID: 'T5' });
    expect(migrated._id.toString()).toBe(legacy._id.toString());
    expect(migrated).toMatchObject({
      name: 'Old Name',
      source: 'openalex',
      originalName: 'Topic 5',
      castCount: 1,
    });
    expect(migrated.castIDs.map(String)).toEqual([castId]);
    expect(await Topic.countDocuments({ openalexID: 'T5' })).toBe(1);
  });

  test('keeps scores and casts when OpenAlex renames or re-describes a topic', async () => {
    await syncCatalog({ fetchPage: pages(5) });
    await Topic.updateOne({ openalexID: 'T2' }, { $set: { 'score.hot': 77, castCount: 3 } });
    await syncCatalog({
      fetchPage: async () => [raw(2, { display_name: 'Renamed', description: 'New' })],
    });
    const topic = await Topic.findOne({ openalexID: 'T2' });
    expect(topic).toMatchObject({
      name: 'Topic 2',
      originalName: 'Renamed',
      description: 'New',
      castCount: 3,
    });
    expect(topic.score.hot).toBe(77);
  });

  test('topics that left the catalog are retired, unless the download looks broken', async () => {
    await syncCatalog({ fetchPage: pages(20) });
    await Topic.updateOne({ openalexID: 'T20' }, { $set: { featured: true } });

    // 18 of 20: still a plausible catalog, so the 2 missing ones are retired.
    const result = await syncCatalog({ fetchPage: pages(18) });
    expect(result.retired).toBe(2);
    const gone = await Topic.findOne({ openalexID: 'T20' });
    expect(gone).toMatchObject({ retired: true, featured: false });

    // Back in the catalog: no longer retired.
    await syncCatalog({ fetchPage: pages(20) });
    expect((await Topic.findOne({ openalexID: 'T20' })).retired).toBe(false);

    // 3 of 20: a broken download must not retire anything.
    const broken = await syncCatalog({ fetchPage: pages(3) });
    expect(broken.retired).toBe(0);
    expect(await Topic.countDocuments({ retired: true })).toBe(0);
  });

  test('an empty answer is an error and changes nothing', async () => {
    await syncCatalog({ fetchPage: pages(5) });
    await expect(syncCatalog({ fetchPage: async () => [] })).rejects.toThrow('no topics');
    await expect(
      syncCatalog({
        fetchPage: async () => {
          throw new Error('OpenAlex is down');
        },
      })
    ).rejects.toThrow('OpenAlex is down');
    expect(await Topic.countDocuments({ retired: false })).toBe(5);
  });

  test('flags the Wikipedia pages shared by several topics', async () => {
    const same = (n) =>
      raw(n, { ids: { wikipedia: 'https://en.wikipedia.org/wiki/Educational_technology' } });
    await syncCatalog({ fetchPage: async () => [same(1), same(2), raw(3)] });
    expect((await Topic.findOne({ openalexID: 'T1' })).anchor).toBe('shared');
    expect((await Topic.findOne({ openalexID: 'T3' })).anchor).toBe('loose');
  });
});

describe('migrateLegacyTopics', () => {
  test('gives topics stored before the atlas an origin, once', async () => {
    await Topic.collection.insertMany([
      {
        name: 'From OpenAlex',
        departmentName: 'Chemistry',
        openalexID: 'T9',
        castCount: 1,
        castIDs: [],
      },
      { name: 'Typed by an author', departmentName: 'Chemistry', castCount: 1, castIDs: [] },
      {
        name: 'Already done',
        departmentName: 'Chemistry',
        source: 'author',
        castCount: 0,
        castIDs: [],
      },
    ]);
    expect(await migrateLegacyTopics()).toEqual({ catalog: 1, authored: 1, detached: 0 });
    expect((await Topic.findOne({ name: 'From OpenAlex' })).source).toBe('openalex');
    expect((await Topic.findOne({ name: 'Typed by an author' })).source).toBe('author');
    expect(await migrateLegacyTopics()).toEqual({ catalog: 0, authored: 0, detached: 0 });
  });

  test('an OpenAlex id shared by old topics stays with the one that has the casts', async () => {
    await Topic.collection.dropIndex('openalexID_1');
    try {
      await Topic.collection.insertMany([
        {
          name: 'Old name',
          departmentName: 'Chemistry',
          openalexID: 'T9',
          castCount: 0,
          castIDs: [],
        },
        {
          name: 'Renamed',
          departmentName: 'Chemistry',
          openalexID: 'T9',
          castCount: 3,
          castIDs: [],
        },
        {
          name: 'Empty id',
          departmentName: 'Chemistry',
          openalexID: '',
          castCount: 1,
          castIDs: [],
        },
        {
          name: 'Empty id too',
          departmentName: 'Chemistry',
          openalexID: '',
          castCount: 1,
          castIDs: [],
        },
      ]);
      expect(await migrateLegacyTopics()).toEqual({ catalog: 1, authored: 2, detached: 1 });
      expect(await Topic.findOne({ name: 'Renamed' }).lean()).toMatchObject({
        source: 'openalex',
        openalexID: 'T9',
        castCount: 3,
      });
      const old = await Topic.findOne({ name: 'Old name' }).lean();
      expect(old).toMatchObject({ source: 'author', castCount: 0 });
      expect(old.openalexID).toBeUndefined();
      expect((await Topic.findOne({ name: 'Empty id' }).lean()).openalexID).toBeUndefined();
      // The unique index can be built again.
      await expect(Topic.syncIndexes()).resolves.toBeDefined();
      await expect(
        Topic.create({ name: 'Twin', departmentName: 'Chemistry', openalexID: 'T9' })
      ).rejects.toThrow('duplicate key');
    } finally {
      await Topic.createIndexes();
    }
  });
});
