const mongoose = require('mongoose');
const processingSchema = require('./processing_schema');

const castSchema = new mongoose.Schema({
  title: { type: String, required: true, unique: true, trim: true },
  description: { type: String, required: false },
  department: { type: String, required: true },
  brightmindid: { type: String, required: true },
  casturl: { type: String, required: true },
  castimageurl: { type: String, required: false },
  university: { type: String, required: true },
  category: { type: String, required: true },
  visibility: { type: String, required: true },
  link: { type: String, required: false },
  duration: { type: Number, required: false },
  dateadded: { type: Date, default: Date.now },
  rating: {
    value: { type: Number, min: 0, max: 10, default: 5 },
    count: { type: Number, default: 1 },
  },
  evaluation: {
    question: { type: String, required: false },
    responses: [{ type: String, required: false }],
    correct: { type: String, required: false },
  },
  topic: { type: String, required: true },
  subtitleurl: { type: String, required: false },
  processing: { type: processingSchema, default: () => ({}) },
});

// Lookups made by the list endpoints (department/topic browsing, "my casts", categories, feed order).
castSchema.index({ department: 1, topic: 1 });
castSchema.index({ brightmindid: 1 });
castSchema.index({ category: 1 });
castSchema.index({ dateadded: -1 });

module.exports = mongoose.model('Cast', castSchema);
