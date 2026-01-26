const keys = jest.fn(() => Promise.resolve());
const config = jest.fn();
const setDriver = jest.fn();
const defineDriver = jest.fn();

jest.mock('localforage', () => ({
  __esModule: true,
  default: {
    keys,
    config,
    setDriver,
    defineDriver,
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
