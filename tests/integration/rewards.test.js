const request = require('supertest');
const app = require('../../app');
const User = require('../../models/user_model');
const { useTestDatabase } = require('../helpers/db');
const { createUser, createCast, createArticle } = require('../helpers/fixtures');

useTestDatabase();

const MISSING_ID = '507f1f77bcf86cd799439011';
const evaluation = (correct) => ({ question: 'Q?', responses: ['A', 'B', 'C'], correct });

/** A user with three watched-but-unanswered questions (two casts and one article). */
const setupQuiz = async () => {
  const casts = await Promise.all([
    createCast({ evaluation: evaluation('A') }),
    createCast({ evaluation: evaluation('B') }),
  ]);
  const article = await createArticle({ evaluation: evaluation('C') });
  const items = [
    { contentid: casts[0]._id.toString(), type: 'cast' },
    { contentid: casts[1]._id.toString(), type: 'cast' },
    { contentid: article._id.toString(), type: 'article' },
  ];
  const user = await createUser({
    evaluation_list: items.map((item) => ({ ...item, watched: true, answered: false })),
  });
  return { user, ids: items.map((item) => item.contentid) };
};

describe('POST /user/:id/quiz', () => {
  test('grades against the stored answers and awards XP, streak and badges', async () => {
    const { user, ids } = await setupQuiz();

    const { body } = await request(app)
      .post(`/user/${user._id}/quiz`)
      .send({
        answers: [
          { contentId: ids[0], response: 'A' },
          { contentId: ids[1], response: 'B' },
          { contentId: ids[2], response: 'A' },
        ],
        utcOffsetMinutes: 60,
      })
      .expect(200);

    expect(
      body.results.map(({ correct, correctAnswer, xp }) => ({ correct, correctAnswer, xp }))
    ).toEqual([
      { correct: true, correctAnswer: 'A', xp: 10 },
      { correct: true, correctAnswer: 'B', xp: 15 },
      { correct: false, correctAnswer: 'C', xp: 2 },
    ]);
    expect(body.summary).toEqual({ total: 3, correct: 2, bestCombo: 2, perfect: false });
    // 20 answers + 2 effort + 5 combo + 5 first streak day
    expect(body.xpEarned).toBe(32);
    expect(body.previous).toMatchObject({ xp: 0, level: 1 });
    expect(body.newBadges.map((badge) => badge.key)).toEqual(['first_quiz']);
    expect(body.rewards).toMatchObject({
      xp: 32,
      level: 1,
      streak: { current: 1, completedToday: true },
    });

    const saved = await User.findById(user._id).lean();
    expect(saved.evaluation_list.map((item) => item.answered)).toEqual([true, true, false]);
    expect(saved.tracking.progress).toBe(2);
    expect(saved.rewards.badges).toEqual([expect.objectContaining({ key: 'first_quiz' })]);
  });

  test('answered or unknown content earns nothing on a replay', async () => {
    const { user, ids } = await setupQuiz();
    const answers = [
      { contentId: ids[0], response: 'A' },
      { contentId: MISSING_ID, response: 'A' },
    ];
    await request(app).post(`/user/${user._id}/quiz`).send({ answers }).expect(200);

    const { body } = await request(app)
      .post(`/user/${user._id}/quiz`)
      .send({ answers })
      .expect(200);
    expect(body.results).toEqual([]);
    expect(body.xpEarned).toBe(0);
    const saved = await User.findById(user._id).lean();
    expect(saved.rewards.quizzesCompleted).toBe(1);
  });

  test('resending the same quiz id earns nothing (retry after a lost response)', async () => {
    const { user, ids } = await setupQuiz();
    const payload = {
      quizId: 'quiz-retry-1',
      answers: [
        { contentId: ids[0], response: 'A' },
        { contentId: ids[1], response: 'C' },
      ],
    };
    const first = await request(app).post(`/user/${user._id}/quiz`).send(payload).expect(200);
    expect(first.body).toMatchObject({ duplicate: false, summary: { total: 2, correct: 1 } });

    // The wrong answer is still pending, but the same quiz id must not be graded twice.
    const retry = await request(app).post(`/user/${user._id}/quiz`).send(payload).expect(200);
    expect(retry.body).toMatchObject({ duplicate: true, xpEarned: 0, results: [] });
    expect(retry.body.rewards.xp).toBe(first.body.rewards.xp);

    const next = await request(app)
      .post(`/user/${user._id}/quiz`)
      .send({ ...payload, quizId: 'quiz-retry-2' })
      .expect(200);
    expect(next.body).toMatchObject({ duplicate: false, summary: { total: 1, correct: 0 } });

    const saved = await User.findById(user._id).lean();
    expect(saved.rewards).toMatchObject({ quizzesCompleted: 2, lastQuizId: 'quiz-retry-2' });
  });

  test('duplicate answers count once and wrong answers stay pending', async () => {
    const { user, ids } = await setupQuiz();
    const { body } = await request(app)
      .post(`/user/${user._id}/quiz`)
      .send({
        answers: [
          { contentId: ids[1], response: 'A' },
          { contentId: ids[1], response: 'B' },
        ],
      })
      .expect(200);
    expect(body.summary).toMatchObject({ total: 1, correct: 0 });
    const saved = await User.findById(user._id).lean();
    expect(saved.evaluation_list[1].answered).toBe(false);
  });

  test('validates the payload and the user', async () => {
    const { user, ids } = await setupQuiz();
    const post = (id, payload) => request(app).post(`/user/${id}/quiz`).send(payload);

    await post(user._id, {}).expect(400);
    await post(user._id, { answers: [] }).expect(400);
    await post(user._id, { answers: [{ contentId: 'bad', response: 'A' }] }).expect(400);
    await post(user._id, { answers: [{ contentId: ids[0] }] }).expect(400);
    await post(user._id, { answers: [{ contentId: ids[0], response: 'A' }], quizId: 'x' }).expect(
      400
    );
    await post(user._id, {
      answers: Array.from({ length: 51 }, () => ({ contentId: ids[0], response: 'A' })),
    }).expect(400);
    await post(MISSING_ID, { answers: [{ contentId: ids[0], response: 'A' }] }).expect(404);
    await post('bad', { answers: [{ contentId: ids[0], response: 'A' }] }).expect(400);
  });
});

