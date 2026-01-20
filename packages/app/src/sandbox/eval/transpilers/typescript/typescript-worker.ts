import type * as TypeScriptType from 'typescript';
import getDependencies from './get-require-statements';
import { ChildHandler } from '../worker-transpiler/child-handler';

const childHandler = new ChildHandler('typescript-worker');

// Use internal unpkg service for intranet deployment
self.importScripts(
  'https://10.4.5.136/unpkg/typescript@3.4.1/lib/typescript.js'
);

declare const ts: typeof TypeScriptType;

// 🚀 TypeScript 编译缓存 - 减少内存占用优化
// 使用 Map 而不是 Object，性能更好且避免原型污染
const compilationCache = new Map<string, {
  transpiledCode: string;
  foundDependencies: any[];
}>();

// 生成缓存键：路径 + 代码内容哈希
function getCacheKey(code: string, path: string, config: any): string {
  // 简单哈希函数，足够用于缓存键生成
  let hash = 0;
  const str = code + JSON.stringify(config);
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `${path}:${hash}`;
}

async function compile(data) {
  const { code, path, config, typescriptVersion } = data;

  if (typescriptVersion !== '3.4.1') {
    // Use internal unpkg service for intranet deployment
    self.importScripts(
      `https://10.4.5.136/unpkg/typescript@${typescriptVersion}/lib/typescript.js`
    );
  }

  const defaultConfig = {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      allowJs: true,
      alwaysStrict: true,
      downlevelIteration: true,
      noImplicitUseStrict: false,
      jsx: ts.JsxEmit.React,
      forceConsistentCasingInFileNames: true,
      noImplicitReturns: true,
      noImplicitThis: true,
      noImplicitAny: true,
      strictNullChecks: true,
      suppressImplicitAnyIndexErrors: true,
      noUnusedLocals: true,
      inlineSourceMap: true,
      inlineSources: true,
      emitDecoratorMetadata: true,
      experimentalDecorators: true,
      lib: ['es2017', 'dom'],
    },
  };

  let finalConfig = { ...defaultConfig };

  if (config) {
    finalConfig = { ...config };
    finalConfig.compilerOptions = {
      ...config.compilerOptions,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      inlineSourceMap: true,
      inlineSources: true,
      emitDecoratorMetadata: true,
    };
  }

  finalConfig.fileName = path;
  finalConfig.reportDiagnostics = true;

  // 🚀 检查缓存
  const cacheKey = getCacheKey(code, path, finalConfig.compilerOptions);
  const cached = compilationCache.get(cacheKey);
  
  if (cached) {
    // 缓存命中，直接返回
    return cached;
  }

  const { outputText: compiledCode } = ts.transpileModule(code, finalConfig);

  const sourceFile = ts.createSourceFile(
    path,
    compiledCode,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS
  );

  const dependencies = getDependencies(sourceFile, ts);
  
  // 🚀 缓存编译结果
  const result = {
    transpiledCode: compiledCode,
    foundDependencies: dependencies,
  };
  
  compilationCache.set(cacheKey, result);
  
  // 🚀 LRU 缓存控制：限制缓存大小为 500 个条目
  if (compilationCache.size > 500) {
    // 删除最早的条目（Map 迭代器按插入顺序）
    const firstKey = compilationCache.keys().next().value;
    compilationCache.delete(firstKey);
  }
  
  return {
    transpiledCode: compiledCode,
    foundDependencies: dependencies.map(dependency => ({
      path: dependency.path,
      isGlob: dependency.type === 'glob',
    })),
  };
}

childHandler.registerFunction('compile', compile);
childHandler.emitReady();
