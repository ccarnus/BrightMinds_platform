// Keeps Topic documents in sync with the casts that reference them.
// A cast names its topic (a string) inside its department (lab). Topics of the catalog persist
// without casts; a topic an author typed is deleted once no cast references it.
const Topic = require('../models/topic_model');

// Placeholders stored on casts until the background job assigns real values.
const PENDING_DEPARTMENT = 'Pending Department';
const PENDING_TOPIC = 'Pending Topic';

const isAssignedTopic = ({ name, departmentName }) =>
  Boolean(name && departmentName) &&
  name !== PENDING_TOPIC &&
  departmentName !== PENDING_DEPARTMENT;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The topic a cast points at: the one with this OpenAlex id, with this exact name in the lab, or
 * a catalog topic of the lab that only differs by capital letters.
 */
const findTopic = async ({ name, departmentName, openalexID }) => {
  if (openalexID) {
    const byId = await Topic.findOne({ openalexID });
    if (byId) return byId;
  }
  const exact = await Topic.findOne({ name, departmentName });
  if (exact) return exact;
  return Topic.findOne({
    departmentName,
    source: 'openalex',
    name: new RegExp(`^${escapeRegex(name.trim())}$`, 'i'),
  });
};

/**
 * Adds a cast id to the topic, creating an author topic when the lab has no such topic.
 * @param {{name: string, departmentName: string, castId?, openalexID?: string}} params
 */
const createTopicIfNotExist = async ({ name, departmentName, openalexID, castId }) => {
  if (!name || !departmentName) {
    throw new Error('Topic name and departmentName are required.');
  }
  let topic = await findTopic({ name, departmentName, openalexID });

  if (!topic) {
    topic = new Topic({
      name,
      departmentName,
      source: 'author',
      openalexID,
      castIDs: castId ? [castId] : [],
      castCount: castId ? 1 : 0,
    });
    await topic.save();
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

/** Removes a cast id from its topic; a topic typed by an author is deleted when it has no casts left. */
const removeExistingTopic = async ({ name, departmentName, castId }) => {
  if (!name || !departmentName) {
    return { status: 404, message: 'Topic not found.' };
  }
  const topic = await findTopic({ name, departmentName });
  if (!topic) {
    return { status: 404, message: 'Topic not found.' };
  }

  const before = topic.castIDs.length;
  topic.castIDs = topic.castIDs.filter((id) => !id.equals(castId));
  topic.castCount = Math.max(0, topic.castCount - (before - topic.castIDs.length));

  if (topic.castCount <= 0 && topic.source !== 'openalex') {
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
  findTopic,
  createTopicIfNotExist,
  removeExistingTopic,
  moveCastTopic,
};
