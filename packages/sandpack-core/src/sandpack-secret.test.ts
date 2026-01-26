const setupDocument = (options?: { cookie?: string; writable?: boolean }) => {
  const cookieValue = options && options.cookie ? options.cookie : '';
  const writable = !(options && options.writable === false);
  const globalAny = global as any;
  let cookieStore = cookieValue;

  globalAny.document = {
    location: { host: 'example.com' },
  };

  Object.defineProperty(globalAny.document, 'cookie', {
    get: () => cookieStore,
    set: (value: string) => {
      if (writable) {
        cookieStore = value;
      }
    },
    configurable: true,
  });

  const locationMock = { reload: jest.fn() };

  Object.defineProperty(globalAny, 'location', {
    value: locationMock,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalAny, 'window', {
    value: {
      location: locationMock,
      open: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      setInterval: global.setInterval,
      clearInterval: global.clearInterval,
      setTimeout: global.setTimeout,
      clearTimeout: global.clearTimeout,
    },
    writable: true,
    configurable: true,
  });

  return { getCookie: () => cookieStore, globalAny };
};

describe('setSandpackSecret', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.resetModules();
  });

  it('does not reload when cookie already matches', () => {
    const { globalAny } = setupDocument({ cookie: 'csb_sandpack_secret=abc' });
    // eslint-disable-next-line global-require
    const { setSandpackSecret } = require('./sandpack-secret');

    setSandpackSecret('abc');
    jest.runAllTimers();

    expect(globalAny.location.reload).not.toHaveBeenCalled();
  });

  it('reloads after setting a new secret', () => {
    const { getCookie, globalAny } = setupDocument();
    // eslint-disable-next-line global-require
    const { setSandpackSecret } = require('./sandpack-secret');

    setSandpackSecret('new-secret');

    expect(getCookie()).toContain('csb_sandpack_secret=new-secret');

    jest.advanceTimersByTime(1000);

    expect(globalAny.location.reload).toHaveBeenCalledTimes(1);
  });

  it('is idempotent when cookie write is blocked', () => {
    const { globalAny } = setupDocument({ writable: false });
    // eslint-disable-next-line global-require
    const { setSandpackSecret } = require('./sandpack-secret');

    setSandpackSecret('blocked-secret');
    jest.advanceTimersByTime(1000);

    setSandpackSecret('blocked-secret');
    jest.advanceTimersByTime(1000);

    expect(globalAny.location.reload).toHaveBeenCalledTimes(1);
  });
});

describe('requestSandpackSecretFromApp', () => {
  const setupPopup = () => ({
    closed: false,
    postMessage: jest.fn(),
    close: jest.fn(),
  });

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.resetModules();
  });

  it('resolves empty string when popup closes', async () => {
    const { globalAny } = setupDocument();
    const popup = setupPopup();
    globalAny.window.open.mockReturnValue(popup);

    // eslint-disable-next-line global-require
    const { requestSandpackSecretFromApp } = require('./sandpack-secret');
    const promise = requestSandpackSecretFromApp('team-id');

    jest.advanceTimersByTime(500);
    popup.closed = true;
    jest.advanceTimersByTime(500);

    await expect(promise).resolves.toBe('');
    expect(globalAny.location.reload).not.toHaveBeenCalled();
  });

  it('times out and closes popup', async () => {
    const { globalAny } = setupDocument();
    const popup = setupPopup();
    globalAny.window.open.mockReturnValue(popup);

    // eslint-disable-next-line global-require
    const { requestSandpackSecretFromApp } = require('./sandpack-secret');
    const promise = requestSandpackSecretFromApp('team-id');

    jest.advanceTimersByTime(60000);

    await expect(promise).resolves.toBe('');
    expect(popup.close).toHaveBeenCalledTimes(1);
  });
});
