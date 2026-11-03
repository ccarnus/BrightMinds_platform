const Topic = require('../models/topic_model');
const { departmentNames } = require('../lists/departments');
const { createTopicIfNotExist } = require('../services/topics');
const { assertObjectId, badRequest, notFound, pick, isNonEmptyString } = require('../utils/http');

const UPDATABLE_FIELDS = ['name', 'departmentName', 'openalexID'];

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

exports.getTopicsByDepartment = async (req, res) => {
  const topics = await Topic.find({ departmentName: req.params.departmentName });
  res.status(200).json(topics);
};

exports.getAllTopics = async (req, res) => {
  const topics = await Topic.find();
  res.status(200).json(topics);
};

exports.getOneTopic = async (req, res) => {
  assertObjectId(req.params.id);
  const topic = await Topic.findById(req.params.id);
  if (!topic) throw notFound('Topic not found.');
  res.status(200).json(topic);
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
