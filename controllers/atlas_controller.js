// The research atlas as the app sees it: which topics are hot, how a lab is doing, how to browse
// and search the topics. All reads; the scores come from services/atlas.js.
const Topic = require('../models/topic_model');
const { DOMAINS, departments, departmentNames, domainById } = require('../lists/departments');
const { getStatus } = require('../services/atlas');
const { badRequest } = require('../utils/http');

const HOT_TRENDS = ['surging', 'rising'];
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;

const CARD_FIELDS = [
  'name',
  'departmentName',
  'subfield',
  'keywords',
  'castCount',
  'source',
  'score.hot',
  'score.trend',
  'score.phase',
  'score.works12m',
  'score.yoy',
  'score.growth.rate',
  'score.acceleration',
].join(' ');

/** A topic as a card: what a list needs to show it, and nothing heavy. */
const toCard = (topic) => ({
  id: topic._id,
  name: topic.name,
  lab: topic.departmentName,
  area: topic.subfield?.name || null,
  areaId: topic.subfield?.id ?? null,
  hot: topic.score?.hot ?? null,
  trend: topic.score?.trend ?? null,
  phase: topic.score?.phase ?? null,
  works12m: topic.score?.works12m ?? 0,
  // Change over the previous 12 months, and growth against the topic's area (1 = like the area).
  change: topic.score?.yoy ?? null,
  versusArea: topic.score?.growth?.rate ?? null,
  acceleration: topic.score?.acceleration ?? null,
  castCount: topic.castCount || 0,
  keywords: (topic.keywords || []).slice(0, 3).map((keyword) => keyword.name),
});

const parseLimit = (value) => {
  const limit = Number.parseInt(value, 10);
  if (!Number.isFinite(limit) || limit < 1) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
};

const parseLab = (value) => {
  if (value === undefined || value === '') return undefined;
  if (!departmentNames.includes(String(value))) throw badRequest('Invalid lab.');
  return String(value);
};

