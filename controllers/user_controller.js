const bcrypt = require('bcrypt');
const crypto = require('crypto');
const User = require('../models/user_model');
const Cast = require('../models/cast_model');
const Article = require('../models/article_model');
const { departmentNames } = require('../lists/departments');
const isValidEmail = require('../services/email_validator');
const { sendMail } = require('../services/mailer');
const { MEDIA_DIRS, mediaUrl, deleteMediaByUrl } = require('../services/media');
const { signToken } = require('../middleware/auth');
const {
  messagePage,
  resetPasswordFormPage,
  verificationEmail,
  passwordResetEmail,
} = require('../views/html');
const {
  HttpError,
  assertObjectId,
  badRequest,
  notFound,
  parseJsonField,
  pick,
  isNonEmptyString,
  isValidObjectId,
} = require('../utils/http');

const BCRYPT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 4;
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
const UNIVERSITY_ROLES = ['Professor', 'PhD Student', 'Researcher'];
const OBJECTIVE_TARGETS = {
  Follower: 5,
  Explorer: 10,
  'Deep Learner': 20,
  Researcher: 30,
  Career: 50,
};
const DEFAULT_OBJECTIVE = 'Explorer';
// Fields a user may change on their own profile via PUT /user/:id.
const SELF_EDITABLE_FIELDS = [
  'username',
  'role',
  'university',
  'evaluation_list',
  'preferences',
  'tracking',
  'castPublications',
  'articlePublications',
];
const PUBLIC_LIST_FIELDS =
  '_id email username role profilePictureUrl evaluation_list bookmarkedcontent preferences tracking castPublications articlePublications university isVerified';

const isObjective = (value) => typeof value === 'string' && Object.hasOwn(OBJECTIVE_TARGETS, value);

const getTargetValue = (objective) =>
  isObjective(objective) ? OBJECTIVE_TARGETS[objective] : OBJECTIVE_TARGETS[DEFAULT_OBJECTIVE];

const normalizeEmail = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

const normalizeContentType = (value) => {
  const type = value ? String(value).toLowerCase() : null;
  return type === 'cast' || type === 'article' ? type : null;
};

const normalizeBoolean = (value) => ['1', 'true', 'yes'].includes(String(value).toLowerCase());

/** Accepts the different payload shapes clients have used for bookmarks. */
const resolveBookmarkInput = (body = {}) => {
  const contentId = body.contentId || body.contentid || body.castId || body.articleId || null;
  let type = normalizeContentType(body.type || body.contentType);
  if (!type && body.castId) type = 'cast';
  if (!type && body.articleId) type = 'article';
  return { contentId: contentId ? String(contentId).trim() : null, type };
};

const findUserOr404 = async (id, projection) => {
  assertObjectId(id);
  const user = await User.findById(id, projection);
  if (!user) throw notFound('User not found.');
  return user;
};

/** HTML endpoints render an error page instead of the JSON error handler output. */
const htmlRoute = (handler) => async (req, res) => {
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`Error on ${req.method} ${req.originalUrl}:`, error);
    res.status(500).send(
      messagePage({
        title: 'Server Error',
        paragraphs: ['Sorry, something went wrong. Please try again later.'],
        error: true,
      })
    );
  }
};

// ---------------------------------------------------------------- Account

/** Multipart: `image` file + `user` JSON field. Sends a verification email. */
exports.signup = async (req, res) => {
  if (!req.file) throw badRequest('A profile picture is required (field "image").');
  const data = parseJsonField(req.body, 'user');
  const email = normalizeEmail(data.email);
  if (!isValidEmail(email)) throw badRequest('The email domain name is not a valid one.');
  if (!isNonEmptyString(data.password)) throw badRequest('Password is required.');
  if (await User.exists({ email })) {
    throw new HttpError(409, 'An account with this email already exists.');
  }

  const objective = isObjective(data.objective) ? data.objective : DEFAULT_OBJECTIVE;
  const user = new User({
    email,
    password: await bcrypt.hash(data.password, BCRYPT_ROUNDS),
    username: data.username,
    role: data.role,
    profilePictureUrl: mediaUrl(MEDIA_DIRS.profilePictures, req.file.filename),
    verificationToken: crypto.randomBytes(16).toString('hex'),
    tracking: { objective, target: getTargetValue(objective) },
  });
  if (UNIVERSITY_ROLES.includes(data.role)) {
    user.university = data.university;
  }
  await user.save();

  try {
    await sendMail({
      to: email,
      subject: 'Account Verification - BrightMinds Research',
      html: verificationEmail(user.verificationToken),
    });
  } catch (error) {
    console.error('Error sending verification email:', error);
    await User.deleteOne({ _id: user._id });
    throw new HttpError(500, 'An error occurred during signup. Please try again later.');
  }

  res
    .status(201)
    .json({ response: 'User created. Please check your email to verify your account.' });
};

