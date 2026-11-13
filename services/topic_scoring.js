// Scores of research topics from their publication counts. Pure functions: no I/O, no clock.
//
// Counts are taken over rolling 12-month windows, so seasonality cancels and the day-1 spikes of
// OpenAlex dates (works known only by month or year are dated the 1st) fall once in every window:
//   w0 = the latest 12 months, w1 = the 12 months before, w2 = the 12 months before those.
//
// Growth is the ratio of w0 to what the topic's neighbors' trend predicts (its area, "subfield"),
// shrunk toward 1 with a Gamma-Poisson model, so a topic with few works cannot look hot by chance.

const MIN_RECENT_WORKS = 30; // works in w0 for a topic to be ranked
const MIN_PREVIOUS_WORKS = 20; // works in w1
const MIN_BASELINE_TOPICS = 5;
const TOP_SHARE_PRIOR = { mean: 0.1, strength: 20 }; // 10% of works are in the top 10% by definition
const Z_LOWER = 0.8416; // 20th percentile: "at least this much, with 80% confidence"
const DEFAULT_PRIOR_STRENGTH = 10;

// Weights of the components of the hot score (each is a percentile among the topics of the lab).
const HOT_WEIGHTS = { growth: 0.45, acceleration: 0.2, impact: 0.2, volume: 0.15 };
// Share of the hot score that comes from the independent signals, for the topics that have them.
const SIGNAL_SHARE = 0.25;

const pad = (value) => String(value).padStart(2, '0');
const formatDate = (date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const addMonths = (date, months) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()));
const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

/**
 * The windows to count works in. They end on the 1st of a month at least `lagDays` ago (recent
 * works are still being indexed) and run from the 2nd to the 1st, so each holds 12 month starts.
 * @returns {{ w0: {from, to}, w1: {from, to}, w2: {from, to}, matured: {from, to}, endsOn: string }}
 */
const buildWindows = (now = new Date(), lagDays = 30) => {
  const lagged = addDays(now, -lagDays);
  const end = new Date(Date.UTC(lagged.getUTCFullYear(), lagged.getUTCMonth(), 1));
  const windowEndingAt = (to) => ({
    from: formatDate(addDays(addMonths(to, -12), 1)),
    to: formatDate(to),
  });
  const w0 = windowEndingAt(end);
  const w1 = windowEndingAt(addMonths(end, -12));
  const w2 = windowEndingAt(addMonths(end, -24));
  // Citations take time: the share of top-cited works is read on the two older years.
  return { w0, w1, w2, matured: { from: w2.from, to: w1.to }, endsOn: w0.to };
};

// ---------------------------------------------------------------- statistics

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Inverse of the standard normal CDF (Acklam's approximation, error below 1.2e-9). */
const normalQuantile = (p) => {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [
    -39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (p > 1 - low) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
};

/** Quantile of Gamma(shape, rate) (Wilson-Hilferty; accurate for shape above ~2, ours is 30+). */
const gammaQuantile = (shape, rate, p) => {
  const k = 1 / (9 * shape);
  const base = 1 - k + normalQuantile(p) * Math.sqrt(k);
  return (shape / rate) * Math.max(base, 0) ** 3;
};

/**
 * Strength (alpha) of the prior "a topic grows like its neighbors", from how much the observed
 * ratios spread beyond what counting noise explains (empirical Bayes). Clamped to [3, 200].
 * @param {Array<{c: number, e: number}>} rows observed and expected counts
 */
const estimatePriorStrength = (rows) => {
  if (rows.length < 20) return DEFAULT_PRIOR_STRENGTH;
  const ratios = rows.map((row) => row.c / row.e).sort((a, b) => a - b);
  // The 5% extremes (broken topics) would make every other topic look alike.
  const cut = Math.floor(ratios.length * 0.05);
  const kept = ratios.slice(cut, ratios.length - cut);
  const center = mean(kept);
  const variance = mean(kept.map((ratio) => (ratio - center) ** 2));
  const noise = mean(rows.map((row) => 1 / row.e));
  const spread = Math.max(variance - noise, 1 / 200);
  return Math.min(Math.max(1 / spread, 3), 200);
};

/** Posterior of a growth ratio: its mean and its 20th / 80th percentile. */
const growthPosterior = (count, expected, alpha) => {
  const shape = count + alpha;
  const rate = expected + alpha;
  return {
    rate: shape / rate,
    lower: gammaQuantile(shape, rate, 0.2),
    upper: gammaQuantile(shape, rate, 0.8),
  };
};

/** Share of top-cited works, shrunk toward 10% (what chance gives), with a lower bound. */
const topShare = (top, total) => {
  const { mean: priorMean, strength } = TOP_SHARE_PRIOR;
  const n = total + strength;
  const share = (top + priorMean * strength) / n;
  const spread = Z_LOWER * Math.sqrt((share * (1 - share)) / n);
  return { share, lower: Math.max(share - spread, 0) };
};

/** Percentile (0-100) of each value among all of them; ties share their average rank. */
const percentiles = (values) => {
  if (values.length === 1) return [50];
  const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
  const result = new Array(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1].value === order[i].value) j += 1;
    const rank = (i + j) / 2;
    for (let k = i; k <= j; k += 1) result[order[k].index] = (rank / (order.length - 1)) * 100;
    i = j + 1;
  }
  return result;
};

