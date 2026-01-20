/* eslint-enable import/default */
import { isBabel7 } from '@codesandbox/common/lib/utils/is-babel-7';
import { isUrl } from '@codesandbox/common/lib/utils/is-url';

/* eslint-disable import/default */
// @ts-ignore
import BabelWorker from 'worker-loader?publicPath=/sandbox&name=babel-transpiler.[hash:8].worker.js!./worker/index';

import delay from '@codesandbox/common/lib/utils/delay';
import { endMeasure, measure } from '@codesandbox/common/lib/utils/metrics';
import { LoaderContext, Manager } from 'sandpack-core';
import WorkerTranspiler from '../worker-transpiler/transpiler';
import getBabelConfig from './babel-parser';
import { getSyntaxInfoFromAst } from './ast/syntax-info';
import { convertEsModule } from './ast/convert-esmodule';
import { ESTreeAST, generateCode, parseModule } from './ast/utils';
import { collectDependenciesFromAST } from './ast/collect-dependencies';
import { rewriteImportMeta } from './ast/rewrite-meta';
import replaceImportPathAliases from './replace-import-path-aliases';
import { indexedDBCache } from './indexeddb-cache';

const MAX_WORKER_ITERS = 100;

interface TranspilationResult {
  transpiledCode: string;
}

// const WORKER_COUNT = process.env.SANDPACK ? 1 : 3;

// 优化改动----使用 1 个 Worker 避免重复加载 babel.min.js
// 3 个 Worker 会导致 babel.min.js 被加载 3 次（约 2013ms），改为 1 个可节省 1341ms
const WORKER_COUNT = 1;

interface IDep {
  path: string;
  isAbsolute?: boolean;
  isEntry?: boolean;
  isGlob?: boolean;
}

function addCollectedDependencies(
  loaderContext: LoaderContext,
  deps: Array<IDep>
): Promise<Array<void>> {
  return Promise.all(
    deps.map(async dep => {
      if (dep.isGlob) {
        loaderContext.addDependenciesInDirectory(dep.path, {
          isAbsolute: dep.isAbsolute,
          isEntry: dep.isEntry,
        });
      } else {
        await loaderContext.addDependency(dep.path, {
          isAbsolute: dep.isAbsolute,
          isEntry: dep.isEntry,
        });
      }
    })
  );
}

// Right now this is in a worker, but when we're going to allow custom plugins
// we need to move this out of the worker again, because the config needs
// to support custom plugins
class BabelTranspiler extends WorkerTranspiler {
  worker: Worker;

  constructor() {
    super(
      'babel-loader',
      // @ts-ignore
      async () => {
        let iteration = 0;
        while (typeof globalThis.babelworkers === 'undefined') {
          if (iteration >= MAX_WORKER_ITERS) {
            throw new Error('Could not load Babel worker');
          }
          await delay(50); // eslint-disable-line
          iteration++;
        }

        if (globalThis.babelworkers.length === 0) {
          return BabelWorker();
        }

        // We set these up in startup.ts.
        return globalThis.babelworkers.pop();
      },
      {
        maxWorkerCount: WORKER_COUNT,
        preload: true,
      }
    );
  }

  startupWorkersInitialized = false;

  // 🚀 优化: Worker 初始化后恢复缓存
  private cacheInitialized = false;
  private cacheInitPromise: Promise<void> | null = null;
  
  // 🚀 优化: 跟踪是否执行过编译，用于决定是否需要保存缓存
  private hasCompiled = false;
  private cacheSaved = false;

  // 🚀 优化: 确保缓存系统被初始化(延迟初始化,在第一次编译前)
  private async ensureCacheInitialized(): Promise<void> {
    if (this.cacheInitialized) {
      return;
    }
    
    // 如果正在初始化,等待完成
    if (this.cacheInitPromise) {
      return this.cacheInitPromise;
    }
    
    this.cacheInitPromise = (async () => {
      this.cacheInitialized = true;
      console.log('[Cache] Initializing IndexedDB cache...');
      
      // 异步恢复缓存
      try {
        await this.restorePersistedCache();
      } catch (err) {
        console.warn('[Cache] Failed to restore cache:', err);
      }
      
      // 🔧 修改：不再在 beforeunload 时保存，改为在编译完成后保存
    })();
    
    return this.cacheInitPromise;
  }

