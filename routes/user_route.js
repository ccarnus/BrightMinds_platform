const express = require('express');
const router = express.Router();
const userCtrl = require('../controllers/user_controller.js');
const multer = require('../backend/multer-config_user.js');

router.post('/signup', multer, userCtrl.signup);
router.get('/confirmation/:token', userCtrl.confirmation);
router.post('/login', userCtrl.login);
router.get('/',userCtrl.getAllUser);
router.get('/:id',userCtrl.getOneUser);
router.delete('/:id', userCtrl.deleteOneUser);
router.put('/:id', multer, userCtrl.updateOneUser);
//password update
router.post('/reset-password-request', userCtrl.requestPasswordResetEmail);
router.get('/reset-password/:token', userCtrl.showResetPasswordForm);
router.post('/reset-password/:token', userCtrl.resetPassword);
//add remove content
router.post('/add/content/:id',userCtrl.updateUserAddContentToList);
router.post('/remove/content/:id',userCtrl.updateUserRemoveContentFromList);
router.post('/mark/content/as/answered/:id', userCtrl.markContentAsAnswered);
//Bookmarks
router.get('/bookmarks/:id', userCtrl.getUserBookmarks);
router.post('/add/bookmarks/:id', userCtrl.addUserBookmark);
router.delete('/remove/bookmarks/:id/:contentId', userCtrl.removeUserBookmark);
//Preferences
router.get('/:id/preferences', userCtrl.getUserPreferences);
router.post('/:id/preferences', userCtrl.updateUserPreferences);
//Tracking
router.get('/:id/suggested/for/you',userCtrl.getSuggestedForYou);
router.put('/:id/update/tracking', userCtrl.updateUserTracking);
router.get('/:id/tracking', userCtrl.getUserTracking);

module.exports = router;
