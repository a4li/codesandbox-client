/**
 * Babel 编译缓存 IndexedDB 持久化
 * 
 * 优势:
 * - 大容量存储 (几百MB+)
 * - 异步 API,不阻塞主线程
 * - 结构化存储,按 key 高效查询
 * - 浏览器自动管理
 */

const DB_NAME = 'babel-compilation-cache';
const DB_VERSION = 1;
const STORE_NAME = 'cache-entries';

interface CacheEntry {
  key: string;
  code: string;
  dependencies: any[];
  timestamp: number;
}

class IndexedDBCache {
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;
  private isInitializing = false;

  constructor() {
    this.initPromise = this.init();
  }

  /**
   * 检查数据库连接是否有效
   */
  private isDbValid(): boolean {
    if (!this.db) return false;
    
    // 检查数据库连接是否仍然有效
    try {
      // 尝试访问 objectStoreNames 来验证连接
      const _ = this.db.objectStoreNames;
      return true;
    } catch (e) {
      // 连接已失效（例如数据库被删除）
      console.warn('[IndexedDB Cache] Database connection invalid:', e);
      this.db = null;
      return false;
    }
  }

  /**
   * 确保数据库连接有效，如果无效则重新初始化
   */
  private async ensureDb(): Promise<IDBDatabase | null> {
    // 如果正在初始化，等待完成
    if (this.isInitializing && this.initPromise) {
      await this.initPromise;
    }
    
    // 检查当前连接是否有效
    if (this.isDbValid()) {
      return this.db;
    }
    
    // 重新初始化
    console.log('[IndexedDB Cache] Re-initializing database connection...');
    this.initPromise = this.init();
    await this.initPromise;
    
    return this.db;
  }

