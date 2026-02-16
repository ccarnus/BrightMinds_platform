const mongoose = require('mongoose');
const uniqueValidator = require('mongoose-unique-validator');

const userSchema = mongoose.Schema({
    email: { 
        type: String, 
        required: true, 
        unique: true,
        lowercase: true,
        trim: true
    },
    password: { type: String, required: true },
    username: { type: String, required: true },
    role: { 
        type: String, 
        required: true,
        enum: ['College Student', 'Professor', 'Researcher', 'Learning Enthusiast', 'PhD Student']
    },
    university: { type: String, required: false },
    profilePictureUrl: { type: String, required: true },
    isVerified: { type: Boolean, default: false },
    verificationToken: { type: String, required: false },
    resetPasswordToken: { type: String, required: false },
    resetPasswordExpires: { type: Date, required: false },
    evaluation_list: [{
        contentid: { type: String, required: false },
        type: { type: String, required: false },
        watched: { type: Boolean, required: false },
        answered: { type: Boolean, required: false }
    }],
    bookmarkedcontent: [{
        contentid: { type: String, required: false },
        type: { type: String, enum: ['cast', 'article'], required: false },
        bookmarkedAt: { type: Date, default: Date.now }
    }],
    preferences: [{
        category: { type: String, required: true },
        weight: { type: Number, required: true },
        count: { type: Number, required: true, default: 0 }
    }],
    tracking: {
        objective: { type: String, default: "Explorer" },
        progress: { type: Number, default: 0 },
        target: { type: Number, default: 10 },
        history: [{
            category: { type: String, required: true },
            count: { type: Number, default: 0 }
        }]
    },
    castPublications: [{ 
        type: mongoose.Schema.Types.ObjectId, ref: 'Cast' 
        }],
    articlePublications: [{ 
        type: mongoose.Schema.Types.ObjectId, ref: 'Article' 
    }]
});

userSchema.plugin(uniqueValidator);

module.exports = mongoose.model('User', userSchema);
