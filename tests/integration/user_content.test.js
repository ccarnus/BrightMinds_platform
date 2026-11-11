const request = require('supertest');
const app = require('../../app');
const User = require('../../models/user_model');
const { useTestDatabase } = require('../helpers/db');
const { createUser, createCast } = require('../helpers/fixtures');

useTestDatabase();

const MISSING_ID = '507f1f77bcf86cd799439011';

describe('evaluation list', () => {
  test('adding a cast marks it watched and counts it once in the learning stats', async () => {
    const user = await createUser();
    const cast = await createCast({ department: 'Chemistry' });

    for (let i = 0; i < 2; i++) {
      await request(app)
        .post(`/user/add/content/${user._id}`)
        .send({ contentId: cast._id.toString() })
        .expect(200);
    }

    const updated = await User.findById(user._id).lean();
    expect(updated.evaluation_list).toHaveLength(1);
    expect(updated.evaluation_list[0]).toEqual({
      _id: expect.anything(),
      contentid: cast._id.toString(),
      watched: true,
      answered: false,
    });
    expect(updated.learning.stats.casts).toBe(1);
    expect(updated.learning.stats.fields).toEqual([
      expect.objectContaining({ field: 'Chemistry', casts: 1 }),
    ]);
  });

  test('stats count per department across casts', async () => {
    const user = await createUser();
    const first = await createCast({ department: 'Chemistry' });
    const second = await createCast({ department: 'Chemistry' });
    for (const cast of [first, second]) {
      await request(app)
        .post(`/user/add/content/${user._id}`)
        .send({ contentId: cast._id })
        .expect(200);
    }
    const updated = await User.findById(user._id).lean();
    expect(updated.learning.stats.casts).toBe(2);
    expect(updated.learning.stats.fields).toEqual([
      expect.objectContaining({ field: 'Chemistry', casts: 2 }),
    ]);
  });

  test('validates cast and user', async () => {
    const user = await createUser();
    const cast = await createCast();
    await request(app).post(`/user/add/content/${user._id}`).send({ contentId: 'bad' }).expect(400);
    await request(app)
      .post(`/user/add/content/${user._id}`)
      .send({ contentId: MISSING_ID })
      .expect(404);
    await request(app)
      .post(`/user/add/content/${MISSING_ID}`)
      .send({ contentId: cast._id })
      .expect(404);
  });

  test('mark as answered, then remove', async () => {
    const user = await createUser({
      evaluation_list: [{ contentid: 'c1', watched: true, answered: false }],
    });

    await request(app)
      .post(`/user/mark/content/as/answered/${user._id}`)
      .send({ contentId: 'c1' })
      .expect(200);
    expect((await User.findById(user._id)).evaluation_list[0].answered).toBe(true);

    await request(app)
      .post(`/user/remove/content/${user._id}`)
      .send({ contentId: 'c1' })
      .expect(200);
    expect((await User.findById(user._id)).evaluation_list).toHaveLength(0);
  });

  test('mark as answered returns 404 without crashing for unknown evaluation or user', async () => {
    const user = await createUser();
    await request(app)
      .post(`/user/mark/content/as/answered/${user._id}`)
      .send({ contentId: 'nope' })
      .expect(404);
    await request(app)
      .post(`/user/mark/content/as/answered/${MISSING_ID}`)
      .send({ contentId: 'x' })
      .expect(404);
    await request(app)
      .post(`/user/remove/content/${MISSING_ID}`)
      .send({ contentId: 'x' })
      .expect(404);
  });
});

describe('bookmarks', () => {
  test('add, list (plain and expanded) and remove', async () => {
    const user = await createUser();
    const first = await createCast();
    const second = await createCast();

    await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ contentId: first._id })
      .expect(201);
    // The cast id is also accepted as `castId`.
    const added = await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ castId: second._id })
      .expect(201);
    expect(added.body.bookmark).toEqual({ contentid: second._id.toString() });

    const plain = await request(app).get(`/user/bookmarks/${user._id}`).expect(200);
    expect(plain.body.map((b) => b.contentid)).toEqual([
      first._id.toString(),
      second._id.toString(),
    ]);
    expect(plain.body[0]).not.toHaveProperty('type');

    const expanded = await request(app).get(`/user/bookmarks/${user._id}?expand=true`).expect(200);
    expect(expanded.body[0].content.title).toBe(first.title);
    expect(expanded.body[1].content.title).toBe(second.title);
    // Bookmarked casts come as cards: no transcript, quiz or processing state.
    expect(expanded.body[0].content).not.toHaveProperty('description');

    await request(app).delete(`/user/remove/bookmarks/${user._id}/${first._id}`).expect(200);
    const after = await request(app).get(`/user/bookmarks/${user._id}`).expect(200);
    expect(after.body).toHaveLength(1);
  });

  test('expanded view leaves deleted casts without content', async () => {
    const cast = await createCast();
    const user = await createUser({
      bookmarkedcontent: [{ contentid: cast._id.toString() }, { contentid: MISSING_ID }],
    });
    const res = await request(app).get(`/user/bookmarks/${user._id}?expand=1`).expect(200);
    expect(res.body[0]).toMatchObject({
      contentid: cast._id.toString(),
      content: expect.objectContaining({ title: cast.title }),
    });
    expect(res.body[1]).toMatchObject({ contentid: MISSING_ID, content: null });
  });

  test('rejects duplicates', async () => {
    const cast = await createCast();
    const user = await createUser({ bookmarkedcontent: [{ contentid: cast._id.toString() }] });
    await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ contentId: cast._id })
      .expect(400);
    expect((await User.findById(user._id)).bookmarkedcontent).toHaveLength(1);
  });

  test('validates input', async () => {
    const user = await createUser();
    const cast = await createCast();
    await request(app).post(`/user/add/bookmarks/${user._id}`).send({}).expect(400);
    await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ contentId: 'bad' })
      .expect(400);
    await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ contentId: MISSING_ID })
      .expect(404);
    await request(app)
      .post(`/user/add/bookmarks/${MISSING_ID}`)
      .send({ contentId: cast._id })
      .expect(404);
    await request(app).delete(`/user/remove/bookmarks/${user._id}/${cast._id}`).expect(404);
  });
});

