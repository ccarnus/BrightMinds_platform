const mongoose = require('mongoose');

// One document remembering when each part of the research atlas was last refreshed.
const atlasStateSchema = new mongoose.Schema({
  key: { type: String, default: 'atlas', unique: true },
  catalogSyncedAt: { type: Date, default: null },
  metricsAt: { type: Date, default: null },
  signalsAt: { type: Date, default: null },
  // The end of the 12-month windows of the latest metrics.
  windowsEndOn: { type: String, default: null },
  topics: { type: Number, default: 0 },
  lastError: { type: String, default: null },
  lastErrorAt: { type: Date, default: null },
});

atlasStateSchema.statics.get = async function getState() {
  return this.findOneAndUpdate(
    { key: 'atlas' },
    { $setOnInsert: { key: 'atlas' } },
    { upsert: true, new: true }
  );
};

module.exports = mongoose.model('AtlasState', atlasStateSchema);
