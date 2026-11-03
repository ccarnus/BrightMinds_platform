const express = require('express');
const universityController = require('../controllers/university_controller');
const { authenticate } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

router.post('/', authenticate, upload.universityIcon, universityController.createUniversity);
router.get('/', universityController.getAllUniversity);
router.get('/by/name/:id', universityController.getOneUniversityByName);
router.get('/:id', universityController.getOneUniversity);
router.put('/:id', authenticate, upload.universityIcon, universityController.updateOneUniversity);
router.delete('/:id', authenticate, universityController.deleteOneUniversity);

module.exports = router;
