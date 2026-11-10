/**
 * Quiz gamification: XP, levels, daily streak and badges.
 * Pure functions (no I/O) so the rules are easy to test; the user controller applies them.
 * The mobile app mirrors these constants for previews: keep `src/features/track/utils/rewards.js` in sync.
 */

const XP = {
  correct: 10,
  // Small reward for trying, so a wrong answer still feels like progress.
  attempt: 2,
  // Each consecutive correct answer after the first adds 5 XP, up to +20.
  comboStep: 5,
  maxComboBonus: 20,
  // All answers correct in a quiz of at least `perfectMinQuestions` questions.
  perfect: 20,
  perfectMinQuestions: 2,
  // First quiz of the day: 5 XP per streak day, up to +35.
  streakStep: 5,
  maxStreakBonus: 35,
};

const MAX_QUIZ_ANSWERS = 50;
const MAX_UTC_OFFSET_MINUTES = 14 * 60;

const LEVEL_TITLES = [
  'Curious Mind',
  'Apprentice',
  'Thinker',
  'Scholar',
  'Expert',
  'Sage',
  'Visionary',
  'Luminary',
  'Genius',
  'Bright Mind',
];

/** Total XP needed to reach `level` (level 1 = 0 XP, 2 = 100, 3 = 300, 4 = 600, ...). */
const levelThreshold = (level) => 50 * level * (level - 1);

const levelForXp = (xp) => {
  let level = 1;
  while (level < 1000 && levelThreshold(level + 1) <= xp) level += 1;
  return level;
};

const levelTitle = (level) => LEVEL_TITLES[Math.min(level, LEVEL_TITLES.length) - 1];

/** Level, title and progress toward the next level for an XP total. */
const levelInfo = (xp = 0) => {
  const level = levelForXp(xp);
  const floor = levelThreshold(level);
  const next = levelThreshold(level + 1);
  return {
    level,
    levelTitle: levelTitle(level),
    levelXp: xp - floor,
    levelSpan: next - floor,
    nextLevelXp: next,
    progress: (xp - floor) / (next - floor),
  };
};

// Badges are checked after every quiz; `stats` is the user's rewards state after the quiz.
const BADGES = [
  {
    key: 'first_quiz',
    title: 'First Steps',
    description: 'Complete your first quiz.',
    earned: ({ stats }) => stats.quizzesCompleted >= 1,
  },
  {
    key: 'perfect_quiz',
    title: 'Flawless',
    description: 'Answer every question of a quiz of 3+ questions correctly.',
    earned: ({ quiz }) => !!quiz && quiz.perfect && quiz.total >= 3,
  },
  {
    key: 'combo_5',
    title: 'On Fire',
    description: 'Answer 5 questions in a row correctly.',
    earned: ({ stats }) => stats.bestCombo >= 5,
  },
  {
    key: 'streak_3',
    title: 'Habit Builder',
    description: 'Take a quiz 3 days in a row.',
    earned: ({ stats }) => stats.streak.best >= 3,
  },
  {
    key: 'streak_7',
    title: 'Unstoppable',
    description: 'Take a quiz 7 days in a row.',
    earned: ({ stats }) => stats.streak.best >= 7,
  },
  {
    key: 'correct_10',
    title: 'Sharp Mind',
    description: 'Answer 10 questions correctly.',
    earned: ({ stats }) => stats.correctAnswers >= 10,
  },
  {
    key: 'correct_50',
    title: 'Knowledge Seeker',
    description: 'Answer 50 questions correctly.',
    earned: ({ stats }) => stats.correctAnswers >= 50,
  },
  {
    key: 'quizzes_10',
    title: 'Dedicated Learner',
    description: 'Complete 10 quizzes.',
    earned: ({ stats }) => stats.quizzesCompleted >= 10,
  },
  {
    key: 'level_5',
    title: 'Rising Star',
    description: 'Reach level 5.',
    earned: ({ stats }) => levelForXp(stats.xp) >= 5,
  },
  {
    key: 'objective_reached',
    title: 'Goal Getter',
    description: 'Reach a milestone of your learning path.',
    earned: ({ learning }) => (learning?.milestones?.length || 0) > 0,
  },
];

/** Accepts integer minutes east of UTC (e.g. 120 for UTC+2); anything else counts as UTC. */
const normalizeUtcOffset = (value) => {
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || Math.abs(minutes) > MAX_UTC_OFFSET_MINUTES) return 0;
  return minutes;
};

/** `YYYY-MM-DD` of the user's local day. */
const localDay = (utcOffsetMinutes = 0, now = new Date()) =>
  new Date(now.getTime() + utcOffsetMinutes * 60000).toISOString().slice(0, 10);

