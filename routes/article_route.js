const express = require('express');
const articleController = require('../controllers/article_controller');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/', authenticate, articleController.createArticle);
router.get('/', articleController.getAllArticle);
router.get('/trending/right/now', articleController.getArticleTrending);
router.get('/category/:id', articleController.getAllArticleByCategory);
router.get('/department/:id', articleController.getAllArticleByDepartment);
router.get('/brightmindid/:id', articleController.getAllArticleByBrightmindid);
router.get('/evaluation/:id', articleController.getEvaluationForArticle);
router.get('/:id', articleController.getOneArticle);
router.put('/:id', authenticate, articleController.updateOneArticle);
router.delete('/:id', authenticate, articleController.deleteOneArticle);
router.get('/:id/rating', articleController.getArticleRating);
router.post('/:id/rating', authenticate, articleController.updateArticleRating);

module.exports = router;
