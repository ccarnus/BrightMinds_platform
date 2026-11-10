const Article = require('../models/article_model');
const computeDuration = require('../services/compute_duration');
const { MEDIA_DIRS, deleteMediaByUrl, mediaUrl } = require('../services/media');
const { saveUploadedImage } = require('../services/uploaded_image');
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
const { articleQueue } = require('../queues/article_queue');
const { enqueue } = require('../queues/create_queue');
const {
  assertObjectId,
  badRequest,
  notFound,
  parseJsonField,
  pick,
  isNonEmptyString,
} = require('../utils/http');

const EDITABLE_FIELDS = [
  'title',
  'description',
  'brightmindid',
  'university',
  'category',
  'visibility',
  'link',
];
// Updates may also replace the generated question (the previous API accepted any field). The cover
// image only changes through an uploaded file.
const UPDATE_FIELDS = [...EDITABLE_FIELDS, 'evaluation'];

const findArticleOr404 = async (id) => {
  assertObjectId(id);
  const article = await Article.findById(id);
  if (!article) throw notFound('Article not found.');
  return article;
};

/** Article fields: a multipart `article` JSON field, or plain JSON / form fields. */
const readArticleData = (body) =>
  body?.article !== undefined ? parseJsonField(body, 'article') : body || {};

/** Stores the uploaded cover image (re-encoded, original upload deleted) and returns its URL. */
const storeCoverImage = async (req) => {
  const filename = await saveUploadedImage(req.file.path, {
    dir: MEDIA_DIRS.articleImages,
    prefix: 'article',
  });
  req.file = undefined;
  return mediaUrl(MEDIA_DIRS.articleImages, filename);
};

/**
 * Multipart: `image` file (the cover, required) + `article` JSON field. The question, department
 * (if not given) and topic (if not given) are generated in the background.
 */
exports.createArticle = async (req, res) => {
  if (!req.file) throw badRequest('A cover image is required (multipart field "image").');
  const data = readArticleData(req.body);
  assertValidTitle(data.title);
  const department = resolveDepartment(data.department);
  const topicProvided = isNonEmptyString(data.topic);

  const article = new Article({
    ...pick(data, EDITABLE_FIELDS),
    department,
    topic: topicProvided ? data.topic.trim() : PENDING_TOPIC,
    duration: typeof data.duration === 'number' ? data.duration : computeDuration(data.description),
  });
  if (data.dateadded) {
    article.dateadded = new Date(data.dateadded);
  }
  // Invalid articles are rejected before spending time on the image.
  await article.validate();
  article.articleimageurl = await storeCoverImage(req);
  try {
    await article.save();
  } catch (error) {
    await deleteMediaByUrl(article.articleimageurl, MEDIA_DIRS.articleImages);
    throw error;
  }

  if (topicProvided && isAssignedTopic({ name: article.topic, departmentName: department })) {
    await createTopicIfNotExist({
      name: article.topic,
      departmentName: department,
      contentId: article._id,
      contentType: 'article',
    });
  }
  await addPublicationToAuthor(article.brightmindid, 'articlePublications', article._id);
  enqueue(articleQueue, { articleId: article._id.toString() });

  res.status(201).json({
    response: 'Article created and topic updated (or pending generation).',
    id: article._id,
    articleimageurl: article.articleimageurl,
  });
};

exports.getAllArticle = async (req, res) => {
  res.status(200).json(await Article.find().sort({ _id: 1 }));
};

exports.getOneArticle = async (req, res) => {
  res.status(200).json(await findArticleOr404(req.params.id));
};

/** JSON, or multipart with an optional new cover `image` + `article` JSON field. */
exports.updateOneArticle = async (req, res) => {
  const article = await findArticleOr404(req.params.id);
  const data = readArticleData(req.body);
  assertValidTitle(data.title);

  const department =
    data.department === undefined ? article.department : resolveDepartment(data.department);
  const topic = isNonEmptyString(data.topic) ? data.topic.trim() : article.topic;
  const previousTopic = { name: article.topic, departmentName: article.department };
  const previousImageUrl = article.articleimageurl;

  Object.assign(article, pick(data, UPDATE_FIELDS), { department, topic });
  if (typeof data.duration === 'number') article.duration = data.duration;
  if (data.dateadded) article.dateadded = new Date(data.dateadded);
  // Validate before touching topics so a rejected update leaves them consistent.
  await article.validate();
  const newImageUrl = req.file ? await storeCoverImage(req) : undefined;
  if (newImageUrl) article.articleimageurl = newImageUrl;

  await moveContentTopic({
    from: previousTopic,
    to: { name: topic, departmentName: department },
    contentId: article._id,
    contentType: 'article',
  });
  try {
    await article.save();
  } catch (error) {
    if (newImageUrl) await deleteMediaByUrl(newImageUrl, MEDIA_DIRS.articleImages);
    throw error;
  }
  if (newImageUrl) await deleteMediaByUrl(previousImageUrl, MEDIA_DIRS.articleImages);

  res.status(201).json({ response: 'Article updated and topic adjusted.' });
};

exports.deleteOneArticle = async (req, res) => {
  const article = await findArticleOr404(req.params.id);

  const imageDeleted = await deleteMediaByUrl(article.articleimageurl, MEDIA_DIRS.articleImages);
  await Article.deleteOne({ _id: article._id });
  await removeContentReferences(article._id);
  const topicResult = await removeExistingTopic({
    name: article.topic,
    departmentName: article.department,
    contentId: article._id,
    contentType: 'article',
  });

  let message = 'Article deleted successfully.';
  if (!imageDeleted)
    message += ' However, there was an error deleting the associated article image.';
  message += ` ${topicResult.message}`;
  res.status(200).json({ response: message });
};

exports.getAllArticleByCategory = async (req, res) => {
  res.status(200).json(await Article.find({ category: req.params.id }).sort({ _id: 1 }));
};

exports.getAllArticleByDepartment = async (req, res) => {
  res.status(200).json(await Article.find({ department: req.params.id }).sort({ _id: 1 }));
};

exports.getAllArticleByBrightmindid = async (req, res) => {
  res.status(200).json(await Article.find({ brightmindid: req.params.id }).sort({ _id: 1 }));
};

exports.getEvaluationForArticle = async (req, res) => {
  const article = await findArticleOr404(req.params.id);
  res.status(200).json({ evaluation: article.evaluation || '' });
};

exports.getArticleRating = async (req, res) => {
  const article = await findArticleOr404(req.params.id);
  res.status(200).json({ rating: article.rating });
};

exports.updateArticleRating = async (req, res) => {
  assertObjectId(req.params.id);
  const article = await applyRating(Article, req.params.id, req.body.action);
  if (!article) throw notFound('Article not found.');
  res.status(200).json({ message: 'Rating updated.', rating: article.rating });
};

/** Articles from the last 14 days, best rated first. */
exports.getArticleTrending = async (req, res) => {
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const articles = await Article.find({ dateadded: { $gte: twoWeeksAgo } }).sort({
    'rating.value': -1,
  });
  res.status(200).json(articles);
};
