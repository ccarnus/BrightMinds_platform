// Lazily-created OpenAI client. Returns null when no API key is configured.
const config = require('../config');

let client;

const getOpenAIClient = () => {
  if (!config.openai.apiKey) return null;
  if (!client) {
    const OpenAI = require('openai');
    client = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return client;
};

module.exports = { getOpenAIClient };
