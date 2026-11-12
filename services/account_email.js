// Sends the emails with a link (email confirmation, password reset) and keeps them from being abused:
// at most one per cooldown and a few per hour for each user and kind, whatever the number of requests.
const User = require('../models/user_model');
const config = require('../config');
const { sendMail } = require('./mailer');
const { generateToken } = require('./email_tokens');
const emails = require('../views/emails');

const HOUR_MS = 60 * 60 * 1000;

const KINDS = {
  verification: {
    tokenField: 'verificationToken',
    expiresField: 'verificationExpires',
    ttl: () => config.account.verificationTtlMs,
    build: emails.verificationEmail,
  },
  reset: {
    tokenField: 'resetPasswordToken',
    expiresField: 'resetPasswordExpires',
    ttl: () => config.account.resetTtlMs,
    build: emails.passwordResetEmail,
  },
};

const secondsUntil = (when, now) => Math.max(1, Math.ceil((when - now) / 1000));

/** Works out the throttle entry after one more email, or the delay before another is allowed. */
const nextThrottle = (entry = {}, now) => {
  const last = entry.lastAt ? entry.lastAt.getTime() : 0;
  const cooldownEnd = last + config.account.emailCooldownMs;
  if (last && now < cooldownEnd) return { retryAfterSeconds: secondsUntil(cooldownEnd, now) };

  const windowStart = entry.windowStart ? entry.windowStart.getTime() : 0;
  const inWindow = windowStart && now - windowStart < HOUR_MS;
  if (inWindow && entry.count >= config.account.emailMaxPerHour) {
    return { retryAfterSeconds: secondsUntil(windowStart + HOUR_MS, now) };
  }
  return {
    lastAt: new Date(now),
    windowStart: new Date(inWindow ? windowStart : now),
    count: inWindow ? (entry.count || 0) + 1 : 1,
  };
};

const restoreThrottle = (userId, kind, previous, claimedAt) => {
  const path = `mailThrottle.${kind}`;
  const set = {};
  const unset = {};
  ['lastAt', 'windowStart', 'count'].forEach((key) => {
    if (previous?.[key] === undefined || previous?.[key] === null) unset[`${path}.${key}`] = '';
    else set[`${path}.${key}`] = previous[key];
  });
  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;
  return User.updateOne({ _id: userId, [`${path}.lastAt`]: claimedAt }, update);
};

/**
 * Emails a fresh link of `kind` ('verification' | 'reset') to the user.
 * With `background`, the send is not awaited; with `waitMs`, it is awaited at most that long.
 * @returns {Promise<{status: 'sent'|'pending'|'throttled'|'failed', retryAfterSeconds?: number,
 *   errorKind?: string}>}
 */
const issueEmail = async (user, kind, { waitMs, background = false } = {}) => {
  const spec = KINDS[kind];
  const now = Date.now();
  const previous = user.mailThrottle?.[kind];
  const next = nextThrottle(previous, now);
  if (next.retryAfterSeconds)
    return { status: 'throttled', retryAfterSeconds: next.retryAfterSeconds };

  const { token, hash } = generateToken();
  const path = `mailThrottle.${kind}`;
  // Only one of several simultaneous requests finds the previous `lastAt` still in place.
  const claim = await User.updateOne(
    { _id: user._id, [`${path}.lastAt`]: previous?.lastAt ?? null },
    {
      $set: {
        [spec.tokenField]: hash,
        [spec.expiresField]: new Date(now + spec.ttl()),
        [`${path}.lastAt`]: next.lastAt,
        [`${path}.windowStart`]: next.windowStart,
        [`${path}.count`]: next.count,
      },
    }
  );
  if (claim.modifiedCount === 0) {
    return {
      status: 'throttled',
      retryAfterSeconds: Math.ceil(config.account.emailCooldownMs / 1000),
    };
  }

  const send = sendMail({ to: user.email, ...spec.build({ username: user.username, token }) }).then(
    () => ({ status: 'sent' }),
    async (error) => {
      console.error(`Could not send the ${kind} email to user ${user._id}: ${error.message}`);
      await restoreThrottle(user._id, kind, previous, next.lastAt).catch(() => {});
      return { status: 'failed', errorKind: error.kind || 'unknown' };
    }
  );

  if (background) return { status: 'pending', done: send };
  if (!waitMs) return send;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ status: 'pending', done: send }), waitMs);
  });
  try {
    return await Promise.race([send, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Tells the user their password changed (best effort: it never fails the request). */
const sendPasswordChangedNotice = (user) =>
  sendMail({ to: user.email, ...emails.passwordChangedEmail({ username: user.username }) }).catch(
    (error) => console.error(`Could not send the password-changed notice: ${error.message}`)
  );

module.exports = { issueEmail, sendPasswordChangedNotice };
