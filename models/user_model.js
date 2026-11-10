const mongoose = require('mongoose');

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
  tracking: {
    objective: { type: String, default: 'Explorer' },
    progress: { type: Number, default: 0 },
    target: { type: Number, default: 10 },
    history: [
      {
        category: { type: String, required: true },
        count: { type: Number, default: 0 },
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
    return ret;
  },
});

module.exports = mongoose.model('User', userSchema);
