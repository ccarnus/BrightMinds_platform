// Replaces cast images that are not video thumbnails (former AI illustrations, missing images) with
// an automatic thumbnail of the cast's video. Idempotent: run in the background at server start.
const fs = require('fs');
const Cast = require('../models/cast_model');
const {
  MEDIA_DIRS,
  deleteFile,
  deleteMediaByUrl,
  mediaFilePath,
  mediaPathFromUrl,
  mediaUrl,
} = require('./media');
const { THUMBNAIL_PREFIX, createCastThumbnail } = require('./thumbnail');

const NOT_A_THUMBNAIL = new RegExp(`/${MEDIA_DIRS.castImages}/${THUMBNAIL_PREFIX}_`);

/** @returns {Promise<{ replaced: number, failed: number }>} */
const backfillCastThumbnails = async () => {
  const casts = await Cast.find(
    { castimageurl: { $not: NOT_A_THUMBNAIL } },
    'title casturl castimageurl duration'
  ).lean();
  let replaced = 0;
  let failed = 0;
  for (const cast of casts) {
    const videoPath = mediaPathFromUrl(cast.casturl, MEDIA_DIRS.castVideos);
    if (!videoPath || !fs.existsSync(videoPath)) {
      failed += 1;
      continue;
    }
    try {
      const filename = await createCastThumbnail(videoPath, {
        duration: (cast.duration || 0) * 60,
      });
      // Conditional: keeps a thumbnail the author picked while this ran.
      const updated = await Cast.findOneAndUpdate(
        { _id: cast._id, castimageurl: cast.castimageurl },
        { castimageurl: mediaUrl(MEDIA_DIRS.castImages, filename) }
      );
      if (updated) {
        await deleteMediaByUrl(cast.castimageurl, MEDIA_DIRS.castImages);
        replaced += 1;
      } else {
        await deleteFile(mediaFilePath(MEDIA_DIRS.castImages, filename));
      }
    } catch (error) {
      console.error(`Thumbnail failed for cast ${cast._id} "${cast.title}": ${error.message}`);
      failed += 1;
    }
  }
  return { replaced, failed };
};

module.exports = { backfillCastThumbnails };
