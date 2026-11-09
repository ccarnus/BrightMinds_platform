// Generates the illustration of a cast/article from the visual brief written by analyze_content.
const axios = require('axios');
const crypto = require('crypto');
const sharp = require('sharp');
const config = require('../config');
const { AIError, callOpenAI } = require('./openai');
const { ensureMediaDir, mediaFilePath } = require('./media');

// Card size used by the app; generated in landscape and cropped around the most salient region.
const IMAGE_WIDTH = 980;
const IMAGE_HEIGHT = 560;

const buildPrompt = (brief) =>
  `Editorial illustration for a science-learning app. Subject: ${brief}\n` +
  'Style: clean, modern, realistic illustration; soft natural lighting; simple uncluttered ' +
  'composition with one clear focal point near the center (the edges will be cropped); calm, ' +
  'light or neutral background.\n' +
  'Strictly no text, letters, numbers, labels, captions, logos, watermarks, charts or diagrams, ' +
  'and no recognizable real people.';

const readImage = async (image) => {
  if (image?.b64_json) return Buffer.from(image.b64_json, 'base64');
  if (image?.url) {
    const response = await axios.get(image.url, { responseType: 'arraybuffer', timeout: 60000 });
    return Buffer.from(response.data);
  }
  throw new AIError('content', 'generateImage: response contained no image', {
    operation: 'generateImage',
  });
};

/**
 * Generates an image and saves it as `<prefix>_<timestamp>_<random>.jpg` in media `dir`.
 * @returns {Promise<string>} The saved filename.
 * @throws {AIError}
 */
const generateImage = async (brief, { dir, prefix }) => {
  if (config.isTest) return `${prefix}_test.jpg`;

  const response = await callOpenAI('generateImage', (client) =>
    client.images.generate({
      model: config.openai.imageModel,
      prompt: buildPrompt(brief),
      n: 1,
      size: '1536x1024',
      quality: config.openai.imageQuality,
      output_format: 'jpeg',
    })
  );
  const original = await readImage(response.data?.[0]);

  ensureMediaDir(dir);
  const filename = `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.jpg`;
  await sharp(original)
    .resize(IMAGE_WIDTH, IMAGE_HEIGHT, { fit: 'cover', position: sharp.strategy.attention })
    .jpeg({ quality: 82 })
    .toFile(mediaFilePath(dir, filename));
  return filename;
};

module.exports = { generateImage, buildPrompt };