/** Weighted mean of the available components (null ones are left out and the weights renormalized). */
const blend = (components, weights) => {
  let total = 0;
  let weightSum = 0;
  for (const [name, weight] of Object.entries(weights)) {
    const value = components[name];
    if (typeof value === 'number' && Number.isFinite(value)) {
      total += value * weight;
      weightSum += weight;
    }
  }
  return weightSum ? total / weightSum : null;
};

// ---------------------------------------------------------------- labels

/** How the topic moves against its neighbors, with the confidence the posterior allows. */
const trendOf = ({ eligible, lower, upper }) => {
  if (!eligible) return 'niche';
  if (lower >= 1.2) return 'surging';
  if (lower >= 1.03) return 'rising';
  if (upper <= 0.97) return 'cooling';
  return 'steady';
};

/** Where the topic stands in its life: few works but growing, growing, stable, or shrinking. */
const phaseOf = ({ eligible, yoy, lower, upper, volumeLevel, acceleration }) => {
  if (!eligible) return null;
  if (volumeLevel < 50 && lower >= 1.1 && (acceleration === null || acceleration >= 0))
    return 'emerging';
  if (upper <= 0.97 && yoy < -0.05) return 'declining';
  if (yoy > 0.05) return 'growing';
  return 'mature';
};

// ---------------------------------------------------------------- scoring

const baselineRatio = (rows, pick) => {
  const ratios = rows.map(pick).filter((ratio) => Number.isFinite(ratio) && ratio > 0);
  return ratios.length >= MIN_BASELINE_TOPICS ? median(ratios) : null;
};

/**
 * Scores every topic.
 * @param {Array<{ id: string, lab: string, subfield: number|string, c0: number, c1: number,
 *   c2: number, top: number }>} rows works in w0, w1, w2 and top-cited works in the matured window
 * @returns {Map<string, object>} score per id (see the fields below)
 */
