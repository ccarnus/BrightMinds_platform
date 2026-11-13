const {
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
} = require('../../services/topic_scoring');

describe('buildWindows', () => {
  test('three rolling years ending on the 1st of a month at least 30 days ago', () => {
    const windows = buildWindows(new Date('2026-11-12T10:00:00Z'), 30);
    expect(windows.endsOn).toBe('2026-10-01');
    expect(windows.w0).toEqual({ from: '2025-10-02', to: '2026-10-01' });
    expect(windows.w1).toEqual({ from: '2024-10-02', to: '2025-10-01' });
    expect(windows.w2).toEqual({ from: '2023-10-02', to: '2024-10-01' });
    expect(windows.matured).toEqual({ from: '2023-10-02', to: '2025-10-01' });
  });

  test('the lag can reach back into the previous month or year', () => {
    expect(buildWindows(new Date('2026-01-15T00:00:00Z'), 30).endsOn).toBe('2025-12-01');
    expect(buildWindows(new Date('2026-03-01T00:00:00Z'), 30).endsOn).toBe('2026-01-01');
  });
});

describe('statistics', () => {
  test('normalQuantile matches the usual values', () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 6);
    expect(normalQuantile(0.975)).toBeCloseTo(1.95996, 4);
    expect(normalQuantile(0.2)).toBeCloseTo(-0.84162, 4);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.09023, 3);
  });

  test('gammaQuantile is close to the mean for large shapes and ordered', () => {
    const lower = gammaQuantile(400, 400, 0.2);
    const upper = gammaQuantile(400, 400, 0.8);
    expect(lower).toBeCloseTo(1 - 0.8416 / 20, 2);
    expect(upper).toBeCloseTo(1 + 0.8416 / 20, 2);
    expect(gammaQuantile(40, 20, 0.5)).toBeCloseTo(2, 1);
  });

  test('the posterior of a growth ratio is shrunk toward 1 when there are few works', () => {
    const few = growthPosterior(40, 20, 10); // observed ratio 2
    const many = growthPosterior(4000, 2000, 10); // observed ratio 2
    expect(few.rate).toBeCloseTo(50 / 30, 6);
    expect(many.rate).toBeGreaterThan(1.99);
    expect(few.lower).toBeLessThan(many.lower);
    expect(few.lower).toBeLessThan(few.rate);
    expect(few.upper).toBeGreaterThan(few.rate);
    expect(many.lower).toBeGreaterThan(1.9);
  });

  test('prior strength: weak when topics differ a lot, strong when only counting noise', () => {
    const noisy = Array.from({ length: 200 }, (_, i) => ({ c: 100 * (i % 2 ? 1.5 : 0.5), e: 100 }));
    const calm = Array.from({ length: 200 }, (_, i) => ({ c: i % 2 ? 108 : 92, e: 100 }));
    expect(estimatePriorStrength(noisy)).toBeLessThan(10);
    expect(estimatePriorStrength(calm)).toBeGreaterThan(50);
    expect(estimatePriorStrength(calm.slice(0, 5))).toBe(10);
    expect(estimatePriorStrength(noisy)).toBeGreaterThanOrEqual(3);
    expect(estimatePriorStrength(calm)).toBeLessThanOrEqual(200);
  });

  test('topShare pulls small samples toward 10% and keeps a lower bound', () => {
    const small = topShare(5, 10);
    const large = topShare(2000, 10000);
    expect(small.share).toBeLessThan(0.3);
    expect(large.share).toBeCloseTo(0.2, 1);
    expect(small.lower).toBeLessThan(small.share);
    expect(topShare(0, 0).share).toBeCloseTo(0.1);
  });

  test('percentiles share the rank of ties and cope with one value', () => {
    expect(percentiles([5, 1, 3])).toEqual([100, 0, 50]);
    expect(percentiles([2, 2, 2])).toEqual([50, 50, 50]);
    expect(percentiles([7])).toEqual([50]);
    expect(percentiles([])).toEqual([]);
  });

  test('blend leaves out missing components and renormalizes', () => {
    expect(blend({ a: 100, b: 0 }, { a: 1, b: 1 })).toBe(50);
    expect(blend({ a: 100, b: null }, { a: 1, b: 3 })).toBe(100);
    expect(blend({}, { a: 1 })).toBeNull();
  });

  test('the hot score moves toward the independent signals, only when there are some', () => {
    expect(hotScore(80, null)).toBe(80);
    expect(hotScore(80, 0)).toBeCloseTo(60);
    expect(hotScore(null, 90)).toBeNull();
  });
});