  initialize() {
    super.initialize();
    // 触发缓存初始化
    this.ensureCacheInitialized();
  }

  async doTranspilation(
    code: string,
    loaderContext: LoaderContext
  ): Promise<TranspilationResult> {
    // 🚀 优化: 确保缓存系统在第一次编译前初始化
    await this.ensureCacheInitialized();
    
    const { path } = loaderContext;
    const isNodeModule = path.startsWith('/node_modules') || isUrl(path);

    /**
     * We should never transpile babel-standalone, because it relies on code that runs
     * in non-strict mode. Transpiling this code would add a "use strict;" piece, which
     * would then break the code (because it expects `this` to be global). No transpiler
     * can fix this, and because of this we need to just specifically ignore this file.
     */
    if (path === '/node_modules/babel-standalone/babel.js') {
      return { transpiledCode: code };
    }

    // Check if we can take a shortcut, we have a custom pipeline for transforming
    // node_modules to commonjs and collecting deps
    if (loaderContext.options.simpleRequire || isNodeModule) {
      try {
        const ast: ESTreeAST = parseModule(code);
        const syntaxInfo = getSyntaxInfoFromAst(ast);
        if (!syntaxInfo.jsx) {
          // If the code is ESM we transform it to commonjs and return it
          if (syntaxInfo.esm || syntaxInfo.dynamicImports) {
            measure(`esconvert-${path}`);
            if (syntaxInfo.esm) {
              convertEsModule(ast);
            }
            // We collect requires instead of doing this in convertESModule as some modules also use require
            // Which is actually invalid but we probably don't wanna break anyone's code if it works in other bundlers...
            const deps = collectDependenciesFromAST(ast);
            await addCollectedDependencies(
              loaderContext,
              deps.map(d => ({
                path: d,
              }))
            );
            rewriteImportMeta(ast, {
              url: loaderContext.url,
            });
            endMeasure(`esconvert-${path}`, { silent: true });
            return {
              transpiledCode: generateCode(ast),
            };
          }

          // If the code is commonjs and does not contain any more jsx, we generate and return the code.
          measure(`dep-collection-${path}`);
          const deps = collectDependenciesFromAST(ast);
          await addCollectedDependencies(
            loaderContext,
            deps.map(d => ({
              path: d,
            }))
          );
          endMeasure(`dep-collection-${path}`, { silent: true });
          return {
            transpiledCode: code,
          };
        }
      } catch (err) {
        // do not log this in production, it confuses our users
        if (process.env.NODE_ENV === 'development') {
          console.warn(
            `Error occurred while trying to quickly transform '${path}'`
          );
          console.warn(err);
        }
      }
    }

    if (!isNodeModule) {
      const { alias } = loaderContext.options.configurations.sandbox.parsed;
      // 如果待构建的前端项目中使用了别名，则用真实路径替换源码中的别名
      if (alias && Object.keys(alias).length > 0) {
        // eslint-disable-next-line no-param-reassign
        code = replaceImportPathAliases(code, alias);
      }
    }

    const configs = loaderContext.options.configurations;
    const foundConfig = configs.babel && configs.babel.parsed;
    const loaderOptions = loaderContext.options || {};

    const dependencies =
      (configs.package &&
        configs.package.parsed &&
        configs.package.parsed.dependencies) ||
      {};

    const devDependencies =
      (configs.package &&
        configs.package.parsed &&
        configs.package.parsed.devDependencies) ||
      {};

    const isV7 =
      loaderContext.options.isV7 || isBabel7(dependencies, devDependencies);

    const hasMacros = Object.keys(dependencies).some(
      d => d.indexOf('macro') > -1 || d.indexOf('codegen') > -1
    );

    const babelConfig = getBabelConfig(
      foundConfig || (loaderOptions as any).config,
      loaderOptions,
      path,
      isV7
    );

    const {
      code: transpiledCode,
      dependencies: foundDependencies,
    } = await this.queueCompileFn(
      {
        code,
        config: babelConfig,
        path,
        loaderOptions,
        babelTranspilerOptions:
          configs && configs.babelTranspiler && configs.babelTranspiler.parsed,
        sandboxOptions: configs && configs.sandbox && configs.sandbox.parsed,
        version: isV7 ? 7 : 6,
        hasMacros,
      },
      loaderContext
    );

    await addCollectedDependencies(loaderContext, foundDependencies);
    
    // 🚀 优化: 标记已执行编译
    this.hasCompiled = true;

    return { transpiledCode };
  }

