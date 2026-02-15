const User = require('../models/user_model.js');
const bcrypt = require('bcrypt');
const emailVerificator = require('../backend/email_verificator.js');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const Cast = require('../models/cast_model.js');
const Article = require('../models/article_model.js');
const { departmentNames } = require('../lists/departments.js');
const { deleteFile } = require('./fileHelper.js');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const EMAIL_PWD = process.env.EMAIL_PWD;
const API_BASE_URL = 'https://api.brightmindsresearch.com'

const getTargetValue = (objective) => {
    switch (objective) {
        case 'Follower':
            return 5;
        case 'Explorer':
            return 10;
        case 'Deep Learner':
            return 20;
        case 'Researcher':
            return 30;
        case 'Career':
            return 50;
        default:
            return 10;
    }
};

exports.signup = async (req, res, next) => {
    req.body.user = JSON.parse(req.body.user);

    // Normalize the email to lowercase
    req.body.user.email = req.body.user.email.toLowerCase();
    
    // Validate email domain
    if (!emailVerificator(req.body.user.email)) {
        return res.status(400).json({
            error: "The email domain name is not a valid one."
        });
    }

    try {
        // Hash the password
        const hash = await bcrypt.hash(req.body.user.password, 10);

        // Generate the verification token
        const token = crypto.randomBytes(16).toString('hex');
        const url = "https://api.brightmindsresearch.com";

        // Prepare the user data
        const userData = {
            email: req.body.user.email,
            password: hash,
            username: req.body.user.username,
            role: req.body.user.role,
            profilePictureUrl: url + '/backend/media/profile_pictures/' + req.file.filename,
            verificationToken: token,
            tracking: {
                objective: req.body.user.objective || 'Explorer',
                target: getTargetValue(req.body.user.objective || 'Explorer')
            }
        };

        if (['Professor', 'PhD Student', 'Researcher'].includes(req.body.user.role)) {
            userData.university = req.body.user.university;
        }

        // Configure nodemailer
        const transporter = nodemailer.createTransport({
            service: 'Gmail',
            auth: {
                user: 'clement.carnus@brightmindsresearch.com',
                pass: EMAIL_PWD
            }
        });

        const mailOptions = {
            from: 'clement.carnus@brightmindsresearch.com',
            to: req.body.user.email,
            subject: 'Account Verification - BrightMinds Research',
            html: `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>BrightMinds Research - Email Confirmation</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');

                    body {
                        margin: 0;
                        padding: 0;
                        font-family: 'Montserrat', sans-serif;
                        background-color: #1c1c1c;
                        color: #f1f1f1;
                    }

                    .email-container {
                        max-width: 600px;
                        margin: 0 auto;
                        background-color: #1c1c1c;
                        border: 1px solid #1c1c1c;
                        border-radius: 8px;
                        padding: 20px;
                    }

                    .email-container .logo {
                        text-align: center;
                        margin-bottom: 20px;
                    }

                    .email-container .logo img {
                        max-width: 230px;
                    }

                    .email-container h2 {
                        text-align: center;
                        color: #00407A;
                        font-family: 'MontserratBold', sans-serif;
                    }

                    .email-container p {
                        font-size: 16px;
                        line-height: 1.5;
                        text-align: center;
                        color: #f1f1f1;
                    }

                    .email-container .button-container {
                        text-align: center;
                        margin: 30px 0;
                    }

                    .email-container .button-container a {
                        background-color: #00407A;
                        color: #f1f1f1;
                        padding: 12px 24px;
                        text-decoration: none;
                        border-radius: 5px;
                        font-size: 16px;
                        font-family: 'MontserratBold', sans-serif;
                    }

                    .email-container .footer {
                        text-align: center;
                        margin-top: 20px;
                        margin-bottom: 20px;
                    }

                    .email-container .footer img {
                        max-width: 100px;
                    }

                    .email-container .footer p {
                        font-size: 12px;
                        line-height: 1.5;
                        text-align: center;
                        color: #f1f1f1;
                    }
                </style>
            </head>
            <body>
                <div class="email-container">
                    <div class="logo">
                        <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_title.png" alt="BrightMinds Research">
                    </div>
                    <h2>Welcome!</h2>
                    <p>Thank you for signing up with us. To complete your registration, please confirm your email address by clicking the button below.</p>
                    <div class="button-container">
                        <a href="${API_BASE_URL}/user/confirmation/${token}">Verify Email</a>
                    </div>
                    <p>If you did not create an account with us, please ignore this email.</p>
                    <div class="footer">
                        <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_icon.png" alt="BrightMinds Footer">
                        <p>&copy; 2024 BrightMinds Research LLC. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
            `
        };

        await transporter.sendMail(mailOptions);

        const user = new User(userData);
        await user.save();

        res.status(201).json({ response: 'User created. Please check your email to verify your account.' });

    } catch (error) {
        // Handle errors in email sending or user creation
        console.error('Error during signup:', error);

        // Return a meaningful error message
        res.status(500).json({
            error: 'An error occurred during signup. Please try again later.'
        });
    }
};


