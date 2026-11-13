const Topic = require('../../models/topic_model');
const {
  findTopic,
  createTopicIfNotExist,
  removeExistingTopic,
  moveCastTopic,
} = require('../../services/topics');
const { useTestDatabase } = require('../helpers/db');
const { createCatalogTopic } = require('../helpers/fixtures');

useTestDatabase();

const castId = () => new (require('mongoose').Types.ObjectId)();

describe('findTopic', () => {
  test('by OpenAlex id first, then exact name, then catalog name in any case', async () => {
    const catalog = await createCatalogTopic({ name: 'Quantum Mechanics', openalexID: 'T5' });
    const authored = await Topic.create({ name: 'Zinc', departmentName: 'Chemistry' });

    expect(
      (await findTopic({ name: 'Anything', departmentName: 'Chemistry', openalexID: 'T5' }))._id
    ).toEqual(catalog._id);
    expect((await findTopic({ name: 'Zinc', departmentName: 'Chemistry' }))._id).toEqual(
      authored._id
    );
    expect(
      (await findTopic({ name: ' quantum mechanics ', departmentName: 'Chemistry' }))._id
    ).toEqual(catalog._id);
    expect(
      await findTopic({ name: 'quantum mechanics', departmentName: 'Mathematics' })
    ).toBeNull();
    // Only the catalog is matched loosely: an author topic needs its exact name.
    expect(await findTopic({ name: 'zinc', departmentName: 'Chemistry' })).toBeNull();
  });

  test('a name with regex characters is plain text', async () => {
    await createCatalogTopic({ name: 'C++ (Programming)' });
    expect(
      await findTopic({ name: 'C++ (programming)', departmentName: 'Chemistry' })
    ).not.toBeNull();
    expect(await findTopic({ name: '.*', departmentName: 'Chemistry' })).toBeNull();
  });
});

describe('createTopicIfNotExist', () => {
  test('links the cast to the catalog topic instead of creating a second one', async () => {
    const catalog = await createCatalogTopic({ name: 'Quantum Mechanics', openalexID: 'T5' });
    const id = castId();
    const result = await createTopicIfNotExist({
      name: 'Quantum Mechanics',
      departmentName: 'Chemistry',
      openalexID: 'T5',
      castId: id,
    });
    expect(result.status).toBe(200);
    expect(await Topic.countDocuments()).toBe(1);
    const topic = await Topic.findById(catalog._id).lean();
    expect(topic).toMatchObject({ castCount: 1, source: 'openalex' });
    expect(topic.castIDs).toEqual([id]);

    await createTopicIfNotExist({
      name: 'Quantum Mechanics',
      departmentName: 'Chemistry',
      castId: id,
    });
    expect((await Topic.findById(catalog._id)).castCount).toBe(1);
  });

  test('creates an author topic when the lab has none', async () => {
    const result = await createTopicIfNotExist({
      name: 'My own topic',
      departmentName: 'Chemistry',
      castId: castId(),
    });
    expect(result.status).toBe(201);
    expect(result.topic).toMatchObject({ source: 'author', castCount: 1 });
  });

  test('keeps the OpenAlex id it learns on an author topic', async () => {
    await Topic.create({ name: 'Zinc', departmentName: 'Chemistry' });
    await createTopicIfNotExist({ name: 'Zinc', departmentName: 'Chemistry', openalexID: 'T77' });
    expect((await Topic.findOne({ name: 'Zinc' })).openalexID).toBe('T77');
  });

  test('requires a name and a lab', async () => {
    await expect(createTopicIfNotExist({ name: 'x' })).rejects.toThrow('required');
  });
});

describe('removeExistingTopic', () => {
  test('a catalog topic stays when its last cast goes, an author topic does not', async () => {
    const id = castId();
    await createCatalogTopic({ name: 'Kept', openalexID: 'T6', castIDs: [id], castCount: 1 });
    await Topic.create({
      name: 'Dropped',
      departmentName: 'Chemistry',
      castIDs: [id],
      castCount: 1,
    });

    const kept = await removeExistingTopic({
      name: 'Kept',
      departmentName: 'Chemistry',
      castId: id,
    });
    expect(kept.status).toBe(200);
    expect(await Topic.findOne({ name: 'Kept' }).lean()).toMatchObject({
      castCount: 0,
      castIDs: [],
    });

    await removeExistingTopic({ name: 'Dropped', departmentName: 'Chemistry', castId: id });
    expect(await Topic.findOne({ name: 'Dropped' })).toBeNull();
  });

  test('an unknown topic is a 404 and the count never goes negative', async () => {
    expect(
      (await removeExistingTopic({ name: 'Nope', departmentName: 'Chemistry', castId: castId() }))
        .status
    ).toBe(404);
    expect((await removeExistingTopic({ name: '', departmentName: '' })).status).toBe(404);
    await createCatalogTopic({ name: 'Zero', castCount: 0 });
    await removeExistingTopic({ name: 'Zero', departmentName: 'Chemistry', castId: castId() });
    expect((await Topic.findOne({ name: 'Zero' })).castCount).toBe(0);
  });
});

describe('moveCastTopic', () => {
  test('moves a cast from one topic to another, ignoring pending placeholders', async () => {
    const id = castId();
    await createTopicIfNotExist({ name: 'First', departmentName: 'Chemistry', castId: id });
    await moveCastTopic({
      from: { name: 'First', departmentName: 'Chemistry' },
      to: { name: 'Second', departmentName: 'Chemistry' },
      castId: id,
    });
    expect(await Topic.findOne({ name: 'First' })).toBeNull();
    expect((await Topic.findOne({ name: 'Second' })).castCount).toBe(1);

    await moveCastTopic({
      from: { name: 'Pending Topic', departmentName: 'Pending Department' },
      to: { name: 'Second', departmentName: 'Chemistry' },
      castId: id,
    });
    expect((await Topic.findOne({ name: 'Second' })).castCount).toBe(1);
    expect(await Topic.countDocuments()).toBe(1);
  });
});
