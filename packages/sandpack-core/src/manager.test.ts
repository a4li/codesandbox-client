import Manager from './manager';

jest.mock('@codesandbox/common/lib/utils/global', () => ({
  getGlobal: () => global,
}));

jest.mock('@codesandbox/common/lib/utils/metrics', () => ({
  endMeasure: () => {},
  now: () => 0,
}));

const createPreset = () => ({
  ignoredExtensions: [],
  getTranspilers: () => [],
});

describe('manager global reference', () => {
  const originalWeakRef = (global as any).WeakRef;
  const originalBrowserFS = (global as any).BrowserFS;

  const cleanupGlobals = () => {
    const globalAny = global as any;
    try {
      delete globalAny.manager;
    } catch (e) {
      globalAny.manager = undefined;
    }
    try {
      delete globalAny.managerRef;
    } catch (e) {
      globalAny.managerRef = undefined;
    }
    try {
      delete globalAny.Benchmark;
    } catch (e) {
      globalAny.Benchmark = undefined;
    }
  };

  const createManager = () =>
    new Manager(
      null,
      createPreset() as any,
      {},
      {
        hasFileResolver: false,
        versionIdentifier: 'test',
      }
    );

  beforeEach(() => {
    jest.useFakeTimers();
    cleanupGlobals();
    (global as any).BrowserFS = {
      configure: (_config: any, cb: () => void) => cb(),
    };
  });

  afterEach(() => {
    cleanupGlobals();
    (global as any).WeakRef = originalWeakRef;
    (global as any).BrowserFS = originalBrowserFS;
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('sets and clears WeakRef-backed global manager', () => {
    const manager = createManager();
    const globalAny = global as any;

    expect(globalAny.manager).toBe(manager);
    expect(globalAny.managerRef).toBeDefined();
    expect(typeof globalAny.managerRef.deref).toBe('function');

    manager.dispose();

    expect(globalAny.managerRef).toBeUndefined();
    expect(globalAny.manager).not.toBe(manager);
  });

  it('falls back to strong global reference when WeakRef is unavailable', () => {
    const globalAny = global as any;
    globalAny.WeakRef = undefined;

    const manager = createManager();

    expect(globalAny.manager).toBe(manager);
    expect(globalAny.managerRef).toBeUndefined();

    manager.dispose();

    expect(globalAny.manager).not.toBe(manager);
  });
});
