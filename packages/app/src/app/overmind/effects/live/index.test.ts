import live from './index';

const mockSocketFactory = jest
  .fn()
  .mockImplementation((url: string, options: any) => {
    let errorHandler: (() => void | Promise<void>) | null = null;
    const socket = {
      url,
      options,
      connect: jest.fn(),
      disconnect: jest.fn(),
      onError: jest.fn((handler: () => void | Promise<void>) => {
        errorHandler = handler;
      }),
      __triggerError: async () => {
        if (errorHandler) {
          await errorHandler();
        }
      },
    };
    (global as any).__lastLiveSocket = socket;
    return socket;
  });

jest.mock('phoenix', () => {
  // Use a constructable function for `new Socket(...)`
  const mockSocketCtor = function Socket(url: string, options: any) {
    return mockSocketFactory(url, options);
  };

  return {
    Socket: mockSocketCtor,
    Channel: class {},
    Presence: class {
      onSync() {
        return undefined;
      }

      list() {
        return [];
      }
    },
  };
});

describe('Live pendingMessages cleanup', () => {
  const liveAny = live as any;

  beforeEach(() => {
    jest.useFakeTimers();
    liveAny.pendingMessages.clear();
    liveAny.pendingMessageTimeouts.clear();
    liveAny.channel = null;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    liveAny.pendingMessages.clear();
    liveAny.pendingMessageTimeouts.clear();
    liveAny.channel = null;
  });

  it('cleans up pending messages after timeout', async () => {
    await liveAny.send('test-event', {}, 10);

    expect(liveAny.pendingMessages.size).toBe(1);
    expect(liveAny.pendingMessageTimeouts.size).toBe(1);

    jest.advanceTimersByTime(1011);

    expect(liveAny.pendingMessages.size).toBe(0);
    expect(liveAny.pendingMessageTimeouts.size).toBe(0);
  });

  it('cleans up pending messages on ok response', async () => {
    const pushResponse = {
      receive: jest.fn(),
    } as any;

    pushResponse.receive.mockImplementation((status: string, cb: any) => {
      if (status === 'ok') {
        cb({ ok: true });
      }
      return pushResponse;
    });

    liveAny.channel = {
      push: jest.fn(() => pushResponse),
    };

    await liveAny.send('test-event', {}, 10);

    expect(liveAny.pendingMessages.size).toBe(0);
    expect(liveAny.pendingMessageTimeouts.size).toBe(0);
  });

  it('cleans up pending messages on disconnect', async () => {
    const leaveResponse = {
      receive: jest.fn(),
    } as any;

    leaveResponse.receive.mockImplementation((status: string, cb: any) => {
      if (status === 'ok') {
        cb({});
      }
      return leaveResponse;
    });

    liveAny.channel = {
      leave: jest.fn(() => leaveResponse),
      onMessage: jest.fn(),
    };

    liveAny.pendingMessages.set('msg-1', {});
    const timeoutId = (setTimeout(() => {}, 10000) as unknown) as number;
    liveAny.pendingMessageTimeouts.set('msg-1', timeoutId);

    await liveAny.disconnect();

    expect(liveAny.pendingMessages.size).toBe(0);
    expect(liveAny.pendingMessageTimeouts.size).toBe(0);
  });
});

describe('Live reconnect and JWT refresh', () => {
  const liveAny = live as any;
  const provideJwtToken = jest.fn(() => Promise.resolve('jwt-token'));
  const getLastSocket = () => (global as any).__lastLiveSocket as any;

  beforeEach(() => {
    jest.useFakeTimers();
    provideJwtToken.mockClear();
    mockSocketFactory.mockClear();
    (global as any).__lastLiveSocket = null;
    liveAny.socket = null;
    liveAny.connectionPromise = null;
    liveAny.jwtPromise = undefined;
    liveAny.initialize({
      provideJwtToken,
      onApplyOperation: () => {},
      onOperationError: () => {},
    });
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('uses increasing reconnect backoff delays', async () => {
    await liveAny.getSocket();

    const lastSocket = getLastSocket();
    expect(lastSocket).toBeTruthy();
    const reconnectAfterMs = lastSocket.options.reconnectAfterMs;

    const t1 = reconnectAfterMs(1);
    const t2 = reconnectAfterMs(2);
    const t3 = reconnectAfterMs(3);

    expect(t1).toBeGreaterThanOrEqual(1000);
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
  });

  it('throttles JWT refresh on rapid socket errors', async () => {
    let now = 0;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    await liveAny.getSocket();
    const lastSocket = getLastSocket();
    expect(lastSocket).toBeTruthy();

    now = 20000;
    liveAny.jwtPromise = undefined;
    await lastSocket.__triggerError();

    liveAny.jwtPromise = undefined;
    await lastSocket.__triggerError();

    now = 40000;
    liveAny.jwtPromise = undefined;
    await lastSocket.__triggerError();

    // 1 from initial connect + 1 from first error + 1 after cooldown
    expect(provideJwtToken).toHaveBeenCalledTimes(3);

    nowSpy.mockRestore();
  });
});
