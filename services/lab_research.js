// Research volume of each virtual lab (= department = OpenAlex "field"). It sizes the labs on the
// app's map. One OpenAlex request counts the articles and reviews published in the last 12 months
// for all fields.
const cron = require('node-cron');
const VirtualLab = require('../models/virtual_lab_model');
const config = require('../config');
const openalex = require('./openalex');
const { departments } = require('../lists/departments');

const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
// A failed refresh is not retried by incoming requests for this long.
const RETRY_AFTER_MS = 60 * 60 * 1000;

const log10p = (value) => Math.log10(value + 1);
const formatDate = (date) => date.toISOString().slice(0, 10);

/** Publication counts per OpenAlex field id over the last 12 months. @returns {Promise<Map<number, number>>} */
const fetchWorksByField = async (now = new Date()) => {
  const start = new Date(now);
  start.setUTCFullYear(now.getUTCFullYear() - 1);
  const data = await openalex.get('/works', {
    filter: [
      `type:${openalex.WORK_TYPES}`,
      `from_publication_date:${formatDate(start)}`,
      `to_publication_date:${formatDate(now)}`,
    ].join(','),
    group_by: 'primary_topic.field.id',
    per_page: 200,
  });
  const counts = new Map();
  for (const group of data?.group_by || []) {
    // Keys look like "https://openalex.org/fields/17".
    const id = Number(String(group.key).split('/').pop());
    if (Number.isFinite(id)) counts.set(id, Number(group.count) || 0);
  }
  return counts;
};

/**
 * Position of each value between the quietest and the busiest lab, 0-100, on a log scale (research
 * volumes differ by orders of magnitude). All equal gives 50.
 * @param {number[]} values
 */
const computeLevels = (values) => {
  if (!values.length) return [];
  const logs = values.map(log10p);
  const min = Math.min(...logs);
  const max = Math.max(...logs);
  if (max === min) return logs.map(() => 50);
  return logs.map((value) => Math.round(((value - min) / (max - min)) * 1000) / 10);
};

/** Makes sure every department has a lab document (labs are created from the department list). */
const ensureLabs = async () => {
  await VirtualLab.bulkWrite(
    departments.map(({ display_name: name }) => ({
      updateOne: {
        filter: { name },
        update: { $setOnInsert: { iconurl: '', colorcode: '' } },
        upsert: true,
      },
    }))
  );
};

/**
 * Fetches the research volume of every field and stores it on the labs.
 * Leaves the previous values in place when OpenAlex cannot be reached.
 * @returns {Promise<{ updated: number }>}
 */
const refreshLabResearch = async ({ fetchCounts = fetchWorksByField, now = new Date() } = {}) => {
  await ensureLabs();
  const counts = await fetchCounts(now);
  if (!counts.size) throw new Error('OpenAlex returned no field counts.');

  const works = departments.map(({ id }) => counts.get(id) || 0);
  const levels = computeLevels(works);
  await VirtualLab.bulkWrite(
    departments.map(({ display_name: name }, index) => ({
      updateOne: {
        filter: { name },
        update: {
          $set: {
            'research.works12m': works[index],
            'research.level': levels[index],
            'research.updatedAt': now,
          },
        },
      },
    }))
  );
  return { updated: departments.length };
};

const needsRefresh = async (now = Date.now()) => {
  const labs = await VirtualLab.find({ name: { $in: departments.map((d) => d.display_name) } })
    .select('research.updatedAt')
    .lean();
  if (labs.length < departments.length) return true;
  return labs.some((lab) => {
    const updatedAt = lab.research?.updatedAt;
    return !updatedAt || now - new Date(updatedAt).getTime() > STALE_AFTER_MS;
  });
};

let inFlight = null;
let lastFailureAt = 0;

/** Refreshes in the background when the data is missing or old; never throws, never overlaps. */
const refreshIfStale = () => {
  if (config.isTest || inFlight || Date.now() - lastFailureAt < RETRY_AFTER_MS) return inFlight;
  inFlight = needsRefresh()
    .then((stale) => (stale ? refreshLabResearch() : null))
    .catch((error) => {
      lastFailureAt = Date.now();
      console.error('Lab research refresh failed:', error.message);
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
};

/** Every Monday at 01:00, after the topic indicators update. */
const scheduleWeeklyLabResearch = () => {
  if (config.isTest) return null;
  return cron.schedule('0 1 * * 1', () => {
    refreshLabResearch().catch((error) =>
      console.error('Lab research refresh failed:', error.message)
    );
  });
};

module.exports = {
  fetchWorksByField,
  computeLevels,
  ensureLabs,
  refreshLabResearch,
  refreshIfStale,
  scheduleWeeklyLabResearch,
};
