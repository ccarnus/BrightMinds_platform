// Basic shape check: something@something.tld, no whitespace.
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const isValidEmail = (email) => typeof email === 'string' && EMAIL_REGEX.test(email);

module.exports = isValidEmail;
