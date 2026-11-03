// Background processing for new articles created without a topic: assigns department and topic.
const { createQueue } = require('./create_queue');
const Article = require('../models/article_model');
const { generateTopicForArticle } = require('../services/generate_topic');
const { PENDING_TOPIC } = require('../services/topics');

// Queue name is persisted in Redis: do not rename.
const articleQueue = createQueue('articleQueue');

/** @param {{ data: { articleId: string, generateTopic: boolean } }} job */
const processArticleJob = async (job) => {
  const { articleId, generateTopic } = job.data;
  const article = await Article.findById(articleId);
  if (!article) {
    console.warn(`Article ${articleId} no longer exists, skipping job.`);
    return;
  }
  // Skip if the author set a topic before the job ran.
  if (generateTopic && article.topic === PENDING_TOPIC) {
    await generateTopicForArticle(article);
  }
};

const startArticleWorker = () => articleQueue.process(processArticleJob);

module.exports = { articleQueue, processArticleJob, startArticleWorker };
