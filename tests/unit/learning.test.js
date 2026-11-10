const learning = require('../../services/learning');

const profile = (overrides = {}) => ({
  path: null,
  focusField: null,
  stats: { contents: 0, correctAnswers: 0, papers: 0, fields: [] },
  milestones: [],
  history: [],
  ...overrides,
});

const fields = (...entries) =>
  entries.map(([field, contents, correctAnswers = 0, papers = 0]) => ({
    field,
    contents,
    correctAnswers,
    papers,
  }));

describe('catalog and path names', () => {
  test('four paths with five growing milestones each', () => {
    const paths = learning.catalog();
    expect(paths.map((path) => path.key)).toEqual([
      'follower',
      'explorer',
      'deep_learner',
      'researcher',
    ]);
    paths.forEach((path) => {
      expect(path.milestones).toHaveLength(5);
      path.milestones.slice(1).forEach((step, index) => {
        step.goals.forEach((goal) => {
          const previous = path.milestones[index].goals.find((g) => g.metric === goal.metric);
          expect(goal.target).toBeGreaterThan(previous.target);
        });
      });
    });
    expect(paths[2].milestones[0].goals[0].label).toBe('Casts & articles in your focus field');
  });

  test('keys, display names and legacy spellings resolve; others do not', () => {
    ['deep_learner', 'Deep Learner', 'DeepLearner', 'deep learner'].forEach((name) =>
      expect(learning.resolvePathKey(name)).toBe('deep_learner')
    );
    expect(learning.resolvePathKey('Explorer')).toBe('explorer');
    [undefined, null, '', 'Career', 'toString', 42].forEach((name) =>
      expect(learning.resolvePathKey(name)).toBeNull()
    );
    expect(learning.isRetiredPath('Career')).toBe(true);
    expect(learning.legacyPathKey('Career')).toBe('explorer');
    expect(learning.legacyPathKey('DeepLearner')).toBe('deep_learner');
    expect(learning.legacyPathKey(undefined)).toBe('explorer');
  });

  test('paper ids are normalized from ids and OpenAlex URLs', () => {
    expect(learning.normalizePaperId('W2741809807')).toBe('W2741809807');
    expect(learning.normalizePaperId('https://openalex.org/w2741809807')).toBe('W2741809807');
    expect(learning.normalizePaperId('https://api.openalex.org/works/W1')).toBe('W1');
    ['', 'W', 'X123', 'https://evil.com/W1', 'W1; drop', null].forEach((value) =>
      expect(learning.normalizePaperId(value)).toBeNull()
    );
  });
});

describe('journey', () => {
  test('no path, no journey', () => {
    expect(learning.buildJourney(profile())).toBeNull();
  });

  test('milestones are reached when every goal is met, in order', () => {
    const journey = learning.buildJourney(
      profile({
        path: 'explorer',
        stats: {
          contents: 12,
          fields: fields(['Chemistry', 6], ['Medicine', 4], ['Energy', 2], ['Nursing', 0, 1]),
        },
      })
    );
    // 3 explored fields (Nursing has no activity counted as explored): Wanderer only.
    expect(journey).toMatchObject({ level: 1, total: 5, completed: false });
    expect(journey.next).toMatchObject({ level: 2, title: 'Pathfinder' });
    expect(journey.next.goals).toEqual([
      { metric: 'fields', label: 'Fields explored', current: 3, target: 4 },
      { metric: 'contents', label: 'Casts & articles', current: 12, target: 10 },
    ]);
    expect(journey.next.progress).toBeCloseTo((3 / 4 + 1) / 2);
  });

  test('Deep Learner only counts its focus field', () => {
    const base = {
      path: 'deep_learner',
      stats: {
        contents: 40,
        correctAnswers: 30,
        fields: fields(['Chemistry', 30, 25], ['Medicine', 10, 5]),
      },
    };
    expect(learning.buildJourney(profile({ ...base, focusField: 'Chemistry' })).level).toBe(3);
    expect(learning.buildJourney(profile({ ...base, focusField: 'Medicine' })).level).toBe(1);
    expect(learning.buildJourney(profile({ ...base, focusField: null })).level).toBe(0);
  });

  test('duplicate field entries are merged', () => {
    const stats = learning.fieldStats(
      profile({ stats: { fields: fields(['Chemistry', 1, 1], ['Medicine', 3], ['Chemistry', 2]) } })
    );
    expect(stats).toEqual([
      { field: 'Chemistry', contents: 3, correctAnswers: 1, papers: 0 },
      { field: 'Medicine', contents: 3, correctAnswers: 0, papers: 0 },
    ]);
  });
});

