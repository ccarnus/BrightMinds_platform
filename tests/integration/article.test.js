const fs = require('fs');
const request = require('supertest');
const sharp = require('sharp');
const app = require('../../app');
const Article = require('../../models/article_model');
const Topic = require('../../models/topic_model');
const User = require('../../models/user_model');
const { articleQueue } = require('../../queues/article_queue');
const { mediaDirPath } = require('../../services/media');
const { useTestDatabase } = require('../helpers/db');
const {
  MEDIA_DIRS,
  PNG_BYTES,
  createUser,
  createArticle,
  createMediaFile,
  mediaFileExists,
} = require('../helpers/fixtures');

useTestDatabase();

beforeEach(() => {
  articleQueue.jobs.length = 0;
});

const payload = (author, overrides = {}) => ({
  title: 'Benzene rings',
  description: 'word '.repeat(300),
  brightmindid: author._id.toString(),
  university: 'MIT',
  category: 'Science',
  visibility: 'public',
  department: 'Chemistry',
  topic: 'Organic Chemistry',
  ...overrides,
});

const COVER = { filename: 'cover.png', contentType: 'image/png' };

/** Multipart article: `article` JSON field + `image` cover (pass `image: null` to omit it). */
const postArticle = (data, { image = PNG_BYTES, file = COVER } = {}) => {
  const req = request(app).post('/article').field('article', JSON.stringify(data));
  return image ? req.attach('image', image, file) : req;
};

const articleImageFiles = () =>
  fs.existsSync(mediaDirPath(MEDIA_DIRS.articleImages))
    ? fs.readdirSync(mediaDirPath(MEDIA_DIRS.articleImages))
    : [];

describe('POST /article', () => {
  test('creates the article with its uploaded cover, topic and author publication, then queues AI work', async () => {
    const author = await createUser();
    const res = await postArticle(payload(author, { rating: { value: 10, count: 999 } })).expect(
      201
    );

    const article = await Article.findById(res.body.id);
    expect(article.duration).toBe(2);
    // The question is generated in the background, so OpenAI outages never block posting.
    expect(article.evaluation.question).toBeUndefined();
    expect(article.processing.status).toBe('pending');
    // Mass assignment of protected fields is ignored.
    expect(article.rating.count).toBe(1);

    // The cover is re-encoded as JPEG; the original upload is not kept.
    expect(article.articleimageurl).toMatch(
      /^http:\/\/api\.test\/backend\/media\/article_images\/article_.*\.jpg$/
    );
    expect(res.body.articleimageurl).toBe(article.articleimageurl);
    const filename = article.articleimageurl.split('/').pop();
    expect(mediaFileExists(MEDIA_DIRS.articleImages, filename)).toBe(true);
    const metadata = await sharp(
      `${mediaDirPath(MEDIA_DIRS.articleImages)}/${filename}`
    ).metadata();
    expect(metadata.format).toBe('jpeg');
    expect(articleImageFiles().some((name) => name.startsWith('cover_'))).toBe(false);

    const topic = await Topic.findOne({ name: 'Organic Chemistry', departmentName: 'Chemistry' });
    expect(topic.articleIDs.map(String)).toEqual([article._id.toString()]);
    expect((await User.findById(author._id)).articlePublications.map(String)).toEqual([
      article._id.toString(),
    ]);
    expect(articleQueue.jobs).toEqual([{ articleId: res.body.id }]);
  });

  test('without topic/department, uses placeholders until the AI job fills them', async () => {
    const author = await createUser();
    const res = await postArticle(payload(author, { topic: '', department: '' })).expect(201);
    const article = await Article.findById(res.body.id);
    expect(article.topic).toBe('Pending Topic');
    expect(article.department).toBe('Pending Department');
    expect(await Topic.countDocuments()).toBe(0);
    expect(articleQueue.jobs).toEqual([{ articleId: res.body.id }]);
  });

  test('requires an uploaded cover image', async () => {
    const author = await createUser();
    const missing = await postArticle(payload(author), { image: null }).expect(400);
    expect(missing.body.message).toMatch(/cover image is required/);
    // The former JSON API (no image) is rejected too.
    await request(app).post('/article').send(payload(author)).expect(400);
    expect(await Article.countDocuments()).toBe(0);
  });

  test('rejects unsupported and unreadable images without keeping any file', async () => {
    const author = await createUser();
    const filesBefore = articleImageFiles();
    await postArticle(payload(author), {
      file: { filename: 'photo.heic', contentType: 'image/heic' },
    }).expect(400);
    const unreadable = await postArticle(payload(author), {
      image: Buffer.from('not an image'),
    }).expect(400);
    expect(unreadable.body.message).toMatch(/could not be read/);
    expect(await Article.countDocuments()).toBe(0);
    expect(articleImageFiles()).toEqual(filesBefore);
  });

  test('accepts plain multipart fields as well as the `article` JSON field', async () => {
    const author = await createUser();
    const fields = payload(author);
    const req = request(app).post('/article');
    Object.entries(fields).forEach(([key, value]) => req.field(key, value));
    const res = await req.attach('image', PNG_BYTES, COVER).expect(201);
    expect((await Article.findById(res.body.id)).title).toBe('Benzene rings');
  });

  test.each([
    ['invalid department', { department: 'Alchemy' }],
    ['title too long', { title: 'x'.repeat(86) }],
    ['missing description', { description: undefined }],
    ['missing title', { title: undefined }],
  ])('rejects %s with 400', async (_label, override) => {
    const author = await createUser();
    const filesBefore = articleImageFiles();
    await postArticle(payload(author, override)).expect(400);
    expect(await Article.countDocuments()).toBe(0);
    expect(articleImageFiles()).toEqual(filesBefore);
  });
});

