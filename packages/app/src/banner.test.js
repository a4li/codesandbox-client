const createObserverMock = () => {
  const observe = jest.fn();
  const disconnect = jest.fn();

  class MockMutationObserver {
    constructor() {
      this.observe = observe;
      this.disconnect = disconnect;
      MockMutationObserver.instances.push(this);
    }
  }

  MockMutationObserver.instances = [];

  return { MockMutationObserver, observe, disconnect };
};

describe('banner self-heal', () => {
  const flushPromises = () => new Promise(resolve => setImmediate(resolve));

  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
    if (!global.localStorage) {
      const storage = {};
      global.localStorage = {
        getItem: jest.fn(key => storage[key] ?? null),
        setItem: jest.fn((key, value) => {
          storage[key] = String(value);
        }),
        removeItem: jest.fn(key => {
          delete storage[key];
          delete global.localStorage[key];
        }),
      };
    }
    global.localStorage.removeItem('HIDE_PHISHING_BANNER');
    delete global.localStorage.HIDE_PHISHING_BANNER;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
    delete global.fetch;
    delete global.MutationObserver;
    delete global.localStorage;
  });

  it('uses a single MutationObserver without interval', async () => {
    const { MockMutationObserver, observe } = createObserverMock();
    global.MutationObserver = MockMutationObserver;

    global.fetch = jest.fn(() =>
      Promise.resolve({
        json: () => Promise.resolve({ flagged: true, deleted: false }),
      })
    );

    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    // eslint-disable-next-line global-require
    require('./banner');

    await flushPromises();
    jest.runOnlyPendingTimers();
    await flushPromises();

    expect(document.getElementById('sb__phishing-banner')).toBeTruthy();
    expect(MockMutationObserver.instances.length).toBe(1);
    expect(observe).toHaveBeenCalledWith(document.body, { childList: true });
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('falls back to interval when MutationObserver is unavailable', async () => {
    global.MutationObserver = undefined;
    global.fetch = jest.fn(() =>
      Promise.resolve({
        json: () => Promise.resolve({ flagged: true, deleted: false }),
      })
    );

    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    // eslint-disable-next-line global-require
    require('./banner');

    await flushPromises();
    jest.runOnlyPendingTimers();
    await flushPromises();

    expect(document.getElementById('sb__phishing-banner')).toBeTruthy();
    expect(setIntervalSpy).toHaveBeenCalled();
  });
});