describe('milestones and path changes', () => {
  test('reached milestones are recorded once, per path and focus field', () => {
    const user = profile({
      path: 'follower',
      stats: { contents: 12, correctAnswers: 9, fields: [] },
    });
    const now = new Date('2026-11-10T12:00:00Z');
    const first = learning.recordMilestones(user, now);
    expect(first.map((m) => [m.level, m.title])).toEqual([
      [1, 'Tuned In'],
      [2, 'Regular'],
    ]);
    expect(first[0]).toMatchObject({
      path: 'follower',
      pathTitle: 'Follower',
      total: 5,
      reachedAt: now,
    });
    expect(learning.recordMilestones(user, now)).toEqual([]);
    expect(learning.buildJourney(user).milestones[0].reachedAt).toBe(now);
  });

  test('switching path keeps the activity and archives the previous path', () => {
    const user = profile({
      path: 'follower',
      startedAt: new Date('2026-01-01'),
      stats: { contents: 4, correctAnswers: 2, fields: fields(['Chemistry', 4, 2]) },
    });
    learning.recordMilestones(user);
    const now = new Date('2026-11-10');

    expect(learning.choosePath(user, { path: 'follower' }, now)).toBe(false);
    expect(learning.choosePath(user, { path: 'deep_learner', focusField: 'Chemistry' }, now)).toBe(
      true
    );
    expect(user).toMatchObject({
      path: 'deep_learner',
      focusField: 'Chemistry',
      startedAt: now,
      version: 1,
    });
    // The focus field already has 4 contents and 2 correct answers: Initiate is reached at once.
    expect(learning.recordMilestones(user, now).map((m) => m.title)).toEqual(['Initiate']);

    const serialized = learning.serializeLearning(user);
    expect(serialized.history).toEqual([
      {
        path: 'follower',
        title: 'Follower',
        focusField: null,
        startedAt: new Date('2026-01-01'),
        endedAt: now,
        milestonesReached: 1,
      },
    ]);
    // A focus field only matters for Deep Learner.
    learning.choosePath(user, { path: 'explorer', focusField: 'Chemistry' }, now);
    expect(user.focusField).toBeNull();
  });

  test('the history keeps the latest paths only', () => {
    const user = profile({ path: 'follower' });
    for (let i = 0; i < learning.MAX_HISTORY + 5; i++) {
      learning.choosePath(user, { path: i % 2 ? 'follower' : 'explorer' });
    }
    expect(user.history).toHaveLength(learning.MAX_HISTORY);
  });

  test('the default focus field is the top preference, else the most studied field', () => {
    const preferences = [
      { category: 'Medicine', weight: 20 },
      { category: 'Alchemy', weight: 90 },
      { category: 'Chemistry', weight: 80 },
    ];
    expect(learning.defaultFocusField(preferences, profile())).toBe('Chemistry');
    expect(
      learning.defaultFocusField([], profile({ stats: { fields: fields(['Energy', 2]) } }))
    ).toBe('Energy');
    expect(learning.defaultFocusField([], profile())).toBeNull();
  });

  test('quiz answers count in total and per field', () => {
    const user = profile();
    learning.applyQuizAnswers(user, [
      { correct: true, department: 'Chemistry' },
      { correct: false, department: 'Chemistry' },
      { correct: true, department: 'Medicine' },
      { correct: true },
    ]);
    expect(user.stats.correctAnswers).toBe(3);
    expect(learning.fieldStats(user).map((f) => [f.field, f.correctAnswers])).toEqual([
      ['Chemistry', 1],
      ['Medicine', 1],
    ]);
  });
});

describe('legacy tracking view', () => {
  test('describes the next milestone; a completed path stays full', () => {
    const user = profile({
      path: 'researcher',
      stats: { papers: 3, correctAnswers: 1, fields: [] },
    });
    // Curious Reader: 2 papers + 2 correct answers.
    expect(learning.legacyTracking(user)).toMatchObject({
      objective: 'Researcher',
      progress: 3,
      target: 4,
    });
    const done = profile({
      path: 'follower',
      stats: { contents: 500, correctAnswers: 500, fields: [] },
    });
    expect(learning.legacyTracking(done)).toMatchObject({ progress: 180, target: 180 });
  });
});
