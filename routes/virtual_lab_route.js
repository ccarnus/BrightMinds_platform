const express = require('express');
const virtualLabController = require('../controllers/virtual_lab_controller');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

router.post('/', authenticate, upload.virtualLabIcon, virtualLabController.createVirtualLab);
router.get('/', virtualLabController.getAllVirtualLabs);
router.get('/:id', virtualLabController.getOneVirtualLab);
router.put('/:id', authenticate, upload.virtualLabIcon, virtualLabController.updateOneVirtualLab);
router.delete('/:id', authenticate, virtualLabController.deleteOneVirtualLab);

// Institutes
router.post('/:labId/add/institute', authenticate, virtualLabController.addInstitute);
router.put(
  '/:labId/update/institute/:instituteId',
  authenticate,
  virtualLabController.updateInstitute
);
router.delete(
  '/:labId/remove/institute/:instituteId',
  authenticate,
  virtualLabController.removeInstitute
);

// Topics
router.post('/:id/add/topic', authenticate, virtualLabController.addTopic);
router.put('/:labId/update/topic/:topicId', authenticate, virtualLabController.updateTopic);
router.delete('/:labId/remove/topic/:topicId', authenticate, virtualLabController.removeTopic);

module.exports = router;
