const { departmentNames } = require('../lists/departments');

/*
 * Learning paths: a lens on the user's lifetime learning activity. Each path has 5 milestones whose
 * goals read lifetime stats, so progress never resets: switching path re-reads the same activity.
 * Keys are stable identifiers (the app keys its icons and colors on them): never rename one.
 */

// Version of the `user.learning` document; a missing version means "not migrated from `tracking` yet".
const LEARNING_VERSION = 1;
const MAX_HISTORY = 20;
// Opened papers are remembered to count each one once; the oldest ids are dropped beyond this.
const MAX_PAPER_IDS = 1000;

const METRICS = {
  casts: 'Casts',
  correctAnswers: 'Correct answers',
  fields: 'Fields explored',
  papers: 'Research papers opened',
};

const milestone = (title, goals) => ({ title, goals });

const PATHS = [
  {
    key: 'follower',
    title: 'Follower',
    tagline: 'Stay on top of your favorite fields',
    description:
      'Keep up with what is new in the fields you love. Watch and test yourself regularly to ' +
      'stay ahead of the latest discoveries.',
    feed: 'The newest casts from your preferred fields come first.',
    usesFocusField: false,
    milestones: [
      milestone('Tuned In', { casts: 3, correctAnswers: 2 }),
      milestone('Regular', { casts: 10, correctAnswers: 8 }),
      milestone('Insider', { casts: 25, correctAnswers: 20 }),
      milestone('Trend Spotter', { casts: 50, correctAnswers: 40 }),
      milestone('Ahead of the Curve', { casts: 100, correctAnswers: 80 }),
    ],
  },
  {
    key: 'explorer',
    title: 'Explorer',
    tagline: "Discover fields you've never explored",
    description:
      'Broaden your horizons across research disciplines. Every new field you explore moves you ' +
      'forward, from medicine to astronomy.',
    feed: "Casts from fields you haven't explored yet come first.",
    usesFocusField: false,
    milestones: [
      milestone('Wanderer', { fields: 2, casts: 3 }),
      milestone('Pathfinder', { fields: 4, casts: 10 }),
      milestone('Globetrotter', { fields: 7, casts: 25 }),
      milestone('Polymath', { fields: 11, casts: 50 }),
      milestone('Renaissance Mind', { fields: 16, casts: 100 }),
    ],
  },
  {
    key: 'deep_learner',
    title: 'Deep Learner',
    tagline: 'Master one field, step by step',
    description:
      'Choose a focus field and go deep. Only what you watch and answer in that field counts, ' +
      'building real expertise over time.',
    feed: 'Casts from your focus field come first.',
    usesFocusField: true,
    milestones: [
      milestone('Initiate', { casts: 3, correctAnswers: 2 }),
      milestone('Practitioner', { casts: 10, correctAnswers: 8 }),
      milestone('Specialist', { casts: 25, correctAnswers: 20 }),
      milestone('Authority', { casts: 50, correctAnswers: 40 }),
      milestone('Master', { casts: 100, correctAnswers: 80 }),
    ],
  },
  {
    key: 'researcher',
    title: 'Researcher',
    tagline: 'Go to the source: the papers behind the science',
    description:
      'Understand how research is made. Open the research papers behind the casts and in the labs, ' +
      'and prove what you learned in quizzes.',
    feed: 'Casts from your preferred fields; papers are in the Lab tab and in search.',
    usesFocusField: false,
    milestones: [
      milestone('Curious Reader', { papers: 2, correctAnswers: 2 }),
      milestone('Analyst', { papers: 8, correctAnswers: 8 }),
      milestone('Investigator', { papers: 20, correctAnswers: 20 }),
      milestone('Critical Thinker', { papers: 40, correctAnswers: 40 }),
      milestone('Principal Investigator', { papers: 80, correctAnswers: 80 }),
    ],
  },
];

const PATHS_BY_KEY = new Map(PATHS.map((path) => [path.key, path]));
const PATH_KEYS = PATHS.map((path) => path.key);
const getPath = (key) => PATHS_BY_KEY.get(key) || null;
// Retired paths and where their users were migrated.
const RETIRED_PATHS = { career: 'explorer' };
// Users who never picked a path see their progress through this one on legacy endpoints.
const DEFAULT_PATH = 'explorer';

