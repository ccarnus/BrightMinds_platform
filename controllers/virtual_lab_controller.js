const VirtualLab = require('../models/virtual_lab_model');
const { MEDIA_DIRS, mediaUrl, deleteMediaByUrl } = require('../services/media');
const { assertObjectId, badRequest, notFound, parseJsonField, pick } = require('../utils/http');

const LAB_FIELDS = ['name', 'followers', 'members', 'topics', 'colorcode'];
const TOPIC_FIELDS = [
  'name',
  'gage',
  'institutes',
  'description',
  'followers',
  'members',
  'threads',
];
const INSTITUTE_FIELDS = ['instituteID', 'score'];

const findLabOr404 = async (id) => {
  assertObjectId(id);
  const lab = await VirtualLab.findById(id);
  if (!lab) throw notFound('Virtual lab not found.');
  return lab;
};

/** Multipart: `icon` file + `virtuallab` JSON field. */
exports.createVirtualLab = async (req, res) => {
  if (!req.file) throw badRequest('An icon file is required (field "icon").');
  const data = parseJsonField(req.body, 'virtuallab');
  await VirtualLab.create({
    ...pick(data, LAB_FIELDS),
    iconurl: mediaUrl(MEDIA_DIRS.virtualLabIcons, req.file.filename),
  });
  res.status(201).json({ message: 'Virtual lab created successfully.' });
};

exports.getAllVirtualLabs = async (req, res) => {
  res.status(200).json(await VirtualLab.find());
};

exports.getOneVirtualLab = async (req, res) => {
  res.status(200).json(await findLabOr404(req.params.id));
};

/** Accepts multipart (`icon` + `virtuallab` JSON) or a flat JSON body. */
exports.updateOneVirtualLab = async (req, res) => {
  const lab = await findLabOr404(req.params.id);
  const data =
    req.body.virtuallab !== undefined ? parseJsonField(req.body, 'virtuallab') : req.body;

  const previousIconUrl = lab.iconurl;
  Object.assign(lab, pick(data, LAB_FIELDS));
  if (req.file) {
    lab.iconurl = mediaUrl(MEDIA_DIRS.virtualLabIcons, req.file.filename);
  } else if (typeof data.iconurl === 'string') {
    lab.iconurl = data.iconurl;
  }
  await lab.save();

  if (req.file) {
    await deleteMediaByUrl(previousIconUrl, MEDIA_DIRS.virtualLabIcons);
  }
  res.status(200).json({ message: 'Virtual lab updated successfully.' });
};

exports.deleteOneVirtualLab = async (req, res) => {
  const lab = await findLabOr404(req.params.id);
  await deleteMediaByUrl(lab.iconurl, MEDIA_DIRS.virtualLabIcons);
  await VirtualLab.deleteOne({ _id: lab._id });
  res.status(200).json({ message: 'Virtual lab deleted successfully.' });
};

exports.addTopic = async (req, res) => {
  const lab = await findLabOr404(req.params.id);
  lab.topics.push({
    ...pick(req.body, TOPIC_FIELDS),
    gage: req.body.gage || 0,
    followers: [],
    members: [],
    threads: [],
  });
  await lab.save();
  res.status(200).json({ message: 'Topic added successfully to the virtual lab.' });
};

exports.updateTopic = async (req, res) => {
  const lab = await findLabOr404(req.params.labId);
  const topic = lab.topics.id(req.params.topicId);
  if (!topic) throw notFound('Topic not found.');
  topic.set(pick(req.body, TOPIC_FIELDS));
  await lab.save();
  res.status(200).json({ message: 'Topic updated successfully.' });
};

exports.removeTopic = async (req, res) => {
  const lab = await findLabOr404(req.params.labId);
  const topic = lab.topics.id(req.params.topicId);
  if (!topic) throw notFound('Topic not found.');
  topic.deleteOne();
  await lab.save();
  res.status(200).json({ message: 'Topic removed successfully.' });
};

exports.addInstitute = async (req, res) => {
  const lab = await findLabOr404(req.params.labId);
  lab.institute.push({ instituteID: req.body.instituteID, score: req.body.score || 0 });
  await lab.save();
  res.status(200).json({ message: 'Institute added successfully to the virtual lab.' });
};

/** `:instituteId` is the institute's `instituteID` value, not the subdocument _id. */
exports.updateInstitute = async (req, res) => {
  const lab = await findLabOr404(req.params.labId);
  const institute = lab.institute.find((item) => item.instituteID === req.params.instituteId);
  if (!institute) throw notFound('Institute not found.');
  institute.set(pick(req.body, INSTITUTE_FIELDS));
  await lab.save();
  res.status(200).json({ message: 'Institute updated successfully.' });
};

exports.removeInstitute = async (req, res) => {
  const lab = await findLabOr404(req.params.labId);
  const institute = lab.institute.find((item) => item.instituteID === req.params.instituteId);
  if (!institute) throw notFound('Institute not found.');
  institute.deleteOne();
  await lab.save();
  res.status(200).json({ message: 'Institute removed successfully.' });
};
