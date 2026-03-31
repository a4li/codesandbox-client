/* eslint-disable no-console */
// Responsible for consuming and syncing with the server/local cache
import localforage from 'localforage';
import * as memoryDriver from 'localforage-driver-memory';
import _debug from '@codesandbox/common/lib/utils/debug';
import { ParsedConfigurationFiles } from '@codesandbox/common/lib/templates/template';
import Manager from './manager';
import { SerializedTranspiledModule } from './transpiled-module';

const debug = _debug('cs:compiler:cache');

const host = process.env.CODESANDBOX_HOST;
localforage.defineDriver(memoryDriver);
localforage.setDriver([
  localforage.INDEXEDDB,
  localforage.LOCALSTORAGE,
  localforage.WEBSQL,
  memoryDriver._driver,
]);

const MAX_CACHE_SIZE = 1024 * 1024 * 20;
const MEMORY_CACHE_MAX_SIZE = 1024 * 1024 * 10;
let APICacheUsed = false;
let prewarmScheduled = false;
let memoryDriverChecked = false;
let usingMemoryDriver = false;
let memoryCacheSize = 0;
const memoryCacheEntries = new Map<
  string,
  { size: number; lastAccess: number }
>();

const ensureMemoryDriverStatus = async () => {
  if (memoryDriverChecked) {
    return usingMemoryDriver;
  }

  try {
    await localforage.ready();
    usingMemoryDriver = localforage.driver() === memoryDriver._driver;
  } catch (e) {
    usingMemoryDriver = false;
  } finally {
    memoryDriverChecked = true;
  }

  return usingMemoryDriver;
};

const removeMemoryEntry = (key: string) => {
  const existing = memoryCacheEntries.get(key);
  if (!existing) {
    return;
  }

  memoryCacheSize -= existing.size;
  memoryCacheEntries.delete(key);
};

const touchMemoryEntry = (key: string, size: number) => {
  const existing = memoryCacheEntries.get(key);
  if (existing) {
    memoryCacheSize -= existing.size;
  }

  memoryCacheEntries.set(key, { size, lastAccess: Date.now() });
  memoryCacheSize += size;
};

const ensureMemoryCapacity = async (incomingSize: number) => {
  if (incomingSize > MEMORY_CACHE_MAX_SIZE) {
    return false;
  }

  if (memoryCacheSize + incomingSize <= MEMORY_CACHE_MAX_SIZE) {
    return true;
  }

  const entries = [...memoryCacheEntries.entries()].sort(
    (a, b) => a[1].lastAccess - b[1].lastAccess
  );

  const entriesToEvict: string[] = [];
  let nextSize = memoryCacheSize;

  for (const [key, meta] of entries) {
    entriesToEvict.push(key);
    nextSize -= meta.size;

    if (nextSize + incomingSize <= MEMORY_CACHE_MAX_SIZE) {
      break;
    }
  }

  await Promise.all(
    entriesToEvict.map(key =>
      localforage.removeItem(key).catch(() => {
        // 忽略内存驱动逐出失败
      })
    )
  );

  entriesToEvict.forEach(key => {
    removeMemoryEntry(key);
  });

  return memoryCacheSize + incomingSize <= MEMORY_CACHE_MAX_SIZE;
};

const scheduleIndexedDBPrewarm = () => {
  if (prewarmScheduled) {
    return;
  }

  prewarmScheduled = true;

  const run = () => {
    localforage.keys().catch(() => {
      // 忽略预热失败
    });
  };

  if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
    (window as any).requestIdleCallback(run, { timeout: 2000 });
    return;
  }

  setTimeout(run, 2000);
};
try {
  localforage.config({
    name: 'CodeSandboxApp',
    storeName: 'sandboxes', // Should be alphanumeric, with underscores.
    description:
      'Cached transpilations of the sandboxes, for faster initialization time.',
  });

  // Prewarm store
  scheduleIndexedDBPrewarm();
} catch (e) {
  console.warn('Problems initializing IndexedDB store.');
  console.warn(e);
}

function shouldSaveOnlineCache(firstRun: boolean, changes: number) {
  if (!firstRun || changes > 0) {
    return false;
  }

  if (!(window as any).__SANDBOX_DATA__) {
    return true;
  }

  return false;
}

export function clearIndexedDBCache() {
  memoryCacheEntries.clear();
  memoryCacheSize = 0;
  return localforage.clear();
}

