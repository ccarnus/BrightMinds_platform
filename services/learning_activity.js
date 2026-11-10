// Atomic learning-activity writes, safe when several requests update the same user at once.
const User = require('../models/user_model');
const learning = require('./learning');

/** Adds `amount` to a per-field stat, creating the field entry when needed. */
const incrementFieldStat = async (userId, field, stat, amount = 1) => {
  if (!field) return;
  const counter = `learning.stats.fields.$.${stat}`;
  const existing = await User.updateOne(
    { _id: userId, 'learning.stats.fields.field': field },
    { $inc: { [counter]: amount } }
  );
  if (existing.matchedCount > 0) return;
  const added = await User.updateOne(
    { _id: userId, 'learning.stats.fields.field': { $ne: field } },
    {
      $push: {
        'learning.stats.fields': {
          field,
          contents: 0,
          correctAnswers: 0,
          papers: 0,
          [stat]: amount,
        },
      },
    }
  );
  // Another request created the entry in between: count on it instead.
  if (added.matchedCount === 0) {
    await User.updateOne(
      { _id: userId, 'learning.stats.fields.field': field },
      { $inc: { [counter]: amount } }
    );
  }
};

/** Records the milestones newly reached on the user's path; each one is reported once. */
const recordUserMilestones = async (userId, now = new Date()) => {
  const user = await User.findById(userId, 'learning');
  if (!user) return [];
  const recorded = [];
  for (const record of learning.pendingMilestones(user.learning, now)) {
    const result = await User.updateOne(
      {
        _id: userId,
        $nor: [
          {
            'learning.milestones': {
              $elemMatch: { path: record.path, focusField: record.focusField, level: record.level },
            },
          },
        ],
      },
      { $push: { 'learning.milestones': record } }
    );
    if (result.modifiedCount > 0) recorded.push(learning.describeMilestone(record));
  }
  return recorded;
};

/** A cast watched or an article read for the first time, in its department. */
const recordContentConsumed = async (userId, field) => {
  await User.updateOne({ _id: userId }, { $inc: { 'learning.stats.contents': 1 } });
  await incrementFieldStat(userId, field, 'contents');
  return recordUserMilestones(userId);
};

/** Counts an opened research paper once per user; `recorded` is false when already counted. */
const recordPaperOpened = async (userId, paperId, field) => {
  const result = await User.updateOne(
    { _id: userId, 'learning.paperIds': { $ne: paperId } },
    {
      $push: { 'learning.paperIds': { $each: [paperId], $slice: -learning.MAX_PAPER_IDS } },
      $inc: { 'learning.stats.papers': 1 },
    }
  );
  if (result.matchedCount === 0) return { recorded: false, newMilestones: [] };
  await incrementFieldStat(userId, field, 'papers');
  return { recorded: true, newMilestones: await recordUserMilestones(userId) };
};

module.exports = {
  incrementFieldStat,
  recordUserMilestones,
  recordContentConsumed,
  recordPaperOpened,
};
