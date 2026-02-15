const mongoose = require('mongoose');
const uniqueValidator = require('mongoose-unique-validator');

const virtualLabSchema = mongoose.Schema({
    name: { type: String, required: true, unique: true },
    followers: [{
        userID: { type: String, required: true }
    }],
    members: [{
        userID: { type: String, required: true }
    }],
    institute: [{
        instituteID: { type: String, required: true },
        score: { type: Number, required: false, default:0}
    }],
    topics: [{
        name: { type: String, required: true},
        gage: { type: Number, required: true, default: 0 },
        institutes: [{
            instituteId: { type: String, required: false }
        }],
        description: { type: String, required: false},
        followers: [{
            userID: { type: String, required: true }
        }],
        members: [{
            userID: { type: String, required: true }
        }],
        threads: [{
            content: { type: String, required: true }
        }],
    }],
    iconurl: {type:String, required:true},
    colorcode: {type:String, required:true}
});

virtualLabSchema.plugin(uniqueValidator);

module.exports = mongoose.model('VirtualLab', virtualLabSchema);
