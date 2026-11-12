const mongoose = require('mongoose');
const User = require('../models/user_model');
const Cast = require('../models/cast_model');
const { CARD_PROJECTION } = require('../services/cast');
const { departmentNames } = require('../lists/departments');
const credentials = require('../services/credentials');
const { issueEmail } = require('../services/account_email');
const { MEDIA_DIRS, mediaUrl, deleteMediaByUrl } = require('../services/media');
const rewardsService = require('../services/rewards');
const learningService = require('../services/learning');
const { recordCastWatched } = require('../services/learning_activity');
const {
  HttpError,
  assertObjectId,
  badRequest,
  notFound,
  parseJsonField,
  pick,
  isValidObjectId,
} = require('../utils/http');

// Fields a user may change on their own profile via PUT /user/:id (never `learning` or `rewards`).
const SELF_EDITABLE_FIELDS = [
  'username',
  'role',
  'university',
  'evaluation_list',
  'preferences',
  'castPublications',
];
const PUBLIC_LIST_FIELDS =
  '_id email username role profilePictureUrl evaluation_list bookmarkedcontent preferences learning.path learning.focusField learning.stats castPublications university isVerified';
// Explorer suggestions from unexplored fields can span the whole catalog.
const EXPLORER_SUGGESTION_LIMIT = 50;

const normalizeBoolean = (value) => ['1', 'true', 'yes'].includes(String(value).toLowerCase());

/** Accepts the different payload shapes clients have used for the bookmarked cast id. */
const resolveBookmarkedCastId = (body = {}) => {
  const castId = body.contentId || body.contentid || body.castId || null;
  return castId ? String(castId).trim() : null;
};

const findUserOr404 = async (id, projection) => {
  assertObjectId(id);
  const user = await User.findById(id, projection);
  if (!user) throw notFound('User not found.');
  return user;
};

// ---------------------------------------------------------------- Account (signup, login and password reset: auth_controller)

exports.getAllUser = async (req, res) => {
  res.status(200).json(await User.find().select(PUBLIC_LIST_FIELDS));
};

exports.getOneUser = async (req, res) => {
  res.status(200).json(await findUserOr404(req.params.id));
};

/** Multipart or JSON: optional `image` file + `user` JSON field with the fields to change. */
exports.updateOneUser = async (req, res) => {
  const user = await findUserOr404(req.params.id);
  const data = parseJsonField(req.body, 'user');
  let emailChanged = false;

  if (data.email !== undefined) {
    const email = credentials.normalizeEmail(data.email);
    credentials.assertValid(credentials.emailProblem(email));
    if (email !== user.email) {
      const taken = await credentials.findUserByEmail(email, '_id');
      if (taken && String(taken._id) !== String(user._id)) {
        throw new HttpError(409, 'An account with this email already exists.');
      }
      user.email = email;
      user.isVerified = false;
      user.verifiedAt = undefined;
      // A link sent to the previous address must not confirm the new one.
      user.verificationToken = undefined;
      user.verificationExpires = undefined;
      user.set('mailThrottle.verification', undefined);
      emailChanged = true;
    }
  }
  Object.assign(user, pick(data, SELF_EDITABLE_FIELDS));

  const previousPictureUrl = user.profilePictureUrl;
  if (req.file) {
    user.profilePictureUrl = mediaUrl(MEDIA_DIRS.profilePictures, req.file.filename);
  }
  await user.save();
  if (req.file) {
    await deleteMediaByUrl(previousPictureUrl, MEDIA_DIRS.profilePictures);
  }
  // The new address has to be confirmed; meanwhile the account keeps working.
  if (emailChanged) issueEmail(user, 'verification', { background: true }).catch(() => {});

  res.status(200).json({ message: 'User updated successfully.', user });
};

exports.deleteOneUser = async (req, res) => {
  const user = await findUserOr404(req.params.id);
  await deleteMediaByUrl(user.profilePictureUrl, MEDIA_DIRS.profilePictures);
  await User.deleteOne({ _id: user._id });
  res.status(200).json({ response: 'user removed.' });
};

// ---------------------------------------------------------------- Evaluation list

/**
 * Marks a cast as watched. The first time, it counts in the learning stats (per department) and
 * may reach a milestone of the learning path (`newMilestones`).
 */