exports.confirmation = (req, res, next) => {
    User.findOne({ verificationToken: req.params.token }, (err, user) => {
        if (!user) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>Verification Failed - BrightMinds Research</title>
                    <style>
                        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                        
                        body {
                            margin: 0;
                            padding: 0;
                            font-family: 'Montserrat', sans-serif;
                            background-color: #1c1c1c;
                            color: #1c1c1c;
                        }

                        .container {
                            max-width: 600px;
                            margin: 0 auto;
                            background-color: #1c1c1c;
                            border: 1px solid #1c1c1c;
                            border-radius: 8px;
                            padding: 20px;
                            text-align: center;
                        }

                        .container .logo {
                            margin-bottom: 20px;
                        }

                        .container .logo img {
                            max-width: 230px;
                        }

                        .container h2 {
                            color: #cc0000;
                            font-family: 'MontserratBold', sans-serif;
                        }

                        .container p {
                            font-size: 16px;
                            line-height: 1.5;
                            color: #f1f1f1;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="logo">
                            <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_title.png" alt="BrightMinds Research">
                        </div>
                        <h2>Verification Failed</h2>
                        <p>We were unable to find a user for this token.</p>
                        <p>Please check the link or contact support.</p>
                    </div>
                </body>
                </html>
            `);
        }
        if (user.isVerified) {
            return res.status(400).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Already Verified - BrightMinds Research</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                    
                    body {
                        margin: 0;
                        padding: 0;
                        font-family: 'Montserrat', sans-serif;
                        background-color: #1c1c1c;
                        color: #1c1c1c;
                    }

                    .container {
                        max-width: 600px;
                        margin: 0 auto;
                        background-color: #1c1c1c;
                        border: 1px solid #1c1c1c;
                        border-radius: 8px;
                        padding: 20px;
                        text-align: center;
                    }

                    .container .logo {
                        margin-bottom: 20px;
                    }

                    .container .logo img {
                        max-width: 230px;
                    }

                    .container h2 {
                        color: #00407A;
                        font-family: 'MontserratBold', sans-serif;
                    }

                    .container p {
                        font-size: 16px;
                        line-height: 1.5;
                        color: #f1f1f1;
                    }

                    .container a {
                        color: #00407A;
                        text-decoration: none;
                        font-weight: bold;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="logo">
                        <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_title.png" alt="BrightMinds Research">
                    </div>
                    <h2>Already Verified</h2>
                    <p>This user has already been verified.</p>
                    <a href="https://www.brightmindsresearch.com/">Visit our Site</a>
                </div>
            </body>
            </html>
            `);
        }

        user.isVerified = true;

        user.save((err) => {
            if (err) { return res.status(500).send({ msg: err.message }); }
            res.status(200).send(`
                <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Verification Successful - BrightMinds Research</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                    
                    body {
                        margin: 0;
                        padding: 0;
                        font-family: 'Montserrat', sans-serif;
                        background-color: #1c1c1c;
                        color: #1c1c1c;
                    }

                    .container {
                        max-width: 600px;
                        margin: 0 auto;
                        background-color: #1c1c1c;
                        border: 1px solid #1c1c1c;
                        border-radius: 8px;
                        padding: 20px;
                        text-align: center;
                    }

                    .container .logo {
                        margin-bottom: 20px;
                    }

                    .container .logo img {
                        max-width: 230px;
                    }

                    .container h2 {
                        color: #00407A;
                        font-family: 'MontserratBold', sans-serif;
                    }

                    .container p {
                        font-size: 16px;
                        line-height: 1.5;
                        color: #f1f1f1;
                    }

                    .container a {
                        background-color: #00407A;
                        color: #f1f1f1;
                        padding: 12px 24px;
                        text-decoration: none;
                        border-radius: 5px;
                        font-size: 16px;
                        font-family: 'MontserratBold', sans-serif;
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    <div class="logo">
                        <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_title.png" alt="BrightMinds Research">
                    </div>
                    <h2>Verification Successful!</h2>
                    <p>Your account has been verified. You can now log in.</p>
                    <a href="https://www.brightmindsresearch.com/">Visit our Site</a>
                </div>
            </body>
            </html>
            `);
        });
    });
};


exports.login = (req, res, next) => {
    User.findOne({email: req.body.email}).then(
        (user) => {
            if(!user) {
                return res.status(401).json({
                    response: 'user not found.'
                });
            }
            bcrypt.compare(req.body.password,user.password).then(
                (valid) => {
                    if(!valid) {
                        return res.status(401).json({
                            response: 'incorrect password'
                        });
                    }
                    const token = jwt.sign(
                        {userId: user._id},
                        'RANDOM_TOKEN_SECRET',
                        {expiresIn: '24h'});
                    res.status(200).json({
                        userId: user._id,
                        email: user.email,
                        token: token
                    });
                }
            ).catch((error) => {
                res.status(500).json({
                    error: error
                });
                console.log(error);
            })
        }
    ).catch(
        (error) => {
            res.status(400).json({
                error : error
            });
            console.log(error);
        }
    );
};

