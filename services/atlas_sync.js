// The topic catalog: every OpenAlex topic (4,516 of them) with its place in the hierarchy
// (domain > field = lab > subfield = area), its keywords and the Wikipedia page it points at.
// The sync is idempotent and keeps what BrightMinds adds (casts, scores, cross-reference ids).
const Topic = require('../models/topic_model');
const openalex = require('./openalex');
const { departmentById } = require('../lists/departments');

const PAGE_SIZE = 200;
const MAX_PAGES = 40;
const KEYWORDS_KEPT = 12;
// A sync that returns far fewer topics than before is a broken download: it must not retire anything.
const MIN_SHARE_OF_PREVIOUS = 0.9;

const STOP_WORDS = new Set(['and', 'the', 'of', 'in', 'for', 'to', 'on', 'with', 'a', 'an', 'by']);

const withoutUndefined = (object) =>
  Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined));

const tokens = (text) =>
  String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));

/** "https://en.wikipedia.org/wiki/Cat_health#Diet" -> { title: "Cat health", section: true } */
const parseWikipediaUrl = (url) => {
  if (!url) return { title: null, section: false };
  const last = String(url).split('/wiki/').pop();
  const [rawTitle, ...fragment] = last.split('#');
  try {
    return { title: decodeURIComponent(rawTitle).replace(/_/g, ' '), section: fragment.length > 0 };
  } catch {
    return { title: rawTitle.replace(/_/g, ' '), section: fragment.length > 0 };
  }
};

/** Topic of the OpenAlex API -> what the atlas stores. Returns null for a field the app does not know. */
const normalizeCatalogTopic = (raw) => {
  const fieldId = Number(openalex.shortId(raw?.field?.id));
  const department = departmentById[fieldId];
  const openalexID = openalex.shortId(raw?.id);
  if (!department || !openalexID) return null;

  // Keywords are objects since October 2026; older payloads had plain strings.
  const keywords = (raw.keywords || [])
    .map((keyword) =>
      typeof keyword === 'string'
        ? { id: null, name: keyword, score: null }
        : {
            id: openalex.shortId(keyword.id),
            name: keyword.display_name,
            score: keyword.score ?? null,
          }
    )
    .filter((keyword) => keyword.name)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, KEYWORDS_KEPT);

  const wikipedia = parseWikipediaUrl(raw.ids?.wikipedia);
  return {
    openalexID,
    name: raw.display_name,
    description: raw.description || undefined,
    departmentName: department.display_name,
    subfield: {
      id: Number(openalex.shortId(raw.subfield?.id)) || null,
      name: raw.subfield?.display_name,
    },
    keywords,
    wikipedia: wikipedia.title,
    wikipediaSection: wikipedia.section,
    worksCount: raw.works_count || 0,
    citedByCount: raw.cited_by_count || 0,
  };
};

/**
 * Is the Wikipedia page really about the topic? OpenAlex links every topic to a page, but some are
 * loose ("Veterinary Medicine and Surgery" -> "Cat health") or shared by unrelated topics ("Educational
 * technology"). Only a page whose words all appear in the topic's name or keywords is trusted.
 * @returns {'match'|'loose'|'shared'|undefined}
 */
const anchorQuality = (topic, sharedTitles) => {
  if (!topic.wikipedia) return undefined;
  if (sharedTitles.has(topic.wikipedia)) return 'shared';
  if (topic.wikipediaSection) return 'loose';
  const pageWords = tokens(topic.wikipedia);
  if (!pageWords.length || pageWords.length > 4) return 'loose';
  const topicWords = new Set(tokens([topic.name, ...topic.keywords.map((k) => k.name)].join(' ')));
  // "cells" and "cell": compare on a crude stem.
  const stem = (word) => word.replace(/(ies|es|s)$/, '');
  const stems = new Set([...topicWords].map(stem));
  return pageWords.every((word) => stems.has(stem(word))) ? 'match' : 'loose';
};

const fetchCatalog = async (fetchPage = openalex.fetchTopicsPage) => {
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const results = await fetchPage(page);
    all.push(...results);
    if (results.length < PAGE_SIZE) break;
  }
  return all;
};

