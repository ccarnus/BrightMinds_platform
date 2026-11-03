// Generates a DALL-E illustration for a cast/article and stores it in the media directory.
const axios = require('axios');
const sharp = require('sharp');
const config = require('../config');
const { getOpenAIClient } = require('./openai');
const { ensureMediaDir, mediaFilePath } = require('./media');
const { reportOpenAIAuthError, reportOpenAIMissingApiKey } = require('./openai_alerts');

const IMAGE_WIDTH = 980;
const IMAGE_HEIGHT = 560;

const buildPrompt = (description) =>
  'Create a simple, realistic academic illustration with no text. The image should be clean and ' +
  'minimal, focusing only on the most essential elements to illustrate the main idea. Use neutral ' +
  'or light-colored backgrounds that do not distract from the subject. The overall style should be ' +
  'realistic and clear, suitable for an educational or academic context. Do not include any ' +
  'additional text or decorative elements. The illustration should effectively convey the ' +
  `following concept: ${description}.`;

const downloadImage = async (url) => {
  const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  return Buffer.from(response.data);
};

/**
 * Generates an image and saves it as `<prefix>_<timestamp>.jpg` in media `dir`.
 * @returns {Promise<string|null>} The saved filename, or null on failure.
 */
const generateImage = async (description, { dir, prefix }) => {
  if (config.isTest) {
    return `${prefix}_test.jpg`;
  }

  const client = getOpenAIClient();
  if (!client) {
    await reportOpenAIMissingApiKey({ operation: `generateImage:${prefix}` });
    return null;
  }

  try {
    const response = await client.images.generate({
      model: config.openai.imageModel,
      prompt: buildPrompt(description),
      n: 1,
      size: '1024x1024',
    });
    const imageUrl = response.data?.[0]?.url;
    if (!imageUrl) {
      console.error('Unexpected image generation response:', response);
      return null;
    }

    const original = await downloadImage(imageUrl);
    ensureMediaDir(dir);
    const filename = `${prefix}_${Date.now()}.jpg`;
    await sharp(original)
      .resize(IMAGE_WIDTH, IMAGE_HEIGHT)
      .jpeg()
      .toFile(mediaFilePath(dir, filename));
    return filename;
  } catch (error) {
    await reportOpenAIAuthError(error, { operation: `generateImage:${prefix}` });
    console.error(`Error generating ${prefix} image:`, error);
    return null;
  }
};

module.exports = { generateImage, buildPrompt };
