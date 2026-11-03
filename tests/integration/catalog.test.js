const request = require('supertest');
const app = require('../../app');
const Topic = require('../../models/topic_model');
const University = require('../../models/university_model');
const VirtualLab = require('../../models/virtual_lab_model');
const { useTestDatabase } = require('../helpers/db');
const { PNG_BYTES, MEDIA_DIRS, createMediaFile, mediaFileExists } = require('../helpers/fixtures');

useTestDatabase();

const MISSING_ID = '507f1f77bcf86cd799439011';
const attachIcon = (req) =>
  req.attach('icon', PNG_BYTES, { filename: 'icon.png', contentType: 'image/png' });

describe('topics', () => {
  test('POST /topic creates a topic once (used to hang forever)', async () => {
    const first = await request(app)
      .post('/topic')
      .send({ name: 'Optics', departmentName: 'PhysicsandAstronomy' })
      .expect(201);
    expect(first.body.topic.name).toBe('Optics');
    await request(app)
      .post('/topic')
      .send({ name: 'Optics', departmentName: 'PhysicsandAstronomy' })
      .expect(200);
    expect(await Topic.countDocuments()).toBe(1);
  });

  test('POST /topic validates input', async () => {
    await request(app).post('/topic').send({ departmentName: 'Chemistry' }).expect(400);
    await request(app).post('/topic').send({ name: 'X', departmentName: 'Alchemy' }).expect(400);
  });

  test('read, filter and update', async () => {
    const topic = await Topic.create({ name: 'Optics', departmentName: 'PhysicsandAstronomy' });
    await Topic.create({ name: 'Enzymes', departmentName: 'Chemistry' });

    expect((await request(app).get('/topic').expect(200)).body).toHaveLength(2);
    expect((await request(app).get('/topic/department/Chemistry').expect(200)).body).toHaveLength(
      1
    );
    expect((await request(app).get(`/topic/${topic._id}`).expect(200)).body.name).toBe('Optics');

    const updated = await request(app)
      .put(`/topic/${topic._id}`)
      .send({ openalexID: 'T1', impact: 999 })
      .expect(200);
    expect(updated.body.openalexID).toBe('T1');
    expect(updated.body.impact).toBe(0); // computed fields are not client-editable

    await request(app).get(`/topic/${MISSING_ID}`).expect(404);
    await request(app).put(`/topic/${MISSING_ID}`).send({ name: 'x' }).expect(404);
    await request(app).put(`/topic/${topic._id}`).send({ departmentName: 'Alchemy' }).expect(400);
  });
});

describe('universities', () => {
  test('create, read, update, delete', async () => {
    await attachIcon(
      request(app)
        .post('/university')
        .field('university', JSON.stringify({ name: 'mit', displayedName: 'MIT' }))
    ).expect(201);

    const [university] = (await request(app).get('/university').expect(200)).body;
    expect(university.iconurl).toMatch(/\/backend\/media\/university_icon\/icon_.*\.png$/);
    const iconFile = university.iconurl.split('/').pop();

    expect((await request(app).get(`/university/${university._id}`).expect(200)).body.name).toBe(
      'mit'
    );
    expect((await request(app).get('/university/by/name/mit').expect(200)).body.displayedName).toBe(
      'MIT'
    );

    // JSON update without a file.
    await request(app)
      .put(`/university/${university._id}`)
      .send({ displayedName: 'M.I.T.' })
      .expect(201);
    expect((await University.findById(university._id)).displayedName).toBe('M.I.T.');

    // Multipart update replaces the icon and deletes the old file.
    await attachIcon(
      request(app)
        .put(`/university/${university._id}`)
        .field('university', JSON.stringify({ name: 'mit2' }))
    ).expect(201);
    expect(mediaFileExists(MEDIA_DIRS.universityIcons, iconFile)).toBe(false);

    await request(app).delete(`/university/${university._id}`).expect(200);
    expect(await University.countDocuments()).toBe(0);
  });

  test('errors: missing icon, unknown ids (delete used to crash the process)', async () => {
    await request(app)
      .post('/university')
      .field('university', '{"name":"x","displayedName":"X"}')
      .expect(400);
    await request(app).get(`/university/${MISSING_ID}`).expect(404);
    await request(app).get('/university/by/name/unknown').expect(404);
    await request(app).put(`/university/${MISSING_ID}`).send({ name: 'x' }).expect(404);
    await request(app).delete(`/university/${MISSING_ID}`).expect(404);
  });

  test('a crafted iconurl cannot delete files outside the icon directory', async () => {
    createMediaFile(MEDIA_DIRS.castVideos, 'precious.mp4');
    const university = await University.create({
      name: 'evil',
      displayedName: 'Evil',
      iconurl: 'http://x/backend/media/university_icon/../cast_videos/precious.mp4',
    });
    await request(app).delete(`/university/${university._id}`).expect(200);
    expect(mediaFileExists(MEDIA_DIRS.castVideos, 'precious.mp4')).toBe(true);
  });
});