const normalizeName = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[^a-z]/g, '');

/** Path key from a key or a display name, legacy spellings included ("DeepLearner", "Deep Learner"). */
const resolvePathKey = (value) => {
  if (typeof value !== 'string' || !value.trim()) return null;
  const name = normalizeName(value);
  const path = PATHS.find(
    (candidate) => normalizeName(candidate.key) === name || normalizeName(candidate.title) === name
  );
  return path ? path.key : null;
};

const isRetiredPath = (value) =>
  typeof value === 'string' && Object.hasOwn(RETIRED_PATHS, normalizeName(value));

/** Path for a legacy `tracking.objective`: retired and unknown objectives map to a current path. */
const legacyPathKey = (objective) =>
  resolvePathKey(objective) ||
  (isRetiredPath(objective) ? RETIRED_PATHS[normalizeName(objective)] : DEFAULT_PATH);

const isField = (value) => typeof value === 'string' && departmentNames.includes(value);

const PAPER_ID_PATTERN = /^(?:https?:\/\/(?:api\.)?openalex\.org\/(?:works\/)?)?(W\d{1,12})$/i;

/** Short OpenAlex work id ("W2741809807") from an id or a work URL; null if invalid. */
const normalizePaperId = (value) => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(PAPER_ID_PATTERN);
  return match ? match[1].toUpperCase() : null;
};

const goalLabel = (path, metric) =>
  path.usesFocusField && metric !== 'fields'
    ? `${METRICS[metric]} in your focus field`
    : METRICS[metric];

/** Public catalog of the paths and their milestones. */
const catalog = () =>
  PATHS.map((path) => ({
    key: path.key,
    title: path.title,
    tagline: path.tagline,
    description: path.description,
    feed: path.feed,
    usesFocusField: path.usesFocusField,
    milestones: path.milestones.map((step, index) => ({
      level: index + 1,
      title: step.title,
      goals: Object.entries(step.goals).map(([metric, target]) => ({
        metric,
        label: goalLabel(path, metric),
        target,
      })),
    })),
  }));

// ---------------------------------------------------------------- Stats

const EMPTY_FIELD = { casts: 0, correctAnswers: 0, papers: 0 };

const ensureStats = (learning) => {
  if (!learning.stats) learning.stats = { casts: 0, correctAnswers: 0, papers: 0, fields: [] };
  if (!learning.stats.fields) learning.stats.fields = [];
  return learning.stats;
};

/** Per-field stats, most active first (entries of the same field are merged). */
const fieldStats = (learning) => {
  const merged = new Map();
  (learning?.stats?.fields || []).forEach((entry) => {
    if (!entry?.field) return;
    const current = merged.get(entry.field) || { field: entry.field, ...EMPTY_FIELD };
    merged.set(entry.field, {
      field: entry.field,
      casts: current.casts + (entry.casts || 0),
      correctAnswers: current.correctAnswers + (entry.correctAnswers || 0),
      papers: current.papers + (entry.papers || 0),
    });
  });
  return [...merged.values()].sort(
    (a, b) =>
      b.casts - a.casts ||
      b.correctAnswers - a.correctAnswers ||
      b.papers - a.papers ||
      a.field.localeCompare(b.field)
  );
};

const exploredFields = (learning) =>
  fieldStats(learning)
    .filter((entry) => entry.casts > 0 || entry.papers > 0)
    .map((entry) => entry.field);

const addFieldStat = (learning, field, stat, amount = 1) => {
  if (!field) return;
  const { fields } = ensureStats(learning);
  const entry = fields.find((item) => item.field === field);
  if (entry) {
    entry[stat] = (entry[stat] || 0) + amount;
  } else {
    fields.push({ field, ...EMPTY_FIELD, [stat]: amount });
  }
};

/** Counts the correct answers of a graded quiz; results carry their content's `department`. */
const applyQuizAnswers = (learning, results) => {
  const stats = ensureStats(learning);
  const correct = results.filter((result) => result.correct);
  stats.correctAnswers = (stats.correctAnswers || 0) + correct.length;
  correct.forEach((result) => addFieldStat(learning, result.department, 'correctAnswers'));
};

