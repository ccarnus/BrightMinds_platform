const axios = require('axios');
const { departmentNames, departmentIdByName } = require('../lists/departments');

const isTestEnv = process.env.NODE_ENV === 'test';

let client = null;
if (!isTestEnv) {
  const openai = require('openai');
  client = new openai({
    apiKey: process.env.OPENAI_API_KEY,
  });
}
 
function getFieldId(departmentName) {
  return departmentIdByName[departmentName] || null;
}
 
async function fetchAllOpenAlexTopics(fieldId) {
  let topics = [];
  let page = 1;
  const perPage = 200;
  while (true) {
    const url = `https://api.openalex.org/topics?filter=field.id:${fieldId}&per_page=${perPage}&select=id,display_name&page=${page}`;
    const response = await axios.get(url);
    const results = response.data.results;
    if (results && results.length > 0) {
      topics = topics.concat(results);
      if (results.length < perPage) break;
      page++;
    } else {
      break;
    }
  }
  return topics;
}
 
/**
 * Uses GPT-4 to choose the best matching topic from the provided list based on the description.
 * The prompt is adapted based on the content type (cast or article).
 */
async function determineBestTopic(description, topics, contentType) {
  if (isTestEnv) {
    return topics.length ? topics[0].display_name : null;
  }

  const contentText = contentType === 'article' ? "article" : "cast";
  const topicsText = topics.map(topic => topic.display_name).join('\n');
  const prompt = `I have a ${contentText} with the following description:\n\n"${description}"\n\nHere is a list of topics from the field (one per line). Based on the description, which one of these topics best matches the ${contentText}? Respond with only the topic name exactly as it appears in the list, without any numbering or extra characters.\n\nTopics:\n${topicsText}`;
 
  const response = await client.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are an expert in categorizing research topics.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 50,
    temperature: 0.3,
  });
 
  const bestTopicNameRaw = response.choices[0].message.content.trim();
  const bestTopicName = bestTopicNameRaw.replace(/^\d+\.\s*/, '');
  return bestTopicName;
}
 
/**
 * A helper function that takes a content object (cast or article) and its type,
 * then uses GPT-4 (and the OpenAlex API) to determine the best topic,
 * updates the object’s topic field, and ensures a Topic document exists.
 */
async function generateTopicForContent(content, contentType) {
  if (isTestEnv) {
    return content.topic || null;
  }

  try {
    // If the department is pending, determine it via AI:
    if (!content.department || content.department === "Pending Department") {
      const bestDepartment = await determineDepartmentForContent(content.description);
      content.department = bestDepartment;
      await content.save();
      console.log(`Department for ${contentType} "${content.title}" updated to: ${bestDepartment}`);
    }

    // Now use the updated department to get the field id.
    const fieldId = getFieldId(content.department);
    if (!fieldId) {
      throw new Error(`No field id found for department ${content.department}`);
    }

    // ... Continue with fetching topics and generating the best topic ...
    const openAlexTopics = await fetchAllOpenAlexTopics(fieldId);
    console.log(`Fetched ${openAlexTopics.length} topics from OpenAlex.`);

    if (openAlexTopics.length === 0) {
      throw new Error('No topics returned from OpenAlex.');
    }

    const bestTopicName = await determineBestTopic(content.description, openAlexTopics, contentType);
    console.log(`For ${contentType} "${content.title}" the best matching topic is: ${bestTopicName}`);

    // Find matching topic to extract openalexID, etc.
    const matchedTopic = openAlexTopics.find(topic => topic.display_name === bestTopicName);
    let openalexID = null;
    if (matchedTopic && matchedTopic.id) {
      openalexID = matchedTopic.id.replace('https://openalex.org/', '');
      console.log(`Extracted openalexID: ${openalexID}`);
    } else {
      console.warn(`No matching OpenAlex topic found for ${bestTopicName}`);
    }

    // Update the content object with the new topic.
    content.topic = bestTopicName;
    await content.save();
    console.log(`${contentType} "${content.title}" updated with topic: ${bestTopicName}`);

    // Ensure the Topic document exists.
    const topicController = require('../controllers/topic_controller.js');
    const topicResult = await topicController.createTopicIfNotExist({
      name: bestTopicName,
      departmentName: content.department,
      openalexID,
      contentId: content._id,
      contentType: contentType
    });
    console.log(topicResult.message);

    return bestTopicName;
  } catch (error) {
    console.error(`Error generating topic for ${contentType}:`, error);
    return null;
  }
}

async function determineDepartmentForContent(description) {
  if (isTestEnv) {
    return departmentNames[0];
  }

  const prompt = `I have a cast video with the following transcript:
  
"${description}"

Based on the content, please choose the best matching department from the list below. Respond with only the department name exactly as it appears, without any numbering or extra text.

Departments:
${departmentNames.join('\n')}
`;

  const response = await client.chat.completions.create({
    model: 'gpt-4',
    messages: [
      { role: 'system', content: 'You are an expert in categorizing academic content by department.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 50,
    temperature: 0.3,
  });

  const bestDepartment = response.choices[0].message.content.trim();
  return bestDepartment;
}
 
module.exports = {
  generateTopicForCast: async (cast) => generateTopicForContent(cast, 'cast'),
  generateTopicForArticle: async (article) => generateTopicForContent(article, 'article'),
  fetchAllOpenAlexTopics,
  determineBestTopic,
  getFieldId
};
