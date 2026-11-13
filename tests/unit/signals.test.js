jest.mock('axios');

const axios = require('axios');
const {
  pubmedTerm,
  pubmedCount,
  resolveMesh,
  pubmedSignal,
  arxivQuery,
  arxivCount,
  arxivSignal,
  resolveWikidataId,
  wikipediaSignal,
  smoothedRatio,
} = require('../../services/signals');

const WINDOWS = {
  w0: { from: '2025-10-02', to: '2026-10-01' },
  w1: { from: '2024-10-02', to: '2025-10-01' },
};
const topic = {
  name: 'Tuberculosis Research',
  keywords: [{ name: 'tuberculosis' }, { name: 'drug-resistant "TB"' }, { name: 'BCG vaccine' }],
  ids: {},
};

beforeEach(() => axios.get.mockReset());

describe('smoothedRatio', () => {
  test('a few events more or less do not swing the ratio', () => {
    expect(smoothedRatio(3, 1, 5)).toBeCloseTo(8 / 6);
    expect(smoothedRatio(300, 100, 5)).toBeCloseTo(305 / 105);
    expect(smoothedRatio(0, 0, 5)).toBe(1);
  });
});

describe('PubMed', () => {
  test('the query uses the MeSH descriptor when known, else the main keywords', () => {
    expect(pubmedTerm({ ...topic, ids: { meshLabel: 'Tuberculosis' } })).toBe(
      '"Tuberculosis"[MeSH Terms]'
    );
    expect(pubmedTerm(topic)).toBe(
      '("tuberculosis"[Title/Abstract] OR "drug-resistant TB"[Title/Abstract] OR "BCG vaccine"[Title/Abstract])'
    );
    expect(pubmedTerm({ keywords: [], ids: {} })).toBeNull();
  });

  test('counts the records of a window by entry date', async () => {
    axios.get.mockResolvedValue({ data: { esearchresult: { count: '3736' } } });
    expect(await pubmedCount('"Tuberculosis"[MeSH Terms]', WINDOWS.w0)).toBe(3736);
    const [url, options] = axios.get.mock.calls[0];
    expect(url).toContain('esearch.fcgi');
    expect(options.params).toMatchObject({
      db: 'pubmed',
      datetype: 'edat',
      mindate: '2025/10/02',
      maxdate: '2026/10/01',
      rettype: 'count',
      tool: 'brightminds',
    });
  });

  test('a response without a count is an error', async () => {
    axios.get.mockResolvedValue({ data: { esearchresult: {} } });
    await expect(pubmedCount('x', WINDOWS.w0)).rejects.toThrow('no count');
  });

  test('finds the MeSH descriptor with exactly this label', async () => {
    axios.get.mockResolvedValueOnce({
      data: [{ resource: 'http://id.nlm.nih.gov/mesh/D014376', label: 'Tuberculosis' }],
    });
    expect(await resolveMesh('Tuberculosis')).toEqual({ id: 'D014376', label: 'Tuberculosis' });
    expect(axios.get.mock.calls[0][1].params).toMatchObject({
      label: 'Tuberculosis',
      match: 'exact',
    });
    axios.get.mockResolvedValueOnce({ data: [] });
    expect(await resolveMesh('Nothing')).toBeNull();
  });

  test('the signal compares the latest window with the one before', async () => {
    axios.get
      .mockResolvedValueOnce({ data: { esearchresult: { count: '120' } } })
      .mockResolvedValueOnce({ data: { esearchresult: { count: '80' } } });
    const signal = await pubmedSignal(topic, WINDOWS);
    expect(signal).toMatchObject({ current: 120, previous: 80 });
    expect(signal.ratio).toBeCloseTo(125 / 85);
    expect(await pubmedSignal({ keywords: [], ids: {} }, WINDOWS)).toBeNull();
  });
});

