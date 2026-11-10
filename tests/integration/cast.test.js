const request = require('supertest');

jest.mock('../../services/video', () => ({ getVideoDurationInMinutes: jest.fn() }));
const { getVideoDurationInMinutes } = require('../../services/video');
// Real ffmpeg extraction is covered by tests/unit/thumbnail.test.js.
jest.mock('../../services/thumbnail', () => ({ createCastThumbnail: jest.fn() }));
const { createCastThumbnail } = require('../../services/thumbnail');

const app = require('../../app');
const Cast = require('../../models/cast_model');
const Topic = require('../../models/topic_model');
const User = require('../../models/user_model');
const { castQueue } = require('../../queues/cast_queue');
const { useTestDatabase } = require('../helpers/db');
const {
  MEDIA_DIRS,
  createUser,
  createCast,
  createMediaFile,
  mediaFileExists,
} = require('../helpers/fixtures');

useTestDatabase();

const VIDEO = Buffer.from('fake-mp4-bytes');
let thumbnails = 0;

beforeEach(() => {
  castQueue.jobs.length = 0;
  getVideoDurationInMinutes.mockReset().mockResolvedValue(3.5);
  createCastThumbnail.mockReset().mockImplementation(async () => {
    thumbnails += 1;
    const filename = `thumb_${thumbnails}.jpg`;
    createMediaFile(MEDIA_DIRS.castImages, filename);
    return filename;
  });
});

const imageUrl = (filename) => `http://api.test/backend/media/cast_images/${filename}`;

const postCast = (cast, { withVideo = true } = {}) => {
  const req = request(app).post('/cast').field('cast', JSON.stringify(cast));
  return withVideo
    ? req.attach('video', VIDEO, { filename: 'my talk.mp4', contentType: 'video/mp4' })
    : req;
};

const castPayload = (author, overrides = {}) => ({
  title: 'Black holes',
  brightmindid: author._id.toString(),
  university: 'MIT',
  category: 'Science',
  visibility: 'public',
  department: 'PhysicsandAstronomy',
  topic: 'Astrophysics',
  ...overrides,
});

