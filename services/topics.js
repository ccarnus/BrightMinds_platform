// Keeps Topic documents in sync with the casts that reference them.
// A Topic is identified by (name, departmentName) and is deleted once no cast references it.
const Topic = require('../models/topic_model');
const { computeImpactForTopic } = require('./topic_indicator_computor');

// Placeholders stored on casts until the background job assigns real values.
const PENDING_DEPARTMENT = 'Pending Department';
const PENDING_TOPIC = 'Pending Topic';

const isAssignedTopic = ({ name, departmentName }) =>
  Boolean(name && departmentName) &&
  name !== PENDING_TOPIC &&
  departmentName !== PENDING_DEPARTMENT;

/**
 * Adds a cast id to the (name, departmentName) topic, creating the topic if needed.
 * @param {{name: string, departmentName: string, castId?, openalexID?: string}} params
 */
const createTopicIfNotExist = async ({ name, departmentName, openalexID, castId }) => {
  if (!name || !departmentName) {
    throw new Error('Topic name and departmentName are required.');
  }
  let topic = await Topic.findOne({ name, departmentName });

  if (!topic) {
    topic = new Topic({
      name,
      departmentName,
      openalexID,
      castIDs: castId ? [castId] : [],
      castCount: castId ? 1 : 0,
    });
    await topic.save();
    // Fire and forget: external metrics must not slow down cast creation.
    computeImpactForTopic(topic);
    return { message: 'Topic created successfully.', topic, status: 201 };
  }

  if (!topic.openalexID && openalexID) {
    topic.openalexID = openalexID;
  }
  if (castId && !topic.castIDs.some((id) => id.equals(castId))) {
    topic.castIDs.push(castId);
    topic.castCount += 1;
  }
  await topic.save();
  return { message: 'Topic updated successfully.', topic, status: 200 };
};

/** Removes a cast id from its topic and deletes the topic when it no longer has casts. */
const removeExistingTopic = async ({ name, departmentName, castId }) => {
  if (!name || !departmentName) {
    return { status: 404, message: 'Topic not found.' };
  }
  const topic = await Topic.findOne({ name, departmentName });
  if (!topic) {
    return { status: 404, message: 'Topic not found.' };
  }

  const before = topic.castIDs.length;
  topic.castIDs = topic.castIDs.filter((id) => !id.equals(castId));
  topic.castCount = Math.max(0, topic.castCount - (before - topic.castIDs.length));

  if (topic.castCount <= 0) {
    await Topic.deleteOne({ _id: topic._id });
    return { status: 200, message: 'Topic removed as no more content is associated.' };
  }
  await topic.save();
  return { status: 200, message: 'Content removed from topic successfully.', topic };
};

/** Moves a cast from its previous topic to a new one (no-op if topic and department are unchanged). */
const moveCastTopic = async ({ from, to, castId }) => {
  const changed = from.name !== to.name || from.departmentName !== to.departmentName;
  if (changed && isAssignedTopic(from)) {
    await removeExistingTopic({ ...from, castId });
  }
  if (isAssignedTopic(to)) {
    await createTopicIfNotExist({ ...to, castId });
  }
};

module.exports = {
  PENDING_DEPARTMENT,
  PENDING_TOPIC,
  isAssignedTopic,
  createTopicIfNotExist,
  removeExistingTopic,
  moveCastTopic,
};
