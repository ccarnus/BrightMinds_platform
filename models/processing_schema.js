const mongoose = require('mongoose');

/**
 * State of the background AI processing of a cast/article (see services/ai_pipeline.js).
 * `attempts` only counts failures caused by the item itself (not OpenAI outages or bad keys).
 */
const processingSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'processing', 'done', 'failed'],
      default: 'pending',
    },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    lastAttemptAt: { type: Date },
  },
  { _id: false }
);

module.exports = processingSchema;
