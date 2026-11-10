const rewards = require('../../services/rewards');

const answer = (correct, contentId = 'c') => ({ contentId, correct, correctAnswer: 'A' });

const freshUser = (overrides = {}) => ({
  rewards: {
    xp: 0,
    quizzesCompleted: 0,
    perfectQuizzes: 0,
    answeredQuestions: 0,
    correctAnswers: 0,
    bestCombo: 0,
    streak: { current: 0, best: 0, lastQuizDay: undefined },
    badges: [],
    ...overrides.rewards,
  },
  learning: { milestones: [], ...overrides.learning },
});

describe('levels', () => {
  test('thresholds grow with each level', () => {
    expect([1, 2, 3, 4, 5].map(rewards.levelThreshold)).toEqual([0, 100, 300, 600, 1000]);
    expect(rewards.levelForXp(0)).toBe(1);
    expect(rewards.levelForXp(99)).toBe(1);
    expect(rewards.levelForXp(100)).toBe(2);
    expect(rewards.levelForXp(1000)).toBe(5);
  });

  test('levelInfo reports progress toward the next level', () => {
    expect(rewards.levelInfo(150)).toEqual({
      level: 2,
      levelTitle: 'Apprentice',
      levelXp: 50,
      levelSpan: 200,
      nextLevelXp: 300,
      progress: 0.25,
    });
    expect(rewards.levelInfo(1e6).levelTitle).toBe('Bright Mind');
  });
});

describe('scoreQuiz', () => {
  test('combos grow the bonus until a wrong answer resets it', () => {
    const quiz = rewards.scoreQuiz([
      answer(true),
      answer(true),
      answer(true),
      answer(false),
      answer(true),
    ]);
    expect(quiz.results.map((r) => r.xp)).toEqual([10, 15, 20, 2, 10]);
    expect(quiz).toMatchObject({
      total: 5,
      correct: 4,
      bestCombo: 3,
      perfect: false,
      comboBonus: 15,
    });
    expect(quiz.perfectBonus).toBe(0);
  });

  test('the combo bonus is capped and a perfect quiz earns a bonus', () => {
    const quiz = rewards.scoreQuiz(Array.from({ length: 7 }, () => answer(true)));
    expect(quiz.results.map((r) => r.xp)).toEqual([10, 15, 20, 25, 30, 30, 30]);
    expect(quiz.perfectBonus).toBe(rewards.XP.perfect);
  });

  test('a single question is never a "perfect quiz" bonus', () => {
    expect(rewards.scoreQuiz([answer(true)]).perfectBonus).toBe(0);
  });
});

describe('applyQuiz', () => {
  test('awards XP, streak and badges', () => {
    const user = freshUser();
    const quiz = rewards.scoreQuiz([answer(true), answer(true), answer(true)]);
    const outcome = rewards.applyQuiz(user, quiz, '2026-11-10');

    // 10 + 15 + 20 answers/combo, +20 perfect, +5 first streak day
    expect(outcome.xpEarned).toBe(70);
    expect(outcome.breakdown.map((item) => item.key)).toEqual([
      'answers',
      'combo',
      'perfect',
      'streak',
    ]);
    expect(outcome.previous).toMatchObject({ xp: 0, level: 1 });
    expect(outcome.leveledUp).toBe(false);
    expect(outcome.newBadges.map((badge) => badge.key)).toEqual(['first_quiz', 'perfect_quiz']);
    expect(user.rewards).toMatchObject({
      xp: 70,
      quizzesCompleted: 1,
      perfectQuizzes: 1,
      correctAnswers: 3,
    });
    expect(user.rewards.streak).toMatchObject({ current: 1, best: 1, lastQuizDay: '2026-11-10' });
  });

  test('the streak continues on consecutive days, pays once per day and resets after a gap', () => {
    const user = freshUser({
      rewards: { streak: { current: 2, best: 2, lastQuizDay: '2026-11-09' } },
    });
    const first = rewards.applyQuiz(user, rewards.scoreQuiz([answer(false)]), '2026-11-10');
    expect(user.rewards.streak).toMatchObject({ current: 3, best: 3 });
    expect(first.breakdown.find((item) => item.key === 'streak').xp).toBe(15);
    expect(first.newBadges.map((badge) => badge.key)).toContain('streak_3');

    const second = rewards.applyQuiz(user, rewards.scoreQuiz([answer(false)]), '2026-11-10');
    expect(second.breakdown.find((item) => item.key === 'streak')).toBeUndefined();
    expect(user.rewards.streak.current).toBe(3);

    rewards.applyQuiz(user, rewards.scoreQuiz([answer(false)]), '2026-11-13');
    expect(user.rewards.streak).toMatchObject({ current: 1, best: 3 });
  });

  test('badges are awarded once and level ups are reported', () => {
    const user = freshUser({
      rewards: { xp: 95, quizzesCompleted: 9, correctAnswers: 9, badges: [{ key: 'first_quiz' }] },
      learning: { milestones: [{ path: 'follower', level: 1 }] },
    });
    const outcome = rewards.applyQuiz(user, rewards.scoreQuiz([answer(true)]), '2026-11-10');
    expect(outcome.leveledUp).toBe(true);
    expect(outcome.newBadges.map((badge) => badge.key)).toEqual([
      'correct_10',
      'quizzes_10',
      'objective_reached',
    ]);
    expect(user.rewards.badges.filter((badge) => badge.key === 'first_quiz')).toHaveLength(1);
  });
});

describe('serializeRewards', () => {
  test('a skipped day breaks the displayed streak and every badge is listed', () => {
    const user = freshUser({
      rewards: {
        xp: 120,
        streak: { current: 4, best: 6, lastQuizDay: '2026-11-07' },
        badges: [{ key: 'first_quiz', earnedAt: new Date(0) }],
      },
    });
    const payload = rewards.serializeRewards(user, '2026-11-10');
    expect(payload).toMatchObject({ xp: 120, level: 2, levelXp: 20 });
    expect(payload.streak).toEqual({
      current: 0,
      best: 6,
      completedToday: false,
      lastQuizDay: '2026-11-07',
    });
    expect(payload.badges).toHaveLength(rewards.BADGES.length);
    expect(payload.badges.find((badge) => badge.key === 'first_quiz')).toMatchObject({
      earned: true,
    });
    expect(payload.badges.find((badge) => badge.key === 'streak_7')).toMatchObject({
      earned: false,
      earnedAt: null,
    });
  });

  test('yesterday still keeps the streak alive', () => {
    const user = freshUser({
      rewards: { streak: { current: 4, best: 4, lastQuizDay: '2026-11-09' } },
    });
    expect(rewards.serializeRewards(user, '2026-11-10').streak.current).toBe(4);
  });
});

describe('local day', () => {
  test('applies the UTC offset and rejects invalid offsets', () => {
    const now = new Date('2026-11-10T23:30:00.000Z');
    expect(rewards.localDay(0, now)).toBe('2026-11-10');
    expect(rewards.localDay(60, now)).toBe('2026-11-11');
    expect(rewards.localDay(-600, now)).toBe('2026-11-10');
    expect(rewards.normalizeUtcOffset('120')).toBe(120);
    expect(rewards.normalizeUtcOffset(5000)).toBe(0);
    expect(rewards.normalizeUtcOffset('abc')).toBe(0);
    expect(rewards.previousDay('2026-03-01')).toBe('2026-02-28');
  });
});
