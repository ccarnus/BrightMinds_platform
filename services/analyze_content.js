// One structured-output call per cast/article producing the multiple-choice question and the
// department (used when the author didn't pick one).
const config = require('../config');
const { departmentNames } = require('../lists/departments');
const { AIError, callOpenAI } = require('./openai');

// Long talks/articles are cut (beginning and end are kept: they hold the framing and conclusion).
const MAX_CONTENT_CHARS = 60000;

const SYSTEM_PROMPT = `You create learning material for BrightMinds, a mobile app where people discover research through short talks ("casts") and articles. After going through many pieces of content, users answer one multiple-choice question per piece to check what they understood.

From the content provided, produce:

1. question, correct_answer, distractors: one multiple-choice question.
- Test the core idea: the main finding, the problem addressed, the approach, or why it matters. Do not test trivia (names, dates, exact figures, word-for-word phrasing) unless it is the central result.
- It must be answerable by someone who followed the content, without outside knowledge, and only correct_answer may be right according to the content.
- It must stand alone: users see it later, mixed with questions about other content. Name the subject (e.g. "In research on zinc and bacterial infections, ...") and never refer to "the speaker", "the talk", "this video", "the author" or "the article".
- Exactly 3 distractors: plausible to someone who did not follow the content, on the same subject, similar to the correct answer in length, grammar and specificity, and clearly wrong according to the content. No "all/none of the above", no jokes, no trick negations.
- At most 25 words for the question and 12 words per answer. Write in the language of the content.

2. department: the academic field that best fits the research, from the allowed values.

Talk transcripts come from automatic speech recognition and may contain misheard words: rely on the intended meaning and spell terms correctly.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['question', 'correct_answer', 'distractors', 'department'],
  properties: {
    question: { type: 'string' },
    correct_answer: { type: 'string' },
    distractors: { type: 'array', items: { type: 'string' } },
    department: { type: 'string', enum: departmentNames },
  },
};

const truncate = (text) => {
  const value = String(text || '').trim();
  if (value.length <= MAX_CONTENT_CHARS) return value;
  const half = MAX_CONTENT_CHARS / 2;
  return `${value.slice(0, half)}\n[...]\n${value.slice(-half)}`;
};

const buildUserMessage = ({ title, description, contentType }) =>
  `Content type: ${contentType === 'cast' ? 'research talk (transcript)' : 'article'}\n` +
  `Title: ${String(title || '').trim()}\n\n<content>\n${truncate(description)}\n</content>`;

const shuffle = (array) => {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

/**
 * Validates the model output and converts it to the stored shape { question, responses, correct }
 * (responses shuffled; `correct` is one of them, compared as a string by the app).
 * @returns {{ question: string, responses: string[], correct: string } | null}
 */
const toEvaluation = (output) => {
  const clean = (value) => String(value ?? '').trim();
  const question = clean(output?.question);
  const correct = clean(output?.correct_answer);
  if (!question || !correct) return null;
  const seen = new Set([correct.toLowerCase()]);
  const distractors = [];
  for (const value of Array.isArray(output?.distractors) ? output.distractors : []) {
    const answer = clean(value);
    if (answer && !seen.has(answer.toLowerCase())) {
      seen.add(answer.toLowerCase());
      distractors.push(answer);
    }
  }
  if (distractors.length < 3) return null;
  return { question, responses: shuffle([correct, ...distractors.slice(0, 3)]), correct };
};

const MOCK_ANALYSIS = () => ({
  evaluation: { question: 'Mock question?', responses: ['A', 'B', 'C', 'D'], correct: 'A' },
  department: departmentNames[0],
});

/**
 * @param {{ title: string, description: string, contentType: 'cast'|'article' }} content
 * @returns {Promise<{ evaluation: object, department: string }>}
 * @throws {AIError}
 */
const analyzeContent = async (content) => {
  if (config.isTest) return MOCK_ANALYSIS();

  const response = await callOpenAI('analyzeContent', (client) =>
    client.chat.completions.create({
      model: config.openai.chatModel,
      reasoning_effort: config.openai.reasoningEffort,
      max_completion_tokens: 4000,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'content_analysis', strict: true, schema: SCHEMA },
      },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserMessage(content) },
      ],
    })
  );

  const message = response.choices?.[0]?.message;
  const fail = (reason) => {
    throw new AIError('content', `analyzeContent: ${reason}`, { operation: 'analyzeContent' });
  };
  if (message?.refusal) fail(`model refused (${message.refusal})`);
  let output;
  try {
    output = JSON.parse(message?.content ?? '');
  } catch {
    fail(`unparsable output (finish_reason ${response.choices?.[0]?.finish_reason})`);
  }
  const evaluation = toEvaluation(output);
  if (!evaluation) fail(`invalid question: ${message.content.slice(0, 300)}`);
  if (!departmentNames.includes(output.department)) fail(`unknown department ${output.department}`);
  return { evaluation, department: output.department };
};

module.exports = { analyzeContent, toEvaluation, buildUserMessage, SYSTEM_PROMPT };
