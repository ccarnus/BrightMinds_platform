// Cleanup of the retired article content type, on documents saved with the old schema.
const mongoose = require('mongoose');
const User = require('../../models/user_model');
const Topic = require('../../models/topic_model');
const { migrateToCastOnly } = require('../../services/cast_only_migration');
const { useTestDatabase } = require('../helpers/db');

useTestDatabase();

const CAST_ID = '507f1f77bcf86cd799439011';
const ARTICLE_ID = '507f1f77bcf86cd799439012';

const insertUser = async (fields) => {
  const { insertedId } = await User.collection.insertOne({
    email: `legacy_${Math.random()}@example.com`,
    password: 'x',
    username: 'legacy',
    role: 'College Student',
    profilePictureUrl: 'http://api.test/none.png',
    ...fields,
  });
  return insertedId;
};

test('users lose article data and the type discriminators; their stats are renamed', async () => {
  const id = await insertUser({
    articlePublications: [ARTICLE_ID],
    castPublications: [CAST_ID],
    evaluation_list: [
      { contentid: CAST_ID, type: 'cast', watched: true, answered: true },
      { contentid: ARTICLE_ID, type: 'article', watched: true, answered: false },
      { contentid: 'untyped', watched: true, answered: false },
    ],
    bookmarkedcontent: [
      { contentid: CAST_ID, type: 'cast', bookmarkedAt: new Date('2026-01-01') },
      { contentid: ARTICLE_ID, type: 'article', bookmarkedAt: new Date('2026-01-02') },
    ],
    learning: {
      version: 1,
      path: 'explorer',
      stats: {
        contents: 7,
        correctAnswers: 3,
        papers: 1,
        fields: [
          { field: 'Chemistry', contents: 5, correctAnswers: 2, papers: 0 },
          { field: 'Medicine', contents: 2, correctAnswers: 1, papers: 1 },
        ],
      },
    },
  });
  const untouched = await insertUser({
    learning: { version: 1, stats: { casts: 4, correctAnswers: 1, papers: 0, fields: [] } },
  });

  const result = await migrateToCastOnly();
  expect(result.users).toEqual({ references: 1, stats: 1 });

  const user = await User.collection.findOne({ _id: id });
  expect(user.articlePublications).toBeUndefined();
  expect(user.castPublications).toEqual([CAST_ID]);
  expect(user.evaluation_list).toEqual([
    { contentid: CAST_ID, watched: true, answered: true },
    { contentid: 'untyped', watched: true, answered: false },
  ]);
  expect(user.bookmarkedcontent).toEqual([
    { contentid: CAST_ID, bookmarkedAt: new Date('2026-01-01') },
  ]);
  expect(user.learning.stats).toEqual({
    casts: 7,
    correctAnswers: 3,
    papers: 1,
    fields: [
      { field: 'Chemistry', casts: 5, correctAnswers: 2, papers: 0 },
      { field: 'Medicine', casts: 2, correctAnswers: 1, papers: 1 },
    ],
  });
  expect(user.learning.path).toBe('explorer');

  const other = await User.collection.findOne({ _id: untouched });
  expect(other.learning.stats).toEqual({ casts: 4, correctAnswers: 1, papers: 0, fields: [] });

  expect((await migrateToCastOnly()).users).toEqual({ references: 0, stats: 0 });
});

test('users without lists or field stats migrate too', async () => {
  const id = await insertUser({
    articlePublications: [],
    learning: { version: 1, stats: { contents: 2 } },
  });
  await migrateToCastOnly();
  const user = await User.collection.findOne({ _id: id });
  expect(user.learning.stats).toEqual({ casts: 2, fields: [] });
  expect(user.evaluation_list).toEqual([]);
  expect(user.bookmarkedcontent).toEqual([]);
});

test('topics lose article ids; topics that only had articles are deleted', async () => {
  await Topic.collection.insertMany([
    {
      name: 'Mixed',
      departmentName: 'Chemistry',
      castCount: 1,
      castIDs: [new mongoose.Types.ObjectId(CAST_ID)],
      articleCount: 2,
      articleIDs: [new mongoose.Types.ObjectId(ARTICLE_ID)],
    },
    { name: 'Articles only', departmentName: 'Chemistry', castCount: 0, articleCount: 1 },
    { name: 'Manual', departmentName: 'Chemistry', castCount: 0, articleCount: 0 },
  ]);

  const result = await migrateToCastOnly();
  expect(result.topics).toEqual({ deleted: 1, updated: 2 });

  const topics = await Topic.collection.find().sort({ name: 1 }).toArray();
  expect(topics.map((topic) => topic.name)).toEqual(['Manual', 'Mixed']);
  topics.forEach((topic) => {
    expect(topic).not.toHaveProperty('articleCount');
    expect(topic).not.toHaveProperty('articleIDs');
  });
  expect(topics[1].castCount).toBe(1);
});

describe('articles collection', () => {
  const articles = () => mongoose.connection.db.collection('articles');
  const exists = () => mongoose.connection.db.listCollections({ name: 'articles' }).hasNext();

  test('an empty collection is dropped', async () => {
    await mongoose.connection.db.createCollection('articles');
    expect((await migrateToCastOnly()).articlesCollection).toBe('dropped');
    expect(await exists()).toBe(false);
    expect((await migrateToCastOnly()).articlesCollection).toBe('absent');
  });

  test('a collection that still holds articles is kept', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await articles().insertOne({ title: 'Old article' });
    expect((await migrateToCastOnly()).articlesCollection).toBe('kept');
    expect(await articles().countDocuments()).toBe(1);
    jest.restoreAllMocks();
  });
});
