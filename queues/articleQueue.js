const isTestEnv = process.env.NODE_ENV === 'test';

if (isTestEnv) {
  module.exports = {
    add: async () => {},
    process: () => {},
    close: async () => {},
  };
} else {
  const Queue = require('bull');
  const { generateTopicForArticle } = require('../backend/generate_topic');
  const Article = require('../models/article_model');

  // Initialize the article queue.
  const articleQueue = new Queue('articleQueue');

  // Process jobs in the article queue.
  articleQueue.process(async (job, done) => {
    const { articleId, generateTopic } = job.data;
    
    try {
      const article = await Article.findById(articleId);
      if (!article) {
        throw new Error(`Article with id ${articleId} not found.`);
      }
      if (generateTopic) {
        await generateTopicForArticle(article);
      }
      done();
    } catch (error) {
      console.error('Error processing article topic generation:', error);
      done(error);
    }
  });

  module.exports = articleQueue;
}