describe('preferences and suggestions', () => {
  test('positive/negative updates recompute weights as percentages', async () => {
    const user = await createUser();
    const post = (body) =>
      request(app).post(`/user/${user._id}/preferences`).send(body).expect(200);

    await post({ category: 'Chemistry', modification: 'positive' });
    await post({ category: 'Chemistry', modification: 'positive' });
    await post({ category: 'Mathematics', modification: 'positive' });
    const res = await post({ category: 'Mathematics', modification: 'negative' });
    // Negative on an unknown category is ignored.
    await post({ category: 'Energy', modification: 'negative' });

    const byCategory = Object.fromEntries(res.body.preferences.map((p) => [p.category, p]));
    expect(byCategory.Chemistry).toMatchObject({ count: 2, weight: 100 });
    expect(byCategory.Mathematics).toMatchObject({ count: 0, weight: 0 });

    const read = await request(app).get(`/user/${user._id}/preferences`).expect(200);
    expect(read.body.preferences).toHaveLength(2);
  });

  test('validates modification and category', async () => {
    const user = await createUser();
    await request(app)
      .post(`/user/${user._id}/preferences`)
      .send({ category: 'Chemistry', modification: 'up' })
      .expect(400);
    await request(app)
      .post(`/user/${user._id}/preferences`)
      .send({ category: 'Alchemy', modification: 'positive' })
      .expect(400);
  });

  test('suggested casts are ordered by preference weight', async () => {
    const user = await createUser({
      preferences: [
        { category: 'Chemistry', weight: 25, count: 1 },
        { category: 'Mathematics', weight: 75, count: 3 },
      ],
    });
    const chem = await createCast({ department: 'Chemistry' });
    const math = await createCast({ department: 'Mathematics' });
    await createCast({ department: 'Energy' });

    const res = await request(app).get(`/user/${user._id}/suggested/for/you`).expect(200);
    expect(res.body.map((c) => c._id)).toEqual([math._id.toString(), chem._id.toString()]);
  });

  test('suggestions return 404 without preferences', async () => {
    const user = await createUser();
    await request(app).get(`/user/${user._id}/suggested/for/you`).expect(404);
  });
});

describe('legacy tracking (app <= 1.0.5)', () => {
  test('objectives map to learning paths, "DeepLearner" included', async () => {
    const user = await createUser({
      preferences: [{ category: 'Chemistry', weight: 100, count: 1 }],
    });
    for (const objective of ['Deep Learner', 'DeepLearner']) {
      const res = await request(app)
        .put(`/user/${user._id}/update/tracking`)
        .send({ objective })
        .expect(200);
      // progress/target describe the first Deep Learner milestone (3 casts + 2 answers).
      expect(res.body.tracking).toMatchObject({
        objective: 'Deep Learner',
        progress: 0,
        target: 5,
      });
    }
    const saved = await User.findById(user._id).lean();
    expect(saved.learning).toMatchObject({ path: 'deep_learner', focusField: 'Chemistry' });

    const read = await request(app).get(`/user/${user._id}/tracking`).expect(200);
    expect(read.body).toMatchObject({ tracking: { objective: 'Deep Learner' }, target: 5 });
  });

  test('users without a path read as Explorer, with their field history', async () => {
    const user = await createUser({
      learning: { stats: { casts: 2, fields: [{ field: 'Chemistry', casts: 2 }] } },
    });
    const { body } = await request(app).get(`/user/${user._id}/tracking`).expect(200);
    expect(body.tracking).toEqual({
      objective: 'Explorer',
      // Wanderer: 2 fields + 3 casts; 1 field explored and 2 casts so far.
      progress: 3,
      target: 5,
      history: [{ category: 'Chemistry', count: 2 }],
    });
  });

  test('rejects unknown and retired objectives', async () => {
    const user = await createUser();
    for (const objective of ['Napper', 'toString']) {
      await request(app).put(`/user/${user._id}/update/tracking`).send({ objective }).expect(400);
    }
    const res = await request(app)
      .put(`/user/${user._id}/update/tracking`)
      .send({ objective: 'Career' })
      .expect(400);
    expect(res.body.message).toMatch(/Career path is no longer available/);
  });
});

describe('suggestion ordering (matches the previous implementation)', () => {
  test('equal weights keep preference order; duplicate categories use the highest weight', async () => {
    const user = await createUser({
      preferences: [
        { category: 'Mathematics', weight: 10, count: 1 },
        { category: 'Chemistry', weight: 10, count: 1 },
        { category: 'Energy', weight: 5, count: 1 },
        { category: 'Energy', weight: 50, count: 5 },
      ],
    });
    const chem = await createCast({ department: 'Chemistry' });
    const math = await createCast({ department: 'Mathematics' });
    const energy = await createCast({ department: 'Energy' });

    const res = await request(app).get(`/user/${user._id}/suggested/for/you`).expect(200);
    expect(res.body.map((c) => c._id)).toEqual(
      [energy, math, chem].map((cast) => cast._id.toString())
    );
  });
});
