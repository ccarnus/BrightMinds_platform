const mongoose = require('mongoose');
const processingSchema = require('./processing_schema');

const articleSchema = new mongoose.Schema({
  title: { type: String, required: true },
  department: { type: String, required: true },
  brightmindid: { type: String, required: true },
  description: { type: String, required: true },
  // Generated in the background (see services/ai_pipeline.js).
  articleimageurl: { type: String, required: false },
  university: { type: String, required: true },
  category: { type: String, required: true },
  visibility: { type: String, required: true },
  link: { type: String, required: false },
  duration: { type: Number, required: true },
  dateadded: { type: Date, default: Date.now },
  rating: {
    value: { type: Number, min: 0, max: 10, default: 5 },
    count: { type: Number, default: 1 },
  },
  evaluation: {
    question: { type: String, required: false },
    responses: [
      {
        type: String,
        required: false,
      },
    ],
    correct: { type: String, required: false },
  },
  topic: { type: String, required: true },
  processing: { type: processingSchema, default: () => ({}) },
});

module.exports = mongoose.model('Article', articleSchema);
