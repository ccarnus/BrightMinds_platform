// Migrates the legacy `tracking` field ({ objective, progress, target, history }) to `learning`.
// Runs at server start and is idempotent: only accounts without `learning.version` are migrated.
const User = require('../models/user_model');
const Cast = require('../models/cast_model');
const Article = require('../models/article_model');
const learning = require('./learning');
const { isValidObjectId } = require('../utils/http');

const CONTENT_MODELS = { cast: Cast, article: Article };

/**
 * Correct answers per department. The legacy app marked only correctly answered content as
 * "answered", so answered evaluation-list items are the user's past correct answers.
 */
const correctAnswersByField = async (answered) => {
  const counts = new Map();
  await Promise.all(
    Object.entries(CONTENT_MODELS).map(async ([type, Model]) => {
      // Old items may have no type: look them up in both collections.
      const ids = answered
        .filter((item) => !item.type || item.type === type)
        .map((item) => item.contentid)
        .filter(isValidObjectId);
      if (ids.length === 0) return;
      const docs = await Model.find({ _id: { $in: ids } })
        .select('department')
        .lean();
      docs.forEach((doc) => counts.set(doc.department, (counts.get(doc.department) || 0) + 1));
    })
  );
  return counts;
};

/** The `learning` document for a raw legacy user document. */
const buildLearning = async (doc, now) => {
  const tracking = doc.tracking || {};
  const fields = new Map();
  const fieldEntry = (field) => {
    if (!fields.has(field)) fields.set(field, { field, contents: 0, correctAnswers: 0, papers: 0 });
    return fields.get(field);
  };
  (tracking.history || []).forEach(({ category, count }) => {
    if (category) fieldEntry(category).contents += count || 0;
  });
  const answered = (doc.evaluation_list || []).filter((item) => item?.answered);
  (await correctAnswersByField(answered)).forEach((count, field) => {
    fieldEntry(field).correctAnswers += count;
  });

  const stats = {
    contents: [...fields.values()].reduce((sum, entry) => sum + entry.contents, 0),
    correctAnswers: Math.max(answered.length, tracking.progress || 0),
    papers: 0,
    fields: [...fields.values()],
  };
  const path = learning.legacyPathKey(tracking.objective);
  const result = {
    version: learning.LEARNING_VERSION,
    path,
    focusField: learning.getPath(path).usesFocusField
      ? learning.defaultFocusField(doc.preferences, { stats })
      : null,
    startedAt: now,
    stats,
    paperIds: [],
    milestones: [],
    history: [],
  };
  // Activity done before the migration already reached these milestones.
  result.milestones = learning.pendingMilestones(result, now);
  return result;
};

/** Returns the number of migrated accounts. */
const migrateLearningProfiles = async (now = new Date()) => {
  const pending = { 'learning.version': { $exists: false } };
  const cursor = User.collection.find(pending, {
    projection: { tracking: 1, evaluation_list: 1, preferences: 1 },
  });
  let migrated = 0;
  for await (const doc of cursor) {
    const result = await User.collection.updateOne(
      { _id: doc._id, ...pending },
      { $set: { learning: await buildLearning(doc, now) }, $unset: { tracking: '' } }
    );
    migrated += result.modifiedCount;
  }
  return migrated;
};

module.exports = { migrateLearningProfiles, buildLearning };