describe('reading articles', () => {
  test('list, filters and single article', async () => {
    const a = await createArticle({ category: 'Bio', department: 'Chemistry', brightmindid: 'u1' });
    await createArticle({ category: 'Math', department: 'Mathematics', brightmindid: 'u2' });

    expect((await request(app).get('/article').expect(200)).body).toHaveLength(2);
    expect((await request(app).get('/article/category/Bio').expect(200)).body).toHaveLength(1);
    expect((await request(app).get('/article/department/Chemistry').expect(200)).body).toHaveLength(
      1
    );
    expect((await request(app).get('/article/brightmindid/u1').expect(200)).body).toHaveLength(1);
    expect((await request(app).get(`/article/${a._id}`).expect(200)).body.title).toBe(a.title);
  });

  test('unknown id returns 404, malformed id 400', async () => {
    await request(app).get('/article/507f1f77bcf86cd799439011').expect(404);
    await request(app).get('/article/not-an-id').expect(400);
    await request(app).get('/article/evaluation/507f1f77bcf86cd799439011').expect(404);
  });

  test('evaluation endpoint', async () => {
    const a = await createArticle({
      evaluation: { question: 'Q?', responses: ['a', 'b'], correct: 'a' },
    });
    const res = await request(app).get(`/article/evaluation/${a._id}`).expect(200);
    expect(res.body.evaluation.question).toBe('Q?');
  });

  test('trending returns recent articles, best rated first', async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await createArticle({ title: 'old', dateadded: old, rating: { value: 10, count: 1 } });
    await createArticle({ title: 'low', rating: { value: 2, count: 1 } });
    await createArticle({ title: 'high', rating: { value: 9, count: 1 } });
    const res = await request(app).get('/article/trending/right/now').expect(200);
    expect(res.body.map((a) => a.title)).toEqual(['high', 'low']);
  });
});