exports.getAllUser = async (req, res, next) => {
    try {
      const users = await User.find()
        .select('_id email username role profilePictureUrl evaluation_list preferences tracking castPublications articlePublications university verificationToken isVerified'); 
  
      res.status(200).json(users);
    } catch (error) {
      res.status(500).json({ error: 'An error occurred.' });
    }
  };

  exports.getOneUser = async (req, res, next) => {
    try {
      const user = await User.findById(req.params.id);
      console.log(user.tracking);
  
      if (!user) {
        return res.status(404).json({ message: 'User not found.' });
      }
  
      const userObject = {
        _id: user._id,
        email: user.email,
        username: user.username,
        role: user.role,
        university: user.university,
        profilePictureUrl: user.profilePictureUrl,
        evaluation_list: user.evaluation_list,
        preferences: user.preferences,
        tracking: user.tracking,
        castPublications: user.castPublications,
        articlePublications: user.articlePublications,
        isVerified : user.isVerified,
        verificationToken: user.verificationToken,
      };
  
      res.status(200).json(userObject);
    } catch (error) {
      res.status(500).json({ error: 'Internal server error' });
    }
};

exports.updateOneUser = async (req, res, next) => {
    try {
        const userId = req.params.id;

        // Find the user by ID
        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Check if there's a new profile picture in the request
        if (req.file) {
            // Parse the user data from the request body
            // Assuming the user data is sent as a JSON string under 'user' key
            req.body.user = req.body.user ? JSON.parse(req.body.user) : {};

            // Extract the old profile picture filename
            const oldImageUrl = user.profilePictureUrl;
            const oldImageFilename = oldImageUrl
                ? oldImageUrl.split('/backend/media/profile_pictures/')[1]
                : null;

            // Define the path to the old image
            const oldImagePath = oldImageFilename
                ? `./backend/media/profile_pictures/${oldImageFilename}`
                : null;

            // Delete the old image if it exists
            if (oldImagePath) {
                try {
                    await deleteFile(oldImagePath);
                } catch (err) {
                    // If deletion fails, respond with an error
                    return res.status(500).json({ error: 'Failed to delete old profile picture.' });
                }
            }

            // Update the profilePictureUrl with the new image
            const url = "https://api.brightmindsresearch.com";
            user.profilePictureUrl = `${url}/backend/media/profile_pictures/${req.file.filename}`;
        } else {
            // If no new image, ensure req.body.user is parsed if provided
            req.body.user = req.body.user ? JSON.parse(req.body.user) : {};
        }

        // Update other user fields
        // You can choose to whitelist specific fields to prevent unwanted updates
        const allowedFields = [
            'email',
            'username',
            'role',
            'evaluation_list',
            'preferences',
            'tracking',
            'castPublications',
            'articlePublications',
            'university',
        ];

        allowedFields.forEach(field => {
            if (req.body.user[field] !== undefined) {
                user[field] = req.body.user[field];
            }
        });

        // Optional: Validate department if it's being updated
        if (req.body.user.department) {
            if (!departmentNames.includes(req.body.user.department)) {
                return res.status(400).json({ error: 'Invalid department.' });
            }
            user.department = req.body.user.department;
        }

        // Save the updated user
        await user.save();

        res.status(200).json({ message: 'User updated successfully.', user });
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({ error: 'Internal server error.' });
    }
};

exports.deleteOneUser = (req, res, next) => {
    User.findOne({_id:req.params.id}).then(
        (user) => {
            const filename = user.profilePictureUrl.split('/backend/media/profile_pictures/')[1];
            fs.unlink('./backend/media/profile_pictures/' + filename, () => {
                User.deleteOne({_id: req.params.id}).then(
                    () => {
                        res.status(200).json({
                            response: "user removed."
                        });
                    }
                ).catch((error) => {
                    res.status(404).json({
                        error: error
                    });
                });
            })
        }
    )
}

exports.updateUserAddContentToList = async (req, res, next) => {
    const userId = req.params.id;
    const contentId = String(req.body.contentId);
    const type = req.body.type;

    try {
        // Determine the category of the content
        let category;
        if (type === 'cast') {
            const cast = await Cast.findById(contentId);
            if (!cast) {
                return res.status(404).json({ message: 'Cast not found.' });
            }
            category = cast.department;
        } else if (type === 'article') {
            const article = await Article.findById(contentId);
            if (!article) {
                return res.status(404).json({ message: 'Article not found.' });
            }
            category = article.department;
        } else {
            return res.status(400).json({ message: 'Invalid content type.' });
        }

        // Build the evaluation object you want to add.
        const newEvaluation = {
            contentid: contentId,
            type: type,
            watched: true,
            answered: false
        };

        // If the content already exists, update its status (no duplicates).
        const updateExistingResult = await User.updateOne(
            { _id: userId, "evaluation_list.contentid": contentId },
            {
                $set: {
                    "evaluation_list.$.watched": true,
                    "evaluation_list.$.type": type
                }
            }
        );

        if (updateExistingResult.matchedCount > 0) {
            return res.status(200).json({ message: 'Content already in evaluation list.' });
        }

        // Add only if the content is not already present (protects against duplicates).
        const addEvaluationResult = await User.updateOne(
            { _id: userId, "evaluation_list.contentid": { $ne: contentId } },
            { $push: { evaluation_list: newEvaluation } }
        );

        if (addEvaluationResult.matchedCount === 0) {
            return res.status(200).json({ message: 'Content already in evaluation list.' });
        }

        // Update tracking history only when a new evaluation is added.
        const historyUpdateResult = await User.updateOne(
            { _id: userId, "tracking.history.category": category },
            { $inc: { "tracking.history.$.count": 1 } }
        );

        if (historyUpdateResult.matchedCount === 0) {
            await User.updateOne(
                { _id: userId },
                { $push: { "tracking.history": { category: category, count: 1 } } }
            );
        }

        return res.status(200).json({ message: 'Content added to evaluation list and history updated.' });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'An error occurred.' });
    }
};


