// Removes what the retired "article" content type left in the database, and renames the learning
// stat `contents` to `casts` (casts are the only content now).
// Runs at server start and is idempotent: every step only touches documents that still have the old shape.
const mongoose = require('mongoose');
const User = require('../models/user_model');
const Topic = require('../models/topic_model');

// Casts of the evaluation list / bookmarks lose their `type` (always "cast"); article entries go.
const dropTypeFrom = (list, extraField) => ({
  $map: {
    input: {
      $filter: {
        input: { $ifNull: [list, []] },
        as: 'item',
        cond: { $ne: ['$$item.type', 'article'] },
      },
    },
    as: 'item',
    in: {
      contentid: '$$item.contentid',
      ...extraField.reduce((fields, name) => ({ ...fields, [name]: `$$item.${name}` }), {}),
    },
  },
});

/** Users: article references and `type` discriminators removed, `contents` stats renamed `casts`. */
const migrateUsers = async () => {
  const users = User.collection;
  const oldShape = {
    $or: [
      { articlePublications: { $exists: true } },
      { 'evaluation_list.type': { $exists: true } },
      { 'bookmarkedcontent.type': { $exists: true } },
    ],
  };
  const references = await users.updateMany(oldShape, [
    {
      $set: {
        evaluation_list: dropTypeFrom('$evaluation_list', ['watched', 'answered']),
        bookmarkedcontent: dropTypeFrom('$bookmarkedcontent', ['bookmarkedAt']),
      },
    },
    { $unset: 'articlePublications' },
  ]);

  const stats = await users.updateMany({ 'learning.stats.contents': { $exists: true } }, [
    {
      $set: {
        'learning.stats': {
          $mergeObjects: [
            '$learning.stats',
            {
              casts: { $ifNull: ['$learning.stats.casts', '$learning.stats.contents'] },
              fields: {
                $map: {
                  input: { $ifNull: ['$learning.stats.fields', []] },
                  as: 'entry',
                  in: {
                    field: '$$entry.field',
                    casts: { $ifNull: ['$$entry.casts', '$$entry.contents', 0] },
                    correctAnswers: { $ifNull: ['$$entry.correctAnswers', 0] },
                    papers: { $ifNull: ['$$entry.papers', 0] },
                  },
                },
              },
            },
          ],
        },
      },
    },
    { $unset: 'learning.stats.contents' },
  ]);
  return { references: references.modifiedCount, stats: stats.modifiedCount };
};

/** Topics: article ids and counts removed; topics that only had articles are deleted. */
const migrateTopics = async () => {
  const topics = Topic.collection;
  const emptied = await topics.deleteMany({
    articleCount: { $gt: 0 },
    $or: [{ castCount: { $lte: 0 } }, { castCount: { $exists: false } }],
  });
  const cleaned = await topics.updateMany(
    { $or: [{ articleIDs: { $exists: true } }, { articleCount: { $exists: true } }] },
    { $unset: { articleIDs: '', articleCount: '' } }
  );
  return { deleted: emptied.deletedCount, updated: cleaned.modifiedCount };
};

/** Drops the `articles` collection when it is empty; one still holding articles is kept (and reported). */
const dropArticlesCollection = async () => {
  const exists = await mongoose.connection.db.listCollections({ name: 'articles' }).hasNext();
  if (!exists) return 'absent';
  const articles = mongoose.connection.db.collection('articles');
  if ((await articles.estimatedDocumentCount()) > 0) {
    console.warn('The "articles" collection still holds documents: left untouched.');
    return 'kept';
  }
  await articles.drop();
  return 'dropped';
};

/** @returns {Promise<object>} What each step changed (all zeros once migrated). */
const migrateToCastOnly = async () => ({
  users: await migrateUsers(),
  topics: await migrateTopics(),
  articlesCollection: await dropArticlesCollection(),
});

module.exports = { migrateToCastOnly };
