import {
  getPreloadStatus,
  resetPreloadState,
  startPreloadCommonDependencies,
} from './preload-dependencies';
import { getDependency as getPrebundledDependency } from './preloaded/fetch-dependencies';
import { resolveDependencyInfo } from './dynamic/resolve-dependency';

jest.mock('./preloaded/fetch-dependencies', () => ({
  getDependency: jest.fn(() => Promise.resolve({})),
}));

jest.mock('./dynamic/resolve-dependency', () => ({
  resolveDependencyInfo: jest.fn(() => Promise.resolve()),
}));

describe('preload common dependencies', () => {
  const getDependencyMock = getPrebundledDependency as jest.Mock;
  const resolveDependencyMock = resolveDependencyInfo as jest.Mock;

  beforeEach(() => {
    resetPreloadState();
    getDependencyMock.mockClear();
    resolveDependencyMock.mockClear();
  });

  it('dedupes concurrent preload calls', async () => {
    const deps = { react: '^17.0.2' };

    const handle1 = startPreloadCommonDependencies(undefined, deps);
    const handle2 = startPreloadCommonDependencies(undefined, deps);

    expect(handle1.promise).toBe(handle2.promise);

    await handle1.promise;

    expect(getDependencyMock).toHaveBeenCalledTimes(1);
    expect(resolveDependencyMock).not.toHaveBeenCalled();
  });

  it('cancels when last handle is released', async () => {
    const deps = {
      dep1: '1.0.0',
      dep2: '1.0.0',
      dep3: '1.0.0',
      dep4: '1.0.0',
      dep5: '1.0.0',
      dep6: '1.0.0',
    };

    const handle = startPreloadCommonDependencies(progress => {
      if (progress.loaded === 5) {
        handle.cancel();
      }
    }, deps);

    await handle.promise;

    expect(getDependencyMock).toHaveBeenCalledTimes(5);
    expect(getPreloadStatus().completed).toBe(false);
  });
});