const parseArea = (value) => {
  if (value === undefined || value === '') return undefined;
  const id = Number(value);
  if (!Number.isInteger(id)) throw badRequest('Invalid area.');
  return id;
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every word typed must be in the name, a keyword or the area of the topic. */
const searchFilter = (query) => {
  const words = String(query || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.map((word) => {
    const pattern = new RegExp(escapeRegex(word), 'i');
    return { $or: [{ name: pattern }, { 'keywords.name': pattern }, { 'subfield.name': pattern }] };
  });
};

const SORTS = {
  hot: { 'score.hot': -1, 'score.growth.lower': -1, castCount: -1, name: 1 },
  growth: { 'score.growth.lower': -1, name: 1 },
  volume: { 'score.works12m': -1, name: 1 },
  casts: { castCount: -1, 'score.hot': -1, name: 1 },
  name: { name: 1 },
};

/** The domains and their labs, with how many topics each has and how many are moving. */
exports.getAtlas = async (req, res) => {
  const [counts, status] = await Promise.all([
    Topic.aggregate([
      { $match: { retired: { $ne: true } } },
      {
        $group: {
          _id: '$departmentName',
          topics: { $sum: 1 },
          hot: { $sum: { $cond: [{ $in: ['$score.trend', HOT_TRENDS] }, 1, 0] } },
          casts: { $sum: '$castCount' },
        },
      },
    ]),
    getStatus(),
  ]);
  const byLab = new Map(counts.map((item) => [item._id, item]));
  res.status(200).json({
    updatedAt: status.metricsAt,
    windowsEndOn: status.windowsEndOn,
    domains: DOMAINS.map((domain) => ({
      id: domain.id,
      name: domain.name,
      labs: departments
        .filter((department) => department.domain === domain.id)
        .map((department) => ({
          name: department.display_name,
          topics: byLab.get(department.display_name)?.topics || 0,
          hot: byLab.get(department.display_name)?.hot || 0,
          casts: byLab.get(department.display_name)?.casts || 0,
        })),
    })),
  });
};

/** Hot topics: the ones whose research output grows faster than their area's, with confidence. */
exports.getHotTopics = async (req, res) => {
  const lab = parseLab(req.query.lab);
  const area = parseArea(req.query.area);
  const filter = { retired: { $ne: true }, 'score.hot': { $ne: null } };
  if (req.query.trend !== 'any') filter['score.trend'] = { $in: HOT_TRENDS };
  if (lab) filter.departmentName = lab;
  if (area !== undefined) filter['subfield.id'] = area;

  const topics = await Topic.find(filter)
    .select(CARD_FIELDS)
    .sort(SORTS.hot)
    .limit(parseLimit(req.query.limit))
    .lean();
  res.status(200).json({ topics: topics.map(toCard) });
};

/** A lab page: its areas, its hot topics and the ones just emerging. */
exports.getLabAtlas = async (req, res) => {
  const lab = parseLab(req.params.name);
  if (!lab) throw badRequest('Invalid lab.');
  const base = { departmentName: lab, retired: { $ne: true } };
  const [areas, hot, emerging, total] = await Promise.all([
    Topic.aggregate([
      { $match: { ...base, source: 'openalex' } },
      {
        $group: {
          _id: '$subfield.id',
          name: { $first: '$subfield.name' },
          topics: { $sum: 1 },
          works12m: { $sum: '$score.works12m' },
          hot: { $sum: { $cond: [{ $in: ['$score.trend', HOT_TRENDS] }, 1, 0] } },
        },
      },
      { $sort: { hot: -1, works12m: -1 } },
    ]),
    Topic.find({ ...base, 'score.hot': { $ne: null }, 'score.trend': { $in: HOT_TRENDS } })
      .select(CARD_FIELDS)
      .sort(SORTS.hot)
      .limit(8)
      .lean(),
    Topic.find({ ...base, 'score.phase': 'emerging' })
      .select(CARD_FIELDS)
      .sort(SORTS.growth)
      .limit(8)
      .lean(),
    Topic.countDocuments(base),
  ]);
  const department = departments.find((item) => item.display_name === lab);
  res.status(200).json({
    lab,
    domain: domainById[department.domain].name,
    topics: total,
    areas: areas.map((area) => ({
      id: area._id,
      name: area.name,
      topics: area.topics,
      works12m: area.works12m,
      hot: area.hot,
    })),
    hot: hot.map(toCard),
    emerging: emerging.map(toCard),
  });
};

/** Browse and search all the topics: by lab, area, trend or phase, with a word search and paging. */
exports.browseTopics = async (req, res) => {
  const lab = parseLab(req.query.lab);
  const area = parseArea(req.query.area);
  const filters = [{ retired: { $ne: true } }];
  if (lab) filters.push({ departmentName: lab });
  if (area !== undefined) filters.push({ 'subfield.id': area });
  if (req.query.trend) {
    if (!['surging', 'rising', 'steady', 'cooling', 'niche'].includes(req.query.trend)) {
      throw badRequest('Invalid trend.');
    }
    filters.push({ 'score.trend': req.query.trend });
  }
  if (req.query.phase) {
    if (!['emerging', 'growing', 'mature', 'declining'].includes(req.query.phase)) {
      throw badRequest('Invalid phase.');
    }
    filters.push({ 'score.phase': req.query.phase });
  }
  filters.push(...searchFilter(req.query.q));

  const sort = SORTS[req.query.sort] || SORTS.hot;
  const limit = parseLimit(req.query.limit);
  const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
  const filter = { $and: filters };
  const [total, topics] = await Promise.all([
    Topic.countDocuments(filter),
    Topic.find(filter)
      .select(CARD_FIELDS)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);
  res.status(200).json({ total, page, limit, topics: topics.map(toCard) });
};

/** When the atlas was last refreshed and what it holds. */
exports.getAtlasStatus = async (req, res) => {
  res.status(200).json(await getStatus());
};