const scoreTopics = (rows) => {
  const eligibleOf = (row) => row.c0 >= MIN_RECENT_WORKS && row.c1 >= MIN_PREVIOUS_WORKS;
  const usable = rows.filter(eligibleOf);

  // What a typical topic did, in its area, else in its lab, else everywhere: the trend to compare with.
  const groupBy = (list, key) => {
    const groups = new Map();
    for (const row of list) {
      const value = key(row);
      if (!groups.has(value)) groups.set(value, []);
      groups.get(value).push(row);
    }
    return groups;
  };
  const nowOf = (row) => row.c0 / row.c1;
  const beforeOf = (row) => row.c1 / row.c2;
  const solid = (row) => row.c0 >= 30 && row.c1 >= 30;
  const solidBefore = (row) => row.c1 >= 30 && row.c2 >= 30;
  const globalNow = baselineRatio(rows.filter(solid), nowOf) || 1;
  const globalBefore = baselineRatio(rows.filter(solidBefore), beforeOf) || 1;
  const typical = (list, fallback) => ({
    now: baselineRatio(list.filter(solid), nowOf) || fallback.now,
    before: baselineRatio(list.filter(solidBefore), beforeOf) || fallback.before,
  });
  const labBaselines = new Map(
    [...groupBy(rows, (row) => row.lab)].map(([lab, list]) => [
      lab,
      typical(list, { now: globalNow, before: globalBefore }),
    ])
  );
  const areaBaselines = new Map(
    [...groupBy(rows, (row) => `${row.lab}/${row.subfield}`)].map(([key, list]) => [
      key,
      typical(list, labBaselines.get(list[0].lab)),
    ])
  );
  const expected = new Map(
    rows.map((row) => [row.id, areaBaselines.get(`${row.lab}/${row.subfield}`)])
  );
  const alpha = estimatePriorStrength(
    usable.map((row) => ({ c: row.c0, e: row.c1 * expected.get(row.id).now }))
  );

  const results = new Map();
  for (const row of rows) {
    const eligible = eligibleOf(row);
    const base = expected.get(row.id);
    const now = growthPosterior(row.c0, row.c1 * base.now, alpha);
    const hasBefore = row.c2 >= MIN_PREVIOUS_WORKS && row.c1 >= MIN_RECENT_WORKS;
    const before = hasBefore ? growthPosterior(row.c1, row.c2 * base.before, alpha) : null;
    const matured = row.c1 + row.c2;
    const impact = topShare(row.top || 0, matured);
    results.set(row.id, {
      eligible,
      alpha,
      yoy: row.c1 > 0 ? row.c0 / row.c1 - 1 : null,
      growth: { ...now, expected: row.c1 * base.now },
      acceleration: before ? Math.log(now.rate) - Math.log(before.rate) : null,
      impact: { ...impact, top: row.top || 0, works: matured },
      lab: row.lab,
    });
  }

  // Components become percentiles among the ranked topics of the same lab.
  const labs = groupBy(rows.filter(eligibleOf), (row) => row.lab);
  for (const labRows of labs.values()) {
    const scoreOf = (row) => results.get(row.id);
    const level = (valueOf, filter = () => true) => {
      const subset = labRows.filter((row) => filter(scoreOf(row)));
      const ranks = percentiles(subset.map((row) => valueOf(scoreOf(row), row)));
      return new Map(subset.map((row, index) => [row.id, ranks[index]]));
    };
    const growthLevel = level((score) => score.growth.lower);
    const accelerationLevel = level(
      (score) => score.acceleration,
      (score) => score.acceleration !== null
    );
    const impactLevel = level((score) => score.impact.lower);
    const volumeLevel = level((_score, row) => row.c0);
    for (const row of labRows) {
      const score = scoreOf(row);
      const components = {
        growth: growthLevel.get(row.id),
        acceleration: accelerationLevel.get(row.id) ?? null,
        impact: impactLevel.get(row.id),
        volume: volumeLevel.get(row.id),
      };
      score.levels = { ...components };
      score.hotBase = blend(components, HOT_WEIGHTS);
    }
  }

  for (const row of rows) {
    const score = results.get(row.id);
    if (!score.eligible) {
      score.levels = { growth: null, acceleration: null, impact: null, volume: null };
      score.hotBase = null;
    }
    score.trend = trendOf({
      eligible: score.eligible,
      lower: score.growth.lower,
      upper: score.growth.upper,
    });
    score.phase = phaseOf({
      eligible: score.eligible,
      yoy: score.yoy ?? 0,
      lower: score.growth.lower,
      upper: score.growth.upper,
      volumeLevel: score.levels.volume ?? 0,
      acceleration: score.acceleration,
    });
  }
  return results;
};

/** Final hot score: the OpenAlex score, pulled toward what the independent signals say. */
const hotScore = (hotBase, signalLevel) => {
  if (hotBase === null || hotBase === undefined) return null;
  if (signalLevel === null || signalLevel === undefined) return hotBase;
  return (1 - SIGNAL_SHARE) * hotBase + SIGNAL_SHARE * signalLevel;
};

module.exports = {
  MIN_RECENT_WORKS,
  MIN_PREVIOUS_WORKS,
  HOT_WEIGHTS,
  SIGNAL_SHARE,
  buildWindows,
  normalQuantile,
  gammaQuantile,
  estimatePriorStrength,
  growthPosterior,
  topShare,
  percentiles,
  blend,
  trendOf,
  phaseOf,
  scoreTopics,
  hotScore,
};
