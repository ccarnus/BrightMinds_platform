// Choosing a cast's topic from the catalog stored in the database, with a fake OpenAI client.
jest.mock('axios');
jest.mock('openai', () => {
  const actual = jest.requireActual('openai');
  const client = { chat: { completions: { create: jest.fn() } } };
  const OpenAI = jest.fn(() => client);
  Object.assign(OpenAI, {
    client,
    APIError: actual.APIError,
    APIConnectionError: actual.APIConnectionError,
  });
  return OpenAI;
});

const axios = require('axios');
const OpenAI = require('openai');
const config = require('../../config');
const { resumeOpenAI } = require('../../services/openai');
const { chooseTopic, topicsCache } = require('../../services/generate_topic');
const { useTestDatabase } = require('../helpers/db');
const { createCatalogTopic } = require('../helpers/fixtures');

useTestDatabase();

const { client } = OpenAI;
const CONTENT = {
  title: 'Zinc and bacteria',
  description: 'How zinc stops infections.',
  department: 'Chemistry',
};
const chatReply = (object) => ({
  choices: [{ message: { content: JSON.stringify(object) }, finish_reason: 'stop' }],
});
const schemaOf = (call) => call[0].response_format.json_schema;

beforeEach(() => {
  config.isTest = false;
  config.openai.apiKey = 'sk-test';
  resumeOpenAI();
  topicsCache.clear();
  client.chat.completions.create.mockReset();
  axios.get.mockReset();
});

afterEach(() => {
  config.isTest = true;
  config.openai.apiKey = undefined;
});

describe('chooseTopic with the catalog', () => {
  const seed = async () => {
    await createCatalogTopic({
      name: 'Metal Ions in Biology',
      openalexID: 'T11',
      subfield: { id: 1606, name: 'Inorganic Chemistry' },
      keywords: [{ name: 'zinc' }, { name: 'copper' }],
    });
    await createCatalogTopic({
      name: 'Organometallic Chemistry',
      openalexID: 'T12',
      subfield: { id: 1606, name: 'Inorganic Chemistry' },
    });
    await createCatalogTopic({
      name: 'Polymer Synthesis',
      openalexID: 'T20',
      subfield: { id: 1605, name: 'Organic Chemistry' },
    });
    await createCatalogTopic({
      name: 'Retired topic',
      openalexID: 'T99',
      subfield: { id: 1606, name: 'Inorganic Chemistry' },
      retired: true,
    });
  };

  test('asks for the area, then for the topic of that area, with enumerated ids', async () => {
    await seed();
    client.chat.completions.create
      .mockResolvedValueOnce(chatReply({ topic_id: '1606' }))
      .mockResolvedValueOnce(chatReply({ topic_id: 'T11' }));

    const topic = await chooseTopic(CONTENT);

    expect(topic).toEqual({ name: 'Metal Ions in Biology', openalexID: 'T11' });
    expect(axios.get).not.toHaveBeenCalled();
    const [areaCall, topicCall] = client.chat.completions.create.mock.calls;
    expect(schemaOf(areaCall).name).toBe('area_choice');
    expect(schemaOf(areaCall).schema.properties.topic_id.enum.sort()).toEqual(['1605', '1606']);
    expect(areaCall[0].messages[1].content).toContain('1606: Inorganic Chemistry');
    expect(schemaOf(topicCall).name).toBe('topic_choice');
    expect(schemaOf(topicCall).schema.properties.topic_id.enum.sort()).toEqual(['T11', 'T12']);
    expect(topicCall[0].messages[1].content).toContain('T11: Metal Ions in Biology (zinc, copper)');
    expect(topicCall[0].messages[1].content).not.toContain('T99');
    expect(topicCall[0].messages[2].content).toContain('Zinc and bacteria');
  });

  test('a single area, or a single topic in it, needs no question', async () => {
    await createCatalogTopic({
      name: 'Only',
      openalexID: 'T1',
      subfield: { id: 5, name: 'Alone' },
    });
    expect(await chooseTopic(CONTENT)).toEqual({ name: 'Only', openalexID: 'T1' });
    expect(client.chat.completions.create).not.toHaveBeenCalled();

    await createCatalogTopic({
      name: 'Other area',
      openalexID: 'T2',
      subfield: { id: 6, name: 'Elsewhere' },
    });
    client.chat.completions.create.mockResolvedValueOnce(chatReply({ topic_id: '6' }));
    expect(await chooseTopic(CONTENT)).toEqual({ name: 'Other area', openalexID: 'T2' });
    expect(client.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test('an id that is not in the list is a content error, not a retry', async () => {
    await seed();
    client.chat.completions.create.mockResolvedValueOnce(chatReply({ topic_id: '4242' }));
    await expect(chooseTopic(CONTENT)).rejects.toMatchObject({ kind: 'content' });
  });

  test('the answer is matched without regard to case or spaces', async () => {
    await seed();
    client.chat.completions.create
      .mockResolvedValueOnce(chatReply({ topic_id: ' 1606 ' }))
      .mockResolvedValueOnce(chatReply({ topic_id: 't12' }));
    expect(await chooseTopic(CONTENT)).toEqual({
      name: 'Organometallic Chemistry',
      openalexID: 'T12',
    });
  });

  test('a lab without catalog is classified from the live OpenAlex list', async () => {
    axios.get.mockResolvedValue({
      data: { results: [{ id: 'https://openalex.org/T10', display_name: 'Organic Chemistry' }] },
    });
    client.chat.completions.create.mockResolvedValueOnce(chatReply({ topic_id: 'T10' }));
    expect(await chooseTopic(CONTENT)).toEqual({ name: 'Organic Chemistry', openalexID: 'T10' });
    expect(axios.get).toHaveBeenCalled();
  });

  test('a department with no OpenAlex field is refused', async () => {
    await expect(chooseTopic({ ...CONTENT, department: 'Alchemy' })).rejects.toMatchObject({
      kind: 'content',
    });
  });

  test('in test mode a mock topic is returned without any call', async () => {
    config.isTest = true;
    expect(await chooseTopic(CONTENT)).toEqual({ name: 'Mock Topic', openalexID: 'T0' });
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });
});
