// Rules shared by the cast endpoints: validation, rating and cleanup of references.
const User = require('../models/user_model');
const { departmentNames } = require('../lists/departments');
const { PENDING_DEPARTMENT } = require('./topics');
const { badRequest, isNonEmptyString, isValidObjectId } = require('../utils/http');

const MAX_TITLE_LENGTH = 85;

/** Fields left out of cast lists: the transcript, the quiz answers and the processing state. */
const CARD_PROJECTION = '-description -evaluation -processing';

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

/** Removes a deleted cast from every user's evaluation list, bookmarks and publications. */
const removeCastReferences = async (castId) => {
  const ids = [castId, castId.toString()];
  await User.updateMany(
    {
      $or: [
        { 'evaluation_list.contentid': { $in: ids } },
        { 'bookmarkedcontent.contentid': { $in: ids } },
        { castPublications: castId },
      ],
    },
    {
      $pull: {
        evaluation_list: { contentid: { $in: ids } },
        bookmarkedcontent: { contentid: { $in: ids } },
        castPublications: castId,
      },
    }
  );
};

/** Adds a cast id to the author's publication list. */
const addPublicationToAuthor = async (authorId, castId) => {
  if (!isValidObjectId(authorId)) return;
  await User.updateOne({ _id: authorId }, { $addToSet: { castPublications: castId } });
};

module.exports = {
  MAX_TITLE_LENGTH,
  CARD_PROJECTION,
  assertValidTitle,
  resolveDepartment,
  applyRating,
  removeCastReferences,
  addPublicationToAuthor,
};