  /**
   * 初始化 IndexedDB
   */
  private async init(): Promise<void> {
    if (this.isInitializing) {
      return;
    }
    
    this.isInitializing = true;
    
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        console.warn('[IndexedDB Cache] IndexedDB not available');
        this.isInitializing = false;
        resolve();
        return;
      }

      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.warn('[IndexedDB Cache] Failed to open database:', request.error);
        this.isInitializing = false;
        resolve(); // 不阻塞,即使失败也继续
      };

      request.onsuccess = () => {
        this.db = request.result;
        
        // 监听数据库关闭事件（当数据库被删除时会触发）
        this.db.onclose = () => {
          console.log('[IndexedDB Cache] Database closed, will re-open on next access');
          this.db = null;
        };
        
        // 监听版本变更事件
        this.db.onversionchange = () => {
          console.log('[IndexedDB Cache] Database version changed, closing connection');
          if (this.db) {
            this.db.close();
            this.db = null;
          }
        };
        
        console.log('[IndexedDB Cache] ✅ Database opened');
        this.isInitializing = false;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        
        // 创建对象存储
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const objectStore = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          objectStore.createIndex('timestamp', 'timestamp', { unique: false });
          console.log('[IndexedDB Cache] Created object store');
        }
      };
    });
  }

  /**
   * 保存单个缓存条目
   */
  async set(key: string, code: string, dependencies: any[]): Promise<void> {
    const db = await this.ensureDb();
    if (!db) return;

    return new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        
        const entry: CacheEntry = {
          key,
          code,
          dependencies,
          timestamp: Date.now(),
        };

        const request = objectStore.put(entry);

        request.onsuccess = () => resolve();
        request.onerror = () => {
          console.warn('[IndexedDB Cache] Failed to save entry:', request.error);
          resolve(); // 不阻塞
        };
      } catch (e) {
        console.warn('[IndexedDB Cache] Transaction error:', e);
        this.db = null; // 标记连接失效
        resolve();
      }
    });
  }

  /**
   * 获取单个缓存条目
   */
  async get(key: string): Promise<CacheEntry | null> {
    const db = await this.ensureDb();
    if (!db) return null;

    return new Promise((resolve) => {
      try {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.get(key);

        request.onsuccess = () => {
          resolve(request.result || null);
        };
        request.onerror = () => {
          console.warn('[IndexedDB Cache] Failed to get entry:', request.error);
          resolve(null);
        };
      } catch (e) {
        console.warn('[IndexedDB Cache] Transaction error:', e);
        this.db = null; // 标记连接失效
        resolve(null);
      }
    });
  }

  /**
   * 批量保存缓存条目
   */
  async setMany(entries: Array<[string, CacheEntry]>): Promise<number> {
    const db = await this.ensureDb();
    if (!db) return 0;

    return new Promise((resolve) => {
      try {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        
        let saved = 0;
        for (const [key, entry] of entries) {
          const dbEntry: CacheEntry = {
            key,
            code: entry.code,
            dependencies: entry.dependencies,
            timestamp: entry.timestamp || Date.now(),
          };
          objectStore.put(dbEntry);
          saved++;
        }

        transaction.oncomplete = () => {
          console.log(`[IndexedDB Cache] 💾 Saved ${saved} entries`);
          resolve(saved);
        };
        transaction.onerror = () => {
          console.warn('[IndexedDB Cache] Failed to save entries:', transaction.error);
          resolve(0);
        };
      } catch (e) {
        console.warn('[IndexedDB Cache] Transaction error:', e);
        this.db = null; // 标记连接失效
        resolve(0);
      }
    });
  }

  /**
   * 获取所有缓存条目
   */
  async getAll(): Promise<Array<[string, CacheEntry]>> {
    const db = await this.ensureDb();
    if (!db) return [];

    return new Promise((resolve) => {
      try {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.getAll();

        request.onsuccess = () => {
          const entries: Array<[string, CacheEntry]> = request.result.map((entry: CacheEntry) => [
            entry.key,
            entry,
          ]);
          
          // 调试: 检查是否有重复键
          const uniqueKeys = new Set(entries.map(e => e[0]));
          if (uniqueKeys.size !== entries.length) {
            console.warn(`[IndexedDB Cache] ⚠️ Duplicate keys detected! Unique: ${uniqueKeys.size}, Total: ${entries.length}`);
          }
          
          console.log(`[IndexedDB Cache] ✅ Loaded ${entries.length} entries (${uniqueKeys.size} unique)`);
          resolve(entries);
        };
        request.onerror = () => {
          console.warn('[IndexedDB Cache] Failed to load entries:', request.error);
          resolve([]);
        };
      } catch (e) {
        console.warn('[IndexedDB Cache] Transaction error:', e);
        this.db = null; // 标记连接失效
        resolve([]);
      }
    });
  }

  /**
   * 清空所有缓存
   */
  async clear(): Promise<void> {
    const db = await this.ensureDb();
    if (!db) return;

    return new Promise((resolve) => {
      try {
        const transaction = db.transaction([STORE_NAME], 'readwrite');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.clear();

        request.onsuccess = () => {
          console.log('[IndexedDB Cache] 🗑️  Cleared all entries');
          resolve();
        };
        request.onerror = () => {
          console.warn('[IndexedDB Cache] Failed to clear:', request.error);
          resolve();
        };
      } catch (e) {
        console.warn('[IndexedDB Cache] Transaction error:', e);
        this.db = null; // 标记连接失效
        resolve();
      }
    });
  }

  /**
   * 获取缓存数量
   */
  async count(): Promise<number> {
    const db = await this.ensureDb();
    if (!db) return 0;

    return new Promise((resolve) => {
      try {
        const transaction = db.transaction([STORE_NAME], 'readonly');
        const objectStore = transaction.objectStore(STORE_NAME);
        const request = objectStore.count();

        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(0);
      } catch (e) {
        console.warn('[IndexedDB Cache] Transaction error:', e);
        this.db = null; // 标记连接失效
        resolve(0);
      }
    });
  }
}

// 全局单例
export const indexedDBCache = new IndexedDBCache();
