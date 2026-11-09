// Background AI processing of new articles (question, department, topic, image).
const { createQueue } = require('./create_queue');
const { runAIJob } = require('../services/ai_pipeline');

// Queue name is persisted in Redis: do not rename.
const articleQueue = createQueue('articleQueue');

/** @param {{ data: { articleId: string } }} job (older jobs may carry extra fields; they are ignored) */
const processArticleJob = (job) => runAIJob('article', job);

const startArticleWorker = () => articleQueue.process(processArticleJob);

module.exports = { articleQueue, processArticleJob, startArticleWorker };
