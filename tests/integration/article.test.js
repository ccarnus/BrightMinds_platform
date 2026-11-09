const request = require('supertest');
const app = require('../../app');
const Article = require('../../models/article_model');
const Topic = require('../../models/topic_model');
const User = require('../../models/user_model');
const { articleQueue } = require('../../queues/article_queue');
const { useTestDatabase } = require('../helpers/db');
const {
  MEDIA_DIRS,
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

describe('POST /article', () => {
  test('creates the article, its topic and the author publication, then queues AI work', async () => {
    const author = await createUser();
    const res = await request(app)
      .post('/article')
      .send(payload(author, { rating: { value: 10, count: 999 } }))
      .expect(201);

    const article = await Article.findById(res.body.id);
    expect(article.duration).toBe(2);
    // Question and image are generated in the background, so OpenAI outages never block posting.
    expect(article.evaluation.question).toBeUndefined();
    expect(article.articleimageurl).toBeUndefined();
    expect(article.processing.status).toBe('pending');
    // Mass assignment of protected fields is ignored.
    expect(article.rating.count).toBe(1);

    const topic = await Topic.findOne({ name: 'Organic Chemistry', departmentName: 'Chemistry' });
    expect(topic.articleIDs.map(String)).toEqual([article._id.toString()]);
    expect((await User.findById(author._id)).articlePublications.map(String)).toEqual([
      article._id.toString(),
    ]);
    expect(articleQueue.jobs).toEqual([{ articleId: res.body.id }]);
  });

  test('without topic/department, uses placeholders until the AI job fills them', async () => {
    const author = await createUser();
    const res = await request(app)
      .post('/article')
      .send(payload(author, { topic: '', department: '' }))
      .expect(201);
    const article = await Article.findById(res.body.id);
    expect(article.topic).toBe('Pending Topic');
    expect(article.department).toBe('Pending Department');
    expect(await Topic.countDocuments()).toBe(0);
    expect(articleQueue.jobs).toEqual([{ articleId: res.body.id }]);
  });

  test.each([
    ['invalid department', { department: 'Alchemy' }],
    ['title too long', { title: 'x'.repeat(86) }],
    ['missing description', { description: undefined }],
    ['missing title', { title: undefined }],
  ])('rejects %s with 400', async (_label, override) => {
    const author = await createUser();
    await request(app).post('/article').send(payload(author, override)).expect(400);
    expect(await Article.countDocuments()).toBe(0);
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
    const { body } = await request(app).post('/article').send(payload(author)).expect(201);

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