describe('virtual labs', () => {
  const createLab = () =>
    attachIcon(
      request(app)
        .post('/virtual/lab')
        .field('virtuallab', JSON.stringify({ name: 'Lab', colorcode: '#fff', topics: [] }))
    ).expect(201);

  test('lab CRUD', async () => {
    await createLab();
    const [lab] = (await request(app).get('/virtual/lab').expect(200)).body;
    expect(lab.iconurl).toMatch(/\/backend\/media\/virtuallab_icon\//);

    await request(app).put(`/virtual/lab/${lab._id}`).send({ colorcode: '#000' }).expect(200);
    expect((await request(app).get(`/virtual/lab/${lab._id}`).expect(200)).body.colorcode).toBe(
      '#000'
    );

    await request(app).delete(`/virtual/lab/${lab._id}`).expect(200);
    expect(await VirtualLab.countDocuments()).toBe(0);
    expect(mediaFileExists(MEDIA_DIRS.virtualLabIcons, lab.iconurl.split('/').pop())).toBe(false);
  });

  test('topics and institutes', async () => {
    await createLab();
    const lab = await VirtualLab.findOne();

    await request(app)
      .post(`/virtual/lab/${lab._id}/add/topic`)
      .send({ name: 'T1', description: 'd' })
      .expect(200);
    const topicId = (await VirtualLab.findById(lab._id)).topics[0]._id;
    await request(app)
      .put(`/virtual/lab/${lab._id}/update/topic/${topicId}`)
      .send({ gage: 7, _id: MISSING_ID })
      .expect(200);
    const topic = (await VirtualLab.findById(lab._id)).topics[0];
    expect(topic.gage).toBe(7);
    expect(topic._id.toString()).toBe(topicId.toString());
    await request(app).delete(`/virtual/lab/${lab._id}/remove/topic/${topicId}`).expect(200);
    expect((await VirtualLab.findById(lab._id)).topics).toHaveLength(0);

    await request(app)
      .post(`/virtual/lab/${lab._id}/add/institute`)
      .send({ instituteID: 'inst-1' })
      .expect(200);
    await request(app)
      .put(`/virtual/lab/${lab._id}/update/institute/inst-1`)
      .send({ score: 4 })
      .expect(200);
    expect((await VirtualLab.findById(lab._id)).institute[0].score).toBe(4);
    await request(app).delete(`/virtual/lab/${lab._id}/remove/institute/inst-1`).expect(200);
    expect((await VirtualLab.findById(lab._id)).institute).toHaveLength(0);
  });

  test('errors', async () => {
    await request(app).post('/virtual/lab').field('virtuallab', '{"name":"x"}').expect(400);
    await request(app).get(`/virtual/lab/${MISSING_ID}`).expect(404);
    await request(app).delete(`/virtual/lab/${MISSING_ID}`).expect(404);
    await createLab();
    const lab = await VirtualLab.findOne();
    await request(app)
      .put(`/virtual/lab/${lab._id}/update/topic/${MISSING_ID}`)
      .send({})
      .expect(404);
    await request(app).delete(`/virtual/lab/${lab._id}/remove/topic/${MISSING_ID}`).expect(404);
    await request(app).put(`/virtual/lab/${lab._id}/update/institute/nope`).send({}).expect(404);
    await request(app).delete(`/virtual/lab/${lab._id}/remove/institute/nope`).expect(404);
  });
});
