// Picks the topic (within the cast's lab) that best describes a cast.
// The catalog of topics is in the database (services/atlas_sync.js): a first question picks the area
// (subfield, about 15 per lab), a second the topic in that area (about 18). Short lists are cheaper and
// more reliable than one list of hundreds, and OpenAlex being down no longer blocks casts.
// Until the catalog is synced, the lab's topics are read live from OpenAlex and chosen in one question.
const config = require('../config');
const Topic = require('../models/topic_model');
const openalex = require('./openalex');
const { departmentIdByName } = require('../lists/departments');
const { AIError, callOpenAI, classifyError } = require('./openai');

const OPENALEX_MAX_PAGES = 25;
const TOPICS_CACHE_MS = 24 * 60 * 60 * 1000;
const topicsCache = new Map(); // fieldId -> { at, topics } (live path only)
const CONTENT_LIMIT = 20000;

const AREA_PROMPT =
  'You classify research content into the research areas of one academic field. You receive the ' +
  'list of areas ("<id>: <name>" per line), then a piece of content. Choose the single area that ' +
  'best describes what the research is about (its subject, not its method or context) and answer ' +
  'with its id exactly as listed.';
const TOPIC_PROMPT =
  'You classify research content into the research topics of one research area. You receive the ' +
  'list of topics ("<id>: <name> (keywords)" per line), then a piece of content. Choose the single ' +
  'topic that best describes what the research is about (its subject, not its method or context) ' +
  'and answer with its id exactly as listed.';
// The one-question path of the live catalog.
const LIVE_PROMPT =
  'You classify research content into the OpenAlex topic taxonomy. You receive the list of ' +
  'topics of one academic field ("<id>: <name>" per line), then a piece of content. Choose the ' +
  'single topic that best describes what the research is about (its subject, not its method ' +
  'or context) and answer with its id exactly as listed.';

const getFieldId = (departmentName) => departmentIdByName[departmentName] || null;

const contentMessage = ({ title, description }) => ({
  role: 'user',
  content: `Title: ${title}\n\n<content>\n${String(description || '').slice(0, CONTENT_LIMIT)}\n</content>`,
});

/** One structured question: the model answers with one of `ids`. The list comes first so OpenAI caches it. */
const askForId = async ({
  operation,
  schemaName,
  prompt,
  listing,
  content,
  ids,
  constrain = true,
}) => {
  const response = await callOpenAI(operation, (client) =>
    client.chat.completions.create({
      model: config.openai.chatModel,
      reasoning_effort: config.openai.reasoningEffort,
      max_completion_tokens: 2000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: schemaName,
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['topic_id'],
            properties: {
              topic_id: constrain ? { type: 'string', enum: ids } : { type: 'string' },
            },
          },
        },
      },
      messages: [{ role: 'system', content: prompt }, { role: 'user', content: listing }, content],
    })
  );
  let chosen;
  try {
    chosen = JSON.parse(response.choices?.[0]?.message?.content ?? '').topic_id;
  } catch {
    chosen = null;
  }
  const match = ids.find((id) => id.toLowerCase() === String(chosen).trim().toLowerCase());
  if (!match) {
    throw new AIError('content', `${operation}: unknown id "${chosen}"`, { operation });
  }
  return match;
};

/** Topics of the lab from the database, grouped by area. */
const catalogOf = async (department) => {
  const topics = await Topic.find(
    { departmentName: department, source: 'openalex', retired: { $ne: true } },
    'openalexID name subfield keywords'
  ).lean();
  const areas = new Map();
  for (const topic of topics) {
    const areaId = String(topic.subfield?.id ?? 0);
    if (!areas.has(areaId))
      areas.set(areaId, { id: areaId, name: topic.subfield?.name || 'Other', topics: [] });
    areas.get(areaId).topics.push(topic);
  }
  return [...areas.values()];
};