exports.updateUserRemoveContentFromList = (req, res, next) => {
    const userId = req.params.id;
    const contentId = req.body.contentId;

    User.findById(userId)
        .then((user) => {
            if (!user) {
                return res.status(404).json({ message: 'User not found.' });
            }

            // Filter out the evaluation object with the specified castId
            user.evaluation_list = user.evaluation_list.filter((evaluationObject) => {
                return evaluationObject.contentid !== contentId;
            });

            return user.save();
        })
        .then(() => {
            res.status(200).json({ message: 'Content removed from evaluation list.' });
        })
        .catch((error) => {
            res.status(500).json({ error: 'An error occurred.' });
        });
};

exports.getUserBookmarks = async (req, res, next) => {
    const userId = req.params.id;

    try {
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const bookmarks = user.bookmarkedcontent;
        res.status(200).json(bookmarks);
    } catch (error) {
        res.status(500).json({ error: 'An error occurred.' });
    }
};

exports.addUserBookmark = async (req, res, next) => {
    const userId = req.params.id;
    const castId = String(req.body.castId);

    try {
        const userExists = await User.exists({ _id: userId });
        if (!userExists) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Add only if the content is not already present (protects against duplicates).
        const addBookmarkResult = await User.updateOne(
            { _id: userId, "bookmarkedcontent.contentid": { $ne: castId } },
            { $push: { bookmarkedcontent: { contentid: castId } } }
        );

        if (addBookmarkResult.matchedCount === 0) {
            return res.status(400).json({ message: 'Element is already bookmarked.' });
        }

        res.status(201).json({ message: 'Element bookmarked.' });
    } catch (error) {
        res.status(500).json({ error: 'An error occurred.' });
    }
};

exports.removeUserBookmark = async (req, res, next) => {
    const userId = req.params.id;
    const castId = req.params.castId;

    try {
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Filter out the bookmarked element with the specified castId
        user.bookmarkedcontent = user.bookmarkedcontent.filter(
            (bookmark) => bookmark.contentid !== castId
        );

        await user.save();

        res.status(200).json({ message: 'Element removed from bookmarks.' });
    } catch (error) {
        res.status(500).json({ error: 'An error occurred.' });
    }
};

exports.markContentAsAnswered = async (req, res, next) => {
    const userId = req.params.id;
    const contentId = req.body.contentId;

    User.findById(userId)
        .then((user) => {
            if (!user) {
                return res.status(404).json({ message: 'User not found.' });
            }

            // Find the specific evaluation in the user's "evaluation_list" array
            const evaluation = user.evaluation_list.find(item => item.contentid === contentId);

            if (!evaluation) {
                return res.status(404).json({ message: 'Evaluation not found.' });
            }

            // Update the "answered" field to true
            evaluation.answered = true;

            // Save the user object with the updated evaluation
            return user.save();
        })
        .then(() => {
            res.status(200).json({ message: 'Content marked as answered.' });
        })
        .catch((error) => {
            res.status(500).json({ error: 'An error occurred.' });
        });
}

exports.getSuggestedForYou = async (req, res, next) => {
    try {
        const user = await User.findById(req.params.id);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        if (!user.preferences || user.preferences.length === 0) {
            return res.status(404).json({ message: 'No preferences set for user.' });
        }

        // Step 1: Fetch user preferences
        const preferences = user.preferences;

        // Step 2: Fetch casts for each preference category
        const castsByCategory = await Promise.all(preferences.map(async (pref) => {
            const casts = await Cast.find({ department: pref.category }).sort({ _id: 1 }).lean();
            return casts.map(cast => ({ ...cast, weight: pref.weight }));
        }));

        // Step 3: Flatten the array and sort the casts by weight
        const allCasts = castsByCategory.flat();
        allCasts.sort((a, b) => b.weight - a.weight);

        // Removing duplicates using a Set
        const uniqueCasts = [];
        const seenCasts = new Set();

        for (const cast of allCasts) {
            if (!seenCasts.has(cast._id.toString())) {
                uniqueCasts.push(cast);
                seenCasts.add(cast._id.toString());
            }
        }

        // Removing the weight property for the final response
        const finalCasts = uniqueCasts.map(({ weight, ...rest }) => rest);

        res.status(200).json(finalCasts);
    } catch (error) {
        console.error('Error fetching suggested casts:', error);
        res.status(500).json({ error: 'An error occurred.' });
    }
};

exports.getUserPreferences = (req, res, next) => {
    User.findById(req.params.id)
        .then(user => {
            if (!user) {
                return res.status(404).json({ message: 'User not found.' });
            }

            res.status(200).json({ preferences: user.preferences });
        })
        .catch(error => {
            res.status(500).json({ error: 'An error occurred while fetching user preferences.' });
        });
};

