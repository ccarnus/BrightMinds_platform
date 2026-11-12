// Account access: signup, login, email confirmation and password reset.
const config = require('../config');
const User = require('../models/user_model');
const learningService = require('../services/learning');
const credentials = require('../services/credentials');
const { issueEmail, sendPasswordChangedNotice } = require('../services/account_email');
const { isWellFormedToken, tokenCandidates } = require('../services/email_tokens');
const { MEDIA_DIRS, mediaUrl, deleteMediaByUrl } = require('../services/media');
const { signToken } = require('../middleware/auth');
const { messagePage, resetPasswordFormPage } = require('../views/html');
const {
  HttpError,
  assertObjectId,
  badRequest,
  notFound,
  parseJsonField,
} = require('../utils/http');

const UNIVERSITY_ROLES = ['Professor', 'PhD Student', 'Researcher'];
const INVALID_LOGIN = 'Incorrect email or password.';
const RESET_REQUEST_ANSWER =
  "If an account exists for this email, we've sent a link to reset the password. Check your inbox (and your spam folder).";

/** HTML endpoints render an error page instead of the JSON error handler output. */
const htmlRoute = (handler) => async (req, res) => {
  // The link token is in the URL: keep these pages out of caches, search engines and referrers.
  res.set({
    'Cache-Control': 'no-store',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
  });
  try {
    await handler(req, res);
  } catch (error) {
    console.error(`Error on ${req.method} ${req.originalUrl}:`, error);
    res.status(500).send(
      messagePage({
        title: 'Server Error',
        paragraphs: ['Sorry, something went wrong. Please try again in a few minutes.'],
        error: true,
      })
    );
  }
};

const rateLimited = (res, retryAfterSeconds) => {
  const message = `Please wait ${
    retryAfterSeconds > 90
      ? `${Math.ceil(retryAfterSeconds / 60)} minutes`
      : `${retryAfterSeconds} seconds`
  } before requesting another email.`;
  return res
    .status(429)
    .set('Retry-After', String(retryAfterSeconds))
    .json({ error: message, message, retryAfterSeconds });
};

// ---------------------------------------------------------------- Signup

const validateSignup = (data) => {
  const email = credentials.normalizeEmail(data.email);
  const username = credentials.cleanUsername(data.username);
  credentials.assertValid(credentials.emailProblem(email));
  credentials.assertValid(credentials.usernameProblem(username));
  credentials.assertValid(credentials.passwordProblem(data.password, { email, username }));
  if (!User.ROLES.includes(data.role)) throw badRequest('Please choose a valid role.');
  const university = UNIVERSITY_ROLES.includes(data.role)
    ? credentials.cleanUniversity(data.university).slice(0, credentials.MAX_UNIVERSITY_LENGTH)
    : undefined;
  return { email, username, university };
};

const signupMessage = (status, email) =>
  status === 'failed'
    ? "Your account is ready, but we couldn't send the confirmation email. You can request it again from your profile."
    : `Your account is ready. We sent a confirmation email to ${email}: you can already use BrightMinds while you wait.`;

const createUser = async (data, { email, username, university }, file) => {
  // `objective` is the legacy name of `path`; unknown or retired paths are left for onboarding.
  const path = learningService.resolvePathKey(data.path ?? data.objective);
  const focusField =
    path && learningService.getPath(path).usesFocusField && learningService.isField(data.focusField)
      ? data.focusField
      : null;
  const user = new User({
    email,
    password: await credentials.hashPassword(data.password),
    username,
    role: data.role,
    university,
    profilePictureUrl: mediaUrl(MEDIA_DIRS.profilePictures, file.filename),
    learning: {
      version: learningService.LEARNING_VERSION,
      path,
      focusField,
      startedAt: path ? new Date() : undefined,
    },
  });
  try {
    await user.save();
  } catch (error) {
    // Two signups with the same email at the same moment: the unique index lets only one through.
    if (error?.code === 11000)
      throw new HttpError(409, 'An account with this email already exists.');
    throw error;
  }
  return user;
};