describe('PUT /article/:id', () => {
  test('moving to another topic updates both topics', async () => {
    const author = await createUser();
    const { body } = await postArticle(payload(author)).expect(201);

    await request(app)
      .put(`/article/${body.id}`)
      .send({ topic: 'Physical Chemistry', title: 'Renamed' })
      .expect(201);

    const article = await Article.findById(body.id);
    expect(article.title).toBe('Renamed');
    expect(article.department).toBe('Chemistry');
    expect(await Topic.findOne({ name: 'Organic Chemistry' })).toBeNull();
    const topic = await Topic.findOne({ name: 'Physical Chemistry', departmentName: 'Chemistry' });
    expect(topic.articleIDs.map(String)).toEqual([body.id]);
  });

  test('does not touch unrelated topics (regression)', async () => {
    const other = await Topic.create({ name: 'Unrelated', departmentName: 'Energy', castCount: 1 });
    const article = await createArticle();
    await request(app).put(`/article/${article._id}`).send({ title: 'x' }).expect(201);
    const reloaded = await Topic.findById(other._id);
    expect(reloaded.articleIDs).toHaveLength(0);
    expect(reloaded.articleCount).toBe(0);
  });

  test('rejects an invalid department and unknown articles', async () => {
    const article = await createArticle();
    await request(app).put(`/article/${article._id}`).send({ department: 'Alchemy' }).expect(400);
    await request(app).put('/article/507f1f77bcf86cd799439011').send({ title: 'x' }).expect(404);
  });

  test('a new uploaded cover replaces the previous one', async () => {
    const before = createMediaFile(MEDIA_DIRS.articleImages, 'previous.jpg');
    const article = await createArticle({ articleimageurl: before });

    await request(app)
      .put(`/article/${article._id}`)
      .field('article', JSON.stringify({ title: 'With a new cover' }))
      .attach('image', PNG_BYTES, COVER)
      .expect(201);

    const updated = await Article.findById(article._id);
    expect(updated.title).toBe('With a new cover');
    expect(updated.articleimageurl).toMatch(/\/article_images\/article_.*\.jpg$/);
    expect(mediaFileExists(MEDIA_DIRS.articleImages, 'previous.jpg')).toBe(false);
  });

  test('the cover cannot be replaced by a URL', async () => {
    const before = 'http://api.test/backend/media/article_images/kept.jpg';
    const article = await createArticle({ articleimageurl: before });
    await request(app)
      .put(`/article/${article._id}`)
      .send({ articleimageurl: 'https://example.com/generated.png' })
      .expect(201);
    expect((await Article.findById(article._id)).articleimageurl).toBe(before);
  });
});

describe('ratings', () => {
  test('+ counts as 10 and - as 0 in the running average', async () => {
    const article = await createArticle();
    const plus = await request(app)
      .post(`/article/${article._id}/rating`)
      .send({ action: '+' })
      .expect(200);
    expect(plus.body.rating).toEqual({ value: 7.5, count: 2 });
    const minus = await request(app)
      .post(`/article/${article._id}/rating`)
      .send({ action: '-' })
      .expect(200);
    expect(minus.body.rating).toEqual({ value: 5, count: 3 });

    const read = await request(app).get(`/article/${article._id}/rating`).expect(200);
    expect(read.body.rating).toEqual({ value: 5, count: 3 });
  });

  test('concurrent votes are all counted', async () => {
    const article = await createArticle();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app).post(`/article/${article._id}/rating`).send({ action: '+' })
      )
    );
    expect((await Article.findById(article._id)).rating.count).toBe(11);
  });

  test('rejects invalid actions and unknown articles', async () => {
    const article = await createArticle();
    await request(app).post(`/article/${article._id}/rating`).send({ action: '*' }).expect(400);
    await request(app)
      .post('/article/507f1f77bcf86cd799439011/rating')
      .send({ action: '+' })
      .expect(404);
  });
});

describe('DELETE /article/:id', () => {
  test('removes all user references, the image and the topic', async () => {
    const imageUrl = createMediaFile(MEDIA_DIRS.articleImages, 'to-delete.jpg');
    const user = await createUser();
    const article = await createArticle({
      articleimageurl: imageUrl,
      topic: 'Solo',
      department: 'Chemistry',
    });
    await Topic.create({
      name: 'Solo',
      departmentName: 'Chemistry',
      articleIDs: [article._id],
      articleCount: 1,
    });

    user.evaluation_list.push({
      contentid: article._id.toString(),
      type: 'article',
      watched: true,
      answered: false,
    });
    user.bookmarkedcontent.push({ contentid: article._id.toString() });
    user.articlePublications.push(article._id);
    await user.save();

    await request(app).delete(`/article/${article._id}`).expect(200);

    const updatedUser = await User.findById(user._id).lean();
    const id = article._id.toString();
    expect(updatedUser.evaluation_list.some((entry) => entry.contentid === id)).toBe(false);
    expect(updatedUser.bookmarkedcontent.some((entry) => entry.contentid === id)).toBe(false);
    expect(updatedUser.articlePublications.map(String)).not.toContain(id);
    expect(await Article.findById(article._id)).toBeNull();
    expect(await Topic.findOne({ name: 'Solo' })).toBeNull();
    expect(mediaFileExists(MEDIA_DIRS.articleImages, 'to-delete.jpg')).toBe(false);
  });

  test('returns 404 for unknown articles', async () => {
    await request(app).delete('/article/507f1f77bcf86cd799439011').expect(404);
  });
});
