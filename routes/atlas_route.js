const express = require('express');
const atlasController = require('../controllers/atlas_controller');

const router = express.Router();

router.get('/', atlasController.getAtlas);
router.get('/status', atlasController.getAtlasStatus);
router.get('/hot', atlasController.getHotTopics);
router.get('/topics', atlasController.browseTopics);
router.get('/lab/:name', atlasController.getLabAtlas);

module.exports = router;
