// All outgoing email goes through here. In tests, messages are captured instead of sent.
const nodemailer = require('nodemailer');
const config = require('../config');

const MAX_ATTEMPTS = 2;
const TRANSIENT_CODES = new Set([
  'ETIMEDOUT',
  'ECONNECTION',
  'ECONNRESET',
  'ECONNREFUSED',
  'ESOCKET',
  'EDNS',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * A failed send, sorted by what to do about it (`kind`):
 * - `config`: credentials missing or refused: nothing is sent until an operator fixes them;
 * - `transient`: network or temporary SMTP trouble: trying again later can work;
 * - `recipient`: the address was refused (unknown mailbox, bad syntax);
 * - `unknown`: anything else.
 */
class MailError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = 'MailError';
    this.kind = kind;
    this.cause = cause;
  }
}

const classify = (error) => {
  if (error instanceof MailError) return error.kind;
  if (error?.code === 'EAUTH' || error?.responseCode === 534 || error?.responseCode === 535) {
    return 'config';
  }
  if (error?.code === 'EENVELOPE') return 'recipient';
  if (TRANSIENT_CODES.has(error?.code)) return 'transient';
  if (error?.responseCode >= 400 && error?.responseCode < 500) return 'transient';
  if (error?.responseCode >= 500) return 'recipient';
  return 'unknown';
};

const describe = (error) =>
  String(error?.response || error?.message || error)
    .split('\n')[0]
    .slice(0, 200);

const smtpConfigured = () => Boolean(config.mail.user && config.mail.password);

let transporter;
const sentMessages = [];

const getTransporter = () => {
  if (!transporter) {
    transporter = config.isTest
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({
          service: 'Gmail',
          auth: { user: config.mail.user, pass: config.mail.password },
          connectionTimeout: 10000,
          greetingTimeout: 10000,
          socketTimeout: 20000,
        });
  }
  return transporter;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sends an email from the configured account, trying again once after a temporary failure.
 * @throws {MailError}
 */
const sendMail = async ({ to, subject, html, text, headers }) => {
  if (!config.isTest && !smtpConfigured()) {
    throw new MailError('config', 'EMAIL_USER and EMAIL_PWD are not set: no email can be sent.');
  }
  const message = {
    from: config.mail.user ? { name: config.mail.fromName, address: config.mail.user } : undefined,
    to,
    subject,
    html,
    text,
    headers: { 'Auto-Submitted': 'auto-generated', ...headers },
  };

  for (let attempt = 1; ; attempt += 1) {
    try {
      await getTransporter().sendMail(message);
      break;
    } catch (error) {
      const kind = classify(error);
      if (kind === 'transient' && attempt < MAX_ATTEMPTS) {
        await sleep(config.mail.retryDelayMs * attempt);
      } else {
        throw new MailError(kind, describe(error), error);
      }
    }
  }
  if (config.isTest) sentMessages.push(message);
};

/**
 * Checks that the SMTP account accepts the configured credentials (nothing is sent).
 * @returns {Promise<{ ok: boolean, kind?: string, message?: string }>}
 */
const verifyMail = async () => {
  if (!smtpConfigured()) {
    return { ok: false, kind: 'config', message: 'EMAIL_USER and EMAIL_PWD are not set.' };
  }
  try {
    await getTransporter().verify();
    return { ok: true };
  } catch (error) {
    return { ok: false, kind: classify(error), message: describe(error) };
  }
};

module.exports = { sendMail, verifyMail, smtpConfigured, MailError, sentMessages };