/**
 * Multipart: `image` file + `user` JSON field. The account is created and usable at once; the
 * confirmation email is sent afterwards and a failure to send it never removes the account.
 */
exports.signup = async (req, res) => {
  const { file } = req;
  let user;
  try {
    if (!file) throw badRequest('A profile picture is required (field "image").');
    const data = parseJsonField(req.body, 'user');
    const cleaned = validateSignup(data);
    if (await credentials.findUserByEmail(cleaned.email, '_id')) {
      throw new HttpError(409, 'An account with this email already exists. Try logging in.');
    }
    user = await createUser(data, cleaned, file);
  } catch (error) {
    if (file) {
      await deleteMediaByUrl(
        mediaUrl(MEDIA_DIRS.profilePictures, file.filename),
        MEDIA_DIRS.profilePictures
      ).catch(() => {});
    }
    throw error;
  }

  const result = await issueEmail(user, 'verification', { waitMs: config.account.sendWaitMs });
  res.status(201).json({
    response: signupMessage(result.status, user.email),
    userId: user._id,
    email: user.email,
    token: signToken(user._id),
    isVerified: false,
    emailSent: result.status !== 'failed',
    emailStatus: result.status,
  });
};

// ---------------------------------------------------------------- Login

/** Unverified accounts log in like any other: the confirmation only secures the account. */
exports.login = async (req, res) => {
  const { email: rawEmail, password } = req.body || {};
  if (
    typeof rawEmail !== 'string' ||
    typeof password !== 'string' ||
    !rawEmail.trim() ||
    !password
  ) {
    throw badRequest('Please enter your email and password.');
  }
  const email = credentials.normalizeEmail(rawEmail);
  credentials.assertValid(credentials.emailProblem(email));

  const tooLong = password.length > credentials.MAX_LOGIN_PASSWORD_LENGTH;
  const user = await credentials.findUserByEmail(email);
  // The same work and the same answer whether the email is unknown or the password is wrong.
  const valid = await credentials.verifyPassword(user?.password, tooLong ? '' : password);
  if (!user || tooLong || !valid) {
    return res
      .status(401)
      .json({ error: INVALID_LOGIN, message: INVALID_LOGIN, response: INVALID_LOGIN });
  }

  await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
  return res.status(200).json({
    userId: user._id,
    email: user.email,
    username: user.username,
    role: user.role,
    isVerified: Boolean(user.isVerified),
    token: signToken(user._id),
  });
};

// ---------------------------------------------------------------- Email confirmation

const invalidVerificationPage = () =>
  messagePage({
    title: 'Link not valid',
    paragraphs: [
      'This confirmation link is not valid. It may have been replaced by a newer one.',
      'Open BrightMinds, go to your profile and ask for a new confirmation email.',
    ],
    error: true,
  });

exports.confirmation = htmlRoute(async (req, res) => {
  const { token } = req.params;
  if (!isWellFormedToken(token)) return res.status(400).send(invalidVerificationPage());

  const user = await User.findOne({ verificationToken: { $in: tokenCandidates(token) } });
  if (!user) return res.status(400).send(invalidVerificationPage());

  if (user.isVerified) {
    return res.status(200).send(
      messagePage({
        title: 'Already confirmed',
        paragraphs: ['Your email is already confirmed. You can go back to the BrightMinds app.'],
      })
    );
  }
  if (user.verificationExpires && user.verificationExpires.getTime() < Date.now()) {
    return res.status(400).send(
      messagePage({
        title: 'Link expired',
        paragraphs: [
          'This confirmation link has expired.',
          'Open BrightMinds, go to your profile and ask for a new confirmation email.',
        ],
        error: true,
      })
    );
  }

  // The token stays on the account: opening the same link again shows "already confirmed".
  await User.updateOne(
    { _id: user._id, isVerified: false },
    { $set: { isVerified: true, verifiedAt: new Date() } }
  );
  return res.status(200).send(
    messagePage({
      title: 'Email confirmed',
      paragraphs: ['Thank you! Your email is confirmed. You can go back to the BrightMinds app.'],
    })
  );
});