exports.updateUserPreferences = async (req, res, next) => {
    const userId = req.params.id;
    const { category, modification } = req.body;

    // Verification for 'modification' field
    if (!modification || (modification !== 'positive' && modification !== 'negative')) {
        return res.status(400).json({ message: 'Invalid modification type. Must be either "positive" or "negative".' });
    }

    // Verification for 'category' field
    if (!departmentNames.includes(category)) {
        return res.status(400).json({ message: 'Invalid category. Must be one of the predefined departments.' });
    }

    try {
        const user = await User.findById(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Check if the category already exists in user preferences
        let existingCategory = user.preferences.find(pref => pref.category === category);

        if (existingCategory) {
            // Update the count based on the modification type
            existingCategory.count += modification === 'positive' ? 1 : -1;
            if (existingCategory.count < 0) existingCategory.count = 0; // Ensure count does not go negative
        } else if (modification === 'positive') {
            // If category doesn't exist and modification is positive, create new category with count 1
            user.preferences.push({ category: category, weight: 0, count: 1 });
        } // If category doesn't exist and modification is negative, ignore

        // Calculate the total count of all preferences
        const totalCount = user.preferences.reduce((acc, pref) => acc + pref.count, 0);

        // Update the weights based on the count
        user.preferences.forEach(pref => {
            if (totalCount > 0) {
                pref.weight = (pref.count / totalCount) * 100;
            } else {
                pref.weight = 0;
            }
        });

        // Save the updated user
        await user.save();

        res.status(200).json({ message: 'User preferences updated.', preferences: user.preferences });
    } catch (error) {
        res.status(500).json({ error: 'An error occurred.' });
    }
};


exports.updateUserTracking = async (req, res) => {
    const userId = req.params.id;
    const { objective } = req.body;

    // Define the valid objectives
    const validObjectives = ['Follower', 'Explorer', 'Deep Learner', 'Career', 'Researcher'];

    try {
        // Validate the objective value
        if (!validObjectives.includes(objective)) {
            return res.status(400).json({ message: 'Invalid objective value. Must be one of Follower, Explorer, Deep Learner, Career, or Researcher.' });
        }

        const user = await User.findById(userId);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        // Set the objective and target fields
        user.tracking.objective = objective;
        user.tracking.target = getTargetValue(objective); // Set or update the target field

        await user.save();
        res.status(200).json({ message: 'Tracking updated successfully.', tracking: user.tracking });
    } catch (error) {
        res.status(500).json({ error: 'An error occurred.' });
    }
};


exports.getUserTracking = async (req, res) => {
    const userId = req.params.id;

    try {
        const user = await User.findById(userId).select('tracking');
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.status(200).json({ tracking: user.tracking, target: user.tracking.target});
    } catch (error) {
        res.status(500).json({ error: 'An error occurred.' });
    }
};

exports.requestPasswordResetEmail = async (req, res) => {
    try {
      const { email } = req.body;
      const user = await User.findOne({ email });
  
      // If user doesn't exist or is not verified, handle accordingly:
      if (!user) {
        return res.status(404).json({ message: 'No user found with that email address.' });
      }
      if (!user.isVerified) {
        return res.status(400).json({ message: 'Your email has not been verified.' });
      }
  
      // Generate reset token
      const token = crypto.randomBytes(20).toString('hex');
  
      // Set token and expiration (1 hour from now, for example)
      user.resetPasswordToken = token;
      user.resetPasswordExpires = Date.now() + 3600000; // 1 hour
      await user.save();
  
      // Send the reset link via email
      const transporter = nodemailer.createTransport({
        service: 'Gmail',
        auth: {
          user: 'clement.carnus@brightmindsresearch.com',
          pass: EMAIL_PWD,
        },
      });
  
      // You can customize your email's text or HTML
      const mailOptions = {
        from: 'clement.carnus@brightmindsresearch.com',
        to: user.email,
        subject: 'Password Reset - BrightMinds Research',
        html: `
          <p>Hello ${user.username},</p>
          <p>You requested a password reset for your BrightMinds Research account.</p>
          <p>Please click the link below to set a new password (valid for 1 hour):</p>
          <p><a href="${API_BASE_URL}/user/reset-password/${token}">
            Reset Your Password
          </a></p>
          <p>If you did not request this, please ignore this email.</p>
        `,
      };
  
      await transporter.sendMail(mailOptions);
  
      res.status(200).json({ message: 'Password reset link sent to your email.' });
    } catch (error) {
      console.error('Error sending reset email:', error);
      res.status(500).json({ message: 'Error sending reset email.' });
    }
  };  


  exports.showResetPasswordForm = async (req, res) => {
    try {
        const { token } = req.params;
        // Ensure token corresponds to a valid user and is not expired
        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: Date.now() }, // $gt => must be greater than current time
        });

        if (!user) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                    <title>Password Reset - BrightMinds Research</title>
                    <style>
                        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                        body {
                            margin: 0;
                            padding: 0;
                            font-family: 'Montserrat', sans-serif;
                            background-color: #1c1c1c;
                            color: #f1f1f1;
                        }
                        .email-container {
                            max-width: 600px;
                            margin: 50px auto;
                            background-color: #1c1c1c;
                            border: 1px solid #1c1c1c;
                            border-radius: 8px;
                            padding: 20px;
                            text-align: center;
                        }
                        .email-container h2 {
                            color: #cc0000;
                            font-family: 'MontserratBold', sans-serif;
                        }
                        .email-container p {
                            font-size: 16px;
                            line-height: 1.5;
                            color: #f1f1f1;
                        }
                        a {
                            color: #00407A;
                            text-decoration: none;
                            font-weight: bold;
                        }
                        .button-container {
                            margin-top: 20px;
                        }
                        .button-container a {
                            background-color: #00407A;
                            color: #f1f1f1;
                            padding: 12px 24px;
                            text-decoration: none;
                            border-radius: 5px;
                            font-size: 16px;
                            font-family: 'MontserratBold', sans-serif;
                        }
                    </style>
                </head>
                <body>
                    <div class="email-container">
                        <h2>Invalid or Expired Link</h2>
                        <p>The password reset link is invalid or has expired.</p>
                        <div class="button-container">
                            <a href="https://www.brightmindsresearch.com/">Visit our Site</a>
                        </div>
                    </div>
                </body>
                </html>
            `);
        }

        return res.status(200).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>Reset Your Password - BrightMinds Research</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                    
                    body {
                        margin: 0;
                        padding: 0;
                        font-family: 'Montserrat', sans-serif;
                        background-color: #1c1c1c;
                        color: #f1f1f1;
                    }

                    .email-container {
                        max-width: 600px;
                        margin: 50px auto;
                        background-color: #1c1c1c;
                        border: 1px solid #1c1c1c;
                        border-radius: 8px;
                        padding: 20px;
                        text-align: center;
                    }

                    .email-container .logo {
                        margin-bottom: 20px;
                    }

                    .email-container .logo img {
                        max-width: 230px;
                    }

                    .email-container h2 {
                        color: #00407A;
                        font-family: 'MontserratBold', sans-serif;
                    }

                    .email-container p {
                        font-size: 16px;
                        line-height: 1.5;
                        color: #f1f1f1;
                    }

                    .password-form {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        margin-top: 20px;
                    }

                    .password-form label {
                        margin: 10px 0 5px;
                        font-size: 14px;
                        text-align: left;
                        width: 100%;
                        max-width: 400px;
                    }

                    .password-form input {
                        padding: 10px;
                        width: 100%;
                        max-width: 400px;
                        border: 1px solid #ccc;
                        border-radius: 5px;
                        font-size: 16px;
                    }

                    .password-form button {
                        margin-top: 20px;
                        padding: 12px 24px;
                        background-color: #00407A;
                        color: #f1f1f1;
                        border: none;
                        border-radius: 5px;
                        font-size: 16px;
                        cursor: pointer;
                        font-family: 'MontserratBold', sans-serif;
                    }

                    .password-form button:hover {
                        background-color: #00306B;
                    }

                    .error-message {
                        color: #cc0000;
                        margin-top: 10px;
                        font-size: 14px;
                    }

                    .footer {
                        text-align: center;
                        margin-top: 30px;
                        margin-bottom: 20px;
                    }

                    .footer img {
                        max-width: 100px;
                    }

                    .footer p {
                        font-size: 12px;
                        line-height: 1.5;
                        color: #f1f1f1;
                    }
                </style>
                <script>
                    function validateForm(event) {
                        const password = document.getElementById('password').value;
                        const confirmPassword = document.getElementById('confirmPassword').value;
                        const errorMessage = document.getElementById('error-message');

                        if (password !== confirmPassword) {
                            event.preventDefault();
                            errorMessage.textContent = 'Passwords do not match.';
                            return false;
                        }

                        if (password.length < 4) {
                            event.preventDefault();
                            errorMessage.textContent = 'Password must be at least 4 characters long.';
                            return false;
                        }

                        // Additional validation can be added here

                        return true;
                    }
                </script>
            </head>
            <body>
                <div class="email-container">
                    <div class="logo">
                        <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_title.png" alt="BrightMinds Research">
                    </div>
                    <h2>Reset Your Password</h2>
                    <p>Please enter your new password below.</p>
                    <form class="password-form" action="/user/reset-password/${token}" method="POST" onsubmit="validateForm(event)">
                        <label for="password">New Password:</label>
                        <input type="password" id="password" name="password" required />

                        <label for="confirmPassword">Confirm New Password:</label>
                        <input type="password" id="confirmPassword" name="confirmPassword" required />

                        <div id="error-message" class="error-message"></div>

                        <button type="submit">Reset Password</button>
                    </form>
                    <div class="footer">
                        <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_icon.png" alt="BrightMinds Footer">
                        <p>&copy; 2024 BrightMinds Research LLC. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error rendering password reset form:', error);
        res.status(500).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>Server Error - BrightMinds Research</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                    
                    body {
                        margin: 0;
                        padding: 0;
                        font-family: 'Montserrat', sans-serif;
                        background-color: #1c1c1c;
                        color: #f1f1f1;
                    }

                    .email-container {
                        max-width: 600px;
                        margin: 50px auto;
                        background-color: #1c1c1c;
                        border: 1px solid #1c1c1c;
                        border-radius: 8px;
                        padding: 20px;
                        text-align: center;
                    }

                    .email-container h2 {
                        color: #cc0000;
                        font-family: 'MontserratBold', sans-serif;
                    }

                    .email-container p {
                        font-size: 16px;
                        line-height: 1.5;
                        color: #f1f1f1;
                    }

                    .button-container {
                        margin-top: 20px;
                    }

                    .button-container a {
                        background-color: #00407A;
                        color: #f1f1f1;
                        padding: 12px 24px;
                        text-decoration: none;
                        border-radius: 5px;
                        font-size: 16px;
                        font-family: 'MontserratBold', sans-serif;
                    }
                </style>
            </head>
            <body>
                <div class="email-container">
                    <h2>Server Error</h2>
                    <p>Sorry, something went wrong. Please try again later.</p>
                    <div class="button-container">
                        <a href="https://www.brightmindsresearch.com/">Visit our Site</a>
                    </div>
                </div>
            </body>
            </html>
        `);
    }
};

