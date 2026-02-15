const Article = require('../models/article_model.js');
const generateEvaluation = require('../backend/generate_question');
const generateArticleImage = require('../backend/generate_article_image');
const fs = require('fs');
const User = require('../models/user_model.js');
const { departmentNames } = require('../lists/departments.js');
const Topic = require('../models/topic_model.js');
const { createTopicIfNotExist, removeExistingTopic  } = require('../controllers/topic_controller.js');
const computeDuration = require('../backend/computeDuration');

const isValidDepartment = (department) => departmentNames.includes(department);

exports.createArticle = async (req, res, next) => {
    try {
        const url = "https://api.brightmindsresearch.com";
  
        // Determine if department was provided; if not, use a placeholder.
        const departmentProvided = req.body.department && req.body.department.trim().length > 0;
        let departmentValue;
        if (departmentProvided) {
            if (!isValidDepartment(req.body.department)) {
            return res.status(400).json({ error: 'Invalid department' });
            }
            departmentValue = req.body.department;
        } else {
            departmentValue = "Pending Department";
        }
  
        // Check if the title exceeds 85 characters.
        if (req.body.title && req.body.title.length > 85) {
            return res.status(400).json({ error: 'Title must be 85 characters or less' });
        }
  
        // Generate the evaluation.
        const evaluation = await generateEvaluation(req.body.description);
        if (!evaluation) {
            return res.status(400).json({ error: 'Failed to generate evaluation' });
        }
  
        // Generate the article image.
        const imagePath = await generateArticleImage(req.body.description);
        if (!imagePath) {
            return res.status(400).json({ error: 'Failed to generate article image' });
        }
        const articleImageURL = url + imagePath.replace(/^.*\/backend/, '/backend');
    
        // Compute duration if not provided.
        let durationToUse;
        if (typeof req.body.duration === 'number') {
            durationToUse = req.body.duration;
        } else {
            durationToUse = computeDuration(req.body.description);
        }
    
        // Determine if a topic was provided; if not, use a placeholder.
        const topicProvided = req.body.topic && req.body.topic.trim().length > 0;
        const topicValue = topicProvided ? req.body.topic : "Pending Topic";
    
        // Create the new Article document with the resolved department.
        const article = new Article({
            ...req.body,
            department: departmentValue,
            articleimageurl: articleImageURL,
            evaluation,
            duration: durationToUse,
            topic: topicValue
        });
    
        if (req.body.dateadded) {
            article.dateadded = new Date(req.body.dateadded);
        }
    
        await article.save();
    
        // If a topic was provided, immediately create/update the Topic document.
        if (topicProvided) {
            const topicResult = await createTopicIfNotExist({
            name: req.body.topic,
            departmentName: departmentValue,
            contentId: article._id,
            contentType: 'article',
            });
            console.log(topicResult.message);
        } else {
            console.log("No topic provided. Topic will be generated asynchronously.");
        }
    
        // Add article ID to the user's articlePublications.
        const user = await User.findById(req.body.brightmindid);
        if (user) {
            user.articlePublications.push(article._id);
            await user.save();
        }
    
        // Enqueue a job for background processing to generate the topic (and department if needed).
        if (!topicProvided) {
            const articleQueue = require('../queues/articleQueue.js');
            articleQueue.add({
            articleId: article._id,
            generateTopic: true
            });
        }
    
        res.status(201).json({ response: 'Article created and topic updated (or pending generation).' });
        } catch (error) {
        console.error('Error creating article:', error);
        res.status(500).json({ error: 'Internal server error' });
        }
  };  

exports.getAllArticle = (req, res, next) => {
    Article.find().sort({ _id: 1 }).then(
        (articles) => {
            res.status(200).json(articles);
        }
    ).catch((error) => {
        res.status(400).json({
            error: error
        });
    });
};

exports.getOneArticle = (req, res, next) => {
    Article.findOne({
        _id: req.params.id
    }).then(
        (article) => {
            res.status(200).json(article);
        }
    ).catch((error) => {
        res.status(404).json({
            error: error
        });
    });
};

