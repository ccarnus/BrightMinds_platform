// Runs the independent signals (services/signals.js) for the topics worth the extra requests -
// the hottest of each lab and those with casts - and pulls their hot score toward what the other
// sources say. A signal that cannot be fetched is left out; nothing here blocks the OpenAlex scores.
const config = require('../config');
const Topic = require('../models/topic_model');
const defaultProviders = require('./signals');
const { departmentIdByName } = require('../lists/departments');
const { buildWindows, hotScore, percentiles } = require('./topic_scoring');
const { rankLabs, round } = require('./topic_metrics');

const MIN_TOPICS_TO_RANK = 3;
const PROVIDERS = ['wikipedia', 'pubmed', 'arxiv'];

/** The topics that get signals: the hottest of each lab, and every scored topic with casts. */
const selectTracked = async () => {
  const scored = await Topic.find(
    { source: 'openalex', retired: { $ne: true }, 'score.hotBase': { $ne: null } },
    'openalexID departmentName name keywords ids anchor castCount score.hotBase'
  ).lean();
  const byLab = new Map();
  for (const topic of scored) {
    if (!byLab.has(topic.departmentName)) byLab.set(topic.departmentName, []);
    byLab.get(topic.departmentName).push(topic);
  }
  const tracked = new Map();
  for (const topics of byLab.values()) {
    topics.sort((a, b) => b.score.hotBase - a.score.hotBase);
    topics
      .slice(0, config.atlas.trackedPerLab)
      .forEach((topic) => tracked.set(String(topic._id), topic));
  }
  for (const topic of scored) if (topic.castCount > 0) tracked.set(String(topic._id), topic);
  return [...tracked.values()];
};

/** MeSH descriptor for the topic: tried on its Wikipedia page, then on its main keywords. */
const findMesh = async (topic, providers) => {
  const candidates = [
    topic.ids?.wikipedia,
    ...(topic.keywords || []).slice(0, 2).map((k) => k.name),
  ].filter(Boolean);
  for (const label of candidates) {
    const mesh = await providers.resolveMesh(label);
    if (mesh) return mesh;
  }
  return null;
};

const gather = async (topic, { windows, providers, now, log }) => {
  const fieldId = departmentIdByName[topic.departmentName];
  const found = {};
  const idUpdates = {};
  const safely = async (name, task) => {
    try {
      const value = await task();
      if (value) found[name] = value;
    } catch (error) {
      log(`atlas: ${name} signal failed for "${topic.name}": ${error.message}`);
    }
  };

  if (topic.anchor === 'match' && topic.ids?.wikipedia) {
    await safely('wikipedia', async () => {
      if (!topic.ids.wikidata) {
        const wikidata = await providers.resolveWikidataId(topic.ids.wikipedia);
        if (wikidata) idUpdates['ids.wikidata'] = wikidata;
      }
      const signal = await providers.wikipediaSignal(topic.ids.wikipedia, now);
      return signal && { ...signal, query: topic.ids.wikipedia };
    });
  }
  if (providers.PUBMED_FIELDS.has(fieldId)) {
    await safely('pubmed', async () => {
      let meshLabel = topic.ids?.meshLabel;
      // '' means "looked for it, none": do not look again every week.
      if (topic.ids?.mesh === null || topic.ids?.mesh === undefined) {
        const mesh = await findMesh(topic, providers);
        idUpdates['ids.mesh'] = mesh ? mesh.id : '';
        idUpdates['ids.meshLabel'] = mesh ? mesh.label : null;
        meshLabel = mesh?.label;
      }
      return providers.pubmedSignal({ ...topic, ids: { ...topic.ids, meshLabel } }, windows);
    });
  }
  if (providers.ARXIV_ARCHIVES[fieldId]) {
    await safely('arxiv', () => providers.arxivSignal(topic, windows, fieldId));
  }
  return { found, idUpdates };
};

/**
 * @param {{ now?: Date, providers?: object, log?: Function }} [options]
 * @returns {Promise<{ tracked: number, withSignals: number }>}
 */
const refreshSignals = async ({
  now = new Date(),
  providers = defaultProviders,
  log = () => {},
} = {}) => {
  const windows = buildWindows(now, config.atlas.lagDays);
  const tracked = await selectTracked();
  const gathered = new Map();
  for (const topic of tracked) {
    gathered.set(String(topic._id), await gather(topic, { windows, providers, now, log }));
  }

  // Each signal becomes a percentile among the tracked topics of the lab that have it.
  const levels = new Map();
  for (const provider of PROVIDERS) {
    const byLab = new Map();
    for (const topic of tracked) {
      const signal = gathered.get(String(topic._id)).found[provider];
      if (!signal) continue;
      if (!byLab.has(topic.departmentName)) byLab.set(topic.departmentName, []);
      byLab.get(topic.departmentName).push({ topic, signal });
    }
    for (const entries of byLab.values()) {
      if (entries.length < MIN_TOPICS_TO_RANK) continue;
      const ranks = percentiles(entries.map((entry) => entry.signal.ratio));
      entries.forEach((entry, index) => {
        levels.set(`${entry.topic._id}/${provider}`, ranks[index]);
      });
    }
  }

  const trackedIds = tracked.map((topic) => topic._id);
  // Topics that no longer get signals fall back to their OpenAlex score.
  await Topic.updateMany({ _id: { $nin: trackedIds }, 'score.signalLevel': { $ne: null } }, [
    { $set: { 'score.signalLevel': null, 'score.hot': '$score.hotBase', signals: {} } },
  ]);

  let withSignals = 0;
  const updates = tracked.map((topic) => {
    const { found, idUpdates } = gathered.get(String(topic._id));
    const set = { ...idUpdates, 'signals.computedAt': now };
    const unset = {};
    const providerLevels = [];
    for (const provider of PROVIDERS) {
      const signal = found[provider];
      if (!signal) {
        unset[`signals.${provider}`] = '';
        continue;
      }
      const level = levels.get(`${topic._id}/${provider}`) ?? null;
      if (level !== null) providerLevels.push(level);
      set[`signals.${provider}`] = {
        current: signal.current,
        previous: signal.previous,
        ratio: round(signal.ratio),
        level: round(level, 1),
        query: signal.query,
        fetchedAt: now,
      };
    }
    const signalLevel = providerLevels.length
      ? providerLevels.reduce((sum, level) => sum + level, 0) / providerLevels.length
      : null;
    if (Object.keys(found).length) withSignals += 1;
    set['score.signalLevel'] = round(signalLevel, 1);
    set['score.hot'] = round(hotScore(topic.score.hotBase, signalLevel), 1);
    const update = { $set: set };
    if (Object.keys(unset).length) update.$unset = unset;
    return { updateOne: { filter: { _id: topic._id }, update } };
  });
  if (updates.length) await Topic.bulkWrite(updates, { ordered: false });
  await rankLabs();
  return { tracked: tracked.length, withSignals };
};

module.exports = { selectTracked, refreshSignals };
