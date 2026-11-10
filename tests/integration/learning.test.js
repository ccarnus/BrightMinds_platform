const request = require('supertest');
const app = require('../../app');
const User = require('../../models/user_model');
const { useTestDatabase } = require('../helpers/db');
const { createUser, createCast, createArticle } = require('../helpers/fixtures');
const { migrateLearningProfiles } = require('../../services/learning_migration');

useTestDatabase();

const MISSING_ID = '507f1f77bcf86cd799439011';
const evaluation = (correct) => ({ question: 'Q?', responses: ['A', 'B'], correct });
const learningOf = async (user) => (await User.findById(user._id).lean()).learning;

describe('GET /learning/paths', () => {
  test('lists the paths and their milestones without authentication', async () => {
    const { body } = await request(app).get('/learning/paths').expect(200);
    expect(body.paths.map((path) => path.key)).toEqual([
      'follower',
      'explorer',
      'deep_learner',
      'researcher',
    ]);
    expect(body.paths[1].milestones[0]).toEqual({
      level: 1,
      title: 'Wanderer',
      goals: [
        { metric: 'fields', label: 'Fields explored', target: 2 },
        { metric: 'contents', label: 'Casts & articles', target: 3 },
      ],
    });
  });
});

describe('GET / PUT /user/:id/learning', () => {
  test('a new user has no path yet', async () => {
    const user = await createUser();
    const { body } = await request(app).get(`/user/${user._id}/learning`).expect(200);
    expect(body).toMatchObject({
      path: null,
      focusField: null,
      journey: null,
      history: [],
      stats: { contents: 0, correctAnswers: 0, papers: 0, fieldsExplored: 0, fields: [] },
    });
  });

  test('choosing a path; Deep Learner focuses on the top preference by default', async () => {
    const user = await createUser({
      preferences: [
        { category: 'Medicine', weight: 25, count: 1 },
        { category: 'Chemistry', weight: 75, count: 3 },
      ],
    });
    const { body } = await request(app)
      .put(`/user/${user._id}/learning`)
      .send({ path: 'deep_learner' })
      .expect(200);
    expect(body.message).toBe('Learning path updated.');
    expect(body.learning).toMatchObject({
      path: 'deep_learner',
      title: 'Deep Learner',
      focusField: 'Chemistry',
      journey: { level: 0, total: 5, next: { title: 'Initiate' } },
    });
    expect(body.newMilestones).toEqual([]);

    const again = await request(app)
      .put(`/user/${user._id}/learning`)
      .send({ path: 'Deep Learner', focusField: 'Chemistry' })
      .expect(200);
    expect(again.body.message).toBe('Learning path unchanged.');
  });

  test('switching keeps the progress, archives the previous path and reports reached milestones', async () => {
    const user = await createUser({
      learning: {
        path: 'follower',
        startedAt: new Date('2026-01-01'),
        stats: {
          contents: 6,
          correctAnswers: 2,
          fields: [
            { field: 'Chemistry', contents: 4, correctAnswers: 2 },
            { field: 'Medicine', contents: 2 },
          ],
        },
      },
    });
    const { body } = await request(app)
      .put(`/user/${user._id}/learning`)
      .send({ path: 'explorer' })
      .expect(200);
    expect(body.newMilestones).toEqual([
      expect.objectContaining({ path: 'explorer', level: 1, title: 'Wanderer', total: 5 }),
    ]);
    expect(body.learning.journey).toMatchObject({ level: 1, next: { title: 'Pathfinder' } });
    expect(body.learning.history).toEqual([
      expect.objectContaining({ path: 'follower', title: 'Follower', milestonesReached: 0 }),
    ]);
    expect(body.learning.stats).toMatchObject({ contents: 6, fieldsExplored: 2 });
  });

  test('validates the path, the focus field and the user', async () => {
    const user = await createUser();
    const put = (id, payload) => request(app).put(`/user/${id}/learning`).send(payload);
    await put(user._id, {}).expect(400);
    await put(user._id, { path: 'napper' }).expect(400);
    const retired = await put(user._id, { path: 'Career' }).expect(400);
    expect(retired.body.message).toMatch(/no longer available/);
    await put(user._id, { path: 'deep_learner', focusField: 'Alchemy' }).expect(400);
    await put(MISSING_ID, { path: 'explorer' }).expect(404);
    await request(app).get(`/user/${MISSING_ID}/learning`).expect(404);
  });

  test('the learning profile cannot be edited through the profile update', async () => {
    const user = await createUser();
    await request(app)
      .put(`/user/${user._id}`)
      .send({
        learning: { path: 'researcher', stats: { contents: 999 } },
        tracking: { progress: 99 },
      })
      .expect(200);
    const saved = await User.findById(user._id).lean();
    expect(saved.learning.path).toBeUndefined();
    expect(saved.learning.stats.contents).toBe(0);
    expect(saved.tracking).toBeUndefined();
  });
});

