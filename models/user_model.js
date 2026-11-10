const mongoose = require('mongoose');
const { PATH_KEYS } = require('../services/learning');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: { type: String, required: true },
  username: { type: String, required: true },
  role: {
    type: String,
    required: true,
    enum: ['College Student', 'Professor', 'Researcher', 'Learning Enthusiast', 'PhD Student'],
  },
  university: { type: String, required: false },
  profilePictureUrl: { type: String, required: true },
  isVerified: { type: Boolean, default: false },
  verificationToken: { type: String, required: false },
  resetPasswordToken: { type: String, required: false },
  resetPasswordExpires: { type: Date, required: false },
  evaluation_list: [
    {
      contentid: { type: String, required: false },
      type: { type: String, required: false },
      watched: { type: Boolean, required: false },
      answered: { type: Boolean, required: false },
    },
  ],
  bookmarkedcontent: [
    {
      contentid: { type: String, required: false },
      type: { type: String, enum: ['cast', 'article'], required: false },
      bookmarkedAt: { type: Date, default: Date.now },
    },
  ],
  preferences: [
    {
      category: { type: String, required: true },
      weight: { type: Number, required: true },
      count: { type: Number, required: true, default: 0 },
    },
  ],
  // Learning path and lifetime learning activity (see services/learning.js). Written by the learning
  // endpoints, content tracking and quizzes only: never editable through PUT /user/:id.
  learning: {
    // Missing on accounts not migrated from the legacy `tracking` field yet (see learning_migration.js).
    version: { type: Number, required: false },
    path: { type: String, enum: [...PATH_KEYS, null], required: false },
    // Deep Learner only: the department the path measures.
    focusField: { type: String, required: false },
    startedAt: { type: Date, required: false },
    stats: {
      contents: { type: Number, default: 0 },
      correctAnswers: { type: Number, default: 0 },
      papers: { type: Number, default: 0 },
      fields: [
        {
          _id: false,
          field: { type: String, required: true },
          contents: { type: Number, default: 0 },
          correctAnswers: { type: Number, default: 0 },
          papers: { type: Number, default: 0 },
        },
      ],
    },
    // Opened OpenAlex works (short ids), so each paper counts once. Never serialized.
    paperIds: [{ type: String }],
    milestones: [
      {
        _id: false,
        path: { type: String, required: true },
        focusField: { type: String, required: false },
        level: { type: Number, required: true },
        reachedAt: { type: Date, default: Date.now },
      },
    ],
    history: [
      {
        _id: false,
        path: { type: String, required: true },
        focusField: { type: String, required: false },
        startedAt: { type: Date, required: false },
        endedAt: { type: Date, required: false },
      },
    ],
  },
  castPublications: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Cast',
    },
  ],
  articlePublications: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Article',
    },
  ],
  // Quiz gamification, written only by POST /user/:id/quiz (see services/rewards.js).
  rewards: {
    xp: { type: Number, default: 0 },
    quizzesCompleted: { type: Number, default: 0 },
    perfectQuizzes: { type: Number, default: 0 },
    answeredQuestions: { type: Number, default: 0 },
    correctAnswers: { type: Number, default: 0 },
    bestCombo: { type: Number, default: 0 },
    // Client-generated id of the last graded quiz: a resubmission (retry after a lost response) earns nothing.
    lastQuizId: { type: String, required: false },
    streak: {
      current: { type: Number, default: 0 },
      best: { type: Number, default: 0 },
      // User's local day (YYYY-MM-DD) of the last quiz.
      lastQuizDay: { type: String, required: false },
    },
    badges: [
      {
        _id: false,
        key: { type: String, required: true },
        earnedAt: { type: Date, default: Date.now },
      },
    ],
  },
});

// Secrets must never leave the API, whatever the endpoint serializes.
const PRIVATE_FIELDS = [
  'password',
  'verificationToken',
  'resetPasswordToken',
  'resetPasswordExpires',
  '__v',
];
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    PRIVATE_FIELDS.forEach((field) => delete ret[field]);
    if (ret.learning) delete ret.learning.paperIds;
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
