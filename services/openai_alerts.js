// Emails an alert (throttled) when OpenAI calls fail because the API key is missing or rejected.
const config = require('../config');
const { sendMail } = require('./mailer');

let lastAlertAt = 0;
let lastAlertKey = '';

const normalizeErrorInfo = (error) => {
  const responseError = error?.response?.data?.error;
  return {
    status: error?.status ?? error?.response?.status ?? null,
    code: error?.code ?? responseError?.code ?? error?.error?.code ?? null,
    type: error?.type ?? responseError?.type ?? error?.error?.type ?? null,
    message: error?.message || responseError?.message || error?.error?.message || '',
  };
};

const AUTH_ERROR_CODES = new Set([
  'invalid_api_key',
  'authentication_error',
  'invalid_authentication',
  'account_deactivated',
]);

const isAuthError = (info) => {
  const message = (info.message || '').toLowerCase();
  if (info.status === 401 || info.status === 403) return true;
  if (info.type === 'authentication_error') return true;
  if (info.code && AUTH_ERROR_CODES.has(String(info.code))) return true;
  if (message.includes('invalid api key') || message.includes('incorrect api key')) return true;
  return message.includes('expired') && (message.includes('token') || message.includes('api key'));
};

const shouldAlert = (key) => {
  const now = Date.now();
  if (lastAlertKey === key && now - lastAlertAt < config.alerts.throttleMs) {
    return false;
  }
  lastAlertKey = key;
  lastAlertAt = now;
  return true;
};

const buildAlertText = (title, context, info) => {
  const lines = [
    title,
    `Time: ${new Date().toISOString()}`,
    `Operation: ${context?.operation || 'unknown'}`,
    `Node env: ${config.env}`,
  ];
  if (info) {
    lines.push(`Status: ${info.status ?? 'n/a'}`);
    lines.push(`Code: ${info.code ?? 'n/a'}`);
    lines.push(`Type: ${info.type ?? 'n/a'}`);
    lines.push(`Message: ${info.message || 'n/a'}`);
  }
  return lines.join('\n');
};

const sendAlert = async (subject, text) => {
  console.error(text);
  if (!config.alerts.to || (!config.isTest && !config.mail.password)) {
    return;
  }
  try {
    await sendMail({ to: config.alerts.to, subject, text });
  } catch (sendError) {
    console.error('Failed to send OpenAI alert email:', sendError.message);
  }
};

const reportOpenAIAuthError = async (error, context = {}) => {
  const info = normalizeErrorInfo(error);
  if (!isAuthError(info) || !shouldAlert(`auth:${context.operation || 'unknown'}`)) {
    return false;
  }
  await sendAlert(
    'OpenAI auth error (token expired?)',
    buildAlertText('OpenAI authentication error detected.', context, info)
  );
  return true;
};

const reportOpenAIMissingApiKey = async (context = {}) => {
  if (!shouldAlert(`missing:${context.operation || 'unknown'}`)) {
    return false;
  }
  await sendAlert('OpenAI API key missing', buildAlertText('OpenAI API key is missing.', context));
  return true;
};

module.exports = {
  reportOpenAIAuthError,
  reportOpenAIMissingApiKey,
  normalizeErrorInfo,
  isAuthError,
};
