const request = require('supertest');
const axios = require('axios');
const app = require('../../app');
const VirtualLab = require('../../models/virtual_lab_model');
const Topic = require('../../models/topic_model');
const { departments, departmentNames } = require('../../lists/departments');
const {
  computeLevels,
  fetchWorksByField,
  refreshLabResearch,
} = require('../../services/lab_research');
const { useTestDatabase } = require('../helpers/db');
const { createCast } = require('../helpers/fixtures');

jest.mock('axios');

useTestDatabase();

const idOf = (name) => departments.find((department) => department.display_name === name).id;

describe('computeLevels', () => {
  test('spreads volumes on a log scale between the quietest and the busiest lab', () => {
    expect(computeLevels([9, 999, 99999])).toEqual([0, 50, 100]);
    expect(computeLevels([5])).toEqual([50]);
    expect(computeLevels([7, 7])).toEqual([50, 50]);
    expect(computeLevels([])).toEqual([]);
  });

  test('an empty field counts as the quietest, not as an error', () => {
    const [empty, busy] = computeLevels([0, 999]);
    expect([empty, busy]).toEqual([0, 100]);
  });
});

describe('fetchWorksByField', () => {
  test('reads the counts per field id and asks for the last 12 months', async () => {
    axios.get.mockResolvedValueOnce({
      data: {
        group_by: [
          { key: 'https://openalex.org/fields/17', count: 1133387 },
          { key: 'https://openalex.org/fields/27', count: 2161737 },
          { key: 'unknown', count: 5 },
        ],
      },
    });
    const counts = await fetchWorksByField(new Date('2026-11-12T10:00:00Z'));
    expect(counts.get(17)).toBe(1133387);
    expect(counts.get(27)).toBe(2161737);
    expect(counts.size).toBe(2);
    const { params } = axios.get.mock.calls[0][1];
    expect(params.filter).toBe('from_publication_date:2025-11-12,to_publication_date:2026-11-12');
    expect(params.group_by).toBe('primary_topic.field.id');
  });
});

describe('refreshLabResearch', () => {
  const fetchCounts = async () =>
    new Map([
      [idOf('Medicine'), 2161737],
      [idOf('Veterinary'), 16681],
      [idOf('ComputerScience'), 1133387],
    ]);

  test('creates a lab for every department and stores works and level', async () => {
    const result = await refreshLabResearch({ fetchCounts });
    expect(result.updated).toBe(departmentNames.length);
    expect(await VirtualLab.countDocuments()).toBe(departmentNames.length);

    const medicine = await VirtualLab.findOne({ name: 'Medicine' });
    expect(medicine.research.works12m).toBe(2161737);
    expect(medicine.research.level).toBe(100);
    expect(medicine.research.updatedAt).toBeInstanceOf(Date);

    // Fields OpenAlex did not return count as 0 works: the quietest labs.
    const dentistry = await VirtualLab.findOne({ name: 'Dentistry' });
    expect(dentistry.research.works12m).toBe(0);
    expect(dentistry.research.level).toBe(0);
    const cs = await VirtualLab.findOne({ name: 'ComputerScience' });
    expect(cs.research.level).toBeGreaterThan(0);
    expect(cs.research.level).toBeLessThan(100);
  });

  test('is repeatable and keeps the previous values when OpenAlex fails', async () => {
    await refreshLabResearch({ fetchCounts });
    await refreshLabResearch({ fetchCounts });
    expect(await VirtualLab.countDocuments()).toBe(departmentNames.length);

    await expect(refreshLabResearch({ fetchCounts: async () => new Map() })).rejects.toThrow(
      /no field counts/
    );
    await expect(
      refreshLabResearch({
        fetchCounts: async () => {
          throw new Error('timeout');
        },
      })
    ).rejects.toThrow('timeout');
    expect((await VirtualLab.findOne({ name: 'Medicine' })).research.level).toBe(100);
  });
});

describe('GET /virtual/lab/overview', () => {
  test('lists every department, with null research until it has been fetched', async () => {
    const res = await request(app).get('/virtual/lab/overview').expect(200);
    expect(res.body.labs.map((lab) => lab.name)).toEqual(departmentNames);
    expect(res.body.updatedAt).toBeNull();
    expect(res.body.labs[0]).toEqual({
      name: departmentNames[0],
      works12m: null,
      level: null,
      casts: 0,
      topics: 0,
    });
  });

  test('combines research, casts and topics per department', async () => {
    await refreshLabResearch({
      fetchCounts: async () =>
        new Map([
          [idOf('Medicine'), 2161737],
          [idOf('Veterinary'), 16681],
        ]),
    });
    await createCast({ department: 'Medicine' });
    await createCast({ department: 'Medicine' });
    await Topic.create({ name: 'CAR-T', departmentName: 'Medicine' });

    const res = await request(app).get('/virtual/lab/overview').expect(200);
    const medicine = res.body.labs.find((lab) => lab.name === 'Medicine');
    expect(medicine).toEqual({
      name: 'Medicine',
      works12m: 2161737,
      level: 100,
      casts: 2,
      topics: 1,
    });
    expect(res.body.labs.find((lab) => lab.name === 'Dentistry').level).toBe(0);
    expect(res.body.labs.find((lab) => lab.name === 'Veterinary').level).toBeGreaterThan(0);
    expect(res.body.updatedAt).toEqual(expect.any(String));
  });

  test('is not mistaken for a lab id', async () => {
    await request(app).get('/virtual/lab/overview').expect(200);
    await request(app).get('/virtual/lab/not-an-id').expect(400);
  });
});