describe('GET /user/:id/rewards', () => {
  test('returns the level, streak and full badge catalog', async () => {
    const { user, ids } = await setupQuiz();
    await request(app)
      .post(`/user/${user._id}/quiz`)
      .send({ answers: ids.map((contentId, i) => ({ contentId, response: ['A', 'B', 'C'][i] })) })
      .expect(200);

    const { body } = await request(app).get(`/user/${user._id}/rewards`).expect(200);
    // 10 + 15 + 20 answers/combo, +20 perfect, +5 streak
    expect(body).toMatchObject({ xp: 70, level: 1, levelTitle: 'Curious Mind', nextLevelXp: 100 });
    expect(body.stats).toMatchObject({ quizzesCompleted: 1, perfectQuizzes: 1, correctAnswers: 3 });
    expect(body.badges.filter((badge) => badge.earned).map((badge) => badge.key)).toEqual([
      'first_quiz',
      'perfect_quiz',
    ]);
  });

  test('new users start at level 1 with no streak', async () => {
    const user = await createUser();
    const { body } = await request(app)
      .get(`/user/${user._id}/rewards?utcOffsetMinutes=-300`)
      .expect(200);
    expect(body).toMatchObject({ xp: 0, level: 1, progress: 0, streak: { current: 0, best: 0 } });
    await request(app).get(`/user/${MISSING_ID}/rewards`).expect(404);
  });

  test('rewards cannot be edited through the profile update', async () => {
    const user = await createUser();
    await request(app)
      .put(`/user/${user._id}`)
      .send({ user: { rewards: { xp: 99999 } } })
      .expect(200);
    const saved = await User.findById(user._id).lean();
    expect(saved.rewards.xp).toBe(0);
  });
});