describe('activity', () => {
  test('watching content can reach a milestone', async () => {
    const user = await createUser({ learning: { path: 'explorer' } });
    const contents = await Promise.all([
      createCast({ department: 'Chemistry' }),
      createCast({ department: 'Medicine' }),
      createArticle({ department: 'Medicine' }),
    ]);
    const responses = [];
    for (const [index, content] of contents.entries()) {
      const res = await request(app)
        .post(`/user/add/content/${user._id}`)
        .send({ contentId: content._id, type: index < 2 ? 'cast' : 'article' })
        .expect(200);
      responses.push(res.body.newMilestones);
    }
    expect(responses[0]).toEqual([]);
    expect(responses[2]).toEqual([expect.objectContaining({ title: 'Wanderer', level: 1 })]);
    const saved = await learningOf(user);
    expect(saved.milestones).toEqual([
      expect.objectContaining({ path: 'explorer', level: 1, reachedAt: expect.any(Date) }),
    ]);
  });

  test('opened papers count once, per field, and feed the Researcher path', async () => {
    const user = await createUser({
      learning: { path: 'researcher', stats: { correctAnswers: 2 } },
    });
    const open = (payload) => request(app).post(`/user/${user._id}/learning/papers`).send(payload);

    const first = await open({ paperId: 'https://openalex.org/W100', field: 'Chemistry' }).expect(
      200
    );
    expect(first.body).toEqual({ recorded: true, newMilestones: [] });
    expect((await open({ paperId: 'W100' }).expect(200)).body.recorded).toBe(false);
    const second = await open({ paperId: 'w200' }).expect(200);
    expect(second.body.newMilestones).toEqual([
      expect.objectContaining({ path: 'researcher', title: 'Curious Reader' }),
    ]);

    const saved = await User.findById(user._id).lean();
    expect(saved.learning.paperIds).toEqual(['W100', 'W200']);
    expect(saved.learning.stats.papers).toBe(2);
    expect(saved.learning.stats.fields).toEqual([
      expect.objectContaining({ field: 'Chemistry', papers: 1 }),
    ]);

    // Paper ids stay private.
    const { body } = await request(app).get(`/user/${user._id}`).expect(200);
    expect(body.learning.paperIds).toBeUndefined();
  });

  test('validates papers', async () => {
    const user = await createUser();
    const open = (id, payload) => request(app).post(`/user/${id}/learning/papers`).send(payload);
    await open(user._id, {}).expect(400);
    await open(user._id, { paperId: 'https://evil.com/W1' }).expect(400);
    await open(user._id, { paperId: 'W1', field: 'Alchemy' }).expect(400);
    await open(MISSING_ID, { paperId: 'W1' }).expect(404);
  });

  test('a quiz counts correct answers in the focus field and reports the milestone', async () => {
    const casts = await Promise.all([
      createCast({ department: 'Chemistry', evaluation: evaluation('A') }),
      createCast({ department: 'Chemistry', evaluation: evaluation('A') }),
    ]);
    const user = await createUser({
      learning: {
        path: 'deep_learner',
        focusField: 'Chemistry',
        stats: { contents: 3, fields: [{ field: 'Chemistry', contents: 3 }] },
      },
      evaluation_list: casts.map((cast) => ({
        contentid: cast._id.toString(),
        type: 'cast',
        watched: true,
        answered: false,
      })),
    });
    const { body } = await request(app)
      .post(`/user/${user._id}/quiz`)
      .send({ answers: casts.map((cast) => ({ contentId: cast._id.toString(), response: 'A' })) })
      .expect(200);
    expect(body.newMilestones).toEqual([
      expect.objectContaining({ path: 'deep_learner', focusField: 'Chemistry', title: 'Initiate' }),
    ]);
    expect(body.newBadges.map((badge) => badge.key)).toContain('objective_reached');
    const saved = await learningOf(user);
    expect(saved.stats.correctAnswers).toBe(2);
    expect(saved.stats.fields[0]).toMatchObject({ field: 'Chemistry', correctAnswers: 2 });
  });
});

