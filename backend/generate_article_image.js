const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');

const isTestEnv = process.env.NODE_ENV === 'test';

let client = null;
if (!isTestEnv) {
  const openai = require('openai');
  const apikey = process.env.OPENAI_API_KEY;
  client = new openai({apikey});
}

async function downloadImage(url, filepath) {
    const writer = fs.createWriteStream(filepath);

    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

async function resizeImage(inputPath, outputPath, width, height) {
    try {
        await sharp(inputPath)
            .resize(width, height)
            .toFile(outputPath);
        console.log('Image resized successfully');
        fs.unlinkSync(inputPath); // Delete the original file after resizing
    } catch (error) {
        console.error('Error resizing image:', error);
    }
}

async function generateArticleImage(description) {
    if (isTestEnv) {
        return path.join(__dirname, '/media/article_images/', 'article_test.jpg');
    }

    const modifiedDescription = `Create a simple, realistic academic illustration with no text. The image should be clean and minimal, focusing only on the most essential elements to illustrate the main idea. Use neutral or light-colored backgrounds that do not distract from the subject. The overall style should be realistic and clear, suitable for an educational or academic context. Do not include any additional text or decorative elements. The illustration should effectively convey the following concept: ${description}.`;
    try {
        if (!client) {
            console.error('OpenAI client not configured. Set OPENAI_API_KEY.');
            return null;
        }

        const response = await client.images.generate({
            model: "dall-e-3",
            prompt: modifiedDescription,
            n: 1,
            size: "1024x1024"
        });

        if (!response.data || response.data.length === 0) {
            console.error("Unexpected response structure:", response);
            return null;
        }

        const imageUrl = response.data[0].url;
        const originalImagePath = path.join(__dirname, '/media/article_images/', 'original_' + Date.now() + '.jpg');
        const resizedImagePath = path.join(__dirname, '/media/article_images/', 'article_' + Date.now() + '.jpg');

        await downloadImage(imageUrl, originalImagePath);

        await resizeImage(originalImagePath, resizedImagePath, 980, 560);

        return resizedImagePath;
    } catch (error) {
        console.error('Error generating article image:', error);
        return null;
    }
}

module.exports = generateArticleImage;