describe('arXiv', () => {
  const feed = (total) =>
    `<feed><opensearch:totalResults xmlns:opensearch="x">${total}</opensearch:totalResults></feed>`;

  test('the query joins the archives and the main keywords', () => {
    expect(arxivQuery(topic, ['cs.*', 'stat.ML'])).toBe(
      '(cat:cs.* OR cat:stat.ML) AND (abs:"tuberculosis" OR abs:"drug-resistant TB" OR abs:"BCG vaccine")'
    );
    expect(arxivQuery({ keywords: [] }, ['cs.*'])).toBeNull();
    expect(arxivQuery(topic, undefined)).toBeNull();
  });

  test('reads the total of the answer', async () => {
    axios.get.mockResolvedValue({ data: feed(3682) });
    expect(await arxivCount('cat:cs.LG', WINDOWS.w0)).toBe(3682);
    const [, options] = axios.get.mock.calls[0];
    expect(options.params.search_query).toBe(
      'cat:cs.LG AND submittedDate:[202510020000 TO 202610012359]'
    );
    expect(options.headers['User-Agent']).toContain('BrightMinds');
  });

  test('tries again after a server error, then gives up', async () => {
    axios.get.mockRejectedValueOnce(new Error('500')).mockResolvedValueOnce({ data: feed(7) });
    expect(await arxivCount('q', WINDOWS.w0)).toBe(7);
    axios.get.mockReset();
    axios.get.mockRejectedValue(new Error('500'));
    await expect(arxivCount('q', WINDOWS.w0)).rejects.toThrow('500');
    expect(axios.get).toHaveBeenCalledTimes(3);
  });

  test('the signal for a lab without arXiv archives is null', async () => {
    expect(await arxivSignal(topic, WINDOWS, 27)).toBeNull();
    axios.get.mockResolvedValueOnce({ data: feed(30) }).mockResolvedValueOnce({ data: feed(10) });
    const signal = await arxivSignal(topic, WINDOWS, 17);
    expect(signal).toMatchObject({ current: 30, previous: 10 });
  });
});

describe('Wikipedia', () => {
  const months = (values) => ({ data: { items: values.map((views) => ({ views })) } });

  test('page views of the last 3 months against the 12 before', async () => {
    const views = [...Array(12).fill(1000), 2000, 2000, 2000];
    axios.get.mockResolvedValue(months(views));
    const signal = await wikipediaSignal('Tuberculosis', new Date('2026-11-12T00:00:00Z'));
    expect(signal).toMatchObject({ current: 2000, previous: 1000 });
    expect(signal.ratio).toBeCloseTo(2050 / 1050);
    const [url, options] = axios.get.mock.calls[0];
    expect(url).toContain('/all-access/user/Tuberculosis/monthly/20250801/20261001');
    expect(options.headers['User-Agent']).toContain('BrightMinds');
  });

  test('spaces become underscores, and a page without history or a 404 gives no signal', async () => {
    axios.get.mockResolvedValue(months(Array(15).fill(10)));
    await wikipediaSignal('Stem cell', new Date('2026-11-12T00:00:00Z'));
    expect(axios.get.mock.calls[0][0]).toContain('/Stem_cell/');

    axios.get.mockResolvedValue(months([5, 5, 5]));
    expect(await wikipediaSignal('Young page')).toBeNull();
    axios.get.mockRejectedValue(Object.assign(new Error('no'), { response: { status: 404 } }));
    expect(await wikipediaSignal('Missing')).toBeNull();
    axios.get.mockRejectedValue(Object.assign(new Error('boom'), { response: { status: 500 } }));
    await expect(wikipediaSignal('Any')).rejects.toThrow('boom');
    expect(await wikipediaSignal(null)).toBeNull();
  });

  test('finds the Wikidata item of a page, following redirects', async () => {
    axios.get.mockResolvedValue({
      data: { query: { pages: { 30653: { pageprops: { wikibase_item: 'Q12204' } } } } },
    });
    expect(await resolveWikidataId('Tuberculosis')).toBe('Q12204');
    expect(axios.get.mock.calls[0][1].params).toMatchObject({ prop: 'pageprops', redirects: 1 });
    axios.get.mockResolvedValue({ data: { query: { pages: { '-1': { missing: '' } } } } });
    expect(await resolveWikidataId('Nothing')).toBeNull();
  });
});
