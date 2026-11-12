const mongoose = require('mongoose');

const virtualLabSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  followers: [
    {
      userID: { type: String, required: true },
    },
  ],
  members: [
    {
      userID: { type: String, required: true },
    },
  ],
  institute: [
    {
      instituteID: { type: String, required: true },
      score: { type: Number, required: false, default: 0 },
    },
  ],
  topics: [
    {
      name: { type: String, required: true },
      gage: { type: Number, required: true, default: 0 },
      institutes: [
        {
          instituteId: { type: String, required: false },
        },
      ],
      description: { type: String, required: false },
      followers: [
        {
          userID: { type: String, required: true },
        },
      ],
      members: [
        {
          userID: { type: String, required: true },
        },
      ],
      threads: [
        {
          content: { type: String, required: true },
        },
      ],
    },
  ],
  // Icons and colors live in the app; they are only filled in for labs created by hand.
  iconurl: { type: String, required: false, default: '' },
  colorcode: { type: String, required: false, default: '' },
  // How much research is being done in the field (OpenAlex), refreshed weekly by services/lab_research.js.
  research: {
    works12m: { type: Number, default: null },
    // 0-100: log scale of works12m between the quietest and the busiest lab. Drives the lab's size.
    level: { type: Number, default: null },
    updatedAt: { type: Date, default: null },
  },
});

module.exports = mongoose.model('VirtualLab', virtualLabSchema);
