#!/usr/bin/env node
// Operator commands for the AI pipeline. On the server:
//   docker compose exec brightminds node scripts/ai.js <command>
//   status            content still missing AI outputs (with last error)
//   retry [--failed]  queue unprocessed content now (--failed also retries items that gave up)
//   check             verify the OpenAI key, the configured models and the chat parameters
const mongoose = require('mongoose');
const config = require('../config');
const { callOpenAI } = require('../services/openai');
const { enqueueRetries, getAIStatus } = require('../services/ai_retry');

const printStatus = async () => {
  const status = await getAIStatus();
  for (const [type, { total, unprocessed }] of Object.entries(status)) {
    console.log(`\n${type}s: ${total} total, ${unprocessed.length} missing AI outputs`);
    for (const item of unprocessed) {
      const when = item.lastAttemptAt ? new Date(item.lastAttemptAt).toISOString() : 'never';
      console.log(
        `  [${item.status}] ${item.title} (${item.id}) attempts=${item.attempts} last=${when}`
      );
      if (item.lastError) console.log(`      ${item.lastError}`);
    }
  }
};

const check = async () => {
  const { chatModel, imageModel, transcriptionModel, reasoningEffort } = config.openai;
  console.log(`Key: ${config.openai.apiKey ? 'set' : 'MISSING'}`);
  let ok = true;
  for (const model of [chatModel, imageModel, transcriptionModel]) {
    try {
      await callOpenAI('checkModel', (client) => client.models.retrieve(model));
      console.log(`  OK      model ${model}`);
    } catch (error) {
      ok = false;
      console.log(`  FAILED  model ${model}: ${error.message}`);
    }
  }
  try {
    // Same parameters as the pipeline (structured output, reasoning effort), on a tiny input.
    await callOpenAI('checkChat', (client) =>
      client.chat.completions.create({
        model: chatModel,
        reasoning_effort: reasoningEffort,
        max_completion_tokens: 200,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'check',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['ok'],
              properties: { ok: { type: 'boolean' } },
            },
          },
        },
        messages: [{ role: 'user', content: 'Answer with ok = true.' }],
      })
    );
    console.log(`  OK      structured output with reasoning_effort=${reasoningEffort}`);
  } catch (error) {
    ok = false;
    console.log(`  FAILED  chat parameters: ${error.message}`);
  }
  return ok;
};

const main = async () => {
  const [command, flag] = process.argv.slice(2);
  if (command === 'check') {
    process.exitCode = (await check()) ? 0 : 1;
    return;
  }
  if (!['status', 'retry'].includes(command)) {
    console.log('Usage: node scripts/ai.js status | retry [--failed] | check');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(config.mongoUri);
  try {
    if (command === 'status') await printStatus();
    else {
      const queued = await enqueueRetries({ includeFailed: flag === '--failed' });
      console.log(`Queued ${queued.cast} cast(s) and ${queued.article} article(s).`);
      const { castQueue } = require('../queues/cast_queue');
      const { articleQueue } = require('../queues/article_queue');
      await Promise.all([castQueue.close(), articleQueue.close()]);
    }
  } finally {
    await mongoose.disconnect();
  }
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
