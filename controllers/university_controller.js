const University = require('../models/university_model');
const { MEDIA_DIRS, mediaUrl, deleteMediaByUrl } = require('../services/media');
const { assertObjectId, badRequest, notFound, parseJsonField, pick } = require('../utils/http');

const FIELDS = ['name', 'displayedName'];

const findUniversityOr404 = async (id) => {
  assertObjectId(id);
  const university = await University.findById(id);
  if (!university) throw notFound('University not found.');
  return university;
};

/** Multipart: `icon` file + `university` JSON field ({ name, displayedName }). */
exports.createUniversity = async (req, res) => {
  if (!req.file) throw badRequest('An icon file is required (field "icon").');
  const data = parseJsonField(req.body, 'university');
  await University.create({
    ...pick(data, FIELDS),
    iconurl: mediaUrl(MEDIA_DIRS.universityIcons, req.file.filename),
  });
  res.status(201).json({ response: 'University Created.' });
};

exports.getAllUniversity = async (req, res) => {
  res.status(200).json(await University.find());
};

exports.getOneUniversity = async (req, res) => {
  res.status(200).json(await findUniversityOr404(req.params.id));
};

exports.getOneUniversityByName = async (req, res) => {
  const university = await University.findOne({ name: req.params.id });
  if (!university) throw notFound('University not found.');
  res.status(200).json(university);
};

/** Accepts multipart (`icon` + `university` JSON) or a flat JSON body. */
exports.updateOneUniversity = async (req, res) => {
  const university = await findUniversityOr404(req.params.id);
  const data =
    req.body.university !== undefined ? parseJsonField(req.body, 'university') : req.body;

  const previousIconUrl = university.iconurl;
  Object.assign(university, pick(data, FIELDS));
  if (req.file) {
    university.iconurl = mediaUrl(MEDIA_DIRS.universityIcons, req.file.filename);
  } else if (typeof data.iconurl === 'string') {
    university.iconurl = data.iconurl;
  }
  await university.save();

  if (req.file) {
    await deleteMediaByUrl(previousIconUrl, MEDIA_DIRS.universityIcons);
  }
  res.status(201).json({ response: 'university updated' });
};

exports.deleteOneUniversity = async (req, res) => {
  const university = await findUniversityOr404(req.params.id);
  await deleteMediaByUrl(university.iconurl, MEDIA_DIRS.universityIcons);
  await University.deleteOne({ _id: university._id });
  res.status(200).json({ response: 'University Deleted' });
};
