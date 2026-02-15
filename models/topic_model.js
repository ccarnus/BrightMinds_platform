const mongoose = require('mongoose');

const topicSchema = mongoose.Schema({
  name: { type: String, required: true },
  departmentName: { type: String, required: true },
  articleCount: { type: Number, default: 0 },
  castCount: { type: Number, default: 0 },
  articleIDs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Article' }],
  castIDs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Cast' }],
  openalexID: { type: String, required: false },
  activity: { type: Number, default: 0 },
  impact: { type: Number, default: 0 },
  metrics: {
    openalex: {
      citedByCount: { type: Number, default: 0 },
      worksCount: { type: Number, default: 0 },
      worksLast12Months: { type: Number, default: 0 },
      lastFetchedAt: { type: Date, default: null },
      lastWorksFetchedAt: { type: Date, default: null },
    },
    wikipedia: {
      title: { type: String, default: null },
      views12Months: { type: Number, default: 0 },
      lastFetchedAt: { type: Date, default: null },
    },
    lastComputedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
    backoffUntil: { type: Date, default: null },
  },
});

module.exports = mongoose.model('Topic', topicSchema);
