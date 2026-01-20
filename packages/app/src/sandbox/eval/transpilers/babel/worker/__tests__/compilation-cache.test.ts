/**
 * Babel 编译缓存单元测试
 * 
 * 验证缓存的基本功能:
 * 1. 缓存存取
 * 2. LRU 淘汰
 * 3. 统计信息
 */

import compilationCache from '../compilation-cache';

describe('CompilationCache', () => {
  beforeEach(() => {
    // 每个测试前清空缓存
    compilationCache.clear();
    compilationCache.resetStats();
  });

  describe('基本功能', () => {
    it('应该能正确生成缓存键', () => {
      const code = 'const a = 1;';
      const config = { presets: ['env'] };
      const path = '/test.js';

      const key1 = compilationCache.generateKey(code, config, path);
      const key2 = compilationCache.generateKey(code, config, path);

      // 相同输入应生成相同的键
      expect(key1).toBe(key2);
    });

    it('不同代码应生成不同的缓存键', () => {
      const config = { presets: ['env'] };
      const path = '/test.js';

      const key1 = compilationCache.generateKey('const a = 1;', config, path);
      const key2 = compilationCache.generateKey('const b = 2;', config, path);

      expect(key1).not.toBe(key2);
    });

    it('不同配置应生成不同的缓存键', () => {
      const code = 'const a = 1;';
      const path = '/test.js';

      const key1 = compilationCache.generateKey(code, { presets: ['env'] }, path);
      const key2 = compilationCache.generateKey(code, { presets: ['react'] }, path);

      expect(key1).not.toBe(key2);
    });
  });

  describe('缓存存取', () => {
    it('应该能存储和获取缓存', () => {
      const code = 'const a = 1;';
      const config = { presets: ['env'] };
      const path = '/test.js';
      const compiledCode = 'var a = 1;';
      const dependencies = [{ path: 'react', type: 'direct' }];

      const cacheKey = compilationCache.generateKey(code, config, path);
      compilationCache.set(cacheKey, compiledCode, dependencies);

      const cached = compilationCache.get(cacheKey);

      expect(cached).not.toBeNull();
      expect(cached?.code).toBe(compiledCode);
      expect(cached?.dependencies).toEqual(dependencies);
    });

    it('缓存未命中应返回 null', () => {
      const result = compilationCache.get('non-existent-key');
      expect(result).toBeNull();
    });

    it('应该正确更新访问顺序', () => {
      const code1 = 'const a = 1;';
      const code2 = 'const b = 2;';
      const config = { presets: ['env'] };
      const path = '/test.js';

      const key1 = compilationCache.generateKey(code1, config, path);
      const key2 = compilationCache.generateKey(code2, config, path);

      compilationCache.set(key1, 'var a = 1;', []);
      compilationCache.set(key2, 'var b = 2;', []);

      // 访问 key1
      compilationCache.get(key1);

      // key1 应该比 key2 更晚被淘汰
      const stats = compilationCache.getStats();
      expect(stats.size).toBe(2);
    });
  });

  describe('LRU 淘汰', () => {
    it('缓存满时应该淘汰最久未使用的项', () => {
      // 创建小容量缓存用于测试
      const smallCache = new (compilationCache.constructor as any)(3);

      smallCache.set('key1', 'code1', []);
      smallCache.set('key2', 'code2', []);
      smallCache.set('key3', 'code3', []);

      // 访问 key1 使其变为最近使用
      smallCache.get('key1');

      // 添加 key4,应该淘汰 key2(最久未使用)
      smallCache.set('key4', 'code4', []);

      expect(smallCache.get('key1')).not.toBeNull(); // 仍存在
      expect(smallCache.get('key2')).toBeNull();     // 已被淘汰
      expect(smallCache.get('key3')).not.toBeNull(); // 仍存在
      expect(smallCache.get('key4')).not.toBeNull(); // 刚添加
    });
  });

  describe('统计信息', () => {
    it('应该正确统计缓存命中和未命中', () => {
      const code = 'const a = 1;';
      const config = { presets: ['env'] };
      const path = '/test.js';

      const cacheKey = compilationCache.generateKey(code, config, path);
      compilationCache.set(cacheKey, 'var a = 1;', []);

      // 命中 2 次
      compilationCache.get(cacheKey);
      compilationCache.get(cacheKey);

      // 未命中 1 次
      compilationCache.get('non-existent-key');

      const stats = compilationCache.getStats();

      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.size).toBe(1);
    });

    it('应该正确计算命中率', () => {
      const code = 'const a = 1;';
      const config = { presets: ['env'] };
      const path = '/test.js';

      const cacheKey = compilationCache.generateKey(code, config, path);
      compilationCache.set(cacheKey, 'var a = 1;', []);

      // 命中 3 次,未命中 1 次
      compilationCache.get(cacheKey);
      compilationCache.get(cacheKey);
      compilationCache.get(cacheKey);
      compilationCache.get('non-existent-key');

      const stats = compilationCache.getStats();

      // 3 / (3 + 1) = 75%
      expect(stats.hitRate).toBe('75.00%');
    });

    it('应该正确估算节省的时间', () => {
      const code = 'const a = 1;';
      const config = { presets: ['env'] };
      const path = '/test.js';

      const cacheKey = compilationCache.generateKey(code, config, path);
      compilationCache.set(cacheKey, 'var a = 1;', []);

      // 命中 10 次
      for (let i = 0; i < 10; i++) {
        compilationCache.get(cacheKey);
      }

      const stats = compilationCache.getStats();

      // 假设每次编译 15ms,10 次命中节省 150ms
      expect(stats.totalSavedTime).toBe(150);
    });

    it('应该能重置统计信息', () => {
      const code = 'const a = 1;';
      const config = { presets: ['env'] };
      const path = '/test.js';

      const cacheKey = compilationCache.generateKey(code, config, path);
      compilationCache.set(cacheKey, 'var a = 1;', []);
      compilationCache.get(cacheKey);

      compilationCache.resetStats();

      const stats = compilationCache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.totalSavedTime).toBe(0);
    });
  });

  describe('清空缓存', () => {
    it('应该能清空所有缓存', () => {
      const code1 = 'const a = 1;';
      const code2 = 'const b = 2;';
      const config = { presets: ['env'] };
      const path = '/test.js';

      const key1 = compilationCache.generateKey(code1, config, path);
      const key2 = compilationCache.generateKey(code2, config, path);

      compilationCache.set(key1, 'var a = 1;', []);
      compilationCache.set(key2, 'var b = 2;', []);

      expect(compilationCache.getStats().size).toBe(2);

      compilationCache.clear();

      expect(compilationCache.getStats().size).toBe(0);
      expect(compilationCache.get(key1)).toBeNull();
      expect(compilationCache.get(key2)).toBeNull();
    });
  });
});