describe('labels', () => {
  test.each([
    [{ eligible: false, lower: 2, upper: 3 }, 'niche'],
    [{ eligible: true, lower: 1.3, upper: 1.6 }, 'surging'],
    [{ eligible: true, lower: 1.1, upper: 1.4 }, 'rising'],
    [{ eligible: true, lower: 0.9, upper: 1.2 }, 'steady'],
    [{ eligible: true, lower: 0.6, upper: 0.9 }, 'cooling'],
  ])('trendOf %j is %s', (input, expected) => {
    expect(trendOf(input)).toBe(expected);
  });

  test.each([
    [{ eligible: false }, null],
    [
      { eligible: true, yoy: 0.8, lower: 1.4, upper: 1.9, volumeLevel: 20, acceleration: 0.1 },
      'emerging',
    ],
    [
      { eligible: true, yoy: 0.8, lower: 1.4, upper: 1.9, volumeLevel: 20, acceleration: -0.2 },
      'growing',
    ],
    [
      { eligible: true, yoy: 0.3, lower: 1.1, upper: 1.4, volumeLevel: 80, acceleration: 0 },
      'growing',
    ],
    [
      { eligible: true, yoy: 0.01, lower: 0.95, upper: 1.05, volumeLevel: 80, acceleration: 0 },
      'mature',
    ],
    [
      { eligible: true, yoy: -0.3, lower: 0.6, upper: 0.9, volumeLevel: 80, acceleration: 0 },
      'declining',
    ],
  ])('phaseOf %j is %s', (input, expected) => {
    expect(phaseOf(input)).toBe(expected);
  });
});

describe('scoreTopics', () => {
  // 40 topics of one area growing about 10% a year, then the cases we care about.
  const steady = Array.from({ length: 40 }, (_, i) => {
    const c1 = 400 + i * 10;
    return {
      id: `S${i}`,
      lab: 'Chemistry',
      subfield: 1,
      c0: Math.round(c1 * 1.1),
      c1,
      c2: Math.round(c1 / 1.1),
      top: Math.round(c1 * 0.2),
    };
  });
  const rows = [
    ...steady,
    { id: 'BIG', lab: 'Chemistry', subfield: 1, c0: 4000, c1: 2000, c2: 1500, top: 600 },
    { id: 'SMALL', lab: 'Chemistry', subfield: 1, c0: 40, c1: 20, c2: 18, top: 5 },
    { id: 'FALLING', lab: 'Chemistry', subfield: 1, c0: 600, c1: 1200, c2: 1300, top: 220 },
    { id: 'TINY', lab: 'Chemistry', subfield: 1, c0: 10, c1: 4, c2: 3, top: 0 },
  ];
  const scores = scoreTopics(rows);

  test('a large, clear surge is surging and the hottest of its lab', () => {
    const big = scores.get('BIG');
    expect(big.trend).toBe('surging');
    expect(big.eligible).toBe(true);
    const hottest = [...scores.entries()]
      .filter(([, s]) => s.hotBase !== null)
      .sort((a, b) => b[1].hotBase - a[1].hotBase)[0][0];
    expect(hottest).toBe('BIG');
    expect(big.yoy).toBeCloseTo(1, 6);
  });

  test('the same ratio on few works is not called a surge (shrinkage)', () => {
    const small = scores.get('SMALL');
    expect(small.yoy).toBeCloseTo(1, 6);
    expect(small.trend).not.toBe('surging');
    expect(small.growth.lower).toBeLessThan(scores.get('BIG').growth.lower);
  });

  test('a falling topic is cooling and declining', () => {
    expect(scores.get('FALLING').trend).toBe('cooling');
    expect(scores.get('FALLING').phase).toBe('declining');
    expect(scores.get('FALLING').hotBase).toBeLessThan(scores.get('BIG').hotBase);
  });

  test('topics below the volume floor are niche and have no hot score', () => {
    expect(scores.get('TINY')).toMatchObject({
      eligible: false,
      trend: 'niche',
      hotBase: null,
      phase: null,
    });
  });

  test('topics that follow their area are steady, close to the middle', () => {
    const middle = scores.get('S20');
    expect(middle.trend).toBe('steady');
    expect(middle.growth.rate).toBeCloseTo(1, 1);
    expect(middle.hotBase).toBeGreaterThan(5);
    expect(middle.hotBase).toBeLessThan(95);
  });

  test('acceleration compares this year with the one before, and is missing without history', () => {
    expect(scores.get('BIG').acceleration).toBeGreaterThan(0.2);
    expect(scores.get('FALLING').acceleration).not.toBeNull();
    const noHistory = scoreTopics([
      { id: 'A', lab: 'L', subfield: 1, c0: 100, c1: 80, c2: 0, top: 10 },
    ]).get('A');
    expect(noHistory.acceleration).toBeNull();
  });

  test('impact is the shrunk share of top-cited works', () => {
    expect(scores.get('BIG').impact.share).toBeGreaterThan(scores.get('FALLING').impact.share);
    expect(scores.get('BIG').impact.works).toBe(3500);
  });

  test('labs are ranked separately', () => {
    const two = scoreTopics([
      ...steady.map((row) => ({ ...row, id: `A${row.id}`, lab: 'A' })),
      ...steady.map((row) => ({ ...row, id: `B${row.id}`, lab: 'B' })),
    ]);
    expect(two.get('AS39').levels.volume).toBe(100);
    expect(two.get('BS39').levels.volume).toBe(100);
  });

  test('works with a single topic and with nothing', () => {
    expect(scoreTopics([]).size).toBe(0);
    const one = scoreTopics([
      { id: 'X', lab: 'L', subfield: 1, c0: 100, c1: 100, c2: 100, top: 10 },
    ]).get('X');
    expect(one.trend).toBe('steady');
    expect(one.hotBase).toBe(50);
  });
});
