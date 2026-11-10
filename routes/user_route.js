const express = require('express');
const userController = require('../controllers/user_controller');
const learningController = require('../controllers/learning_controller');
const { authenticate, requireSelf } = require('../middleware/auth');
const { authRateLimit } = require('../middleware/rate_limit');
const upload = require('../middleware/upload');

const router = express.Router();
const self = [authenticate, requireSelf('id')];

// Account
router.post('/signup', authRateLimit, upload.profilePicture, userController.signup);
router.get('/confirmation/:token', userController.confirmation);
router.post('/login', authRateLimit, userController.login);
router.get('/', authenticate, userController.getAllUser);
router.get('/:id', authenticate, userController.getOneUser);
router.put('/:id', self, upload.profilePicture, userController.updateOneUser);
router.delete('/:id', self, userController.deleteOneUser);

// Password reset (HTML form flow, opened from the email link)
router.post('/reset-password-request', authRateLimit, userController.requestPasswordResetEmail);
router.get('/reset-password/:token', userController.showResetPasswordForm);
router.post('/reset-password/:token', authRateLimit, userController.resetPassword);

// Evaluation list
router.post('/add/content/:id', self, userController.updateUserAddContentToList);
router.post('/remove/content/:id', self, userController.updateUserRemoveContentFromList);
router.post('/mark/content/as/answered/:id', self, userController.markContentAsAnswered);

// Quiz & rewards
router.post('/:id/quiz', self, userController.submitQuiz);
router.get('/:id/rewards', self, userController.getUserRewards);

// Bookmarks
router.get('/bookmarks/:id', self, userController.getUserBookmarks);
router.post('/add/bookmarks/:id', self, userController.addUserBookmark);
router.delete('/remove/bookmarks/:id/:contentId', self, userController.removeUserBookmark);

// Preferences & suggestions
router.get('/:id/preferences', self, userController.getUserPreferences);
router.post('/:id/preferences', self, userController.updateUserPreferences);
router.get('/:id/suggested/for/you', self, userController.getSuggestedForYou);

// Learning path
router.get('/:id/learning', self, learningController.getUserLearning);
router.put('/:id/learning', self, learningController.updateUserLearning);
router.post('/:id/learning/papers', self, learningController.recordUserPaper);
// Legacy views of the learning path for app versions <= 1.0.5.
router.put('/:id/update/tracking', self, learningController.updateUserTracking);
router.get('/:id/tracking', self, learningController.getUserTracking);

module.exports = router;
