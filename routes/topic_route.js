const express = require('express');
const topicController = require('../controllers/topic_controller');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.post('/', authenticate, topicController.createTopic);
router.get('/', topicController.getAllTopics);
router.get('/department/:departmentName', topicController.getTopicsByDepartment);
router.get('/:id', topicController.getOneTopic);
router.put('/:id', authenticate, topicController.updateTopic);

module.exports = router;
