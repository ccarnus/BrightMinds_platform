// Keeps Topic documents in sync with the casts/articles that reference them.
// A Topic is identified by (name, departmentName) and is deleted once no content references it.
const Topic = require('../models/topic_model');
const { computeImpactForTopic } = require('./topic_indicator_computor');

// Placeholders stored on content until the background job assigns real values.
const PENDING_DEPARTMENT = 'Pending Department';
const PENDING_TOPIC = 'Pending Topic';

const isAssignedTopic = ({ name, departmentName }) =>
  Boolean(name && departmentName) &&
  name !== PENDING_TOPIC &&
  departmentName !== PENDING_DEPARTMENT;

const CONTENT_FIELDS = {
  article: { ids: 'articleIDs', count: 'articleCount' },
  cast: { ids: 'castIDs', count: 'castCount' },
};

const fieldsFor = (contentType) => CONTENT_FIELDS[contentType] || CONTENT_FIELDS.cast;

/**
 * Adds a content id to the (name, departmentName) topic, creating the topic if needed.
 * @param {{name: string, departmentName: string, contentId, contentType: 'cast'|'article', openalexID?: string}} params
 */
const createTopicIfNotExist = async ({
  name,
  departmentName,
  openalexID,
  contentId,
  contentType,
}) => {
  if (!name || !departmentName) {
    throw new Error('Topic name and departmentName are required.');
  }
  const { ids, count } = fieldsFor(contentType);
  let topic = await Topic.findOne({ name, departmentName });

  if (!topic) {
    topic = new Topic({
      name,
      departmentName,
      openalexID,
      [ids]: contentId ? [contentId] : [],
      [count]: contentId ? 1 : 0,
    });
    await topic.save();
    // Fire and forget: external metrics must not slow down content creation.
    computeImpactForTopic(topic);
    return { message: 'Topic created successfully.', topic, status: 201 };
  }

  if (!topic.openalexID && openalexID) {
    topic.openalexID = openalexID;
  }
  if (contentId && !topic[ids].some((id) => id.equals(contentId))) {
    topic[ids].push(contentId);
    topic[count] += 1;
  }
  await topic.save();
  return { message: 'Topic updated successfully.', topic, status: 200 };
};

/** Removes a content id from its topic and deletes the topic when it no longer has content. */
const removeExistingTopic = async ({ name, departmentName, contentId, contentType }) => {
  if (!name || !departmentName) {
    return { status: 404, message: 'Topic not found.' };
  }
  const topic = await Topic.findOne({ name, departmentName });
  if (!topic) {
    return { status: 404, message: 'Topic not found.' };
  }

  const { ids, count } = fieldsFor(contentType);
  const before = topic[ids].length;
  topic[ids] = topic[ids].filter((id) => !id.equals(contentId));
  topic[count] = Math.max(0, topic[count] - (before - topic[ids].length));

  if (topic.articleCount <= 0 && topic.castCount <= 0) {
    await Topic.deleteOne({ _id: topic._id });
    return { status: 200, message: 'Topic removed as no more content is associated.' };
  }
  await topic.save();
  return { status: 200, message: 'Content removed from topic successfully.', topic };
};

/** Moves content from its previous topic to a new one (no-op if topic and department are unchanged). */
const moveContentTopic = async ({ from, to, contentId, contentType }) => {
  const changed = from.name !== to.name || from.departmentName !== to.departmentName;
  if (changed && isAssignedTopic(from)) {
    await removeExistingTopic({ ...from, contentId, contentType });
  }
  if (isAssignedTopic(to)) {
    await createTopicIfNotExist({ ...to, contentId, contentType });
  }
};

module.exports = {
  PENDING_DEPARTMENT,
  PENDING_TOPIC,
  isAssignedTopic,
  createTopicIfNotExist,
  removeExistingTopic,
  moveContentTopic,
};