describe('path-aware suggestions', () => {
  const suggestions = async (user) =>
    (await request(app).get(`/user/${user._id}/suggested/for/you`).expect(200)).body.map(
      (cast) => cast.title
    );

  test('Explorer: best-rated casts from unexplored fields, then explored preferred fields', async () => {
    await createCast({ title: 'chem', department: 'Chemistry' });
    await createCast({ title: 'energy-low', department: 'Energy', rating: { value: 3 } });
    await createCast({ title: 'energy-top', department: 'Energy', rating: { value: 9 } });
    await createCast({ title: 'math', department: 'Mathematics', rating: { value: 6 } });
    const user = await createUser({
      preferences: [{ category: 'Chemistry', weight: 100, count: 1 }],
      learning: { path: 'explorer', stats: { fields: [{ field: 'Chemistry', contents: 2 }] } },
    });
    expect(await suggestions(user)).toEqual(['energy-top', 'math', 'energy-low', 'chem']);

    // Explorers get suggestions even without preferences.
    const newcomer = await createUser({ learning: { path: 'explorer' } });
    expect(await suggestions(newcomer)).toHaveLength(4);
  });

  test('Follower: newest casts from the preferred fields', async () => {
    await createCast({ title: 'old', department: 'Chemistry', dateadded: new Date('2025-01-01') });
    await createCast({ title: 'new', department: 'Medicine', dateadded: new Date('2026-06-01') });
    await createCast({ title: 'other', department: 'Energy' });
    const user = await createUser({
      preferences: [
        { category: 'Chemistry', weight: 80, count: 4 },
        { category: 'Medicine', weight: 20, count: 1 },
      ],
      learning: { path: 'follower' },
    });
    expect(await suggestions(user)).toEqual(['new', 'old']);
  });

  test('Deep Learner: the focus field first, even outside the preferences', async () => {
    await createCast({ title: 'chem', department: 'Chemistry' });
    await createCast({ title: 'energy', department: 'Energy' });
    const user = await createUser({
      preferences: [{ category: 'Chemistry', weight: 100, count: 1 }],
      learning: { path: 'deep_learner', focusField: 'Energy' },
    });
    expect(await suggestions(user)).toEqual(['energy', 'chem']);
  });
});

describe('migration from the legacy tracking field', () => {
  const insertLegacyUser = async (fields) => {
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

  test('converts tracking into a learning profile, once', async () => {
    const chem = await createCast({ department: 'Chemistry' });
    const article = await createArticle({ department: 'Medicine' });
    const deepId = await insertLegacyUser({
      tracking: {
        objective: 'DeepLearner',
        progress: 0,
        target: 20,
        history: [
          { category: 'Chemistry', count: 4 },
          { category: 'Medicine', count: 1 },
        ],
      },
      preferences: [{ category: 'Chemistry', weight: 100, count: 1 }],
      evaluation_list: [
        { contentid: chem._id.toString(), type: 'cast', watched: true, answered: true },
        { contentid: article._id.toString(), watched: true, answered: true },
        { contentid: 'deleted', type: 'cast', watched: true, answered: true },
        { contentid: chem._id.toString(), type: 'cast', watched: true, answered: false },
      ],
    });
    const careerId = await insertLegacyUser({ tracking: { objective: 'Career', history: [] } });
    const now = new Date('2026-11-10T12:00:00Z');

    expect(await migrateLearningProfiles(now)).toBe(2);
    expect(await migrateLearningProfiles(now)).toBe(0);

    const deep = await User.collection.findOne({ _id: deepId });
    expect(deep.tracking).toBeUndefined();
    expect(deep.learning).toMatchObject({
      version: 1,
      path: 'deep_learner',
      focusField: 'Chemistry',
      startedAt: now,
      stats: { contents: 5, correctAnswers: 3, papers: 0 },
    });
    expect(deep.learning.stats.fields).toEqual([
      { field: 'Chemistry', contents: 4, correctAnswers: 1, papers: 0 },
      { field: 'Medicine', contents: 1, correctAnswers: 1, papers: 0 },
    ]);
    // 4 contents in Chemistry but 1 correct answer: Initiate (3 + 2) is not reached yet.
    expect(deep.learning.milestones).toEqual([]);

    const career = await User.collection.findOne({ _id: careerId });
    expect(career.learning).toMatchObject({ path: 'explorer', focusField: null });

    // Migrated accounts work with the API.
    const { body } = await request(app).get(`/user/${deepId}/learning`).expect(200);
    expect(body.journey.next.goals).toEqual([
      expect.objectContaining({ metric: 'contents', current: 4, target: 3 }),
      expect.objectContaining({ metric: 'correctAnswers', current: 1, target: 2 }),
    ]);
  });
});
