import { WorkerManager } from './worker-manager';

const createManager = (options: any = {}) =>
  new WorkerManager('test', () => ({} as any), options);

describe('WorkerManager limits', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      value: 64,
      configurable: true,
    });
  });

  it('caps default worker count and sets default concurrency', () => {
    const manager = createManager();

    expect(manager.maxWorkerCount).toBe(4);
    expect(manager.maxConcurrency).toBe(6);
  });

  it('caps maxWorkerCount and maxConcurrency when provided', () => {
    const manager = createManager({ maxWorkerCount: 10, maxConcurrency: 20 });

    expect(manager.maxWorkerCount).toBe(4);
    expect(manager.maxConcurrency).toBe(8);
  });

  it('respects lower custom maxWorkerCount', () => {
    const manager = createManager({ maxWorkerCount: 2, maxConcurrency: 3 });

    expect(manager.maxWorkerCount).toBe(2);
    expect(manager.maxConcurrency).toBe(3);
  });

  it('enforces minimum limits', () => {
    const manager = createManager({ maxWorkerCount: 0, maxConcurrency: 0 });

    expect(manager.maxWorkerCount).toBe(1);
    expect(manager.maxConcurrency).toBe(1);
  });

  it('falls back when navigator is unavailable', () => {
    const originalNavigator = (global as any).navigator;
    // @ts-expect-error: simulate no navigator
    (global as any).navigator = undefined;

    try {
      const manager = createManager();
      expect(manager.maxWorkerCount).toBe(4);
    } finally {
      (global as any).navigator = originalNavigator;
    }
  });
});