exports.updateOneArticle = async (req, res, next) => {
    try {
        let article = await Article.findById(req.params.id);
        if (!article) {
            return res.status(404).json({ message: 'Article not found.' });
        }

        if (!isValidDepartment(req.body.department)) {
            return res.status(400).json({ error: 'Invalid department' });
        }

        // Handle the old topic if the topic is being changed
        if (article.topic !== req.body.topic) {
            await removeExistingTopic({
                body: {
                    name: article.topic,
                    departmentName: article.department,
                    contentId: article._id,
                    contentType: 'article',
                }
            }, res, next);
        }

        // Ensure the new topic exists or create it
        await createTopicIfNotExist({
            body: {
                name: req.body.topic,
                departmentName: req.body.department,
                contentId: article._id,
                contentType: 'article',
            }
        }, res, next);

        // Update article details
        article = Object.assign(article, req.body);

        await article.save();
        res.status(201).json({ response: 'Article updated and topic adjusted.' });
    } catch (error) {
        console.error('Error updating article:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};


const removeArticleReferences = async (articleId) => {
    try {
        const articleIdString = articleId.toString();
        const articleIdMatches = [articleId, articleIdString];

        const updateResult = await User.updateMany(
            {
                $or: [
                    { 'evaluation_list.contentid': { $in: articleIdMatches } },
                    { 'bookmarkedcontent.contentid': { $in: articleIdMatches } },
                    { articlePublications: { $in: articleIdMatches } }
                ]
            },
            {
                $pull: {
                    evaluation_list: { contentid: { $in: articleIdMatches } },
                    bookmarkedcontent: { contentid: { $in: articleIdMatches } },
                    articlePublications: { $in: articleIdMatches }
                }
            }
        );

        console.log(`Removed article ${articleIdString} references from users.`, updateResult);
    } catch (error) {
        console.error('Error removing article references from users:', error);
    }
};

exports.deleteOneArticle = async (req, res, next) => {
    try {
        const article = await Article.findById(req.params.id);
        if (!article) {
            return res.status(404).json({ message: 'Article not found.' });
        }

        let imageDeleteError = false;

        // If there's an associated image, delete it
        const imagePath = article.articleimageurl.split('/backend/media/article_images/')[1];
        if (imagePath) {
            fs.unlink(`./backend/media/article_images/${imagePath}`, async (err) => {
                if (err) {
                    console.error('Error deleting article image:', err);
                    imageDeleteError = true;
                }

                try {
                    // Proceed with article cleanup after attempting to delete the image
                    await performArticleCleanup(article, imageDeleteError, req, res);
                } catch (error) {
                    console.error('Error deleting article:', error);
                    res.status(500).json({ error: 'Error deleting article.' });
                }
            });
        } else {
            // No image path found; just proceed with final cleanup
            await performArticleCleanup(article, imageDeleteError, req, res);
        }
    } catch (error) {
        console.error('Error finding article:', error);
        res.status(500).json({ error: 'Error finding article.' });
    }
};

/**
 * This function encapsulates the final "cleanup" steps after
 * the article's image has been handled (or if there was no image).
 */
async function performArticleCleanup(article, imageDeleteError, req, res) {
    // 1) Delete the Article document
    await Article.deleteOne({ _id: article._id });

    // 2) Remove all user references (evaluation_list, bookmarks, publications)
    await removeArticleReferences(article._id);

    // 3) Remove or decrement the topic
    const topicResult = await removeExistingTopic({
        name: article.topic,
        departmentName: article.department,
        contentId: article._id,
        contentType: 'article',
    });

    // Construct a final response message
    let responseMessage = 'Article deleted successfully.';
    if (imageDeleteError) {
        responseMessage += ' However, there was an error deleting the associated article image.';
    }
    if (topicResult && topicResult.message) {
        responseMessage += ` ${topicResult.message}`;
    }

    res.status(200).json({ response: responseMessage });
}

exports.getAllArticleByCategory = (req, res, next) => {
    Article.find({ category: { $exists: true, $eq: req.params.id } }).sort({ _id: 1 }).then(
        (articles) => {
            res.status(200).json(articles);
        }
    ).catch(
        (error) => {
            res.status(400).json({
                error: error
            });
        }
    );
};

exports.getAllArticleByDepartment = (req, res, next) => {
    Article.find({ department: { $exists: true, $eq: req.params.id } }).sort({ _id: 1 }).then(
        (articles) => {
            res.status(200).json(articles);
        }
    ).catch(
        (error) => {
            res.status(400).json({
                error: error
            });
        }
    );
};

exports.getAllArticleByBrightmindid = (req, res, next) => {
    Article.find({ brightmindid: { $exists: true, $eq: req.params.id } }).sort({ _id: 1 }).then(
        (articles) => {
            res.status(200).json(articles);
        }
    ).catch(
        (error) => {
            res.status(400).json({
                error: error
            });
        }
    );
};

exports.getEvaluationForArticle = (req, res, next) => {
    const articleId = req.params.id;

    Article.findById(articleId)
        .then((article) => {
            if (!article) {
                return res.status(404).json({ message: 'Article not found.' });
            }

            const evaluation = article.evaluation || '';
            res.status(200).json({ evaluation });
        })
        .catch((error) => {
            res.status(500).json({ error: 'An error occurred.' });
        });
};

exports.getArticleRating = (req, res, next) => {
    Article.findById(req.params.id)
        .then(article => {
            if (!article) {
                return res.status(404).json({ message: 'Article not found.' });
            }
            res.status(200).json({ rating: article.rating });
        })
        .catch(error => {
            res.status(500).json({ error: 'An error occurred.' });
        });
};

exports.updateArticleRating = (req, res, next) => {
    const action = req.body.action;

    if (action !== '+' && action !== '-') {
        return res.status(400).json({ message: 'Invalid action.' });
    }

    Article.findById(req.params.id)
        .then(article => {
            if (!article) {
                return res.status(404).json({ message: 'Article not found.' });
            }

            if (action === '+') {
                article.rating.value = ((article.rating.value * article.rating.count) + 10) / (article.rating.count + 1);
            } else {
                article.rating.value = ((article.rating.value * article.rating.count)) / (article.rating.count + 1);
            }
            article.rating.count += 1;

            article.save()
                .then(() => res.status(200).json({ message: 'Rating updated.', rating: article.rating }))
                .catch(error => res.status(400).json({ error: 'Unable to update rating.' }));

        })
        .catch(error => {
            res.status(500).json({ error: 'An error occurred.' });
        });
};

exports.getArticleTrending = (req, res, next) => {
    const twoWeeksAgo = new Date();
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    Article.find({ dateadded: { $gte: twoWeeksAgo } })
        .sort({ 'rating.value': -1 })
        .then(
            (articles) => {
                res.status(200).json(articles);
            }
        )
        .catch(
            (error) => {
                res.status(400).json({
                    error: error
                });
            }
        );
};

