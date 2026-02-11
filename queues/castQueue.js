const isTestEnv = process.env.NODE_ENV === 'test';

if (isTestEnv) {
  module.exports = {
    add: async () => {},
    process: () => {},
    close: async () => {},
  };
} else {
  const Queue = require('bull');
  const fs = require('fs').promises;
  const path = require('path');

  const generateEvaluation = require('../backend/generate_question');
  const generateCastImage = require('../backend/generate_cast_image');
  const { generateTopicForCast } = require('../backend/generate_topic');
  const Cast = require('../models/cast_model');
  const transcribeVideo = require('../backend/transcription');

  // 1. Initialize the queue:
  const castQueue = new Queue('castQueue');

  // 2. Process jobs:
  castQueue.process(async (job, done) => {
    // Extract job data including generateTopic flag.
    const { castId, videoFilePath, url, generateTopic } = job.data;

    try {
      // A. Transcribe the video (one call returns text + srt)
      const { text: fullTranscript, srt: srtContent } = await transcribeVideo(videoFilePath);

      // B. Save the SRT file to your server
      const subtitlesDir = path.join(__dirname, '../backend/media/cast_subtitles');
      await fs.mkdir(subtitlesDir, { recursive: true }); // ensure directory exists
      const srtFilename = `${castId}.srt`;
      const srtFilePath = path.join(subtitlesDir, srtFilename);
      await fs.writeFile(srtFilePath, srtContent, 'utf8');

      // C. Build the subtitle URL for serving
      const castSubtitleURL = url + '/backend/media/cast_subtitles/' + srtFilename;

      // D. Update the cast's "description" and "subtitleurl"
      let cast = await Cast.findByIdAndUpdate(
        castId,
        {
          description: fullTranscript,
          subtitleurl: castSubtitleURL
        },
        { new: true }
      );

      // E. If the job indicates that a topic should be generated, call generateTopicForCast.
      if (generateTopic) {
        await generateTopicForCast(cast);
      }

      // F. Generate evaluation and image using the same transcript
      const evaluation = await generateEvaluation(fullTranscript);
      const imagePath = await generateCastImage(fullTranscript);
      const castImageURL = url + imagePath.replace(/^.*\/backend/, '/backend');

      // G. Update the cast with evaluation and image information
      cast = await Cast.findByIdAndUpdate(
        castId,
        {
          evaluation,
          castimageurl: castImageURL
        },
        { new: true }
      );

      done();
    } catch (error) {
      console.error('Error processing cast in queue:', error);
      done(error);
    }
  });

  module.exports = castQueue;
}