const chooseFromCatalog = async (areas, { title, description, department }) => {
  const content = contentMessage({ title, description });
  let area = areas[0];
  if (areas.length > 1) {
    const areaId = await askForId({
      operation: 'chooseArea',
      schemaName: 'area_choice',
      prompt: AREA_PROMPT,
      listing: `Areas of the field ${department}:\n${areas.map((a) => `${a.id}: ${a.name}`).join('\n')}`,
      content,
      ids: areas.map((a) => a.id),
    });
    area = areas.find((a) => a.id === areaId);
  }
  let topic = area.topics[0];
  if (area.topics.length > 1) {
    const lines = area.topics.map((t) => {
      const keywords = (t.keywords || [])
        .slice(0, 3)
        .map((k) => k.name)
        .join(', ');
      return `${t.openalexID}: ${t.name}${keywords ? ` (${keywords})` : ''}`;
    });
    const topicId = await askForId({
      operation: 'chooseTopic',
      schemaName: 'topic_choice',
      prompt: TOPIC_PROMPT,
      listing: `Topics of the area ${area.name} (field ${department}):\n${lines.join('\n')}`,
      content,
      ids: area.topics.map((t) => t.openalexID),
    });
    topic = area.topics.find((t) => t.openalexID === topicId);
  }
  return { name: topic.name, openalexID: topic.openalexID };
};

// ---------------------------------------------------------------- live path (no catalog yet)

const fetchAllOpenAlexTopics = async (fieldId) => {
  const cached = topicsCache.get(fieldId);
  if (cached && Date.now() - cached.at < TOPICS_CACHE_MS) return cached.topics;

  const perPage = 200;
  let topics = [];
  try {
    for (let page = 1; page <= OPENALEX_MAX_PAGES; page++) {
      const data = await openalex.get('/topics', {
        filter: `field.id:${fieldId}`,
        per_page: perPage,
        select: 'id,display_name',
        page,
      });
      const results = data?.results || [];
      topics = topics.concat(results);
      if (results.length < perPage) break;
    }
  } catch (error) {
    // OpenAlex being down must not count against the item: retry like an OpenAI outage.
    const kind = classifyError(error) === 'content' ? 'content' : 'transient';
    throw new AIError(kind, `OpenAlex topics request failed: ${error.message}`, {
      operation: 'fetchOpenAlexTopics',
      cause: error,
    });
  }
  if (!topics.length) {
    throw new AIError('transient', `OpenAlex returned no topics for field ${fieldId}.`, {
      operation: 'fetchOpenAlexTopics',
    });
  }
  const list = topics.map((topic) => ({
    id: openalex.shortId(topic.id),
    name: topic.display_name,
  }));
  topicsCache.set(fieldId, { at: Date.now(), topics: list });
  return list;
};

const chooseFromLive = async ({ title, description, department }, fieldId) => {
  const topics = await fetchAllOpenAlexTopics(fieldId);
  const id = await askForId({
    operation: 'chooseTopic',
    schemaName: 'topic_choice',
    prompt: LIVE_PROMPT,
    listing: `Topics of the field ${department}:\n${topics.map((t) => `${t.id}: ${t.name}`).join('\n')}`,
    content: contentMessage({ title, description }),
    ids: topics.map((t) => t.id),
    // Hundreds of ids: the answer is checked here rather than constrained in the schema.
    constrain: false,
  });
  const topic = topics.find((t) => t.id === id);
  return { name: topic.name, openalexID: topic.id };
};

/**
 * @param {{ title: string, description: string, department: string }} content
 * @returns {Promise<{ name: string, openalexID: string }>}
 * @throws {AIError}
 */
const chooseTopic = async ({ title, description, department }) => {
  const fieldId = getFieldId(department);
  if (!fieldId) {
    throw new AIError('content', `No OpenAlex field for department "${department}".`, {
      operation: 'chooseTopic',
    });
  }
  if (config.isTest) return { name: 'Mock Topic', openalexID: 'T0' };

  const areas = await catalogOf(department);
  if (areas.length) return chooseFromCatalog(areas, { title, description, department });
  return chooseFromLive({ title, description, department }, fieldId);
};

module.exports = { chooseTopic, fetchAllOpenAlexTopics, getFieldId, topicsCache };
