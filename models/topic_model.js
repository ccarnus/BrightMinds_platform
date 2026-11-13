const mongoose = require('mongoose');

// A research topic of the atlas: domain > lab (department) > area (subfield) > topic.
// Topics of the catalog (`source: 'openalex'`) exist whether or not a cast uses them; the ones an
// author typed (`source: 'author'`) disappear with their last cast. Counts and scores are filled in
// by services/atlas.js; the cross-reference ids (`ids`) let other platforms be queried for the same topic.
const keywordSchema = new mongoose.Schema(
  { id: String, name: String, score: Number },
  { _id: false }
);

const yearSchema = new mongoose.Schema({ year: Number, works: Number }, { _id: false });

const signalSchema = new mongoose.Schema(
  {
    // Works (PubMed, arXiv) or page views (Wikipedia) in the latest window and the one before.
    current: Number,
    previous: Number,
    // Smoothed ratio current / previous.
    ratio: Number,
    // 0-100 among the tracked topics of the lab.
    level: Number,
    query: String,
    fetchedAt: Date,
  },
  { _id: false }
);

const topicSchema = new mongoose.Schema({
  name: { type: String, required: true },
  departmentName: { type: String, required: true },
  source: { type: String, enum: ['openalex', 'author'], default: 'author' },
  openalexID: { type: String, required: false },
  // The name OpenAlex gives it (the display name is kept even if OpenAlex renames the topic: casts point at it).
  originalName: { type: String, required: false },
  description: { type: String, required: false },
  subfield: { id: Number, name: String },
  keywords: [keywordSchema],
  ids: {
    wikipedia: { type: String, default: null },
    wikidata: { type: String, default: null },
    mesh: { type: String, default: null },
    meshLabel: { type: String, default: null },
  },
  // Is the Wikipedia page really about this topic? 'match' only then is it used for attention.
  anchor: { type: String, enum: ['match', 'loose', 'shared'], required: false },
  retired: { type: Boolean, default: false },
  // Listed in the app besides the topics that have casts (the hottest of each lab).
  featured: { type: Boolean, default: false },
  castCount: { type: Number, default: 0 },
  castIDs: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Cast' }],

  // 0-100 mirrors read by older app versions: how much is published, and how impactful it is.
  activity: { type: Number, default: 0 },
  impact: { type: Number, default: 0 },
  metrics: {
    openalex: {
      citedByCount: { type: Number, default: 0 },
      worksCount: { type: Number, default: 0 },
      worksLast12Months: { type: Number, default: 0 },
      lastFetchedAt: { type: Date, default: null },
    },
  },

  // What the atlas computes (services/topic_scoring.js).
  score: {
    // 0-100 among the ranked topics of the lab; null for topics too small to rank.
    hot: { type: Number, default: null },
    trend: {
      type: String,
      enum: ['surging', 'rising', 'steady', 'cooling', 'niche'],
      default: null,
    },
    phase: { type: String, enum: ['emerging', 'growing', 'mature', 'declining'], default: null },
    works12m: { type: Number, default: 0 },
    // Works in the three windows and top-cited works in the matured one.
    windows: { c0: Number, c1: Number, c2: Number, top: Number },
    yoy: { type: Number, default: null },
    growth: { rate: Number, lower: Number, upper: Number, expected: Number },
    acceleration: { type: Number, default: null },
    impact: { share: Number, lower: Number, level: Number },
    levels: { growth: Number, acceleration: Number, impact: Number, volume: Number },
    // Fed by the independent signals; null without any.
    signalLevel: { type: Number, default: null },
    hotBase: { type: Number, default: null },
    endsOn: { type: String, default: null },
    computedAt: { type: Date, default: null },
  },
  signals: {
    wikipedia: signalSchema,
    pubmed: signalSchema,
    arxiv: signalSchema,
    computedAt: { type: Date, default: null },
  },
  series: {
    yearly: [yearSchema],
    fetchedAt: { type: Date, default: null },
  },
});

topicSchema.index({ departmentName: 1, name: 1 });
topicSchema.index({ openalexID: 1 }, { unique: true, sparse: true });
topicSchema.index({ departmentName: 1, 'score.hot': -1 });
topicSchema.index({ 'subfield.id': 1 });

/** Topics shown in lists: those with casts, the hottest of each lab and the ones authors created. */
topicSchema.statics.listedFilter = () => ({
  $or: [
    { source: { $ne: 'openalex' } },
    { castCount: { $gt: 0 } },
    { featured: true, retired: { $ne: true } },
  ],
});

module.exports = mongoose.model('Topic', topicSchema);
