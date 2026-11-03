const request = require('supertest');
const app = require('../../app');
const User = require('../../models/user_model');
const { useTestDatabase } = require('../helpers/db');
const { createUser, createCast, createArticle } = require('../helpers/fixtures');

useTestDatabase();

const MISSING_ID = '507f1f77bcf86cd799439011';

describe('evaluation list', () => {
  test('adding content marks it watched and counts it once in tracking history', async () => {
    const user = await createUser();
    const cast = await createCast({ department: 'Chemistry' });

    for (let i = 0; i < 2; i++) {
      await request(app)
        .post(`/user/add/content/${user._id}`)
        .send({ contentId: cast._id.toString(), type: 'cast' })
        .expect(200);
    }

    const updated = await User.findById(user._id).lean();
    expect(updated.evaluation_list).toHaveLength(1);
    expect(updated.evaluation_list[0]).toMatchObject({
      contentid: cast._id.toString(),
      watched: true,
      answered: false,
    });
    expect(updated.tracking.history).toEqual([
      expect.objectContaining({ category: 'Chemistry', count: 1 }),
    ]);
  });

  test('history counts per department across content', async () => {
    const user = await createUser();
    const article = await createArticle({ department: 'Chemistry' });
    const cast = await createCast({ department: 'Chemistry' });
    await request(app)
      .post(`/user/add/content/${user._id}`)
      .send({ contentId: article._id, type: 'article' })
      .expect(200);
    await request(app)
      .post(`/user/add/content/${user._id}`)
      .send({ contentId: cast._id, type: 'cast' })
      .expect(200);
    const updated = await User.findById(user._id).lean();
    expect(updated.tracking.history[0].count).toBe(2);
  });

  test('validates type, content and user', async () => {
    const user = await createUser();
    const cast = await createCast();
    await request(app)
      .post(`/user/add/content/${user._id}`)
      .send({ contentId: cast._id, type: 'video' })
      .expect(400);
    await request(app)
      .post(`/user/add/content/${user._id}`)
      .send({ contentId: 'bad', type: 'cast' })
      .expect(400);
    await request(app)
      .post(`/user/add/content/${user._id}`)
      .send({ contentId: MISSING_ID, type: 'cast' })
      .expect(404);
    await request(app)
      .post(`/user/add/content/${MISSING_ID}`)
      .send({ contentId: cast._id, type: 'cast' })
      .expect(404);
  });

  test('mark as answered, then remove', async () => {
    const user = await createUser({
      evaluation_list: [{ contentid: 'c1', type: 'cast', watched: true, answered: false }],
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
    const cast = await createCast();
    const article = await createArticle();

    await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ contentId: cast._id, type: 'cast' })
      .expect(201);
    // Type is inferred when omitted.
    const inferred = await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ articleId: article._id })
      .expect(201);
    expect(inferred.body.bookmark.type).toBe('article');

    const plain = await request(app).get(`/user/bookmarks/${user._id}`).expect(200);
    expect(plain.body.map((b) => b.type)).toEqual(['cast', 'article']);

    const expanded = await request(app).get(`/user/bookmarks/${user._id}?expand=true`).expect(200);
    expect(expanded.body[0].content.title).toBe(cast.title);
    expect(expanded.body[1].content.title).toBe(article.title);

    await request(app).delete(`/user/remove/bookmarks/${user._id}/${cast._id}`).expect(200);
    const after = await request(app).get(`/user/bookmarks/${user._id}`).expect(200);
    expect(after.body).toHaveLength(1);
  });

  test('expanded view resolves legacy bookmarks without a type', async () => {
    const cast = await createCast();
    const user = await createUser({
      bookmarkedcontent: [{ contentid: cast._id.toString() }, { contentid: MISSING_ID }],
    });
    const res = await request(app).get(`/user/bookmarks/${user._id}?expand=1`).expect(200);
    expect(res.body[0]).toMatchObject({
      type: 'cast',
      content: expect.objectContaining({ title: cast.title }),
    });
    expect(res.body[1]).toMatchObject({ type: null, content: null });
  });

  test('rejects duplicates and backfills a missing type', async () => {
    const cast = await createCast();
    const user = await createUser({ bookmarkedcontent: [{ contentid: cast._id.toString() }] });
    await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ contentId: cast._id, type: 'cast' })
      .expect(400);
    expect((await User.findById(user._id)).bookmarkedcontent[0].type).toBe('cast');
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
      .send({ contentId: cast._id, type: 'video' })
      .expect(400);
    await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ contentId: MISSING_ID })
      .expect(404);
    await request(app)
      .post(`/user/add/bookmarks/${user._id}`)
      .send({ contentId: cast._id, type: 'article' })
      .expect(404);
    await request(app)
      .post(`/user/add/bookmarks/${MISSING_ID}`)
      .send({ contentId: cast._id })
      .expect(404);
    await request(app).delete(`/user/remove/bookmarks/${user._id}/${cast._id}`).expect(404);
    await request(app)
      .delete(`/user/remove/bookmarks/${user._id}/${cast._id}?type=video`)
      .expect(400);
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

describe('tracking', () => {
  test('updating the objective sets the matching target', async () => {
    const user = await createUser();
    const res = await request(app)
      .put(`/user/${user._id}/update/tracking`)
      .send({ objective: 'Deep Learner' })
      .expect(200);
    expect(res.body.tracking).toMatchObject({ objective: 'Deep Learner', target: 20 });

    const read = await request(app).get(`/user/${user._id}/tracking`).expect(200);
    expect(read.body.target).toBe(20);
  });

  test('rejects unknown objectives', async () => {
    const user = await createUser();
    await request(app)
      .put(`/user/${user._id}/update/tracking`)
      .send({ objective: 'Napper' })
      .expect(400);
  });

  test('inherited object keys are not valid objectives', async () => {
    const user = await createUser();
    await request(app)
      .put(`/user/${user._id}/update/tracking`)
      .send({ objective: 'toString' })
      .expect(400);
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
