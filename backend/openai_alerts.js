const nodemailer = require('nodemailer');

const DEFAULT_THROTTLE_MS = 60 * 60 * 1000;

const ALERT_EMAIL_TO = process.env.OPENAI_ALERT_EMAIL_TO || process.env.ALERT_EMAIL_TO;
const ALERT_EMAIL_FROM =
  process.env.OPENAI_ALERT_EMAIL_FROM ||
  process.env.ALERT_EMAIL_FROM ||
  'clement.carnus@brightmindsresearch.com';
const ALERT_EMAIL_PWD =
  process.env.OPENAI_ALERT_EMAIL_PWD ||
  process.env.ALERT_EMAIL_PWD ||
  process.env.EMAIL_PWD;
const ALERT_THROTTLE_MS = Number(process.env.OPENAI_ALERT_THROTTLE_MS) || DEFAULT_THROTTLE_MS;

let transporter = null;
let lastAlertAt = 0;
let lastAlertKey = '';

const normalizeErrorInfo = (error) => {
  const responseError = error?.response?.data?.error;
  return {
    status: error?.status ?? error?.response?.status ?? null,
    code: error?.code ?? responseError?.code ?? error?.error?.code ?? null,
    type: error?.type ?? responseError?.type ?? error?.error?.type ?? null,
    message:
      error?.message ||
      responseError?.message ||
      error?.error?.message ||
      '',
  };
};

const isAuthError = (info) => {
  const message = (info.message || '').toLowerCase();
  if (info.status === 401 || info.status === 403) {
    return true;
  }
  if (info.type === 'authentication_error') {
    return true;
  }
  if (info.code) {
    const code = String(info.code);
    if (
      code === 'invalid_api_key' ||
      code === 'authentication_error' ||
      code === 'invalid_authentication' ||
      code === 'account_deactivated'
    ) {
      return true;
    }
  }
  if (message.includes('invalid api key') || message.includes('incorrect api key')) {
    return true;
  }
  if (message.includes('expired') && (message.includes('token') || message.includes('api key'))) {
    return true;
  }
  return false;
};

const shouldAlert = (key) => {
  const now = Date.now();
  if (lastAlertKey === key && now - lastAlertAt < ALERT_THROTTLE_MS) {
    return false;
  }
  lastAlertKey = key;
  lastAlertAt = now;
  return true;
};

const getTransporter = () => {
  if (!ALERT_EMAIL_TO || !ALERT_EMAIL_PWD || !ALERT_EMAIL_FROM) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
        user: ALERT_EMAIL_FROM,
        pass: ALERT_EMAIL_PWD,
      },
    });
  }
  return transporter;
};

const sendAlertEmail = async (subject, text) => {
  const mailer = getTransporter();
  if (!mailer) {
    return false;
  }
  await mailer.sendMail({
    from: ALERT_EMAIL_FROM,
    to: ALERT_EMAIL_TO,
    subject,
    text,
  });
  return true;
};

const buildAlertText = (title, context, info) => {
  const lines = [
    title,
    `Time: ${new Date().toISOString()}`,
    `Operation: ${context?.operation || 'unknown'}`,
    `Node env: ${process.env.NODE_ENV || 'unknown'}`,
  ];

  if (info) {
    lines.push(`Status: ${info.status ?? 'n/a'}`);
    lines.push(`Code: ${info.code ?? 'n/a'}`);
    lines.push(`Type: ${info.type ?? 'n/a'}`);
    lines.push(`Message: ${info.message || 'n/a'}`);
  }

  return lines.join('\n');
};

const reportOpenAIAuthError = async (error, context = {}) => {
  const info = normalizeErrorInfo(error);
  if (!isAuthError(info)) {
    return false;
  }

  const key = `auth:${context.operation || 'unknown'}`;
  if (!shouldAlert(key)) {
    return false;
  }

  const text = buildAlertText('OpenAI authentication error detected.', context, info);
  console.error(text);
  try {
    await sendAlertEmail('OpenAI auth error (token expired?)', text);
  } catch (sendError) {
    console.error('Failed to send OpenAI alert email:', sendError.message);
  }
  return true;
};

const reportOpenAIMissingApiKey = async (context = {}) => {
  const key = `missing:${context.operation || 'unknown'}`;
  if (!shouldAlert(key)) {
    return false;
  }

  const text = buildAlertText('OpenAI API key is missing.', context);
  console.error(text);
  try {
    await sendAlertEmail('OpenAI API key missing', text);
  } catch (sendError) {
    console.error('Failed to send OpenAI alert email:', sendError.message);
  }
  return true;
};

module.exports = {
  reportOpenAIAuthError,
  reportOpenAIMissingApiKey,
};