exports.resetPassword = async (req, res) => {
    try {
        const { token } = req.params;
        const { password, confirmPassword } = req.body;

        // Check if both passwords are provided
        if (!password || !confirmPassword) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                    <title>Invalid Submission - BrightMinds Research</title>
                    <style>
                        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                        body {
                            margin: 0;
                            padding: 0;
                            font-family: 'Montserrat', sans-serif;
                            background-color: #1c1c1c;
                            color: #f1f1f1;
                        }
                        .email-container {
                            max-width: 600px;
                            margin: 50px auto;
                            background-color: #1c1c1c;
                            border: 1px solid #1c1c1c;
                            border-radius: 8px;
                            padding: 20px;
                            text-align: center;
                        }
                        .email-container .logo {
                            margin-bottom: 20px;
                        }
                        .email-container .logo img {
                            max-width: 230px;
                        }
                        .email-container h2 {
                            color: #cc0000;
                            font-family: 'MontserratBold', sans-serif;
                        }
                        .email-container p {
                            font-size: 16px;
                            line-height: 1.5;
                            color: #f1f1f1;
                        }
                        .button-container {
                            margin-top: 20px;
                        }
                        .button-container a {
                            background-color: #00407A;
                            color: #f1f1f1;
                            padding: 12px 24px;
                            text-decoration: none;
                            border-radius: 5px;
                            font-size: 16px;
                            font-family: 'MontserratBold', sans-serif;
                        }
                    </style>
                </head>
                <body>
                    <div class="email-container">
                        <div class="logo">
                            <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_title.png" alt="BrightMinds Research">
                        </div>
                        <h2>Invalid Submission</h2>
                        <p>Please provide both password fields.</p>
                        <div class="button-container">
                            <a href="javascript:history.back()">Go Back</a>
                        </div>
                        <div class="footer">
                            <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_icon.png" alt="BrightMinds Footer">
                            <p>&copy; 2024 BrightMinds Research LLC. All rights reserved.</p>
                        </div>
                    </div>
                </body>
                </html>
            `);
        }

        // Check if passwords match
        if (password !== confirmPassword) {
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                    <title>Passwords Do Not Match - BrightMinds Research</title>
                    <style>
                        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                        body {
                            margin: 0;
                            padding: 0;
                            font-family: 'Montserrat', sans-serif;
                            background-color: #1c1c1c;
                            color: #f1f1f1;
                        }
                        .email-container {
                            max-width: 600px;
                            margin: 50px auto;
                            background-color: #1c1c1c;
                            border: 1px solid #1c1c1c;
                            border-radius: 8px;
                            padding: 20px;
                            text-align: center;
                        }
                        .email-container .logo {
                            margin-bottom: 20px;
                        }
                        .email-container .logo img {
                            max-width: 230px;
                        }
                        .email-container h2 {
                            color: #cc0000;
                            font-family: 'MontserratBold', sans-serif;
                        }
                        .email-container p {
                            font-size: 16px;
                            line-height: 1.5;
                            color: #f1f1f1;
                        }
                        .button-container {
                            margin-top: 20px;
                        }
                        .button-container a {
                            background-color: #00407A;
                            color: #f1f1f1;
                            padding: 12px 24px;
                            text-decoration: none;
                            border-radius: 5px;
                            font-size: 16px;
                            font-family: 'MontserratBold', sans-serif;
                        }
                    </style>
                </head>
                <body>
                    <div class="email-container">
                        <div class="logo">
                            <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_title.png" alt="BrightMinds Research">
                        </div>
                        <h2>Passwords Do Not Match</h2>
                        <p>The passwords you entered do not match. Please try again.</p>
                        <div class="button-container">
                            <a href="javascript:history.back()">Go Back</a>
                        </div>
                        <div class="footer">
                            <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_icon.png" alt="BrightMinds Footer">
                            <p>&copy; 2024 BrightMinds Research LLC. All rights reserved.</p>
                        </div>
                    </div>
                </body>
                </html>
            `);
        }

        // Continue with the existing password reset logic
        const user = await User.findOne({
            resetPasswordToken: token,
            resetPasswordExpires: { $gt: Date.now() },
        });

        if (!user) {
            // Handle invalid or expired token
            return res.status(400).send(`
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8" />
                    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                    <title>Invalid or Expired Link - BrightMinds Research</title>
                    <style>
                        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                        body {
                            margin: 0;
                            padding: 0;
                            font-family: 'Montserrat', sans-serif;
                            background-color: #1c1c1c;
                            color: #f1f1f1;
                        }
                        .email-container {
                            max-width: 600px;
                            margin: 50px auto;
                            background-color: #1c1c1c;
                            border: 1px solid #1c1c1c;
                            border-radius: 8px;
                            padding: 20px;
                            text-align: center;
                        }
                        .email-container .logo {
                            margin-bottom: 20px;
                        }
                        .email-container .logo img {
                            max-width: 230px;
                        }
                        .email-container h2 {
                            color: #cc0000;
                            font-family: 'MontserratBold', sans-serif;
                        }
                        .email-container p {
                            font-size: 16px;
                            line-height: 1.5;
                            color: #f1f1f1;
                        }
                        .button-container {
                            margin-top: 20px;
                        }
                        .button-container a {
                            background-color: #00407A;
                            color: #f1f1f1;
                            padding: 12px 24px;
                            text-decoration: none;
                            border-radius: 5px;
                            font-size: 16px;
                            font-family: 'MontserratBold', sans-serif;
                        }
                        .footer {
                            text-align: center;
                            margin-top: 30px;
                            margin-bottom: 20px;
                        }

                        .footer img {
                            max-width: 100px;
                        }

                        .footer p {
                            font-size: 12px;
                            line-height: 1.5;
                            color: #f1f1f1;
                        }
                    </style>
                </head>
                <body>
                    <div class="email-container">
                        <div class="logo">
                            <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_title.png" alt="BrightMinds Research">
                        </div>
                        <h2>Invalid or Expired Link</h2>
                        <p>The password reset link is invalid or has expired.</p>
                        <div class="footer">
                            <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_icon.png" alt="BrightMinds Footer">
                            <p>&copy; 2024 BrightMinds Research LLC. All rights reserved.</p>
                        </div>
                    </div>
                </body>
                </html>
            `);
        }

        // Hash the new password
        const hash = await bcrypt.hash(password, 10);

        // Update user's password and clear the reset token fields
        user.password = hash;
        user.resetPasswordToken = undefined;
        user.resetPasswordExpires = undefined;
        await user.save();

        // Return a success message (styled similarly to your verification emails)
        return res.status(200).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>Password Updated - BrightMinds Research</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                    body {
                        margin: 0;
                        padding: 0;
                        font-family: 'Montserrat', sans-serif;
                        background-color: #1c1c1c;
                        color: #f1f1f1;
                    }
                    .email-container {
                        max-width: 600px;
                        margin: 50px auto;
                        background-color: #1c1c1c;
                        border: 1px solid #1c1c1c;
                        border-radius: 8px;
                        padding: 20px;
                        text-align: center;
                    }
                    .email-container .logo {
                        margin-bottom: 20px;
                    }
                    .email-container .logo img {
                        max-width: 230px;
                    }
                    .email-container h2 {
                        color: #00407A;
                        font-family: 'MontserratBold', sans-serif;
                    }
                    .email-container p {
                        font-size: 16px;
                        line-height: 1.5;
                        color: #f1f1f1;
                    }
                    .footer {
                        text-align: center;
                        margin-top: 20px;
                        margin-bottom: 20px;
                    }
                    .footer img {
                        max-width: 100px;
                    }
                    .footer p {
                        font-size: 12px;
                        line-height: 1.5;
                        color: #f1f1f1;
                    }
                </style>
            </head>
            <body>
                <div class="email-container">
                    <div class="logo">
                        <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_title.png" alt="BrightMinds Research">
                    </div>
                    <h2>Password Updated!</h2>
                    <p>Your password has been successfully updated. You can now log in with your new password.</p>
                    <div class="footer">
                        <img src="${API_BASE_URL}/backend/media/verification_email/BrightMinds_icon.png" alt="BrightMinds Footer">
                        <p>&copy; 2024 BrightMinds Research LLC. All rights reserved.</p>
                    </div>
                </div>
            </body>
            </html>
        `);
    } catch (error) {
        console.error('Error resetting password:', error);
        return res.status(500).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>Server Error - BrightMinds Research</title>
                <style>
                    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@400;700&display=swap');
                    body {
                        margin: 0;
                        padding: 0;
                        font-family: 'Montserrat', sans-serif;
                        background-color: #1c1c1c;
                        color: #f1f1f1;
                    }
                    .email-container {
                        max-width: 600px;
                        margin: 50px auto;
                        background-color: #1c1c1c;
                        border: 1px solid #1c1c1c;
                        border-radius: 8px;
                        padding: 20px;
                        text-align: center;
                    }
                    .email-container h2 {
                        color: #cc0000;
                        font-family: 'MontserratBold', sans-serif;
                    }
                    .email-container p {
                        font-size: 16px;
                        line-height: 1.5;
                        color: #f1f1f1;
                    }
                    .button-container {
                        margin-top: 20px;
                    }
                    .button-container a {
                        background-color: #00407A;
                        color: #f1f1f1;
                        padding: 12px 24px;
                        text-decoration: none;
                        border-radius: 5px;
                        font-size: 16px;
                        font-family: 'MontserratBold', sans-serif;
                    }
                </style>
            </head>
            <body>
                <div class="email-container">
                    <h2>Server Error</h2>
                    <p>Sorry, something went wrong. Please try again later.</p>
                    <div class="button-container">
                        <a href="https://www.brightmindsresearch.com/">Visit our Site</a>
                    </div>
                </div>
            </body>
            </html>
        `);
    }
};


  
