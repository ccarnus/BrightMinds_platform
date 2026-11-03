const Article = require('../models/article_model');
const generateEvaluation = require('../services/generate_question');
const { generateImage } = require('../services/generate_image');
const computeDuration = require('../services/compute_duration');
const { MEDIA_DIRS, mediaUrl, deleteMediaByUrl } = require('../services/media');
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
const { assertObjectId, notFound, pick, isNonEmptyString, HttpError } = require('../utils/http');

const EDITABLE_FIELDS = [
  'title',
  'description',
  'brightmindid',
  'university',
  'category',
  'visibility',
  'link',
];
const REQUIRED_FIELDS = [
  'title',
  'description',
  'brightmindid',
  'university',
  'category',
  'visibility',
];
// Updates may also replace the generated parts (the previous API accepted any field).
const UPDATE_FIELDS = [...EDITABLE_FIELDS, 'evaluation', 'articleimageurl'];

const findArticleOr404 = async (id) => {
  assertObjectId(id);
  const article = await Article.findById(id);
  if (!article) throw notFound('Article not found.');
  return article;
};

exports.createArticle = async (req, res) => {
  const body = req.body;
  assertValidTitle(body.title);
  const department = resolveDepartment(body.department);
  const topicProvided = isNonEmptyString(body.topic);

  const article = new Article({
    ...pick(body, EDITABLE_FIELDS),
    department,
    topic: topicProvided ? body.topic.trim() : PENDING_TOPIC,
    duration: typeof body.duration === 'number' ? body.duration : computeDuration(body.description),
  });
  if (body.dateadded) {
    article.dateadded = new Date(body.dateadded);
  }
  // Fail fast before spending OpenAI credits on an invalid payload.
  await article.validate(REQUIRED_FIELDS);

  const [evaluation, imageFilename] = await Promise.all([
    generateEvaluation(body.description),
    generateImage(body.description, { dir: MEDIA_DIRS.articleImages, prefix: 'article' }),
  ]);
  if (!evaluation) throw new HttpError(502, 'Failed to generate evaluation');
  if (!imageFilename) throw new HttpError(502, 'Failed to generate article image');
  article.evaluation = evaluation;
  article.articleimageurl = mediaUrl(MEDIA_DIRS.articleImages, imageFilename);

  await article.save();

  if (topicProvided && isAssignedTopic({ name: article.topic, departmentName: department })) {
    await createTopicIfNotExist({
      name: article.topic,
      departmentName: department,
      contentId: article._id,
      contentType: 'article',
    });
  }
  await addPublicationToAuthor(article.brightmindid, 'articlePublications', article._id);
  if (!topicProvided) {
    enqueue(articleQueue, { articleId: article._id.toString(), generateTopic: true });
  }

  res.status(201).json({
    response: 'Article created and topic updated (or pending generation).',
    id: article._id,
  });
};

exports.getAllArticle = async (req, res) => {
  res.status(200).json(await Article.find().sort({ _id: 1 }));
};

exports.getOneArticle = async (req, res) => {
  res.status(200).json(await findArticleOr404(req.params.id));
};

exports.updateOneArticle = async (req, res) => {
  const article = await findArticleOr404(req.params.id);
  const body = req.body;
  assertValidTitle(body.title);

  const department =
    body.department === undefined ? article.department : resolveDepartment(body.department);
  const topic = isNonEmptyString(body.topic) ? body.topic.trim() : article.topic;
  const previousTopic = { name: article.topic, departmentName: article.department };

  Object.assign(article, pick(body, UPDATE_FIELDS), { department, topic });
  if (typeof body.duration === 'number') article.duration = body.duration;
  if (body.dateadded) article.dateadded = new Date(body.dateadded);
  // Validate before touching topics so a rejected update leaves them consistent.
  await article.validate();

  await moveContentTopic({
    from: previousTopic,
    to: { name: topic, departmentName: department },
    contentId: article._id,
    contentType: 'article',
  });
  await article.save();

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