exports.confirmation = htmlRoute(async (req, res) => {
  const user = await User.findOne({ verificationToken: String(req.params.token) });
  if (!user) {
    return res.status(400).send(
      messagePage({
        title: 'Verification Failed',
        paragraphs: [
          'We were unable to find a user for this token.',
          'Please check the link or contact support.',
        ],
        error: true,
      })
    );
  }
  if (user.isVerified) {
    return res.status(400).send(
      messagePage({
        title: 'Already Verified',
        paragraphs: ['This user has already been verified.'],
      })
    );
  }
  user.isVerified = true;
  await user.save();
  return res.status(200).send(
    messagePage({
      title: 'Verification Successful',
      heading: 'Verification Successful!',
      paragraphs: ['Your account has been verified. You can now log in.'],
    })
  );
});

exports.login = async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!email || typeof password !== 'string') {
    throw badRequest('Email and password are required.');
  }
  const user = await User.findOne({ email });
  if (!user) {
    return res.status(401).json({ response: 'user not found.' });
  }
  if (!(await bcrypt.compare(password, user.password))) {
    return res.status(401).json({ response: 'incorrect password' });
  }
  return res.status(200).json({ userId: user._id, email: user.email, token: signToken(user._id) });
};

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

  if (data.email !== undefined) {
    const email = normalizeEmail(data.email);
    if (!isValidEmail(email)) throw badRequest('Invalid email.');
    user.email = email;
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

  res.status(200).json({ message: 'User updated successfully.', user });
};

exports.deleteOneUser = async (req, res) => {
  const user = await findUserOr404(req.params.id);
  await deleteMediaByUrl(user.profilePictureUrl, MEDIA_DIRS.profilePictures);
  await User.deleteOne({ _id: user._id });
  res.status(200).json({ response: 'user removed.' });
};

// ---------------------------------------------------------------- Password reset

exports.requestPasswordResetEmail = async (req, res) => {
  const user = await User.findOne({ email: normalizeEmail(req.body.email) });
  if (!user) throw notFound('No user found with that email address.');
  if (!user.isVerified) throw badRequest('Your email has not been verified.');

  user.resetPasswordToken = crypto.randomBytes(20).toString('hex');
  user.resetPasswordExpires = Date.now() + RESET_TOKEN_TTL_MS;
  await user.save();

  try {
    await sendMail({
      to: user.email,
      subject: 'Password Reset - BrightMinds Research',
      html: passwordResetEmail({ username: user.username, token: user.resetPasswordToken }),
    });
  } catch (error) {
    console.error('Error sending reset email:', error);
    throw new HttpError(500, 'Error sending reset email.');
  }
  res.status(200).json({ message: 'Password reset link sent to your email.' });
};

const findUserByResetToken = (token) =>
  User.findOne({ resetPasswordToken: String(token), resetPasswordExpires: { $gt: Date.now() } });

const invalidResetLinkPage = () =>
  messagePage({
    title: 'Invalid or Expired Link',
    paragraphs: ['The password reset link is invalid or has expired.'],
    error: true,
  });

exports.showResetPasswordForm = htmlRoute(async (req, res) => {
  const user = await findUserByResetToken(req.params.token);
  if (!user) {
    return res.status(400).send(invalidResetLinkPage());
  }
  return res.status(200).send(resetPasswordFormPage(req.params.token));
});

exports.resetPassword = htmlRoute(async (req, res) => {
  const { password, confirmPassword } = req.body;
  const goBack = { href: 'javascript:history.back()', label: 'Go Back' };

  if (
    typeof password !== 'string' ||
    typeof confirmPassword !== 'string' ||
    !password ||
    !confirmPassword
  ) {
    return res.status(400).send(
      messagePage({
        title: 'Invalid Submission',
        paragraphs: ['Please provide both password fields.'],
        error: true,
        button: goBack,
      })
    );
  }
  if (password !== confirmPassword) {
    return res.status(400).send(
      messagePage({
        title: 'Passwords Do Not Match',
        paragraphs: ['The passwords you entered do not match. Please try again.'],
        error: true,
        button: goBack,
      })
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).send(
      messagePage({
        title: 'Password Too Short',
        paragraphs: [`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`],
        error: true,
        button: goBack,
      })
    );
  }

  const user = await findUserByResetToken(req.params.token);
  if (!user) {
    return res.status(400).send(invalidResetLinkPage());
  }
  user.password = await bcrypt.hash(password, BCRYPT_ROUNDS);
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  await user.save();

  return res.status(200).send(
    messagePage({
      title: 'Password Updated',
      heading: 'Password Updated!',
      paragraphs: [
        'Your password has been successfully updated. You can now log in with your new password.',
      ],
    })
  );
});