describe('POST /cast', () => {
  test('stores the video, creates the cast and enqueues background processing', async () => {
    const author = await createUser();
    const res = await postCast(castPayload(author)).expect(201);

    const cast = await Cast.findById(res.body.id);
    expect(cast.duration).toBe(3.5);
    expect(cast.casturl).toMatch(
      /^http:\/\/api\.test\/backend\/media\/cast_videos\/my_talk_.*\.mp4$/
    );
    const filename = cast.casturl.split('/').pop();
    expect(mediaFileExists(MEDIA_DIRS.castVideos, filename)).toBe(true);

    expect(
      await Topic.findOne({ name: 'Astrophysics', departmentName: 'PhysicsandAstronomy' })
    ).not.toBeNull();
    expect((await User.findById(author._id)).castPublications.map(String)).toEqual([res.body.id]);
    expect(castQueue.jobs).toEqual([{ castId: res.body.id }]);
    expect(cast.processing.status).toBe('pending');

    // API upload without a chosen moment: the thumbnail is picked automatically from the video.
    expect(createCastThumbnail).toHaveBeenCalledWith(expect.stringContaining('my_talk_'), {
      duration: 210,
      time: undefined,
    });
    expect(cast.castimageurl).toBe(imageUrl(`thumb_${thumbnails}.jpg`));
    expect(res.body.castimageurl).toBe(cast.castimageurl);
  });

  test('uses the moment of the video chosen by the author', async () => {
    const author = await createUser();
    await postCast(castPayload(author, { thumbnailTime: 12.5 })).expect(201);
    expect(createCastThumbnail).toHaveBeenCalledWith(expect.any(String), {
      duration: 210,
      time: 12.5,
    });
  });

  test.each([-1, 'abc', true])('rejects thumbnailTime %p with 400', async (thumbnailTime) => {
    const author = await createUser();
    await postCast(castPayload(author, { thumbnailTime })).expect(400);
    expect(await Cast.countDocuments()).toBe(0);
    expect(createCastThumbnail).not.toHaveBeenCalled();
  });

  test('a video without readable frames still creates the cast, without image', async () => {
    createCastThumbnail.mockRejectedValue(new Error('No frame could be read from the video.'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const author = await createUser();
    const res = await postCast(castPayload(author)).expect(201);
    expect((await Cast.findById(res.body.id)).castimageurl).toBeUndefined();
    expect(res.body.castimageurl).toBeNull();
    console.error.mockRestore();
  });

  test('without topic, leaves a placeholder for the worker', async () => {
    const author = await createUser();
    const res = await postCast(castPayload(author, { topic: '' })).expect(201);
    expect((await Cast.findById(res.body.id)).topic).toBe('Pending Topic');
    expect(castQueue.jobs).toEqual([{ castId: res.body.id }]);
  });

  test('rejects duplicate titles with 409 and removes the uploaded file', async () => {
    const author = await createUser();
    await createCast({ title: 'Black holes' });
    await postCast(castPayload(author)).expect(409);
    expect(await Cast.countDocuments()).toBe(1);
  });

  test('requires a video and rejects other file types', async () => {
    const author = await createUser();
    await postCast(castPayload(author), { withVideo: false }).expect(400);
    await request(app)
      .post('/cast')
      .field('cast', JSON.stringify(castPayload(author)))
      .attach('video', VIDEO, { filename: 'x.exe', contentType: 'application/octet-stream' })
      .expect(400);
  });

  test('returns 400 when the video cannot be read', async () => {
    getVideoDurationInMinutes.mockRejectedValue(new Error('ffprobe failed'));
    const author = await createUser();
    await postCast(castPayload(author)).expect(400);
    expect(await Cast.countDocuments()).toBe(0);
  });

  test.each([
    ['invalid department', { department: 'Alchemy' }],
    ['title too long', { title: 'x'.repeat(86) }],
    ['missing required fields', { university: undefined }],
  ])('rejects %s with 400', async (_label, override) => {
    const author = await createUser();
    await postCast(castPayload(author, override)).expect(400);
    expect(await Cast.countDocuments()).toBe(0);
  });
});

describe('reading casts', () => {
  test('list endpoints', async () => {
    await createCast({ department: 'Chemistry', topic: 'A', category: 'X', brightmindid: 'u1' });
    await createCast({ department: 'Chemistry', topic: 'B', category: 'Y', brightmindid: 'u2' });
    await createCast({ department: 'Energy', topic: 'A', category: 'Y', brightmindid: 'u2' });

    expect((await request(app).get('/cast').expect(200)).body).toHaveLength(3);
    expect((await request(app).get('/cast/category/Y').expect(200)).body).toHaveLength(2);
    expect((await request(app).get('/cast/brightmindid/u1').expect(200)).body).toHaveLength(1);
    expect((await request(app).get('/cast/department/Chemistry').expect(200)).body).toHaveLength(2);
    expect(
      (await request(app).get('/cast/department/Chemistry?topic=B').expect(200)).body
    ).toHaveLength(1);
    expect((await request(app).get('/cast/trending/right/now').expect(200)).body).toHaveLength(3);

    const simplified = await request(app).get('/cast/all/simplified').expect(200);
    expect(simplified.body.count).toBe(3);
    expect(Object.keys(simplified.body.casts[0]).sort()).toEqual(['_id', 'title']);

    const popular = await request(app).get('/cast/popular/department').expect(200);
    expect(popular.body[0]).toEqual({ _id: 'Chemistry', count: 2 });
  });

  test('single cast, evaluation and rating', async () => {
    const cast = await createCast({
      evaluation: { question: 'Q?', responses: ['a'], correct: 'a' },
    });
    expect((await request(app).get(`/cast/${cast._id}`).expect(200)).body.title).toBe(cast.title);
    expect(
      (await request(app).get(`/cast/evaluation/${cast._id}`).expect(200)).body.evaluation.question
    ).toBe('Q?');
    expect((await request(app).get(`/cast/${cast._id}/rating`).expect(200)).body.rating).toEqual({
      value: 5,
      count: 1,
    });
    await request(app).get('/cast/507f1f77bcf86cd799439011').expect(404);
    await request(app).get('/cast/bad-id').expect(400);
  });

  test('rating updates', async () => {
    const cast = await createCast();
    const res = await request(app)
      .post(`/cast/${cast._id}/rating`)
      .send({ action: '+' })
      .expect(200);
    expect(res.body.rating).toEqual({ value: 7.5, count: 2 });
    await request(app).post(`/cast/${cast._id}/rating`).send({ action: 'x' }).expect(400);
  });
});

describe('PUT /cast/:id', () => {
  test('partial update keeps other fields and moves the topic', async () => {
    const cast = await createCast({ topic: 'Old', department: 'Chemistry' });
    await Topic.create({
      name: 'Old',
      departmentName: 'Chemistry',
      castIDs: [cast._id],
      castCount: 1,
    });

    await request(app)
      .put(`/cast/${cast._id}`)
      .field('cast', JSON.stringify({ topic: 'New', dateadded: '2024-01-02T00:00:00.000Z' }))
      .expect(200);

    const updated = await Cast.findById(cast._id);
    expect(updated.topic).toBe('New');
    expect(updated.title).toBe(cast.title);
    expect(updated.dateadded.toISOString()).toBe('2024-01-02T00:00:00.000Z');
    expect(await Topic.findOne({ name: 'Old' })).toBeNull();
    expect(await Topic.findOne({ name: 'New', departmentName: 'Chemistry' })).not.toBeNull();
  });

  test('replacing the video deletes the previous files and takes a new thumbnail', async () => {
    const oldUrl = createMediaFile(MEDIA_DIRS.castVideos, 'old.mp4');
    const oldImage = createMediaFile(MEDIA_DIRS.castImages, 'old.jpg');
    const cast = await createCast({ casturl: oldUrl, castimageurl: oldImage });
    getVideoDurationInMinutes.mockResolvedValue(9);

    await request(app)
      .put(`/cast/${cast._id}`)
      .field('cast', '{}')
      .attach('video', VIDEO, { filename: 'new.mp4', contentType: 'video/mp4' })
      .expect(200);

    const updated = await Cast.findById(cast._id);
    expect(updated.duration).toBe(9);
    expect(updated.casturl).not.toBe(oldUrl);
    expect(mediaFileExists(MEDIA_DIRS.castVideos, 'old.mp4')).toBe(false);
    expect(createCastThumbnail).toHaveBeenCalledWith(expect.stringContaining('new_'), {
      duration: 540,
      time: undefined,
    });
    expect(updated.castimageurl).toBe(imageUrl(`thumb_${thumbnails}.jpg`));
    expect(mediaFileExists(MEDIA_DIRS.castImages, 'old.jpg')).toBe(false);
  });

  test('thumbnailTime alone picks a new moment of the current video', async () => {
    const cast = await createCast({
      casturl: createMediaFile(MEDIA_DIRS.castVideos, 'talk.mp4'),
      castimageurl: createMediaFile(MEDIA_DIRS.castImages, 'before.jpg'),
      duration: 2,
    });

    await request(app)
      .put(`/cast/${cast._id}`)
      .field('cast', JSON.stringify({ thumbnailTime: 42 }))
      .expect(200);

    expect(createCastThumbnail).toHaveBeenCalledWith(expect.stringContaining('talk.mp4'), {
      duration: 120,
      time: 42,
    });
    expect((await Cast.findById(cast._id)).castimageurl).toBe(imageUrl(`thumb_${thumbnails}.jpg`));
    expect(mediaFileExists(MEDIA_DIRS.castImages, 'before.jpg')).toBe(false);
  });

  test('a thumbnail that cannot be read is reported and the previous one kept', async () => {
    createCastThumbnail.mockRejectedValue(new Error('No frame could be read from the video.'));
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const before = createMediaFile(MEDIA_DIRS.castImages, 'kept.jpg');
    const cast = await createCast({ castimageurl: before });

    await request(app)
      .put(`/cast/${cast._id}`)
      .field('cast', JSON.stringify({ thumbnailTime: 3 }))
      .expect(422);

    expect((await Cast.findById(cast._id)).castimageurl).toBe(before);
    expect(mediaFileExists(MEDIA_DIRS.castImages, 'kept.jpg')).toBe(true);
    console.error.mockRestore();
  });

  test('the image cannot be set directly: it always comes from the video', async () => {
    const cast = await createCast({ castimageurl: imageUrl('thumb_original.jpg') });
    await request(app)
      .put(`/cast/${cast._id}`)
      .field('cast', JSON.stringify({ castimageurl: 'https://example.com/ai.png', title: 'New' }))
      .expect(200);
    const updated = await Cast.findById(cast._id);
    expect(updated.title).toBe('New');
    expect(updated.castimageurl).toBe(imageUrl('thumb_original.jpg'));
    expect(createCastThumbnail).not.toHaveBeenCalled();
  });

  test('validates input', async () => {
    const cast = await createCast();
    await request(app).put(`/cast/${cast._id}`).field('cast', '{bad').expect(400);
    await request(app)
      .put(`/cast/${cast._id}`)
      .field('cast', JSON.stringify({ department: 'Alchemy' }))
      .expect(400);
    await request(app)
      .put(`/cast/${cast._id}`)
      .field('cast', JSON.stringify({ thumbnailTime: -5 }))
      .expect(400);
    await request(app).put('/cast/507f1f77bcf86cd799439011').field('cast', '{}').expect(404);
  });
});

describe('DELETE /cast/:id', () => {
  test('removes media files, user references and the topic', async () => {
    const user = await createUser();
    const cast = await createCast({
      topic: 'Solo',
      department: 'Chemistry',
      casturl: createMediaFile(MEDIA_DIRS.castVideos, 'v.mp4'),
      castimageurl: createMediaFile(MEDIA_DIRS.castImages, 'i.jpg'),
      subtitleurl: createMediaFile(MEDIA_DIRS.castSubtitles, 's.srt'),
    });
    await Topic.create({
      name: 'Solo',
      departmentName: 'Chemistry',
      castIDs: [cast._id],
      castCount: 1,
    });

    user.evaluation_list.push({
      contentid: cast._id.toString(),
      type: 'cast',
      watched: true,
      answered: false,
    });
    user.bookmarkedcontent.push({ contentid: cast._id.toString() });
    user.castPublications.push(cast._id);
    await user.save();

    await request(app).delete(`/cast/${cast._id}`).expect(200);

    const updatedUser = await User.findById(user._id).lean();
    const id = cast._id.toString();
    expect(updatedUser.evaluation_list.some((entry) => entry.contentid === id)).toBe(false);
    expect(updatedUser.bookmarkedcontent.some((entry) => entry.contentid === id)).toBe(false);
    expect(updatedUser.castPublications.map(String)).not.toContain(id);
    expect(await Cast.findById(cast._id)).toBeNull();
    expect(await Topic.findOne({ name: 'Solo' })).toBeNull();
    expect(mediaFileExists(MEDIA_DIRS.castVideos, 'v.mp4')).toBe(false);
    expect(mediaFileExists(MEDIA_DIRS.castImages, 'i.jpg')).toBe(false);
    expect(mediaFileExists(MEDIA_DIRS.castSubtitles, 's.srt')).toBe(false);
  });

  test('a crafted media URL cannot delete files outside its media directory', async () => {
    createMediaFile(MEDIA_DIRS.castVideos, 'keep.mp4');
    const cast = await createCast({
      castimageurl: 'http://x/backend/media/cast_images/../cast_videos/keep.mp4',
    });
    await request(app).delete(`/cast/${cast._id}`).expect(200);
    expect(mediaFileExists(MEDIA_DIRS.castVideos, 'keep.mp4')).toBe(true);
  });

  test('returns 404 for unknown casts', async () => {
    await request(app).delete('/cast/507f1f77bcf86cd799439011').expect(404);
  });
});

describe('review regressions', () => {
  test('accepts iOS .mov uploads and generic MIME types with a known extension', async () => {
    const author = await createUser();
    const mov = await request(app)
      .post('/cast')
      .field('cast', JSON.stringify(castPayload(author, { title: 'iOS clip' })))
      .attach('video', VIDEO, { filename: 'clip.MOV', contentType: 'video/quicktime' })
      .expect(201);
    expect((await Cast.findById(mov.body.id)).casturl).toMatch(/\.mov$/);

    const generic = await request(app)
      .post('/cast')
      .field('cast', JSON.stringify(castPayload(author, { title: 'RN clip' })))
      .attach('video', VIDEO, { filename: 'clip.mp4', contentType: 'application/octet-stream' })
      .expect(201);
    expect((await Cast.findById(generic.body.id)).casturl).toMatch(/\.mp4$/);
  });

  test('a rejected update does not move the topic', async () => {
    const cast = await createCast({ topic: 'Kept', department: 'Chemistry' });
    await Topic.create({
      name: 'Kept',
      departmentName: 'Chemistry',
      castIDs: [cast._id],
      castCount: 1,
    });

    await request(app)
      .put(`/cast/${cast._id}`)
      .field('cast', JSON.stringify({ topic: 'Other', title: '' }))
      .expect(400);

    expect(await Topic.findOne({ name: 'Kept' })).not.toBeNull();
    expect(await Topic.findOne({ name: 'Other' })).toBeNull();
  });

  test('the uploaded video is kept if a step after saving the cast fails', async () => {
    const author = await createUser();
    const spy = jest.spyOn(Topic, 'findOne').mockRejectedValueOnce(new Error('db hiccup'));
    await postCast(castPayload(author)).expect(500);
    spy.mockRestore();

    const cast = await Cast.findOne({ title: 'Black holes' });
    expect(mediaFileExists(MEDIA_DIRS.castVideos, cast.casturl.split('/').pop())).toBe(true);
  });
});
