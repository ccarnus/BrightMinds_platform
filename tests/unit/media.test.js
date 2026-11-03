const path = require('path');
const config = require('../../config');
const { MEDIA_DIRS, mediaUrl, mediaPathFromUrl } = require('../../services/media');

const dirPath = path.join(config.mediaRoot, MEDIA_DIRS.castImages);

describe('mediaUrl', () => {
  test('builds a public URL under /backend/media', () => {
    expect(mediaUrl(MEDIA_DIRS.castImages, 'a.jpg')).toBe(
      'http://api.test/backend/media/cast_images/a.jpg'
    );
  });
});

describe('mediaPathFromUrl', () => {
  test('resolves a stored URL to a file in the media directory', () => {
    expect(mediaPathFromUrl(mediaUrl(MEDIA_DIRS.castImages, 'a.jpg'), MEDIA_DIRS.castImages)).toBe(
      path.join(dirPath, 'a.jpg')
    );
  });

  test('works with URLs from another host (legacy production URLs)', () => {
    const url = 'https://api.brightmindsresearch.com/backend/media/cast_images/b.jpg?x=1';
    expect(mediaPathFromUrl(url, MEDIA_DIRS.castImages)).toBe(path.join(dirPath, 'b.jpg'));
  });

  test.each([
    'http://x/backend/media/cast_images/../../../app.js',
    'http://x/backend/media/cast_images/..%2F..%2Fapp.js',
    'http://x/backend/media/cast_images/..\\..\\app.js',
  ])('never escapes the media directory: %s', (url) => {
    const resolved = mediaPathFromUrl(url, MEDIA_DIRS.castImages);
    expect(path.dirname(resolved)).toBe(dirPath);
  });

  test.each([
    [null],
    [''],
    ['http://x/backend/media/other_dir/a.jpg'],
    ['http://x/backend/media/cast_images/'],
    ['http://x/backend/media/cast_images/..'],
    ['http://x/backend/media/cast_images/%E0%A4%A'],
  ])('returns null for unusable URLs: %s', (url) => {
    expect(mediaPathFromUrl(url, MEDIA_DIRS.castImages)).toBeNull();
  });
});
