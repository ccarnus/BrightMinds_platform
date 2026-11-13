#!/usr/bin/env node
// Operator commands for the research atlas. On the server:
//   docker compose exec brightminds node scripts/atlas.js <command>
//   status          what is stored and when each part was refreshed
//   sync            download the topic catalog from OpenAlex (about 25 requests)
//   metrics         count the works of every topic and score them (a few hundred requests, ~7 minutes)
//   signals         run PubMed / arXiv / Wikipedia for the tracked topics
//   all             sync when old, then metrics, then signals (what the weekly job does)
//   hot [lab]       the hottest topics, optionally of one lab (e.g. Medicine)
//   topic <text>    scores of the topics whose name contains <text>
const mongoose = require('mongoose');
const config = require('../config');
const Topic = require('../models/topic_model');
const { syncCatalog } = require('../services/atlas_sync');
const { refreshTopicMetrics } = require('../services/topic_metrics');
const { refreshSignals } = require('../services/topic_signals');
const { refreshAtlas, getStatus } = require('../services/atlas');

const log = (message) => console.log(message);

const printStatus = async () => {
  const status = await getStatus();
  const when = (date) => (date ? new Date(date).toISOString() : 'never');
  console.log(
    `OpenAlex key: ${status.openalexKey ? 'set' : 'not set (shared keyless budget: set OPENALEX_API_KEY)'}`
  );
  console.log(`catalog synced: ${when(status.catalogSyncedAt)}`);
  console.log(
    `metrics:        ${when(status.metricsAt)} (windows end ${status.windowsEndOn || '-'})`
  );
  console.log(`signals:        ${when(status.signalsAt)}`);
  console.log(`topics: ${JSON.stringify(status.topics)}`);
  if (status.lastError)
    console.log(`last error (${when(status.lastErrorAt)}): ${status.lastError}`);
};

const printTopics = (topics) => {
  for (const topic of topics) {
    const s = topic.score || {};
    console.log(
      `${String(s.hot ?? '-').padStart(5)}  ${String(s.trend || '-').padEnd(8)} ${String(s.phase || '-').padEnd(9)}` +
        ` ${String(s.works12m ?? 0).padStart(8)} works  ${topic.departmentName} / ${topic.subfield?.name || '-'} / ${topic.name}`
    );
  }
};

const hot = async (lab) => {
  const filter = { 'score.hot': { $ne: null }, 'score.trend': { $in: ['surging', 'rising'] } };
  if (lab) filter.departmentName = lab;
  printTopics(await Topic.find(filter).sort({ 'score.hot': -1 }).limit(25).lean());
};

const topic = async (text) => {
  if (!text) throw new Error('Usage: atlas.js topic <text>');
  const found = await Topic.find({
    name: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
  })
    .limit(15)
    .lean();
  printTopics(found);
  if (found.length === 1)
    console.log(
      JSON.stringify(
        { score: found[0].score, signals: found[0].signals, ids: found[0].ids },
        null,
        2
      )
    );
};

const commands = {
  status: printStatus,
  sync: async () => console.log(await syncCatalog()),
  metrics: async () => console.log(await refreshTopicMetrics({ log })),
  signals: async () => console.log(await refreshSignals({ log })),
  all: async () => console.log(await refreshAtlas({ log })),
  hot: (lab) => hot(lab),
  topic: (text) => topic(text),
};

const main = async () => {
  const [command, argument] = process.argv.slice(2);
  if (!commands[command]) {
    console.log('Commands: status | sync | metrics | signals | all | hot [lab] | topic <text>');
    return false;
  }
  await mongoose.connect(config.mongoUri);
  try {
    await commands[command](argument);
  } finally {
    await mongoose.disconnect();
  }
  return true;
};

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
