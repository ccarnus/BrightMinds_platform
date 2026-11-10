const User = require('../models/user_model');
const learningService = require('../services/learning');
const { recordPaperOpened } = require('../services/learning_activity');
const { assertObjectId, badRequest, notFound } = require('../utils/http');

const AVAILABLE_PATHS = 'Follower, Explorer, Deep Learner or Researcher';

const findUserOr404 = async (id, projection) => {
  assertObjectId(id);
  const user = await User.findById(id, projection);
  if (!user) throw notFound('User not found.');
  return user;
};

/**
 * Validates a path choice. Keys and display names (legacy spellings included) are accepted;
 * Deep Learner's focus field defaults to the user's top preference.
 */
const parsePathChoice = (value, focusField, user) => {
  const path = learningService.resolvePathKey(value);
  if (!path) {
    throw badRequest(
      learningService.isRetiredPath(value)
        ? `The ${value} path is no longer available. Choose ${AVAILABLE_PATHS}.`
        : `Invalid learning path. Must be ${AVAILABLE_PATHS}.`
    );
  }
  if (!learningService.getPath(path).usesFocusField) return { path, focusField: null };
  if (focusField === undefined || focusField === null) {
    return { path, focusField: learningService.defaultFocusField(user.preferences, user.learning) };
  }
  if (!learningService.isField(focusField)) {
    throw badRequest('Invalid focus field. Must be one of the predefined departments.');
  }
  return { path, focusField };
};

/** Applies a path choice and records the milestones the new path already reached. */
const switchPath = async (user, choice) => {
  const now = new Date();
  const changed = learningService.choosePath(user.learning, choice, now);
  const newMilestones = learningService.recordMilestones(user.learning, now);
  if (changed || newMilestones.length > 0) await user.save();
  return { changed, newMilestones };
};

exports.getLearningPaths = async (req, res) => {
  res.status(200).json({ paths: learningService.catalog() });
};

exports.getUserLearning = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'learning');
  res.status(200).json(learningService.serializeLearning(user.learning));
};

/** `{ path, focusField? }`: progress is never lost, the previous path goes to the history. */
exports.updateUserLearning = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'learning preferences');
  const choice = parsePathChoice(req.body.path, req.body.focusField, user);
  const { changed, newMilestones } = await switchPath(user, choice);
  res.status(200).json({
    message: changed ? 'Learning path updated.' : 'Learning path unchanged.',
    learning: learningService.serializeLearning(user.learning),
    newMilestones,
  });
};

/** `{ paperId, field? }`: an OpenAlex work opened in the app, counted once. */
exports.recordUserPaper = async (req, res) => {
  assertObjectId(req.params.id);
  const paperId = learningService.normalizePaperId(req.body.paperId);
  if (!paperId) throw badRequest('paperId must be an OpenAlex work id (e.g. W2741809807).');
  const field = req.body.field ?? null;
  if (field !== null && !learningService.isField(field)) {
    throw badRequest('Invalid field. Must be one of the predefined departments.');
  }
  if (!(await User.exists({ _id: req.params.id }))) throw notFound('User not found.');
  const { recorded, newMilestones } = await recordPaperOpened(req.params.id, paperId, field);
  res.status(200).json({ recorded, newMilestones });
};

// ---------------------------------------------------------------- Legacy tracking (app <= 1.0.5)

exports.getUserTracking = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'learning');
  const tracking = learningService.legacyTracking(user.learning);
  res.status(200).json({ tracking, target: tracking.target });
};

exports.updateUserTracking = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'learning preferences');
  const choice = parsePathChoice(req.body.objective, undefined, user);
  await switchPath(user, choice);
  res.status(200).json({
    message: 'Tracking updated successfully.',
    tracking: learningService.legacyTracking(user.learning),
  });
};
