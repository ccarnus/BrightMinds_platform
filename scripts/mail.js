#!/usr/bin/env node
// Operator commands for the email account. On the server:
//   docker compose exec brightminds node scripts/mail.js <command>
//   check            verify that the SMTP account accepts EMAIL_USER / EMAIL_PWD (sends nothing)
//   test <address>   send the three account emails (confirmation, reset, password changed) to <address>
const config = require('../config');
const { sendMail, verifyMail } = require('../services/mailer');
const emails = require('../views/emails');

const HINTS = {
  config: 'Set EMAIL_USER and EMAIL_PWD (a Google "app password": 2-step verification must be on).',
  transient:
    'Network or temporary SMTP problem: check the server can reach smtp.gmail.com:465/587.',
  recipient: 'The address was refused.',
};

const check = async () => {
  console.log(`Account: ${config.mail.user || 'MISSING'}`);
  const result = await verifyMail();
  if (result.ok) {
    console.log('OK: the SMTP account accepted the credentials.');
    return true;
  }
  console.log(`FAILED (${result.kind}): ${result.message}`);
  console.log(HINTS[result.kind] || 'See the message above.');
  return false;
};

const sendTest = async (to) => {
  if (!to) {
    console.log('Usage: mail.js test <address>');
    return false;
  }
  const samples = [
    emails.verificationEmail({ username: 'Test User', token: 'sample-token' }),
    emails.passwordResetEmail({ username: 'Test User', token: 'sample-token' }),
    emails.passwordChangedEmail({ username: 'Test User' }),
  ];
  for (const sample of samples) {
    await sendMail({ to, ...sample, subject: `[TEST] ${sample.subject}` });
    console.log(`Sent: ${sample.subject}`);
  }
  return true;
};

const main = async () => {
  const [command, argument] = process.argv.slice(2);
  if (command === 'check') return check();
  if (command === 'test') return sendTest(argument);
  console.log('Commands: check | test <address>');
  return false;
};

main()
  .then((ok) => process.exit(ok ? 0 : 1))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
