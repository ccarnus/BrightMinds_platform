const Cast = require('../models/cast_model');
const { getVideoDurationInMinutes } = require('../services/video');
const { createCastThumbnail } = require('../services/thumbnail');
const { MEDIA_DIRS, deleteMediaByUrl, mediaPathFromUrl, mediaUrl } = require('../services/media');
const {
  PENDING_TOPIC,
  createTopicIfNotExist,
  removeExistingTopic,
  moveContentTopic,
  isAssignedTopic,
} = require('../services/topics');
const {
  assertValidTitle,
  resolveDepartment,
  applyRating,
  removeContentReferences,
  addPublicationToAuthor,
} = require('../services/content');
const { castQueue } = require('../queues/cast_queue');
const { enqueue } = require('../queues/create_queue');
const {
  HttpError,
  assertObjectId,
  badRequest,
  notFound,
  parseJsonField,
  pick,
  isNonEmptyString,
} = require('../utils/http');

const CREATE_FIELDS = ['title', 'brightmindid', 'category', 'university', 'visibility', 'link'];
// The image is always a frame of the video (see services/thumbnail.js): never set directly.
const UPDATE_FIELDS = [...CREATE_FIELDS, 'description'];

const findCastOr404 = async (id) => {
  assertObjectId(id);
  const cast = await Cast.findById(id);
  if (!cast) throw notFound('Cast not found.');
  return cast;
};

const readDuration = async (file) => {
  try {
    return await getVideoDurationInMinutes(file.path);
  } catch (error) {
    console.error('ffprobe failed:', error.message);
    throw badRequest('Could not read the uploaded video.');
  }
};

/** `thumbnailTime`: the moment of the video (seconds) shown as the cast's image. */
const parseThumbnailTime = (value) => {
  if (value === undefined || value === null || value === '') return undefined;
  const time =
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
      ? Number(value)
      : NaN;
  if (!Number.isFinite(time) || time < 0) {
    throw badRequest('thumbnailTime must be a number of seconds (0 or more).');
  }
  return time;
};

/**
 * Thumbnail URL for the video (frame at `time`, or picked automatically), or undefined if no frame
 * could be read: a cast without an image still works (the app shows a placeholder).
 */
const makeThumbnail = async (videoPath, durationMinutes, time) => {
  try {
    const filename = await createCastThumbnail(videoPath, {
      duration: (durationMinutes || 0) * 60,
      time,
    });
    return mediaUrl(MEDIA_DIRS.castImages, filename);
  } catch (error) {
    console.error(`Thumbnail extraction failed for ${videoPath}: ${error.message}`);
    return undefined;
  }
};

/**
 * Multipart: `video` file + `cast` JSON field. The image is a frame of the video: at
 * `cast.thumbnailTime` (seconds) when given, picked automatically otherwise. Transcription etc. runs
 * in the cast queue.
 */
exports.createCast = async (req, res) => {
  if (!req.file) throw badRequest('A video file is required (field "video").');
  const data = parseJsonField(req.body, 'cast');
  assertValidTitle(data.title);
  const department = resolveDepartment(data.department);
  const topicProvided = isNonEmptyString(data.topic);
  const thumbnailTime = parseThumbnailTime(data.thumbnailTime);

  if (isNonEmptyString(data.title) && (await Cast.exists({ title: data.title.trim() }))) {
    throw new HttpError(409, 'A cast with this title already exists.');
  }

  const cast = new Cast({
    ...pick(data, CREATE_FIELDS),
    description: '',
    department,
    topic: topicProvided ? data.topic.trim() : PENDING_TOPIC,
    casturl: mediaUrl(MEDIA_DIRS.castVideos, req.file.filename),
    duration: await readDuration(req.file),
  });
  if (data.dateadded) {
    cast.dateadded = new Date(data.dateadded);
  }
  await cast.save();
  // The cast now references the video: the error handler must not delete it if a later step fails.
  const videoPath = req.file.path;
  req.file = undefined;

  const thumbnailUrl = await makeThumbnail(videoPath, cast.duration, thumbnailTime);
  if (thumbnailUrl) {
    cast.castimageurl = thumbnailUrl;
    await Cast.updateOne({ _id: cast._id }, { castimageurl: thumbnailUrl });
  }

  if (topicProvided && isAssignedTopic({ name: cast.topic, departmentName: department })) {
    await createTopicIfNotExist({
      name: cast.topic,
      departmentName: department,
      contentId: cast._id,
      contentType: 'cast',
    });
  }
  await addPublicationToAuthor(cast.brightmindid, 'castPublications', cast._id);
  enqueue(castQueue, { castId: cast._id.toString() });

  res.status(201).json({
    response: 'Cast created successfully. Background processing initiated.',
    id: cast._id,
    castimageurl: cast.castimageurl || null,
  });
};

exports.getAllCast = async (req, res) => {
  res.status(200).json(await Cast.find().sort({ _id: 1 }));
};

exports.getOneCast = async (req, res) => {
  res.status(200).json(await findCastOr404(req.params.id));
};

/**
 * Multipart: optional `video` file + `cast` JSON field with the fields to change. A new video gets a
 * new thumbnail (at `thumbnailTime` if given, automatic otherwise); `thumbnailTime` alone re-picks
 * the thumbnail from the current video.
 */