// ---------------------------------------------------------------- Evaluation list

/** Marks content as watched and counts it once in tracking.history (per department). */
exports.updateUserAddContentToList = async (req, res) => {
  const userId = req.params.id;
  assertObjectId(userId);
  const { type } = req.body;
  const contentId = String(req.body.contentId);

  const Model = type === 'cast' ? Cast : type === 'article' ? Article : null;
  if (!Model) throw badRequest('Invalid content type.');
  assertObjectId(contentId, 'contentId');
  const content = await Model.findById(contentId).select('department');
  if (!content) throw notFound(`${type === 'cast' ? 'Cast' : 'Article'} not found.`);
  if (!(await User.exists({ _id: userId }))) throw notFound('User not found.');

  const existing = await User.updateOne(
    { _id: userId, 'evaluation_list.contentid': contentId },
    { $set: { 'evaluation_list.$.watched': true, 'evaluation_list.$.type': type } }
  );
  if (existing.matchedCount > 0) {
    return res.status(200).json({ message: 'Content already in evaluation list.' });
  }

  // The $ne guard protects against concurrent duplicate inserts.
  const added = await User.updateOne(
    { _id: userId, 'evaluation_list.contentid': { $ne: contentId } },
    { $push: { evaluation_list: { contentid: contentId, type, watched: true, answered: false } } }
  );
  if (added.matchedCount === 0) {
    return res.status(200).json({ message: 'Content already in evaluation list.' });
  }

  const category = content.department;
  const history = await User.updateOne(
    { _id: userId, 'tracking.history.category': category },
    { $inc: { 'tracking.history.$.count': 1 } }
  );
  if (history.matchedCount === 0) {
    await User.updateOne(
      { _id: userId },
      { $push: { 'tracking.history': { category, count: 1 } } }
    );
  }

  return res.status(200).json({ message: 'Content added to evaluation list and history updated.' });
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

// ---------------------------------------------------------------- Bookmarks

/** `?expand=true` embeds the bookmarked cast/article document in each entry. */
exports.getUserBookmarks = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'bookmarkedcontent');
  const bookmarks = user.toObject().bookmarkedcontent || [];
  if (!normalizeBoolean(req.query.expand || req.query.includeContent)) {
    return res.status(200).json(bookmarks);
  }

  const castIds = new Set();
  const articleIds = new Set();
  for (const bookmark of bookmarks) {
    const id = bookmark.contentid ? String(bookmark.contentid).trim() : null;
    if (!isValidObjectId(id)) continue;
    const type = normalizeContentType(bookmark.type);
    // Legacy bookmarks have no type: look them up in both collections.
    if (type !== 'article') castIds.add(id);
    if (type !== 'cast') articleIds.add(id);
  }

  const [casts, articles] = await Promise.all([
    castIds.size ? Cast.find({ _id: { $in: [...castIds] } }).lean() : [],
    articleIds.size ? Article.find({ _id: { $in: [...articleIds] } }).lean() : [],
  ]);
  const castMap = new Map(casts.map((cast) => [String(cast._id), cast]));
  const articleMap = new Map(articles.map((article) => [String(article._id), article]));

  const expanded = bookmarks.map((bookmark) => {
    const contentid = bookmark.contentid ? String(bookmark.contentid).trim() : null;
    let type = normalizeContentType(bookmark.type);
    let content = null;
    if (contentid) {
      if (type !== 'article' && castMap.has(contentid)) {
        type = 'cast';
        content = castMap.get(contentid);
      } else if (type !== 'cast' && articleMap.has(contentid)) {
        type = 'article';
        content = articleMap.get(contentid);
      }
    }
    return {
      contentid,
      type: contentid ? type : null,
      bookmarkedAt: bookmark.bookmarkedAt || null,
      content,
    };
  });
  return res.status(200).json(expanded);
};

