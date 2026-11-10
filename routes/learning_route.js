const express = require('express');
const learningController = require('../controllers/learning_controller');

const router = express.Router();

// Public catalog of the learning paths and their milestones.
router.get('/paths', learningController.getLearningPaths);

module.exports = router;