exports.updateOneCast = async (req, res) => {
  const cast = await findCastOr404(req.params.id);
  const data = parseJsonField(req.body, 'cast');
  assertValidTitle(data.title);
  const thumbnailTime = parseThumbnailTime(data.thumbnailTime);

  const department =
    data.department === undefined ? cast.department : resolveDepartment(data.department);
  const topic = isNonEmptyString(data.topic) ? data.topic.trim() : cast.topic;
  const previousTopic = { name: cast.topic, departmentName: cast.department };
  const previousVideoUrl = cast.casturl;
  const previousImageUrl = cast.castimageurl;
  if (req.file) {
    cast.duration = await readDuration(req.file);
    cast.casturl = mediaUrl(MEDIA_DIRS.castVideos, req.file.filename);
  }
  Object.assign(cast, pick(data, UPDATE_FIELDS), { department, topic });
  if (data.dateadded) cast.dateadded = new Date(data.dateadded);
  // Validate before touching topics so a rejected update leaves them consistent.
  await cast.validate();

  let thumbnailUrl;
  if (req.file || thumbnailTime !== undefined) {
    const videoPath = req.file
      ? req.file.path
      : mediaPathFromUrl(cast.casturl, MEDIA_DIRS.castVideos);
    thumbnailUrl = await makeThumbnail(videoPath, cast.duration, thumbnailTime);
    // Asked explicitly: a failure must be reported (a new video just keeps no image).
    if (!thumbnailUrl && !req.file) {
      throw new HttpError(422, 'Could not read a frame of the video at this time.');
    }
    if (thumbnailUrl) cast.castimageurl = thumbnailUrl;
  }

  await moveContentTopic({
    from: previousTopic,
    to: { name: topic, departmentName: department },
    contentId: cast._id,
    contentType: 'cast',
  });
  try {
    await cast.save();
  } catch (error) {
    if (thumbnailUrl) await deleteMediaByUrl(thumbnailUrl, MEDIA_DIRS.castImages);
    throw error;
  }

  if (req.file) {
    await deleteMediaByUrl(previousVideoUrl, MEDIA_DIRS.castVideos);
  }
  if (thumbnailUrl) {
    await deleteMediaByUrl(previousImageUrl, MEDIA_DIRS.castImages);
  }
  res.status(200).json({ message: 'Cast updated successfully and topic adjusted.' });
};

exports.deleteOneCast = async (req, res) => {
  const cast = await findCastOr404(req.params.id);

  const filesDeleted = await Promise.all([
    deleteMediaByUrl(cast.casturl, MEDIA_DIRS.castVideos),
    deleteMediaByUrl(cast.castimageurl, MEDIA_DIRS.castImages),
    deleteMediaByUrl(cast.subtitleurl, MEDIA_DIRS.castSubtitles),
  ]);
  await Cast.deleteOne({ _id: cast._id });
  await removeContentReferences(cast._id);
  const topicResult = await removeExistingTopic({
    name: cast.topic,
    departmentName: cast.department,
    contentId: cast._id,
    contentType: 'cast',
  });

  let message = 'Cast deleted successfully.';
  if (filesDeleted.includes(false)) message += ' However, there was an error removing media files.';
  message += ` ${topicResult.message}`;
  res.status(200).json({ message });
};

exports.getAllCastByCategory = async (req, res) => {
  res.status(200).json(await Cast.find({ category: req.params.id }).sort({ _id: 1 }));
};

exports.getAllCastByBrightmindid = async (req, res) => {
  res.status(200).json(await Cast.find({ brightmindid: req.params.id }).sort({ _id: 1 }));
};

/** Optional `?topic=` query narrows the department to one topic. */
exports.getAllCastByDepartment = async (req, res) => {
  const filter = { department: req.params.id };
  if (typeof req.query.topic === 'string' && req.query.topic) {
    filter.topic = req.query.topic;
  }
  res.status(200).json(await Cast.find(filter).sort({ _id: 1 }));
};

exports.getEvaluationForCast = async (req, res) => {
  const cast = await findCastOr404(req.params.id);
  res.status(200).json({ evaluation: cast.evaluation || '' });
};

exports.getCastRating = async (req, res) => {
  const cast = await findCastOr404(req.params.id);
  res.status(200).json({ rating: cast.rating });
};

exports.updateCastRating = async (req, res) => {
  assertObjectId(req.params.id);
  const cast = await applyRating(Cast, req.params.id, req.body.action);
  if (!cast) throw notFound('Cast not found.');
  res.status(200).json({ message: 'Rating updated.', rating: cast.rating });
};

/** All casts, newest first. */
exports.getCastTrending = async (req, res) => {
  res.status(200).json(await Cast.find().sort({ dateadded: -1 }));
};

exports.getPopularDepartment = async (req, res) => {
  const departments = await Cast.aggregate([
    { $group: { _id: '$department', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  res.status(200).json(departments);
};

exports.getSimplifiedCast = async (req, res) => {
  const casts = await Cast.find({}, '_id title').sort({ _id: 1 });
  res.status(200).json({ count: casts.length, casts });
};