exports.addUserBookmark = async (req, res) => {
  const userId = req.params.id;
  assertObjectId(userId);
  const rawType = req.body.type || req.body.contentType;
  if (rawType && !normalizeContentType(rawType)) throw badRequest('Invalid content type.');
  const { contentId, type } = resolveBookmarkInput(req.body);
  if (!contentId) throw badRequest('contentId is required.');
  assertObjectId(contentId, 'contentId');
  if (!(await User.exists({ _id: userId }))) throw notFound('User not found.');

  let resolvedType = type;
  if (!resolvedType) {
    const [cast, article] = await Promise.all([
      Cast.exists({ _id: contentId }),
      Article.exists({ _id: contentId }),
    ]);
    if (cast && article) throw badRequest('Content type is required.');
    if (!cast && !article) throw notFound('Content not found.');
    resolvedType = cast ? 'cast' : 'article';
  } else {
    const Model = resolvedType === 'cast' ? Cast : Article;
    if (!(await Model.exists({ _id: contentId }))) {
      throw notFound(`${resolvedType === 'cast' ? 'Cast' : 'Article'} not found.`);
    }
  }

  const added = await User.updateOne(
    { _id: userId, 'bookmarkedcontent.contentid': { $ne: contentId } },
    {
      $push: {
        bookmarkedcontent: { contentid: contentId, type: resolvedType, bookmarkedAt: new Date() },
      },
    }
  );
  if (added.modifiedCount === 0) {
    // Backfill the type on legacy bookmarks that were saved without one.
    await User.updateOne(
      {
        _id: userId,
        bookmarkedcontent: { $elemMatch: { contentid: contentId, type: { $exists: false } } },
      },
      { $set: { 'bookmarkedcontent.$.type': resolvedType } }
    );
    throw badRequest('Element is already bookmarked.');
  }

  res.status(201).json({
    message: 'Element bookmarked.',
    bookmark: { contentid: contentId, type: resolvedType },
  });
};

/** Optional `?type=cast|article` only removes the bookmark if its type matches. */
exports.removeUserBookmark = async (req, res) => {
  const userId = req.params.id;
  assertObjectId(userId);
  const contentId = String(req.params.contentId);
  const rawType = req.query.type || req.query.contentType || req.body.type || req.body.contentType;
  const type = normalizeContentType(rawType);
  if (rawType && !type) throw badRequest('Invalid content type.');
  if (!(await User.exists({ _id: userId }))) throw notFound('User not found.');

  const result = await User.updateOne(
    { _id: userId },
    {
      $pull: {
        bookmarkedcontent: type ? { contentid: contentId, type } : { contentid: contentId },
      },
    }
  );
  if (result.modifiedCount === 0) throw notFound('Bookmark not found.');
  res.status(200).json({ message: 'Element removed from bookmarks.' });
};

// ---------------------------------------------------------------- Preferences & tracking

/**
 * Casts from the user's preferred departments: highest weight first, ties in preference order,
 * then by _id within a department.
 */
exports.getSuggestedForYou = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'preferences');
  if (!user.preferences?.length) throw notFound('No preferences set for user.');

  // Rank per department: its best weight, and the position of the preference giving it.
  const rankByDepartment = new Map();
  user.preferences.forEach((pref, index) => {
    const current = rankByDepartment.get(pref.category);
    if (!current || pref.weight > current.weight) {
      rankByDepartment.set(pref.category, { weight: pref.weight, index });
    }
  });

  const casts = await Cast.find({ department: { $in: [...rankByDepartment.keys()] } })
    .sort({ _id: 1 })
    .lean();
  // Array.prototype.sort is stable: casts keep _id order within a department.
  casts.sort((a, b) => {
    const rankA = rankByDepartment.get(a.department);
    const rankB = rankByDepartment.get(b.department);
    return rankB.weight - rankA.weight || rankA.index - rankB.index;
  });
  res.status(200).json(casts);
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

exports.updateUserTracking = async (req, res) => {
  const { objective } = req.body;
  if (!isObjective(objective)) {
    throw badRequest(
      'Invalid objective value. Must be one of Follower, Explorer, Deep Learner, Career, or Researcher.'
    );
  }
  const user = await findUserOr404(req.params.id);
  user.tracking.objective = objective;
  user.tracking.target = getTargetValue(objective);
  await user.save();
  res.status(200).json({ message: 'Tracking updated successfully.', tracking: user.tracking });
};

exports.getUserTracking = async (req, res) => {
  const user = await findUserOr404(req.params.id, 'tracking');
  res.status(200).json({ tracking: user.tracking, target: user.tracking.target });
};
