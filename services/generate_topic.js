// Assigns a department and an OpenAlex topic to casts/articles created without them (background jobs).
const axios = require('axios');
const config = require('../config');
const { departmentNames, departmentIdByName } = require('../lists/departments');
const { getOpenAIClient } = require('./openai');
const { createTopicIfNotExist, PENDING_DEPARTMENT } = require('./topics');
const { reportOpenAIAuthError, reportOpenAIMissingApiKey } = require('./openai_alerts');

const OPENALEX_MAX_PAGES = 25;

const getFieldId = (departmentName) => departmentIdByName[departmentName] || null;

const fetchAllOpenAlexTopics = async (fieldId) => {
  const perPage = 200;
  let topics = [];
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
  return topics;
};

const askModel = async (operation, systemPrompt, userPrompt) => {
  const client = getOpenAIClient();
  if (!client) {
    await reportOpenAIMissingApiKey({ operation });
    throw new Error('OpenAI API key not configured. Set OPENAI_API_KEY.');
  }
  try {
    const response = await client.chat.completions.create({
      model: config.openai.chatModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 50,
      temperature: 0.3,
    });
    return response.choices[0].message.content.trim().replace(/^\d+\.\s*/, '');
  } catch (error) {
    await reportOpenAIAuthError(error, { operation });
    throw error;
  }
};

/** Returns the list entry matching `answer` (case-insensitive, quotes ignored), or null. */
const matchFromList = (answer, list) => {
  const normalize = (value) =>
    String(value)
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase();
  const target = normalize(answer);
  return list.find((item) => normalize(item) === target) || null;
};

/** Uses the chat model to choose the best matching topic name from the OpenAlex list. */
const determineBestTopic = async (description, topics, contentType) => {
  if (config.isTest) {
    return topics.length ? topics[0].display_name : null;
  }
  const names = topics.map((topic) => topic.display_name);
  const prompt =
    `I have a ${contentType} with the following description:\n\n"${description}"\n\n` +
    'Here is a list of topics from the field (one per line). Based on the description, which one ' +
    `of these topics best matches the ${contentType}? Respond with only the topic name exactly as ` +
    `it appears in the list, without any numbering or extra characters.\n\nTopics:\n${names.join('\n')}`;
  const answer = await askModel(
    'determineBestTopic',
    'You are an expert in categorizing research topics.',
    prompt
  );
  return matchFromList(answer, names) || answer;
};

/** Uses the chat model to choose a department; throws if the answer is not a known department. */
const determineDepartmentForContent = async (description) => {
  if (config.isTest) {
    return departmentNames[0];
  }
  const prompt =
    `I have a piece of academic content with the following description:\n\n"${description}"\n\n` +
    'Based on the content, please choose the best matching department from the list below. ' +
    'Respond with only the department name exactly as it appears, without any numbering or extra ' +
    `text.\n\nDepartments:\n${departmentNames.join('\n')}`;
  const answer = await askModel(
    'determineDepartmentForContent',
    'You are an expert in categorizing academic content by department.',
    prompt
  );
  const department = matchFromList(answer, departmentNames);
  if (!department) {
    throw new Error(`Model returned an unknown department: "${answer}"`);
  }
  return department;
};

/**
 * Resolves the department (if pending) and topic of a cast/article document, saves it,
 * and registers it on the Topic. Returns the topic name, or null on failure.
 */
const generateTopicForContent = async (content, contentType) => {
  if (config.isTest) {
    return content.topic || null;
  }
  try {
    if (!content.department || content.department === PENDING_DEPARTMENT) {
      content.department = await determineDepartmentForContent(content.description);
      await content.save();
      console.log(`Department for ${contentType} "${content.title}" set to ${content.department}`);
    }

    const fieldId = getFieldId(content.department);
    if (!fieldId) {
      throw new Error(`No field id found for department ${content.department}`);
    }

    const openAlexTopics = await fetchAllOpenAlexTopics(fieldId);
    if (openAlexTopics.length === 0) {
      throw new Error('No topics returned from OpenAlex.');
    }

    const bestTopicName = await determineBestTopic(
      content.description,
      openAlexTopics,
      contentType
    );
    const matchedTopic = openAlexTopics.find((topic) => topic.display_name === bestTopicName);
    const openalexID = matchedTopic?.id?.replace('https://openalex.org/', '') || undefined;
    if (!openalexID) {
      console.warn(`No matching OpenAlex topic found for ${bestTopicName}`);
    }

    content.topic = bestTopicName;
    await content.save();
    await createTopicIfNotExist({
      name: bestTopicName,
      departmentName: content.department,
      openalexID,
      contentId: content._id,
      contentType,
    });
    console.log(`${contentType} "${content.title}" assigned to topic ${bestTopicName}`);
    return bestTopicName;
  } catch (error) {
    console.error(`Error generating topic for ${contentType}:`, error);
    return null;
  }
};

module.exports = {
  generateTopicForCast: (cast) => generateTopicForContent(cast, 'cast'),
  generateTopicForArticle: (article) => generateTopicForContent(article, 'article'),
  fetchAllOpenAlexTopics,
  determineBestTopic,
  getFieldId,
  matchFromList,
};
