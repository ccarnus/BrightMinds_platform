// Emails an alert when the AI pipeline cannot use OpenAI or gives up on an item.
// Throttled per (kind, operation) so an outage sends one email, not one per queued item.
const config = require('../config');
const { sendMail } = require('./mailer');

const lastAlertAt = new Map();

const SUBJECTS = {
  config: 'OpenAI configuration problem (API key, credit or model)',
  transient: 'OpenAI unreachable: AI processing delayed',
  content: 'AI processing gave up on an item',
};

const ACTIONS = {
  config:
    'Check OPENAI_API_KEY, the account credit and the model names (OPENAI_*_MODEL), then restart ' +
    'the API. Unprocessed content is retried automatically every day.',
  transient:
    'Nothing to do if this is temporary: unprocessed content is retried automatically every day.',
  content:
    'This item reached the maximum number of attempts and will not be retried automatically. ' +
    'Fix it, then run `node scripts/ai.js retry --failed`.',
};

const shouldAlert = (key) => {
  const now = Date.now();
  if (now - (lastAlertAt.get(key) ?? -Infinity) < config.alerts.throttleMs) return false;
  lastAlertAt.set(key, now);
  return true;
};

/**
 * @param {{ kind: string, operation?: string, message: string, status?: number, code?: string }} error
 * @param {string} [details] Extra lines (e.g. which item).
 * @returns {Promise<boolean>} Whether an alert was emitted (false when throttled).
 */
const alertOpenAIProblem = async (error, details = '') => {
  const kind = SUBJECTS[error.kind] ? error.kind : 'content';
  const operation = error.operation || 'unknown';
  if (!shouldAlert(`${kind}:${operation}:${details}`)) return false;

  const text = [
    SUBJECTS[kind],
    `Time: ${new Date().toISOString()}`,
    `Operation: ${operation}`,
    `Error: ${error.message}`,
    `Status: ${error.status ?? 'n/a'} · Code: ${error.code ?? 'n/a'}`,
    details,
    '',
    ACTIONS[kind],
  ]
    .filter((line) => line !== undefined)
    .join('\n');
  console.error(text);

  if (config.alerts.to && (config.isTest || config.mail.password)) {
    try {
      await sendMail({ to: config.alerts.to, subject: `[BrightMinds] ${SUBJECTS[kind]}`, text });
    } catch (sendError) {
      console.error('Failed to send OpenAI alert email:', sendError.message);
    }
  }
  return true;
};

/** Test helper: forget throttling state. */
const resetAlertThrottle = () => lastAlertAt.clear();

module.exports = { alertOpenAIProblem, resetAlertThrottle };