// ---------------------------------------------------------------- Journey

const focusFieldOf = (learning, path) =>
  path.usesFocusField ? learning?.focusField || null : null;

/** Lifetime values a path measures; Deep Learner only counts its focus field. */
const pathMetrics = (learning, path) => {
  if (path.usesFocusField) {
    const focusField = focusFieldOf(learning, path);
    const focus = fieldStats(learning).find((entry) => entry.field === focusField) || EMPTY_FIELD;
    return {
      casts: focus.casts,
      correctAnswers: focus.correctAnswers,
      papers: focus.papers,
      fields: focus.casts > 0 || focus.papers > 0 ? 1 : 0,
    };
  }
  const stats = learning?.stats || {};
  return {
    casts: stats.casts || 0,
    correctAnswers: stats.correctAnswers || 0,
    papers: stats.papers || 0,
    fields: exploredFields(learning).length,
  };
};

const isReached = (step, metrics) =>
  Object.entries(step.goals).every(([metric, target]) => (metrics[metric] || 0) >= target);

// Goals only grow from one milestone to the next, so reached milestones are always a prefix.
const reachedLevel = (path, metrics) => {
  let level = 0;
  while (level < path.milestones.length && isReached(path.milestones[level], metrics)) level += 1;
  return level;
};

const recordedMilestones = (learning, pathKey, focusField) =>
  (learning?.milestones || []).filter(
    (record) => record.path === pathKey && (record.focusField || null) === focusField
  );

/** Milestones of the current path, with goal progress and when each was reached. */
const buildJourney = (learning) => {
  const path = PATHS_BY_KEY.get(learning?.path);
  if (!path) return null;
  const focusField = focusFieldOf(learning, path);
  const metrics = pathMetrics(learning, path);
  const level = reachedLevel(path, metrics);
  const reachedAt = new Map(
    recordedMilestones(learning, path.key, focusField).map((record) => [
      record.level,
      record.reachedAt,
    ])
  );
  const milestones = path.milestones.map((step, index) => {
    const goals = Object.entries(step.goals).map(([metric, target]) => ({
      metric,
      label: goalLabel(path, metric),
      current: metrics[metric] || 0,
      target,
    }));
    return {
      level: index + 1,
      title: step.title,
      goals,
      progress:
        goals.reduce((sum, goal) => sum + Math.min(goal.current / goal.target, 1), 0) /
        goals.length,
      reached: index < level,
      reachedAt: index < level ? reachedAt.get(index + 1) || null : null,
    };
  });
  return {
    level,
    total: milestones.length,
    completed: level === milestones.length,
    next: milestones[level] || null,
    milestones,
  };
};

const describeMilestone = ({ path, focusField, level, reachedAt }) => {
  const definition = PATHS_BY_KEY.get(path);
  return {
    path,
    pathTitle: definition.title,
    focusField: focusField || null,
    level,
    title: definition.milestones[level - 1].title,
    total: definition.milestones.length,
    reachedAt,
  };
};

/** Milestones reached on the current path but not recorded yet. */
const pendingMilestones = (learning, now = new Date()) => {
  const path = PATHS_BY_KEY.get(learning?.path);
  if (!path) return [];
  const focusField = focusFieldOf(learning, path);
  const level = reachedLevel(path, pathMetrics(learning, path));
  const recorded = new Set(
    recordedMilestones(learning, path.key, focusField).map((record) => record.level)
  );
  const pending = [];
  for (let step = 1; step <= level; step += 1) {
    if (!recorded.has(step))
      pending.push({ path: path.key, focusField, level: step, reachedAt: now });
  }
  return pending;
};

/** Records newly reached milestones on `learning` and returns them for celebrations. */
const recordMilestones = (learning, now = new Date()) => {
  const pending = pendingMilestones(learning, now);
  if (pending.length > 0) {
    if (!learning.milestones) learning.milestones = [];
    pending.forEach((record) => learning.milestones.push(record));
  }
  return pending.map(describeMilestone);
};

// ---------------------------------------------------------------- Path choice

