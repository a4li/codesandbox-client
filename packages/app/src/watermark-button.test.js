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

describe('watermark self-heal', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.resetModules();
    jest.restoreAllMocks();
    delete global.MutationObserver;
  });

  it('uses a single MutationObserver without interval', () => {
    const { MockMutationObserver, observe } = createObserverMock();
    global.MutationObserver = MockMutationObserver;

    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    // eslint-disable-next-line global-require
    require('./watermark-button');

    jest.advanceTimersByTime(250);

    expect(document.getElementById('sb__open-sandbox-watermark')).toBeTruthy();
    expect(MockMutationObserver.instances.length).toBe(1);
    expect(observe).toHaveBeenCalledWith(document.body, { childList: true });
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });

  it('falls back to interval when MutationObserver is unavailable', () => {
    global.MutationObserver = undefined;

    const setIntervalSpy = jest.spyOn(global, 'setInterval');

    // eslint-disable-next-line global-require
    require('./watermark-button');

    jest.advanceTimersByTime(250);

    expect(document.getElementById('sb__open-sandbox-watermark')).toBeTruthy();
    expect(setIntervalSpy).toHaveBeenCalled();
  });
});