exports.updateUserAddContentToList = async (req, res) => {
  const userId = req.params.id;
  assertObjectId(userId);
  const contentId = String(req.body.contentId);

  assertObjectId(contentId, 'contentId');
  const cast = await Cast.findById(contentId).select('department');
  if (!cast) throw notFound('Cast not found.');
  if (!(await User.exists({ _id: userId }))) throw notFound('User not found.');

  const existing = await User.updateOne(
    { _id: userId, 'evaluation_list.contentid': contentId },
    { $set: { 'evaluation_list.$.watched': true } }
  );
  if (existing.matchedCount > 0) {
    return res.status(200).json({ message: 'Content already in evaluation list.' });
  }

  // The $ne guard protects against concurrent duplicate inserts.
  const added = await User.updateOne(
    { _id: userId, 'evaluation_list.contentid': { $ne: contentId } },
    { $push: { evaluation_list: { contentid: contentId, watched: true, answered: false } } }
  );
  if (added.matchedCount === 0) {
    return res.status(200).json({ message: 'Content already in evaluation list.' });
  }

  const newMilestones = await recordCastWatched(userId, cast.department);
  return res.status(200).json({
    message: 'Content added to evaluation list and history updated.',
    newMilestones,
  });
};

exports.updateUserRemoveContentFromList = async (req, res) => {
  assertObjectId(req.params.id);
  const result = await User.updateOne(
    { _id: req.params.id },
    { $pull: { evaluation_list: { contentid: String(req.body.contentId) } } }
  );
  if (result.matchedCount === 0) throw notFound('User not found.');
  res.status(200).json({ message: 'Content removed from evaluation list.' });
};

exports.markContentAsAnswered = async (req, res) => {
  const user = await findUserOr404(req.params.id);
  const contentId = String(req.body.contentId);
  const evaluation = user.evaluation_list.find((item) => item.contentid === contentId);
  if (!evaluation) throw notFound('Evaluation not found.');
  evaluation.answered = true;
  await user.save();
  res.status(200).json({ message: 'Content marked as answered.' });
};

// ---------------------------------------------------------------- Quiz rewards

const EMPTY_QUIZ_SUMMARY = { total: 0, correct: 0, bestCombo: 0, perfect: false };
const QUIZ_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const quizDay = (utcOffsetMinutes) =>
  rewardsService.localDay(rewardsService.normalizeUtcOffset(utcOffsetMinutes));

/** Optional client-generated quiz id that makes a resubmission harmless. */
const parseQuizId = (quizId) => {
  if (quizId === undefined || quizId === null) return null;
  if (typeof quizId !== 'string' || !QUIZ_ID_PATTERN.test(quizId)) {
    throw badRequest('quizId must be 8 to 64 letters, digits, "-" or "_".');
  }
  return quizId;
};

/** Response of a quiz that earned nothing (nothing left to grade, or an already graded quiz id). */
const emptyQuizResponse = (user, today, duplicate) => {
  const xp = user.rewards.xp || 0;
  return {
    results: [],
    summary: EMPTY_QUIZ_SUMMARY,
    xpEarned: 0,
    breakdown: [],
    previous: { xp, ...rewardsService.levelInfo(xp) },
    leveledUp: false,
    newBadges: [],
    newMilestones: [],
    duplicate,
    rewards: rewardsService.serializeRewards(user, today),
  };
};

/** Validates `answers` and keeps the first answer per content id, in order. */
const parseQuizAnswers = (answers) => {
  if (!Array.isArray(answers) || answers.length === 0) {
    throw badRequest('answers must be a non-empty array.');
  }
  if (answers.length > rewardsService.MAX_QUIZ_ANSWERS) {
    throw badRequest(`A quiz has at most ${rewardsService.MAX_QUIZ_ANSWERS} answers.`);
  }
  const seen = new Set();
  return answers.reduce((unique, answer) => {
    const contentId = String(answer?.contentId ?? '');
    assertObjectId(contentId, 'contentId');
    if (typeof answer.response !== 'string') throw badRequest('Each answer needs a response.');
    if (!seen.has(contentId)) {
      seen.add(contentId);
      unique.push({ contentId, response: answer.response });
    }
    return unique;
  }, []);
};

/** Loads the `evaluation` and `department` of the casts of evaluation-list items, keyed by cast id. */
const loadEvaluations = async (items) => {
  const ids = items.map((item) => item.contentid);
  if (ids.length === 0) return new Map();
  const casts = await Cast.find({ _id: { $in: ids } }).select('evaluation department');
  return new Map(
    casts.map((cast) => [
      String(cast._id),
      { evaluation: cast.evaluation, department: cast.department },
    ])
  );
};

/**
 * Grades a quiz against the stored correct answers and awards XP, streak and badges; correct
 * answers also count in the learning stats and may reach a learning path milestone.
 * Only questions still pending in the evaluation list count, so replays earn nothing;
 * correct answers are marked as answered (wrong ones stay pending for a later quiz).
 * Resending the last `quizId` earns nothing and answers `duplicate: true`.
 */
