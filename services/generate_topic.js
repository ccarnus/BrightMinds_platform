// Picks the OpenAlex topic (within the content's department) that best matches a cast/article.
const axios = require('axios');
const config = require('../config');
const { departmentIdByName } = require('../lists/departments');
const { AIError, callOpenAI, classifyError } = require('./openai');

const OPENALEX_MAX_PAGES = 25;
const TOPICS_CACHE_MS = 24 * 60 * 60 * 1000;
const topicsCache = new Map(); // fieldId -> { at, topics }

const SYSTEM_PROMPT =
  'You classify research content into the OpenAlex topic taxonomy. You receive the list of ' +
  'topics of one academic field ("<id>: <name>" per line), then a piece of content. Choose the ' +
  'single topic that best describes what the research is about (its subject, not its method ' +
  'or context) and answer with its id exactly as listed.';

const getFieldId = (departmentName) => departmentIdByName[departmentName] || null;

const fetchAllOpenAlexTopics = async (fieldId) => {
  const cached = topicsCache.get(fieldId);
  if (cached && Date.now() - cached.at < TOPICS_CACHE_MS) return cached.topics;

  const perPage = 200;
  let topics = [];
  try {
    for (let page = 1; page <= OPENALEX_MAX_PAGES; page++) {
      const response = await axios.get('https://api.openalex.org/topics', {
        params: {
          filter: `field.id:${fieldId}`,
          per_page: perPage,
          select: 'id,display_name',
          page,
        },
        timeout: 30000,
      });
      const results = response.data?.results || [];
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
    id: topic.id.replace('https://openalex.org/', ''),
    name: topic.display_name,
  }));
  topicsCache.set(fieldId, { at: Date.now(), topics: list });
  return list;
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
  const topics = await fetchAllOpenAlexTopics(fieldId);

  // The topic list is identical for every item of a department and comes first, so OpenAI's
  // prompt caching bills it at the cached rate after the first call.
  const response = await callOpenAI('chooseTopic', (client) =>
    client.chat.completions.create({
      model: config.openai.chatModel,
      reasoning_effort: config.openai.reasoningEffort,
      max_completion_tokens: 2000,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'topic_choice',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['topic_id'],
            properties: { topic_id: { type: 'string' } },
          },
        },
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Topics of the field ${department}:\n${topics.map((t) => `${t.id}: ${t.name}`).join('\n')}`,
        },
        {
          role: 'user',
          content: `Title: ${title}\n\n<content>\n${String(description || '').slice(0, 20000)}\n</content>`,
        },
      ],
    })
  );

  let topicId;
  try {
    topicId = JSON.parse(response.choices?.[0]?.message?.content ?? '').topic_id;
  } catch {
    topicId = null;
  }
  const topic = topics.find((t) => t.id.toLowerCase() === String(topicId).trim().toLowerCase());
  if (!topic) {
    throw new AIError('content', `chooseTopic: unknown topic id "${topicId}"`, {
      operation: 'chooseTopic',
    });
  }
  return { name: topic.name, openalexID: topic.id };
};

module.exports = { chooseTopic, fetchAllOpenAlexTopics, getFieldId, topicsCache };