/** Sends a new confirmation email to the logged-in user (self only). */
exports.resendVerification = async (req, res) => {
  assertObjectId(req.params.id);
  const user = await User.findById(req.params.id);
  if (!user) throw notFound('User not found.');
  if (user.isVerified) {
    return res.status(200).json({
      message: 'Your email is already confirmed.',
      emailStatus: 'verified',
      isVerified: true,
    });
  }

  const result = await issueEmail(user, 'verification', { waitMs: config.account.sendWaitMs });
  if (result.status === 'throttled') return rateLimited(res, result.retryAfterSeconds);
  if (result.status === 'failed') {
    throw new HttpError(
      503,
      "We couldn't send the email right now. Please try again in a few minutes."
    );
  }
  return res.status(200).json({
    message: `We sent a confirmation email to ${user.email}.`,
    emailStatus: result.status,
    isVerified: false,
  });
};

// ---------------------------------------------------------------- Password reset

/** Always answers the same, so the endpoint cannot be used to find out which emails have an account. */
exports.requestPasswordResetEmail = async (req, res) => {
  const { email: rawEmail } = req.body || {};
  if (typeof rawEmail !== 'string' || !rawEmail.trim()) {
    throw badRequest('Please enter your email address.');
  }
  const email = credentials.normalizeEmail(rawEmail);
  credentials.assertValid(credentials.emailProblem(email));

  const user = await credentials.findUserByEmail(email);
  // Not awaited: sending takes time only when the account exists.
  if (user) issueEmail(user, 'reset', { background: true }).catch(() => {});
  res.status(200).json({ message: RESET_REQUEST_ANSWER });
};

const findUserByResetToken = (token) =>
  isWellFormedToken(token)
    ? User.findOne({
        resetPasswordToken: { $in: tokenCandidates(token) },
        resetPasswordExpires: { $gt: new Date() },
      })
    : null;

const invalidResetLinkPage = () =>
  messagePage({
    title: 'Link expired',
    paragraphs: [
      'This password reset link is no longer valid: it has expired or was already used.',
      'In the app, tap "Forgot password?" to get a new one.',
    ],
    error: true,
  });

exports.showResetPasswordForm = htmlRoute(async (req, res) => {
  const user = await findUserByResetToken(req.params.token);
  if (!user) return res.status(400).send(invalidResetLinkPage());
  return res.status(200).send(resetPasswordFormPage(req.params.token));
});

exports.resetPassword = htmlRoute(async (req, res) => {
  const { token } = req.params;
  const { password, confirmPassword } = req.body || {};
  const user = await findUserByResetToken(token);
  if (!user) return res.status(400).send(invalidResetLinkPage());

  const refuse = (reason) => res.status(400).send(resetPasswordFormPage(token, reason));
  if (typeof password !== 'string' || typeof confirmPassword !== 'string' || !password) {
    return refuse('Please fill in both password fields.');
  }
  if (password !== confirmPassword) return refuse('The two passwords do not match.');
  const problem = credentials.passwordProblem(password, {
    email: user.email,
    username: user.username,
  });
  if (problem) return refuse(problem);

  const hash = await credentials.hashPassword(password);
  // Consumed atomically: of two simultaneous submissions with the same link only one succeeds.
  const updated = await User.findOneAndUpdate(
    {
      _id: user._id,
      resetPasswordToken: { $in: tokenCandidates(token) },
      resetPasswordExpires: { $gt: new Date() },
    },
    {
      $set: { password: hash, isVerified: true, passwordChangedAt: new Date() },
      // Receiving the link proves the mailbox is theirs: keeps an earlier date when already confirmed.
      $min: { verifiedAt: new Date() },
      $unset: { resetPasswordToken: '', resetPasswordExpires: '' },
    },
    { new: true }
  );
  if (!updated) return res.status(400).send(invalidResetLinkPage());

  sendPasswordChangedNotice(updated);
  return res.status(200).send(
    messagePage({
      title: 'Password updated',
      paragraphs: ['Your password has been updated. You can now log in to BrightMinds with it.'],
    })
  );
});