/**
 * Downloads the catalog and upserts it. Topics that already exist (including the ones created
 * before the atlas, matched by their OpenAlex id) keep their name, casts and scores.
 * @returns {Promise<{ topics: number, created: number, retired: number }>}
 */
const syncCatalog = async ({ fetchPage } = {}) => {
  const catalog = (await fetchCatalog(fetchPage)).map(normalizeCatalogTopic).filter(Boolean);
  if (!catalog.length) throw new Error('OpenAlex returned no topics.');

  const titleCounts = new Map();
  for (const topic of catalog) {
    if (topic.wikipedia)
      titleCounts.set(topic.wikipedia, (titleCounts.get(topic.wikipedia) || 0) + 1);
  }
  const sharedTitles = new Set(
    [...titleCounts].filter(([, count]) => count > 1).map(([title]) => title)
  );

  const previous = await Topic.countDocuments({ source: 'openalex' });
  const existing = new Set(
    (
      await Topic.find(
        { openalexID: { $in: catalog.map((t) => t.openalexID) } },
        'openalexID'
      ).lean()
    ).map((topic) => topic.openalexID)
  );

  await Topic.bulkWrite(
    catalog.map((topic) => ({
      updateOne: {
        filter: { openalexID: topic.openalexID },
        update: {
          $set: withoutUndefined({
            source: 'openalex',
            retired: false,
            originalName: topic.name,
            description: topic.description,
            subfield: topic.subfield,
            keywords: topic.keywords,
            'ids.wikipedia': topic.wikipedia,
            anchor: anchorQuality(topic, sharedTitles),
            'metrics.openalex.worksCount': topic.worksCount,
            'metrics.openalex.citedByCount': topic.citedByCount,
          }),
          $setOnInsert: {
            name: topic.name,
            departmentName: topic.departmentName,
            castCount: 0,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false }
  );

  let retired = 0;
  if (!previous || catalog.length >= previous * MIN_SHARE_OF_PREVIOUS) {
    const result = await Topic.updateMany(
      {
        source: 'openalex',
        openalexID: { $nin: catalog.map((t) => t.openalexID) },
        retired: { $ne: true },
      },
      { $set: { retired: true, featured: false } }
    );
    retired = result.modifiedCount;
  }
  return { topics: catalog.length, created: catalog.length - existing.size, retired };
};

/**
 * Topics stored before the atlas have no `source`: the ones with an OpenAlex id are catalog
 * topics, the others were typed by an author. An OpenAlex id can belong to one topic only (the
 * catalog is upserted by it): when old topics share one, the one with the most casts keeps it and
 * the others become author topics with the same name and casts. Idempotent.
 */
const migrateLegacyTopics = async () => {
  await Topic.updateMany({ openalexID: '' }, { $unset: { openalexID: '' } });
  const groups = await Topic.aggregate([
    { $match: { openalexID: { $type: 'string' } } },
    {
      $group: {
        _id: '$openalexID',
        topics: { $push: { id: '$_id', castCount: { $ifNull: ['$castCount', 0] } } },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  let detached = 0;
  for (const group of groups) {
    const [, ...others] = group.topics.sort(
      (a, b) => b.castCount - a.castCount || String(a.id).localeCompare(String(b.id))
    );
    const result = await Topic.updateMany(
      { _id: { $in: others.map((topic) => topic.id) } },
      { $set: { source: 'author' }, $unset: { openalexID: '' } }
    );
    detached += result.modifiedCount;
  }
  if (detached) await Topic.createIndexes();

  const catalog = await Topic.updateMany(
    { source: { $exists: false }, openalexID: { $type: 'string' } },
    { $set: { source: 'openalex' } }
  );
  const authored = await Topic.updateMany(
    { source: { $exists: false } },
    { $set: { source: 'author' } }
  );
  return { catalog: catalog.modifiedCount, authored: authored.modifiedCount, detached };
};

module.exports = {
  parseWikipediaUrl,
  normalizeCatalogTopic,
  anchorQuality,
  fetchCatalog,
  syncCatalog,
  migrateLegacyTopics,
};