exports.submitQuiz = async (req, res) => {
  const answers = parseQuizAnswers(req.body.answers);
  const quizId = parseQuizId(req.body.quizId);
  const today = quizDay(req.body.utcOffsetMinutes);
  const user = await findUserOr404(req.params.id);

  if (quizId && user.rewards.lastQuizId === quizId) {
    return res.status(200).json(emptyQuizResponse(user, today, true));
  }

  const pending = new Map(
    user.evaluation_list.filter((item) => !item.answered).map((item) => [item.contentid, item])
  );
  const eligible = answers.filter((answer) => pending.has(answer.contentId));
  const evaluations = await loadEvaluations(
    eligible.map((answer) => pending.get(answer.contentId))
  );
  const graded = eligible
    .filter((answer) => evaluations.get(answer.contentId)?.evaluation?.correct)
    .map((answer) => {
      const { evaluation, department } = evaluations.get(answer.contentId);
      return {
        contentId: answer.contentId,
        correct: answer.response === evaluation.correct,
        correctAnswer: evaluation.correct,
        department,
      };
    });

  if (graded.length === 0) {
    return res.status(200).json(emptyQuizResponse(user, today, false));
  }

  const quiz = rewardsService.scoreQuiz(graded);
  quiz.results
    .filter((result) => result.correct)
    .forEach((result) => {
      pending.get(result.contentId).answered = true;
    });
  learningService.applyQuizAnswers(user.learning, quiz.results);
  const newMilestones = learningService.recordMilestones(user.learning);
  const outcome = rewardsService.applyQuiz(user, quiz, today);
  if (quizId) user.rewards.lastQuizId = quizId;

  // The version check rejects a concurrent submission of the same quiz (double tap, retry).
  user.increment();
  try {
    await user.save();
  } catch (error) {
    if (error instanceof mongoose.Error.VersionError) {
      throw new HttpError(409, 'This quiz was already submitted.');
    }
    throw error;
  }

  res.status(200).json({
    results: quiz.results,
    summary: {
      total: quiz.total,
      correct: quiz.correct,
      bestCombo: quiz.bestCombo,
      perfect: quiz.perfect,
    },
    ...outcome,
    newMilestones,
    duplicate: false,
    rewards: rewardsService.serializeRewards(user, today),
  });
};

/** `?utcOffsetMinutes=` lets the streak follow the user's local day. */
exports.getUserRewards = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'rewards');
  res.status(200).json(rewardsService.serializeRewards(user, quizDay(req.query.utcOffsetMinutes)));
};

// ---------------------------------------------------------------- Bookmarks

/** `?expand=true` embeds the bookmarked cast document in each entry (`content`, null if deleted). */
exports.getUserBookmarks = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'bookmarkedcontent');
  const bookmarks = user.toObject().bookmarkedcontent || [];
  if (!normalizeBoolean(req.query.expand || req.query.includeContent)) {
    return res.status(200).json(bookmarks);
  }

  const castIds = bookmarks
    .map((bookmark) => (bookmark.contentid ? String(bookmark.contentid).trim() : null))
    .filter(isValidObjectId);
  const casts = castIds.length
    ? await Cast.find({ _id: { $in: castIds } })
        .select(CARD_PROJECTION)
        .lean()
    : [];
  const castMap = new Map(casts.map((cast) => [String(cast._id), cast]));

  const expanded = bookmarks.map((bookmark) => {
    const contentid = bookmark.contentid ? String(bookmark.contentid).trim() : null;
    return {
      contentid,
      bookmarkedAt: bookmark.bookmarkedAt || null,
      content: castMap.get(contentid) || null,
    };
  });
  return res.status(200).json(expanded);
};

exports.addUserBookmark = async (req, res) => {
  const userId = req.params.id;
  assertObjectId(userId);
  const contentId = resolveBookmarkedCastId(req.body);
  if (!contentId) throw badRequest('contentId is required.');
  assertObjectId(contentId, 'contentId');
  if (!(await User.exists({ _id: userId }))) throw notFound('User not found.');
  if (!(await Cast.exists({ _id: contentId }))) throw notFound('Cast not found.');

  const added = await User.updateOne(
    { _id: userId, 'bookmarkedcontent.contentid': { $ne: contentId } },
    { $push: { bookmarkedcontent: { contentid: contentId, bookmarkedAt: new Date() } } }
  );
  if (added.modifiedCount === 0) throw badRequest('Element is already bookmarked.');

  res.status(201).json({ message: 'Element bookmarked.', bookmark: { contentid: contentId } });
};