/** Focus field by default: the user's top preference, else the field they learned most about. */
const defaultFocusField = (preferences, learning) => {
  const ranked = (preferences || [])
    .map((pref, index) => ({ field: pref.category, weight: pref.weight || 0, index }))
    .filter((pref) => isField(pref.field))
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  if (ranked.length > 0) return ranked[0].field;
  return fieldStats(learning).find((entry) => entry.casts > 0)?.field || null;
};

/** Switches to `path` (the previous one goes to the history). Returns false when nothing changed. */
const choosePath = (learning, { path, focusField = null }, now = new Date()) => {
  const definition = PATHS_BY_KEY.get(path);
  const focus = definition.usesFocusField ? focusField || null : null;
  if (learning.path === path && (learning.focusField || null) === focus) return false;
  if (learning.path) {
    if (!learning.history) learning.history = [];
    learning.history.push({
      path: learning.path,
      focusField: learning.focusField || null,
      startedAt: learning.startedAt || null,
      endedAt: now,
    });
    if (learning.history.length > MAX_HISTORY) {
      learning.history.splice(0, learning.history.length - MAX_HISTORY);
    }
  }
  learning.path = path;
  learning.focusField = focus;
  learning.startedAt = now;
  learning.version = learning.version || LEARNING_VERSION;
  return true;
};

// ---------------------------------------------------------------- Serialization

const serializeLearning = (learning) => {
  const path = PATHS_BY_KEY.get(learning?.path) || null;
  const stats = learning?.stats || {};
  const fields = fieldStats(learning);
  return {
    path: path ? path.key : null,
    title: path ? path.title : null,
    tagline: path ? path.tagline : null,
    focusField: path ? focusFieldOf(learning, path) : null,
    startedAt: path ? learning.startedAt || null : null,
    stats: {
      casts: stats.casts || 0,
      correctAnswers: stats.correctAnswers || 0,
      papers: stats.papers || 0,
      fieldsExplored: exploredFields(learning).length,
      fields,
    },
    journey: buildJourney(learning),
    history: [...(learning?.history || [])].reverse().map((entry) => {
      const definition = PATHS_BY_KEY.get(entry.path);
      return {
        path: entry.path,
        title: definition ? definition.title : entry.path,
        focusField: entry.focusField || null,
        startedAt: entry.startedAt || null,
        endedAt: entry.endedAt || null,
        milestonesReached: recordedMilestones(learning, entry.path, entry.focusField || null)
          .length,
      };
    }),
  };
};

/**
 * Shape of the retired `tracking` payload for app versions still calling GET /user/:id/tracking:
 * progress/target describe the next milestone of the path (summed over its goals).
 */
const legacyTracking = (learning) => {
  const view = PATHS_BY_KEY.has(learning?.path)
    ? learning
    : { path: DEFAULT_PATH, stats: learning?.stats, milestones: learning?.milestones };
  const journey = buildJourney(view);
  const step = journey.next || journey.milestones[journey.milestones.length - 1];
  const target = step.goals.reduce((sum, goal) => sum + goal.target, 0);
  const progress = step.goals.reduce((sum, goal) => sum + Math.min(goal.current, goal.target), 0);
  return {
    objective: PATHS_BY_KEY.get(view.path).title,
    progress,
    target,
    history: fieldStats(learning)
      .filter((entry) => entry.casts > 0)
      .map((entry) => ({ category: entry.field, count: entry.casts })),
  };
};

module.exports = {
  LEARNING_VERSION,
  MAX_HISTORY,
  MAX_PAPER_IDS,
  METRICS,
  PATHS,
  PATH_KEYS,
  RETIRED_PATHS,
  DEFAULT_PATH,
  getPath,
  resolvePathKey,
  isRetiredPath,
  legacyPathKey,
  isField,
  normalizePaperId,
  catalog,
  fieldStats,
  exploredFields,
  addFieldStat,
  applyQuizAnswers,
  pathMetrics,
  buildJourney,
  pendingMilestones,
  recordMilestones,
  describeMilestone,
  defaultFocusField,
  choosePath,
  serializeLearning,
  legacyTracking,
};
