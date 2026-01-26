import { __private__ } from './fetch-dependencies';

const mockDelay = jest.fn<Promise<void>, [number?]>(() => Promise.resolve());

jest.mock('../../utils/delay', () => ({
  __esModule: true,
  default: (ms?: number) => mockDelay(ms),
}));

jest.mock('@codesandbox/common/lib/utils/debug', () => () => () => undefined);

describe('fetch-dependencies retry strategy', () => {
  const originalFetch = (global as any).fetch;

  beforeEach(() => {
    mockDelay.mockClear();
    (global as any).fetch = jest.fn(() => Promise.reject(new Error('network')));
  });

  afterEach(() => {
    (global as any).fetch = originalFetch;
  });

  it('retries up to the configured limit', async () => {
    const { requestPackager, RETRY_COUNT } = __private__;

    await expect(
      requestPackager('https://example.invalid/packages', 'GET', 0, Date.now())
    ).rejects.toBeTruthy();

    // initial attempt + RETRY_COUNT retries
    expect((global as any).fetch).toHaveBeenCalledTimes(RETRY_COUNT + 1);
  });

  it('fails fast when retry window is exceeded', async () => {
    const { requestPackager, MAX_RETRY_TOTAL_MS } = __private__;

    await expect(
      requestPackager(
        'https://example.invalid/packages',
        'GET',
        0,
        Date.now() - (MAX_RETRY_TOTAL_MS + 1)
      )
    ).rejects.toThrow(/retry window exceeded/i);
  });
});