exports.removeUserBookmark = async (req, res) => {
  const userId = req.params.id;
  assertObjectId(userId);
  if (!(await User.exists({ _id: userId }))) throw notFound('User not found.');

  const result = await User.updateOne(
    { _id: userId },
    { $pull: { bookmarkedcontent: { contentid: String(req.params.contentId) } } }
  );
  if (result.modifiedCount === 0) throw notFound('Bookmark not found.');
  res.status(200).json({ message: 'Element removed from bookmarks.' });
};

// ---------------------------------------------------------------- Preferences & suggestions

/** Preferred departments, highest weight first (ties in preference order; duplicates use the best). */
const rankedPreferences = (preferences = []) => {
  const rankByDepartment = new Map();
  preferences.forEach((pref, index) => {
    const current = rankByDepartment.get(pref.category);
    if (!current || pref.weight > current.weight) {
      rankByDepartment.set(pref.category, { weight: pref.weight, index });
    }
  });
  return [...rankByDepartment.entries()]
    .sort(([, a], [, b]) => b.weight - a.weight || a.index - b.index)
    .map(([department]) => department);
};

/** Casts of `departments` in that department order, by _id within a department. */
const castsInDepartmentOrder = async (departments) => {
  if (departments.length === 0) return [];
  const order = new Map(departments.map((department, index) => [department, index]));
  const casts = await Cast.find({ department: { $in: departments } })
    .select(CARD_PROJECTION)
    .sort({ _id: 1 })
    .lean();
  // Array.prototype.sort is stable: casts keep _id order within a department.
  return casts.sort((a, b) => order.get(a.department) - order.get(b.department));
};

/**
 * "For You" casts, shaped by the learning path:
 * - Follower: the newest casts from the preferred fields;
 * - Explorer: the best-rated casts from fields not explored yet, then the explored preferred fields;
 * - Deep Learner: the focus field first, then the other preferred fields;
 * - otherwise: preferred fields by weight (ties in preference order), by _id within a field.
 * 404 when there is nothing to base suggestions on.
 */
exports.getSuggestedForYou = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'preferences learning');
  const preferred = rankedPreferences(user.preferences);
  const path = user.learning?.path;

  if (path === 'explorer') {
    const explored = learningService.exploredFields(user.learning);
    const unexplored = await Cast.find({ department: { $nin: explored } })
      .select(CARD_PROJECTION)
      .sort({ 'rating.value': -1, dateadded: -1, _id: 1 })
      .limit(EXPLORER_SUGGESTION_LIMIT)
      .lean();
    const familiar = await castsInDepartmentOrder(
      preferred.filter((department) => explored.includes(department))
    );
    return res.status(200).json([...unexplored, ...familiar]);
  }

  const focusField = path === 'deep_learner' ? user.learning.focusField : null;
  const departments = focusField
    ? [focusField, ...preferred.filter((department) => department !== focusField)]
    : preferred;
  if (departments.length === 0) throw notFound('No preferences set for user.');

  if (path === 'follower') {
    const newest = await Cast.find({ department: { $in: departments } })
      .select(CARD_PROJECTION)
      .sort({ dateadded: -1, _id: -1 })
      .lean();
    return res.status(200).json(newest);
  }
  res.status(200).json(await castsInDepartmentOrder(departments));
};

exports.getUserPreferences = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'preferences');
  res.status(200).json({ preferences: user.preferences });
};

/** `modification: 'positive' | 'negative'` adjusts a department's count; weights are recomputed as %. */
exports.updateUserPreferences = async (req, res) => {
  const { category, modification } = req.body;
  if (modification !== 'positive' && modification !== 'negative') {
    throw badRequest('Invalid modification type. Must be either "positive" or "negative".');
  }
  if (!departmentNames.includes(category)) {
    throw badRequest('Invalid category. Must be one of the predefined departments.');
  }

  const user = await findUserOr404(req.params.id);
  const existing = user.preferences.find((pref) => pref.category === category);
  if (existing) {
    existing.count = Math.max(0, existing.count + (modification === 'positive' ? 1 : -1));
  } else if (modification === 'positive') {
    user.preferences.push({ category, weight: 0, count: 1 });
  }

  const total = user.preferences.reduce((sum, pref) => sum + pref.count, 0);
  user.preferences.forEach((pref) => {
    pref.weight = total > 0 ? (pref.count / total) * 100 : 0;
  });
  await user.save();
  res.status(200).json({ message: 'User preferences updated.', preferences: user.preferences });
};
