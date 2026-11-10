const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { MAX_IMAGE_SIZE, saveUploadedImage } = require('../../services/uploaded_image');
const { MEDIA_DIRS, mediaFilePath } = require('../../services/media');

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-upload-'));
afterAll(() => fs.rmSync(workDir, { recursive: true, force: true }));

const upload = async (name, buffer) => {
  const file = path.join(workDir, name);
  fs.writeFileSync(file, buffer);
  return file;
};

test('re-encodes a large transparent PNG to a bounded JPEG and deletes the upload', async () => {
  const png = await sharp({
    create: {
      width: 3200,
      height: 1000,
      channels: 4,
      background: { r: 0, g: 0, b: 255, alpha: 0 },
    },
  })
    .png()
    .toBuffer();
  const file = await upload('cover.png', png);

  const filename = await saveUploadedImage(file, {
    dir: MEDIA_DIRS.articleImages,
    prefix: 'article',
  });

  expect(filename).toMatch(/^article_\d+_[0-9a-f]{6}\.jpg$/);
  const metadata = await sharp(mediaFilePath(MEDIA_DIRS.articleImages, filename)).metadata();
  expect(metadata).toMatchObject({ format: 'jpeg', width: MAX_IMAGE_SIZE, height: 500 });
  expect(metadata.exif).toBeUndefined();
  expect(fs.existsSync(file)).toBe(false);
});

test('small images are not enlarged, and the EXIF orientation is applied', async () => {
  // A 40x20 image tagged "rotate 90°" (orientation 6) is stored upright as 20x40.
  const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: '#888' } })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const file = await upload('photo.jpg', jpeg);
  const filename = await saveUploadedImage(file, {
    dir: MEDIA_DIRS.articleImages,
    prefix: 'article',
  });
  const metadata = await sharp(mediaFilePath(MEDIA_DIRS.articleImages, filename)).metadata();
  expect(metadata).toMatchObject({ width: 20, height: 40 });
  expect(metadata.orientation).toBeUndefined();
});

test('an unreadable file is a 400 and leaves no file behind', async () => {
  const file = await upload('broken.png', Buffer.from('not an image'));
  await expect(
    saveUploadedImage(file, { dir: MEDIA_DIRS.articleImages, prefix: 'article' })
  ).rejects.toMatchObject({ status: 400 });
  expect(fs.existsSync(file)).toBe(false);
});