  async getTranspilerContext(manager: Manager): Promise<any> {
    const baseConfig = await super.getTranspilerContext(manager);

    const babelTranspilerOptions =
      manager.configurations &&
      manager.configurations.babelTranspiler &&
      manager.configurations.babelTranspiler.parsed;

    const result = await this.workerManager.callFn({
      method: 'get-babel-context',
      data: {
        transpilerOptions: babelTranspilerOptions,
      },
    });

    const { version, availablePlugins, availablePresets } = result;
    return {
      ...baseConfig,
      babelVersion: version,
      availablePlugins,
      availablePresets,
      babelTranspilerOptions,
    };
  }

  // 🚀 优化: 获取编译缓存统计
  async getCacheStats(): Promise<any> {
    try {
      const stats = await this.workerManager.callFn({
        method: 'get-cache-stats',
        data: {},
      });
      return stats;
    } catch (e) {
      console.warn('Failed to get cache stats:', e);
      return null;
    }
  }

  // 🚀 优化: 打印缓存统计
  async printCacheStats(): Promise<void> {
    try {
      await this.workerManager.callFn({
        method: 'print-cache-stats',
        data: {},
      });
    } catch (e) {
      console.warn('Failed to print cache stats:', e);
    }
  }

  // 🚀 优化: 导出缓存并持久化到 IndexedDB
  async exportAndPersistCache(): Promise<void> {
    try {
      const cacheData = await this.workerManager.callFn({
        method: 'export-cache',
        data: {},
      });
      
      if (cacheData && cacheData.entries) {
        await indexedDBCache.setMany(cacheData.entries);
      }
    } catch (e) {
      console.warn('[Cache] Failed to export cache:', e);
    }
  }

  // 🚀 优化: 编译完成后保存缓存（只保存一次）
  async persistCacheIfNeeded(): Promise<void> {
    // 只有执行过编译且还未保存过缓存时才保存
    if (this.hasCompiled && !this.cacheSaved) {
      this.cacheSaved = true;
      console.log('[Cache] Persisting cache after compilation...');
      await this.exportAndPersistCache();
      console.log('[Cache] ✅ Cache persisted to IndexedDB');
    }
  }

  // 🚀 优化: 从 IndexedDB 恢复缓存到 Worker
  async restorePersistedCache(): Promise<void> {
    try {
      const entries = await indexedDBCache.getAll();
      
      if (entries.length === 0) {
        return;
      }
      
      console.log(`[Cache] Restoring ${entries.length} entries to worker...`);
      const result = await this.workerManager.callFn({
        method: 'import-cache',
        data: { entries },
      });

      if (!result || !result.success) {
        console.warn('[Cache] Worker import failed:', result);
      }
    } catch (e) {
      console.warn('[Cache] Failed to restore cache:', e);
    }
  }

  // 🚀 优化: 清空持久化缓存
  async clearPersistedCache(): Promise<void> {
    await indexedDBCache.clear();
  }

  // 🚀 优化: 清空编译缓存
  async clearCompilationCache(): Promise<void> {
    try {
      await this.workerManager.callFn({
        method: 'clear-compilation-cache',
        data: {},
      });
    } catch (e) {
      console.warn('Failed to clear compilation cache:', e);
    }
  }
}

const transpiler = new BabelTranspiler();

// 🚀 优化: 将缓存统计方法暴露到全局(用于调试)
// 使用 setTimeout 确保在模块加载后执行
if (typeof window !== 'undefined') {
  setTimeout(() => {
    (window as any).__babelCache = {
      getStats: () => transpiler.getCacheStats(),
      printStats: () => transpiler.printCacheStats(),
      clear: () => transpiler.clearCompilationCache(),
    };
    
    // 输出提示
    console.log('[Babel Cache] API available at window.__babelCache');
  }, 0);
}

export { BabelTranspiler };

export default transpiler;
