const express = require('express');
const castController = require('../controllers/cast_controller');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

router.post('/', authenticate, upload.castVideo, castController.createCast);
router.get('/', castController.getAllCast);
router.get('/all/simplified', castController.getSimplifiedCast);
router.get('/trending/right/now', castController.getCastTrending);
router.get('/popular/department', castController.getPopularDepartment);
router.get('/category/:id', castController.getAllCastByCategory);
router.get('/department/:id', castController.getAllCastByDepartment);
router.get('/brightmindid/:id', castController.getAllCastByBrightmindid);
router.get('/evaluation/:id', castController.getEvaluationForCast);
router.get('/:id', castController.getOneCast);
router.put('/:id', authenticate, upload.castVideo, castController.updateOneCast);
router.delete('/:id', authenticate, castController.deleteOneCast);
router.get('/:id/rating', castController.getCastRating);
router.post('/:id/rating', authenticate, castController.updateCastRating);

module.exports = router;