export async function saveCache(
  managerModuleToTranspile: any,
  manager: Manager,
  changes: number,
  firstRun: boolean
) {
  if (!manager.id) {
    return Promise.resolve(false);
  }

  const managerState = {
    ...(await manager.serialize({
      entryPath: managerModuleToTranspile
        ? managerModuleToTranspile.path
        : null,
      optimizeForSize: true,
    })),
  };

  try {
    const shouldLimitMemoryCache = await ensureMemoryDriverStatus();
    const memoryEntrySize = shouldLimitMemoryCache
      ? JSON.stringify(managerState).length
      : 0;
    let shouldSaveLocalCache = true;

    if (shouldLimitMemoryCache) {
      removeMemoryEntry(manager.id);
      const canFit = await ensureMemoryCapacity(memoryEntrySize);
      if (!canFit) {
        shouldSaveLocalCache = false;
      }
    }

    if (process.env.NODE_ENV === 'development') {
      debug(
        'Saving cache of ' +
          (JSON.stringify(managerState).length / 1024).toFixed(2) +
          'kb to indexedDB'
      );
    }

    if (shouldSaveLocalCache) {
      await localforage.setItem(manager.id, managerState);

      if (shouldLimitMemoryCache) {
        touchMemoryEntry(manager.id, memoryEntrySize);
      }
    }
  } catch (e) {
    if (process.env.NODE_ENV === 'development') {
      console.error(e);
    }
    manager.clearCache();
  }

  if (shouldSaveOnlineCache(firstRun, changes)) {
    const stringifiedManagerState = JSON.stringify(managerState);

    if (stringifiedManagerState.length > MAX_CACHE_SIZE) {
      return Promise.resolve(false);
    }

    // 🔧 私有部署环境下跳过 API 缓存保存
    if (process.env.SANDPACK || !host) {
      return Promise.resolve(false);
    }

    debug(
      'Saving cache of ' +
        (stringifiedManagerState.length / 1024).toFixed(2) +
        'kb to CodeSandbox API'
    );

    return window
      .fetch(`${host}/api/v1/sandboxes/${manager.id}/cache`, {
        method: 'POST',
        body: JSON.stringify({
          version: manager.version,
          data: stringifiedManagerState,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      })
      .then(x => x.json())
      .catch(e => {
        if (process.env.NODE_ENV === 'development') {
          console.warn('Something went wrong while saving cache.');
          console.warn(e);
        }
      });
  }

  return Promise.resolve(false);
}

export function deleteAPICache(
  sandboxId: string,
  version: string
): Promise<any> {
  if (APICacheUsed && !process.env.SANDPACK) {
    debug('Deleting cache of API');
    return window
      .fetch(`${host}/api/v1/sandboxes/${sandboxId}/cache`, {
        method: 'DELETE',
        body: JSON.stringify({
          version,
        }),
        headers: {
          'Content-Type': 'application/json',
        },
      })
      .then(x => x.json())
      .catch(e => {
        console.error('Something went wrong while deleting cache.');
        console.error(e);
      });
  }

  return Promise.resolve(false);
}

export type ManagerCache = {
  transpiledModules: { [id: string]: SerializedTranspiledModule };
  cachedPaths: { [path: string]: { [path: string]: string } };
  version: string;
  timestamp: number;
  configurations: ParsedConfigurationFiles;
  entry: string | undefined;
  meta: { [dir: string]: string[] };
  dependenciesQuery: string;
};

function findCacheToUse(
  cache1: ManagerCache | undefined,
  cache2: ManagerCache | undefined
) {
  if (!cache1 && !cache2) {
    return null;
  }

  if (cache1 && !cache2) {
    return cache1!;
  }

  if (cache2 && !cache1) {
    return cache2!;
  }

  return cache2!.timestamp > cache1!.timestamp ? cache2! : cache1!;
}

export function ignoreNextCache() {
  try {
    localStorage.setItem('ignoreCache', 'true');
  } catch (e) {
    console.warn(e);
  }
}

// 通过 localforage 从浏览器数据存储中（indexDB/localStorage 等）读取上次构建应用的编译结果，
// 从而减少二次构建时间
export async function consumeCache(manager: Manager) {
  console.log('[consumeCache] manager.id:', manager.id);

  if (!manager.id) {
    console.log('[consumeCache] ❌ No manager.id, returning false');
    return false;
  }

  try {
    const shouldIgnoreCache =
      localStorage.getItem('ignoreCache') ||
      localStorage.getItem('ignoreCacheDev');
    if (shouldIgnoreCache) {
      localStorage.removeItem('ignoreCache');
      console.log('[consumeCache] ❌ ignoreCache flag set, returning false');
      return false;
    }

    const cacheData = (window as any).__SANDBOX_DATA__;
    const localData: ManagerCache | undefined = await localforage.getItem(
      manager.id || ''
    );

    if (localData && (await ensureMemoryDriverStatus())) {
      const existing = memoryCacheEntries.get(manager.id);
      const size = existing ? existing.size : JSON.stringify(localData).length;
      touchMemoryEntry(manager.id, size);
    }

    console.log('[consumeCache] cacheData from __SANDBOX_DATA__:', !!cacheData);
    console.log('[consumeCache] localData from IndexedDB:', !!localData);
    if (localData) {
      console.log(
        '[consumeCache] localData.version:',
        localData.version,
        'manager.version:',
        manager.version
      );
    }

    const cache = findCacheToUse(cacheData && cacheData.data, localData);
    if (cache) {
      if (cache.version === manager.version) {
        if (cache === localData) {
          APICacheUsed = false;
        } else {
          APICacheUsed = true;
        }

        debug(
          `Loading cache from ${cache === localData ? 'IndexedDB' : 'API'}`,
          cache
        );
        console.log(
          '[consumeCache] ✅ Cache version matched, loading from',
          cache === localData ? 'IndexedDB' : 'API'
        );

        await manager.load(cache);

        return true;
      }
      console.log(
        '[consumeCache] ❌ Version mismatch: cache.version=',
        cache.version,
        'manager.version=',
        manager.version
      );
    } else {
      console.log('[consumeCache] ❌ No cache found');
    }

    return false;
  } catch (e) {
    console.warn('Problems consuming cache');
    console.warn(e);

    return false;
  }
}
