const WORDS_PER_MINUTE = 150;

/**
 * Estimated reading time of an article, in minutes (150 words per minute, rounded up).
 * @param {string} description
 * @returns {number}
 */
const computeDuration = (description) => {
  const wordCount = String(description || '')
    .split(/\s+/)
    .filter(Boolean).length;
  return Math.ceil(wordCount / WORDS_PER_MINUTE);
};

module.exports = computeDuration;
