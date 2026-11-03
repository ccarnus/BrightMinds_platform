// Logic shared by casts and articles ("content").
const User = require('../models/user_model');
const { departmentNames } = require('../lists/departments');
const { PENDING_DEPARTMENT } = require('./topics');
const { badRequest, isNonEmptyString, isValidObjectId } = require('../utils/http');

const MAX_TITLE_LENGTH = 85;

const assertValidTitle = (title) => {
  if (typeof title === 'string' && title.length > MAX_TITLE_LENGTH) {
    throw badRequest(`Title must be ${MAX_TITLE_LENGTH} characters or less`);
  }
};

/** Returns a valid department, PENDING_DEPARTMENT when empty, or throws 400. */
const resolveDepartment = (value) => {
  if (!isNonEmptyString(value)) return PENDING_DEPARTMENT;
  if (!departmentNames.includes(value)) throw badRequest('Invalid department');
  return value;
};

/**
 * Atomically records a vote: '+' counts as 10, '-' as 0, averaged into rating.value.
 * @returns {Promise<object|null>} The updated document, or null if not found.
 */
const applyRating = (Model, id, action) => {
  if (action !== '+' && action !== '-') {
    throw badRequest('Invalid action.');
  }
  const value = { $ifNull: ['$rating.value', 5] };
  const count = { $ifNull: ['$rating.count', 1] };
  return Model.findByIdAndUpdate(
    id,
    [
      {
        $set: {
          'rating.value': {
            $divide: [
              { $add: [{ $multiply: [value, count] }, action === '+' ? 10 : 0] },
              { $add: [count, 1] },
            ],
          },
          'rating.count': { $add: [count, 1] },
        },
      },
    ],
    { new: true }
  );
};

/** Removes a deleted cast/article from every user's evaluation list, bookmarks and publications. */
const removeContentReferences = async (contentId) => {
  const ids = [contentId, contentId.toString()];
  await User.updateMany(
    {
      $or: [
        { 'evaluation_list.contentid': { $in: ids } },
        { 'bookmarkedcontent.contentid': { $in: ids } },
        { castPublications: contentId },
        { articlePublications: contentId },
      ],
    },
    {
      $pull: {
        evaluation_list: { contentid: { $in: ids } },
        bookmarkedcontent: { contentid: { $in: ids } },
        castPublications: contentId,
        articlePublications: contentId,
      },
    }
  );
};

/** Adds a content id to the author's publication list (`castPublications` or `articlePublications`). */
const addPublicationToAuthor = async (authorId, field, contentId) => {
  if (!isValidObjectId(authorId)) return;
  await User.updateOne({ _id: authorId }, { $addToSet: { [field]: contentId } });
};

module.exports = {
  MAX_TITLE_LENGTH,
  assertValidTitle,
  resolveDepartment,
  applyRating,
  removeContentReferences,
  addPublicationToAuthor,
};
