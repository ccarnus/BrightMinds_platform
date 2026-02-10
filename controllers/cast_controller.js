const Cast = require('../models/cast_model.js');
const User = require('../models/user_model.js');
const { getVideoDurationInSeconds } = require('../backend/videoUtils');
const fs = require('fs').promises;
const departments = require('../lists/departments.js');
const castQueue = require('../queues/castQueue.js');
const Topic = require('../models/topic_model.js');
const { createTopicIfNotExist, removeExistingTopic  } = require('../controllers/topic_controller.js');

const isValidDepartment = (department) => departments.includes(department);

exports.createCast = async (req, res, next) => {
    try {
      const url = 'https://api.brightmindsresearch.com';
      req.body.cast = JSON.parse(req.body.cast);

      //Check duplicate title
      const existing = await Cast.findOne({ title: req.body.cast.title });
        if (existing) {
        return res
            .status(409)
            .json({ error: 'A cast with this title already exists.' });
        }
  
      // Determine if department was provided. If not, assign a placeholder.
      const departmentProvided = req.body.cast.department && req.body.cast.department.trim().length > 0;
      let departmentValue;
      if (departmentProvided) {
        if (!isValidDepartment(req.body.cast.department)) {
          return res.status(400).json({ error: 'Invalid department' });
        }
        departmentValue = req.body.cast.department;
      } else {
        departmentValue = "Pending Department";
      }
  
      // Check if the title exceeds 85 characters.
      if (req.body.cast.title && req.body.cast.title.length > 85) {
        return res.status(400).json({ error: 'Title must be 85 characters or less' });
      }
  
      // Get the video duration using your utility function.
      const videoFilePath = './backend/media/cast_videos/' + req.file.filename;
      const duration = await getVideoDurationInSeconds(videoFilePath);
  
      // Check if a topic was provided. If not, use a placeholder.
      const topicProvided = req.body.cast.topic && req.body.cast.topic.trim().length > 0;
      const topicValue = topicProvided ? req.body.cast.topic : "Pending Topic";
  
      // Create the new cast document.
      const cast = new Cast({
        title: req.body.cast.title,
        description: "", // To be filled after transcription in the background.
        department: departmentValue,
        brightmindid: req.body.cast.brightmindid,
        casturl: url + '/backend/media/cast_videos/' + req.file.filename,
        castimageurl: "", // Placeholder for now.
        category: req.body.cast.category,
        university: req.body.cast.university,
        visibility: req.body.cast.visibility,
        link: req.body.cast.link,
        evaluation: "", // Placeholder for now.
        duration: duration,
        topic: topicValue,
      });
  
      if (req.body.cast.dateadded) {
        cast.dateadded = new Date(req.body.cast.dateadded);
      }
  
      await cast.save();
  
      // If a topic was provided, immediately create/update the topic document.
      if (topicProvided) {
        const topicResult = await createTopicIfNotExist({
          name: req.body.cast.topic,
          departmentName: departmentValue,
          contentId: cast._id,
          contentType: 'cast',
        });
        console.log(topicResult.message);
      } else {
        console.log("No topic provided. Will generate topic asynchronously.");
      }
  
      // Add cast ID to the user's castPublications.
      const user = await User.findById(req.body.cast.brightmindid);
      if (user) {
        user.castPublications.push(cast._id);
        await user.save();
      }
  
      // Add a job to the queue for background processing.
      // The flag generateTopic is set to true if no topic was provided.
      castQueue.add({
        castId: cast._id,
        videoFilePath: videoFilePath,
        url: url,
        generateTopic: !topicProvided,
      });
  
      res.status(201).json({
        response: 'Cast created successfully. Background processing initiated.',
      });
    } catch (error) {
      console.error('Error creating cast:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  };  


exports.getAllCast = (req, res, next) => {
    Cast.find().sort({ _id: 1 }).then(
        (casts) => {
            res.status(200).json(casts);
        }
    ).catch((error) => {
        res.status(400).json({
            error: error
        });
    });
}

exports.getOneCast = (req, res, next) => {
    Cast.findOne({
        _id:req.params.id
    }).then(
        (cast) => {
            res.status(200).json(cast);
        }
    ).catch((error) => {
        res.status(404).json({
            error: error
        });
    });
}


exports.updateOneCast = async (req, res, next) => {
    try {
        let cast = await Cast.findById(req.params.id);
        if (!cast) {
            return res.status(404).json({ message: 'Cast not found.' });
        }

        req.body.cast = JSON.parse(req.body.cast);

        // Validate the department
        if (!isValidDepartment(req.body.cast.department)) {
            return res.status(400).json({
                error: 'Invalid department'
            });
        }

        const departmentName = req.body.cast.department;

        // Handle the old topic if the topic is being changed
        if (cast.topic !== req.body.cast.topic) {
            let oldTopic = cast.topic; 
            const topicRemovalResult = await removeExistingTopic({
                name: oldTopic,
                departmentName: cast.department,
                contentId: cast._id,
                contentType: 'cast',
            });

            if (topicRemovalResult.status === 404) {
                console.warn('Old topic not found; skipping removal.');
            } else {
                console.log(topicRemovalResult.message);
            }
        }

        // Ensure the new topic exists or create it
        const topicCreationResult = await createTopicIfNotExist({
            name: req.body.cast.topic,
            departmentName,
            contentId: cast._id,
            contentType: 'cast',
        });

        console.log(topicCreationResult.message);

        // Update the cast details
        if (req.file) {
            const url = "https://api.brightmindsresearch.com"
            const videoFilePath = './backend/media/cast_videos/' + req.file.filename;
            const duration = await getVideoDurationInSeconds(videoFilePath);

            cast.casturl = url + '/backend/media/cast_videos/' + req.file.filename;
            cast.duration = duration;
        }

        // Update the remaining fields
        cast.title = req.body.cast.title;
        cast.description = req.body.cast.description;
        cast.department = departmentName;  // Store department name directly
        cast.brightmindid = req.body.cast.brightmindid;
        cast.castimageurl = req.body.cast.castimageurl;
        cast.category = req.body.cast.category;
        cast.university = req.body.cast.university;
        cast.visibility = req.body.cast.visibility;
        cast.link = req.body.cast.link;
        cast.topic = req.body.cast.topic;
        dateadded: new Date(req.body.cast.dateadded),
        await cast.save();

        res.status(200).json({ message: 'Cast updated successfully and topic adjusted.' });
    } catch (error) {
        console.error('Error updating cast:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const removeCastReferences = async (castId) => {
    try {
        const castIdString = castId.toString();
        const castIdMatches = [castId, castIdString];

        const updateResult = await User.updateMany(
            {
                $or: [
                    { 'evaluation_list.contentid': { $in: castIdMatches } },
                    { 'bookmarkedcontent.contentid': { $in: castIdMatches } },
                    { castPublications: { $in: castIdMatches } }
                ]
            },
            {
                $pull: {
                    evaluation_list: { contentid: { $in: castIdMatches } },
                    bookmarkedcontent: { contentid: { $in: castIdMatches } },
                    castPublications: { $in: castIdMatches }
                }
            }
        );

        console.log(`Removed cast ${castIdString} references from users.`, updateResult);
    } catch (error) {
        console.error('Error removing cast references from users:', error);
    }
};
exports.deleteOneCast = async (req, res, next) => {
    try {
        const cast = await Cast.findById(req.params.id);
        if (!cast) {
            return res.status(404).json({ error: 'Cast not found.' });
        }

        // 1) Delete the associated video file if it exists

        let videoDeleteError = false;
        if (cast.casturl) {
            const videoFilename = cast.casturl.split('/media/cast_videos/')[1];
            if (videoFilename) {
                try {
                    await fs.access('./backend/media/cast_videos/' + videoFilename);
                    await fs.unlink('./backend/media/cast_videos/' + videoFilename);
                } catch (videoErr) {
                    if (videoErr.code !== 'ENOENT') {
                        console.error('Error deleting video file:', videoErr);
                        videoDeleteError = true;
                    } else {
                        console.log('Video file not found, skipping deletion:', videoFilename);
                    }
                }
            }
        }

        // 2) Delete the associated image file if it exists
        let imageDeleteError = false;
        if (cast.castimageurl) {
            const imageFilename = cast.castimageurl.split('/media/cast_images/')[1];
            if (imageFilename) {
                try {
                    await fs.access('./backend/media/cast_images/' + imageFilename);
                    await fs.unlink('./backend/media/cast_images/' + imageFilename);
                } catch (imageErr) {
                    if (imageErr.code !== 'ENOENT') {
                        console.error('Error deleting image file:', imageErr);
                        imageDeleteError = true;
                    } else {
                        console.log('Image file not found, skipping deletion:', imageFilename);
                    }
                }
            }
        }

        // 3) Delete the associated subtitle file if it exists
        let subtitleDeleteError = false;
        if (cast.subtitleurl) {
            // e.g. "https://api.brightmindsresearch.com/backend/media/cast_subtitles/CAST_ID.srt"
            const subtitleFilename = cast.subtitleurl.split('/media/cast_subtitles/')[1];
            if (subtitleFilename) {
                try {
                    await fs.access('./backend/media/cast_subtitles/' + subtitleFilename);
                    await fs.unlink('./backend/media/cast_subtitles/' + subtitleFilename);
                } catch (subtitleErr) {
                    if (subtitleErr.code !== 'ENOENT') {
                        console.error('Error deleting subtitle file:', subtitleErr);
                        subtitleDeleteError = true;
                    } else {
                        console.log('Subtitle file not found, skipping deletion:', subtitleFilename);
                    }
                }
            }
        }

        // 4) Delete the Cast document from DB
        await Cast.deleteOne({ _id: cast._id });

        // 5) Remove cast references from users (evaluation_list, bookmarks, publications)
        await removeCastReferences(cast._id);

        // 6) Remove topic association from DB
        const topicResult = await removeExistingTopic({
            name: cast.topic,
            departmentName: cast.department,
            contentId: cast._id,
            contentType: 'cast',
        });

        let responseMessage = 'Cast deleted successfully.';
        if (videoDeleteError || imageDeleteError || subtitleDeleteError) {
            responseMessage += ' However, there was an error removing media files.';
        }
        responseMessage += ` ${topicResult.message}`;

        res.status(200).json({ message: responseMessage });
    } catch (error) {
        console.error('Error deleting cast:', error);
        res.status(500).json({ error: 'Error deleting cast.' });
    }
};  


exports.getAllNewCast = (req, res, next) => {

}

exports.getAllNewCastByCategory = (req, res, next) => {

}

exports.getAllCastByCategory = (req, res, next) => {
    Cast.find({category:{$exists:true, $eq: req.params.id}}).sort({ _id: 1 }).then(
        (casts) => {
            res.status(200).json(casts);
        }
    ).catch(
        (error) => {
            res.status(400).json({
                error: error
            });
        }
    );
}

exports.getAllCastByBrightmindid = (req, res, next) => {
    Cast.find({brightmindid:{$exists:true, $eq: req.params.id}}).sort({ _id: 1 }).then(
        (casts) => {
            res.status(200).json(casts);
        }
    ).catch(
        (error) => {
            res.status(400).json({
                error: error
            });
        }
    );
}

exports.getEvaluationForCast = (req, res, next) => {
    const castId = req.params.id;

    Cast.findById(castId)
        .then((cast) => {
            if (!cast) {
                return res.status(404).json({ message: 'Cast not found.' });
            }

            const evaluation = cast.evaluation || '';
            res.status(200).json({ evaluation });
        })
        .catch((error) => {
            res.status(500).json({ error: 'An error occurred.' });
        });
};


exports.getCastRating = (req, res, next) => {
    Cast.findById(req.params.id)
        .then(cast => {
            if (!cast) {
                return res.status(404).json({ message: 'Cast not found.' });
            }
            res.status(200).json({ rating: cast.rating });
        })
        .catch(error => {
            res.status(500).json({ error: 'An error occurred.' });
        });
};

exports.updateCastRating = (req, res, next) => {
    const action = req.body.action;

    if (action !== '+' && action !== '-') {
        return res.status(400).json({ message: 'Invalid action.' });
    }

    Cast.findById(req.params.id)
        .then(cast => {
            if (!cast) {
                return res.status(404).json({ message: 'Cast not found.' });
            }

            // Update logic
            if (action === '+') {
                cast.rating.value = ((cast.rating.value * cast.rating.count) + 10) / (cast.rating.count + 1);
            } else {
                cast.rating.value = ((cast.rating.value * cast.rating.count)) / (cast.rating.count + 1);
            }
            cast.rating.count += 1;

            // Save the updated cast
            cast.save()
                .then(() => res.status(200).json({ message: 'Rating updated.', rating: cast.rating }))
                .catch(error => res.status(400).json({ error: 'Unable to update rating.' }));

        })
        .catch(error => {
            res.status(500).json({ error: 'An error occurred.' });
        });
};

exports.getCastTrending = (req, res, next) => {

    Cast.find()
        .sort({ dateadded: -1 })
        .then(
            (casts) => {
                res.status(200).json(casts);
            }
        )
        .catch(
            (error) => {
                res.status(400).json({
                    error: error
                });
            }
        );
};

exports.getAllCastByDepartment = (req, res, next) => {
    const departmentId = req.params.id;
    const topic = req.query.topic; // Read topic from query parameter

    // Build the query filter. Always filter by department, then add topic if provided.
    let filter = { department: departmentId };
    if (topic) {
        filter.topic = topic;
    }

    Cast.find(filter)
        .sort({ _id: 1 })
        .then((casts) => {
            res.status(200).json(casts);
        })
        .catch((error) => {
            res.status(400).json({
                error: error
            });
        });
};

exports.getPopularDepartment = async (req, res, next) => {
    try {
        const departments = await Cast.aggregate([
            {
                $group: {
                    _id: "$department",
                    count: { $sum: 1 }
                }
            },
            {
                $sort: { count: -1 }
            }
        ]);
        res.status(200).json(departments);
    } catch (error) {
        console.error('Error fetching popular departments:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

exports.getSimplifiedCast = async (req, res, next) => {
    try {
      // 1️⃣ get total
      const total = await Cast.countDocuments();
  
      // 2️⃣ get list of { _id, title }
      const casts = await Cast
        .find({}, '_id title')
        .sort({ _id: 1 });
  
      // 3️⃣ return both
      res.status(200).json({
        count: total,
        casts
      });
    } catch (error) {
      console.error('Error fetching simplified casts:', error);
      res.status(400).json({ error });
    }
  };
  


