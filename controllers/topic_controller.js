const Topic = require('../models/topic_model');
const { departmentNames } = require('../lists/departments');
const { createTopicIfNotExist } = require('../services/topics');
const { ensureSeries, buildProgress } = require('../services/topic_metrics');
const { assertObjectId, badRequest, notFound, pick, isNonEmptyString } = require('../utils/http');

const UPDATABLE_FIELDS = ['name', 'departmentName', 'openalexID'];
// Light enough for lists; the full document comes with GET /topic/:id.
const LIST_EXCLUDED = '-keywords -series -signals -description';
const LISTED_ORDER = { 'score.hot': -1, castCount: -1, name: 1 };

exports.createTopic = async (req, res) => {
  const { name, departmentName, openalexID } = req.body;
  if (!isNonEmptyString(name)) {
    throw badRequest('name is required.');
  }
  if (!departmentNames.includes(departmentName)) {
    throw badRequest('Invalid department.');
  }
  const result = await createTopicIfNotExist({ name: name.trim(), departmentName, openalexID });
  res.status(result.status).json({ message: result.message, topic: result.topic });
};

/** The topics of a lab shown in the app: those with casts, the hottest ones and the author-made ones. */
exports.getTopicsByDepartment = async (req, res) => {
  const topics = await Topic.find({
    departmentName: req.params.departmentName,
    ...Topic.listedFilter(),
  })
    .select(LIST_EXCLUDED)
    .sort(LISTED_ORDER);
  res.status(200).json(topics);
};

exports.getAllTopics = async (req, res) => {
  const topics = await Topic.find(Topic.listedFilter()).select(LIST_EXCLUDED).sort(LISTED_ORDER);
  res.status(200).json(topics);
};

exports.getOneTopic = async (req, res) => {
  assertObjectId(req.params.id);
  const topic = await Topic.findById(req.params.id);
  if (!topic) throw notFound('Topic not found.');
  res.status(200).json(topic);
};

/**
 * How a topic is doing: its trend and phase, its growth against its area, and its output year by
 * year (fetched on first use, then weekly). If OpenAlex cannot be reached the last known series is returned.
 */
exports.getTopicProgress = async (req, res) => {
  assertObjectId(req.params.id);
  const topic = await Topic.findById(req.params.id);
  if (!topic) throw notFound('Topic not found.');
  try {
    await ensureSeries(topic);
  } catch (error) {
    console.error(`Could not refresh the series of topic ${topic._id}:`, error.message);
  }
  res.status(200).json(buildProgress(topic));
};

exports.updateTopic = async (req, res) => {
  assertObjectId(req.params.id);
  const update = pick(req.body, UPDATABLE_FIELDS);
  if (update.departmentName && !departmentNames.includes(update.departmentName)) {
    throw badRequest('Invalid department.');
  }
  const topic = await Topic.findByIdAndUpdate(req.params.id, update, {
    new: true,
    runValidators: true,
  });
  if (!topic) throw notFound('Topic not found.');
  res.status(200).json(topic);
};
