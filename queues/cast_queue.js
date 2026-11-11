// Background AI processing of new casts (transcript, subtitles, question, topic).
const { createQueue } = require('./create_queue');
const { runAIJob } = require('../services/ai_pipeline');

// Queue name is persisted in Redis: do not rename.
const castQueue = createQueue('castQueue');

/** @param {{ data: { castId: string } }} job (older jobs may carry extra fields; they are ignored) */
const processCastJob = (job) => runAIJob(job);

const startCastWorker = () => castQueue.process(processCastJob);

module.exports = { castQueue, processCastJob, startCastWorker };
