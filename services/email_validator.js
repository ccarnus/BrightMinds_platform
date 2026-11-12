const { domainToASCII } = require('node:url');

const MAX_EMAIL_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;
const LOCAL_PART = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/**
 * Shape check of an email address (RFC 5321 limits): one "@", an ASCII local part without leading,
 * trailing or doubled dots, and a domain with at least two valid labels and a real TLD.
 * It cannot tell whether the mailbox exists: only the confirmation email does.
 */
const isValidEmail = (email) => {
  if (typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH) return false;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@')) return false;

  const local = email.slice(0, at);
  if (
    local.length > MAX_LOCAL_LENGTH ||
    !LOCAL_PART.test(local) ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..')
  ) {
    return false;
  }

  // Accents in the domain (IDN) are accepted once converted to their ASCII form.
  const domain = domainToASCII(email.slice(at + 1));
  const labels = domain.split('.');
  if (!domain || labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) {
    return false;
  }
  const tld = labels[labels.length - 1];
  return /^[A-Za-z]{2,}$/.test(tld) || /^xn--[A-Za-z0-9-]+$/.test(tld);
};

module.exports = isValidEmail;
