// Generates the multiple-choice evaluation attached to each cast/article.
const config = require('../config');
const { getOpenAIClient } = require('./openai');
const { reportOpenAIAuthError, reportOpenAIMissingApiKey } = require('./openai_alerts');

const cleanAnswerChoice = (choice) => choice.replace(/^\s*[a-zA-Z][).]\s*/, '').trim();

const shuffle = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

/**
 * Parses the model output: first non-empty line is the question, following lines are
 * the answers with the correct one first. Answers are shuffled before being returned.
 * @returns {{question: string, responses: string[], correct: string} | null}
 */
const parseEvaluation = (text) => {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return null;

  const question = lines[0].replace(/^question:\s*/i, '');
  const responses = lines.slice(1).map(cleanAnswerChoice).filter(Boolean);
  if (responses.length < 2) return null;

  const correct = responses[0];
  return { question, responses: shuffle(responses), correct };
};

const buildPrompt = (description) =>
  'Generate a multiple-choice question based on the following description (place the correct ' +
  'answer first). The question should aim to see if the user understood what was described. The ' +
  'user will answer the question after seeing many different description, so the question should ' +
  'not expect the user to know what description it refers to. Here is the description: ' +
  `${description}\nQuestion:`;

/** @returns {Promise<{question, responses, correct} | null>} */
const generateEvaluation = async (description) => {
  if (config.isTest) {
    return { question: 'Mock question?', responses: ['A', 'B', 'C', 'D'], correct: 'A' };
  }

  const client = getOpenAIClient();
  if (!client) {
    await reportOpenAIMissingApiKey({ operation: 'generateEvaluation' });
    return null;
  }

  try {
    const response = await client.chat.completions.create({
      model: config.openai.chatModel,
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: buildPrompt(description) },
      ],
      max_tokens: 500,
      temperature: 0.7,
    });
    const evaluation = parseEvaluation(response.choices?.[0]?.message?.content);
    if (!evaluation) {
      console.error(
        'Could not parse generated evaluation:',
        response.choices?.[0]?.message?.content
      );
    }
    return evaluation;
  } catch (error) {
    await reportOpenAIAuthError(error, { operation: 'generateEvaluation' });
    console.error('Error generating question:', error);
    return null;
  }
};

module.exports = generateEvaluation;
module.exports.parseEvaluation = parseEvaluation;