const previousDay = (day) => {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

/**
 * Grades answers in submission order (the order drives the combo) and computes the XP.
 * @param {{ contentId: string, correct: boolean, correctAnswer: string }[]} graded
 */
const scoreQuiz = (graded) => {
  let combo = 0;
  let bestCombo = 0;
  let comboBonus = 0;
  const results = graded.map((answer) => {
    let xp;
    if (answer.correct) {
      combo += 1;
      bestCombo = Math.max(bestCombo, combo);
      const bonus = Math.min((combo - 1) * XP.comboStep, XP.maxComboBonus);
      comboBonus += bonus;
      xp = XP.correct + bonus;
    } else {
      combo = 0;
      xp = XP.attempt;
    }
    return { ...answer, xp };
  });

  const correct = results.filter((answer) => answer.correct).length;
  const total = results.length;
  const perfect = total > 0 && correct === total;
  const perfectBonus = perfect && total >= XP.perfectMinQuestions ? XP.perfect : 0;

  return { results, total, correct, bestCombo, perfect, comboBonus, perfectBonus };
};

const streakAfterQuiz = (streak, today) => {
  const last = streak.lastQuizDay;
  if (last === today) return { ...streak, firstQuizToday: false };
  const current = last === previousDay(today) ? streak.current + 1 : 1;
  return {
    current,
    best: Math.max(streak.best || 0, current),
    lastQuizDay: today,
    firstQuizToday: true,
  };
};

/**
 * Applies a scored quiz to a user document's rewards and returns what changed.
 * Mutates `user`; the caller saves it.
 */
const applyQuiz = (user, quiz, today) => {
  const rewards = user.rewards;
  const previousXp = rewards.xp || 0;
  const previousLevel = levelForXp(previousXp);

  const streak = streakAfterQuiz(
    {
      current: rewards.streak.current || 0,
      best: rewards.streak.best || 0,
      lastQuizDay: rewards.streak.lastQuizDay,
    },
    today
  );
  const streakBonus = streak.firstQuizToday
    ? Math.min(streak.current * XP.streakStep, XP.maxStreakBonus)
    : 0;

  const breakdown = [
    { key: 'answers', label: 'Correct answers', xp: quiz.correct * XP.correct },
    { key: 'effort', label: 'Effort', xp: (quiz.total - quiz.correct) * XP.attempt },
    { key: 'combo', label: 'Combo bonus', xp: quiz.comboBonus },
    { key: 'perfect', label: 'Perfect quiz', xp: quiz.perfectBonus },
    { key: 'streak', label: 'Daily streak', xp: streakBonus },
  ].filter((item) => item.xp > 0);
  const xpEarned = breakdown.reduce((sum, item) => sum + item.xp, 0);

  rewards.xp = previousXp + xpEarned;
  rewards.quizzesCompleted = (rewards.quizzesCompleted || 0) + 1;
  rewards.answeredQuestions = (rewards.answeredQuestions || 0) + quiz.total;
  rewards.correctAnswers = (rewards.correctAnswers || 0) + quiz.correct;
  rewards.bestCombo = Math.max(rewards.bestCombo || 0, quiz.bestCombo);
  if (quiz.perfect && quiz.total >= XP.perfectMinQuestions) {
    rewards.perfectQuizzes = (rewards.perfectQuizzes || 0) + 1;
  }
  rewards.streak.current = streak.current;
  rewards.streak.best = streak.best;
  rewards.streak.lastQuizDay = streak.lastQuizDay;

  // The learning stats (services/learning.js) are updated by the caller before the badges are checked.
  const owned = new Set(rewards.badges.map((badge) => badge.key));
  const context = { stats: rewards, quiz, learning: user.learning };
  const newBadges = BADGES.filter((badge) => !owned.has(badge.key) && badge.earned(context));
  const earnedAt = new Date();
  newBadges.forEach((badge) => rewards.badges.push({ key: badge.key, earnedAt }));

  return {
    xpEarned,
    breakdown,
    previous: { xp: previousXp, ...levelInfo(previousXp) },
    leveledUp: levelForXp(rewards.xp) > previousLevel,
    newBadges: newBadges.map(({ key, title, description }) => ({ key, title, description })),
  };
};

/** Public rewards payload; the streak only counts as current if the last quiz was today or yesterday. */
const serializeRewards = (user, today) => {
  const rewards = user.rewards || {};
  const streak = rewards.streak || {};
  const xp = rewards.xp || 0;
  const alive = streak.lastQuizDay === today || streak.lastQuizDay === previousDay(today);
  const earned = new Map((rewards.badges || []).map((badge) => [badge.key, badge.earnedAt]));
  return {
    xp,
    ...levelInfo(xp),
    streak: {
      current: alive ? streak.current || 0 : 0,
      best: streak.best || 0,
      completedToday: streak.lastQuizDay === today,
      lastQuizDay: streak.lastQuizDay || null,
    },
    stats: {
      quizzesCompleted: rewards.quizzesCompleted || 0,
      perfectQuizzes: rewards.perfectQuizzes || 0,
      correctAnswers: rewards.correctAnswers || 0,
      answeredQuestions: rewards.answeredQuestions || 0,
      bestCombo: rewards.bestCombo || 0,
    },
    badges: BADGES.map(({ key, title, description }) => ({
      key,
      title,
      description,
      earned: earned.has(key),
      earnedAt: earned.get(key) || null,
    })),
  };
};

module.exports = {
  XP,
  MAX_QUIZ_ANSWERS,
  LEVEL_TITLES,
  BADGES,
  levelThreshold,
  levelForXp,
  levelInfo,
  normalizeUtcOffset,
  localDay,
  previousDay,
  scoreQuiz,
  applyQuiz,
  serializeRewards,
};
