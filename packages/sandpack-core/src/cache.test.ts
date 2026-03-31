const keys = jest.fn(() => Promise.resolve());
const config = jest.fn();
const setDriver = jest.fn();
const defineDriver = jest.fn();
const ready = jest.fn(() => Promise.resolve());
const driver = jest.fn(() => 'memory');
const setItem = jest.fn(() => Promise.resolve());
const getItem = jest.fn(() => Promise.resolve(undefined));
const removeItem = jest.fn(() => Promise.resolve());
const clear = jest.fn(() => Promise.resolve());

jest.mock('localforage', () => ({
  __esModule: true,
  default: {
    keys,
    config,
    setDriver,
    defineDriver,
    ready,
    driver,
    setItem,
    getItem,
    removeItem,
    clear,
  },
}));

jest.mock('localforage-driver-memory', () => ({
  __esModule: true,
  _driver: 'memory',
}));

jest.mock('@codesandbox/common/lib/utils/debug', () => ({
  __esModule: true,
  default: () => () => {},
}));

describe('indexeddb prewarm', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    keys.mockClear();
    config.mockClear();
    setDriver.mockClear();
    defineDriver.mockClear();
    ready.mockClear();
    driver.mockClear();
    setItem.mockClear();
    getItem.mockClear();
    removeItem.mockClear();
    clear.mockClear();
    jest.resetModules();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('defers keys() to avoid startup blocking', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      require('./cache');
    });

    expect(keys).not.toHaveBeenCalled();

    jest.runOnlyPendingTimers();

    expect(keys).toHaveBeenCalledTimes(1);
  });

  it('schedules prewarm once per module load', () => {
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      require('./cache');
      // eslint-disable-next-line global-require
      require('./cache');
    });

    jest.runOnlyPendingTimers();

    expect(keys).toHaveBeenCalledTimes(1);
  });
});

describe('memory cache limits', () => {
  beforeEach(() => {
    keys.mockClear();
    config.mockClear();
    setDriver.mockClear();
    defineDriver.mockClear();
    ready.mockClear();
    driver.mockClear();
    setItem.mockClear();
    getItem.mockClear();
    removeItem.mockClear();
    clear.mockClear();
    jest.resetModules();
  });

  it('skips local cache when entry exceeds memory limit', async () => {
    const bigPayload = 'x'.repeat(1024 * 1024 * 10 + 1);
    const manager = {
      id: 'sandbox-id',
      serialize: jest.fn(() =>
        Promise.resolve({
          bigPayload,
        })
      ),
      clearCache: jest.fn(),
    } as any;

    const { saveCache } = await import('./cache');

    await saveCache({ path: '/index.ts' }, manager, 0, false);

    expect(setItem).not.toHaveBeenCalled();
  });

  it('evicts least-recent entries when over capacity', async () => {
    const { saveCache, consumeCache } = await import('./cache');

    (getItem as jest.Mock).mockImplementation((key: string) => {
      if (key === 'sandbox-a') {
        return Promise.resolve({ payload: 'a'.repeat(2048) });
      }
      return Promise.resolve(undefined);
    });

    await consumeCache({
      id: 'sandbox-a',
      version: '1',
      load: jest.fn(),
    } as any);

    const manager = {
      id: 'sandbox-b',
      serialize: jest.fn(() =>
        Promise.resolve({ payload: 'y'.repeat(1024 * 1024 * 10 - 1024) })
      ),
      clearCache: jest.fn(),
    } as any;

    await saveCache({ path: '/index.ts' }, manager, 0, false);

    expect(removeItem).toHaveBeenCalledWith('sandbox-a');
  });
});
