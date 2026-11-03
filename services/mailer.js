// All outgoing email goes through here. In tests, messages are captured instead of sent.
const nodemailer = require('nodemailer');
const config = require('../config');

let transporter;
const sentMessages = [];

const getTransporter = () => {
  if (!transporter) {
    transporter = config.isTest
      ? nodemailer.createTransport({ jsonTransport: true })
      : nodemailer.createTransport({
          service: 'Gmail',
          auth: { user: config.mail.user, pass: config.mail.password },
        });
  }
  return transporter;
};

/** Sends an email from the configured account. Throws if sending fails. */
const sendMail = async ({ to, subject, html, text }) => {
  const message = { from: config.mail.user, to, subject, html, text };
  await getTransporter().sendMail(message);
  if (config.isTest) {
    sentMessages.push(message);
  }
};

module.exports = { sendMail, sentMessages };
