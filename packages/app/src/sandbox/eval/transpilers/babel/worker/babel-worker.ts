/* eslint-disable global-require, no-console, no-use-before-define */
import flatten from 'lodash-es/flatten';
import refreshBabelPlugin from 'react-refresh/babel';

import delay from '@codesandbox/common/lib/utils/delay';

import * as resolve from 'resolve';
import getDependencyName from 'sandbox/eval/utils/get-dependency-name';
import { join } from '@codesandbox/common/lib/utils/path';
import patchedMacrosPlugin from './utils/macrosPatch';
import detective, {
  extractMetadataFromResult,
} from './plugins/babel-plugin-detective';
import infiniteLoops from './plugins/babel-plugin-transform-prevent-infinite-loops';
import dynamicCSSModules from './plugins/babel-plugin-dynamic-css-modules';
import renameImport from './plugins/babel-plugin-rename-imports';

import { BABEL7_VERSION } from '../babel-version';

import getDependencies from './get-require-statements';
import { downloadFromError, downloadPath } from './dynamic-download';
import { getModulesFromMainThread } from '../../utils/fs';
import { remapBabelHack } from './utils/remap-babel-hack';
import { installErrorMock } from './utils/error-mock';
import {
  normalizePluginName,
  normalizePresetName,
} from './utils/normalize-name';

import { evaluateFromPath, resetCache as resetEvalCache } from './evaluate';
import {
  getPrefixedPluginName,
  getPrefixedPresetName,
} from './get-prefixed-name';
import { patchedResolve } from './utils/resolvePatch';
import { loadBabelTypes } from './utils/babelTypes';
import { ChildHandler } from '../../worker-transpiler/child-handler';
import compilationCache from './compilation-cache';
import hashsum from 'hash-sum';

declare const Babel: IBabel;

// 🚀 优化: 统一缓存清理函数
function resetCache() {
  resetEvalCache(); // 清理 evaluate.ts 中的缓存
  compilationCache.clear(); // 清理编译结果缓存
}

let fsInitialized = false;
let fsLoading = false;
let lastConfig = null;

const childHandler = new ChildHandler('babel-worker');
const IGNORED_MODULES = ['util', 'os'];
const { BrowserFS } = self;

// Default in memory
BrowserFS.configure({ fs: 'InMemory' }, () => {});

self.process = {
  cwd() {
    return '/';
  },
  env: { NODE_ENV: 'development', BABEL_ENV: 'development' },
  platform: 'linux',
  argv: [],
  // @ts-ignore
  stderr: {},
  versions: {
    // @ts-ignore
    node: 10,
  },
};
// Trick Babel that we're in a commonjs env
// @ts-ignore
self.module = { exports: {} };
// @ts-ignore
const { exports } = self.module;
self.exports = exports;

// This one is called from the babel transpiler and babel-plugin-macros
// @ts-ignore
self.require = path => {
  if (path === 'resolve') {
    return patchedResolve();
  }

  if (path === 'assert') {
    return require('assert');
  }

  if (path === 'tty') {
    return {
      isatty() {
        return false;
      },
    };
  }

  if (path === 'util') {
    return require('util');
  }

  if (path === 'os') {
    const os = require('os-browserify');
    os.homedir = () => '/home/sandbox';
    return os;
  }

  const module = BrowserFS.BFSRequire(path);
  if (module) {
    return module;
  }

  if (IGNORED_MODULES.indexOf(path) > -1) {
    return {};
  }

  const fs = BrowserFS.BFSRequire('fs');

  // This code can be called while Babel is initializing.
  // When babel is initializing we can't resolve plugins yet.
  if (!('Babel' in self)) {
    return undefined;
  }

  return evaluateFromPath(
    fs,
    BrowserFS.BFSRequire,
    path,
    '/node_modules/babel-plugin-macros/index.js',
    Babel.availablePlugins,
    Babel.availablePresets
  );
};

// @ts-ignore
self.require.resolve = p => resolve.sync(p);

async function initializeBrowserFS(loaderContextId) {
  fsLoading = true;

  const modules = await getModulesFromMainThread({
    childHandler,
    loaderContextId,
  });
  const tModules = {};
  modules.forEach(module => {
    tModules[module.path] = { module };
  });

  const bfsWrapper = {
    getTranspiledModules: () => tModules,
    addModule: () => {},
    removeModule: () => {},
    moveModule: () => {},
    updateModule: () => {},
  };

  return new Promise(resolvePromise => {
    BrowserFS.configure(
      {
        fs: 'OverlayFS',
        options: {
          writable: { fs: 'InMemory' },
          readable: {
            fs: 'CodeSandboxFS',
            options: {
              manager: bfsWrapper,
            },
          },
        },
      },
      err => {
        if (err) {
          console.error(err);
          return;
        }
        fsLoading = false;
        fsInitialized = true;
        resolvePromise(null);
        // BrowserFS is initialized and ready-to-use!
      }
    );
  });
}

async function waitForFs(loaderContextId) {
  if (!fsInitialized) {
    if (!fsLoading) {
      // We only load the fs when it's needed. The FS is expensive, as we sync all
      // files of the main thread to the worker. We only want to do this if it's really
      // needed.
      await Promise.all([
        initializeBrowserFS(loaderContextId),
        loadBabelTypes(),
      ]);
    }

    while (!fsInitialized) {
      await delay(50); // eslint-disable-line
    }
  }
}

/**
 * Babel can transform the plugin name to a longer name (eg. styled-jsx -> babel-styled-jsx)
 * We want to know this beforehand, this function will check which one it is
 */
async function resolveDependencyName({
  name,
  isV7,
  isPreset = false,
  loaderContextId,
}: {
  name: string;
  isV7: boolean;
  isPreset?: boolean;
  loaderContextId: number;
}) {
  // styled-jsx/babel -> styled-jsx
  // @babel/plugin-env/package.json -> @babel/plugin-env
  const dependencyName = getDependencyName(name);
  try {
    await downloadPath(join(dependencyName, 'package.json'), {
      loaderContextId,
      childHandler,
    });

    return name;
  } catch (e) {
    const prefixedFunction = isPreset
      ? getPrefixedPresetName
      : getPrefixedPluginName;
    // Get the prefixed path, try that
    const prefixedName = prefixedFunction(dependencyName, isV7);

    try {
      await downloadPath(join(prefixedName, 'package.json'), {
        loaderContextId,
        childHandler,
      });
    } catch (err) {
      throw new Error(
        `Cannot find plugin '${dependencyName}' or '${prefixedName}'`
      );
    }

    return prefixedName;
  }
}

async function installPlugin(opts, count = 0) {
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const { Babel, BFSRequire, name, currentPath, isV7, loaderContextId } = opts;
  const normalizedPluginName = normalizePluginName(name);
  if (Babel.availablePlugins[name]) {
    Babel.availablePlugins[normalizedPluginName] = Babel.availablePlugins[name];
    return Babel.availablePlugins[name];
  }

  if (Babel.availablePlugins[normalizedPluginName]) {
    Babel.availablePlugins[name] = Babel.availablePlugins[normalizedPluginName];
    return Babel.availablePlugins[name];
  }

  await waitForFs(loaderContextId);

  const fs = BFSRequire('fs');

  let evaluatedPlugin = null;

  const pluginName = await resolveDependencyName({
    name,
    isV7,
    loaderContextId,
  });

  const nodeModulePath = `/node_modules/${pluginName}`;
  await downloadPath(nodeModulePath, {
    childHandler,
    loaderContextId,
  });

  try {
    await downloadPath(nodeModulePath, {
      childHandler,
      loaderContextId,
    });

    const evaluatedFromPath = evaluateFromPath(
      fs,
      BFSRequire,
      nodeModulePath,
      currentPath,
      Babel.availablePlugins,
      Babel.availablePresets
    );

    evaluatedPlugin = evaluatedFromPath.default || evaluatedFromPath;
  } catch (err) {
    if (count > 5) {
      console.error('Compiling babel plugin ' + name + ' went wrong, got:');
      throw err;
    }

    console.warn('Compiling ' + name + ' went wrong, got:');
    console.warn(err);

    /**
     * We assume that a file is missing in the in-memory file system, and try to download it by
     * parsing the error.
     */
    await downloadFromError({
      error: err,
      childHandler,
      loaderContextId,
    });
    resetCache();
    return installPlugin(opts, count + 1);
  }

  if (!evaluatedPlugin) {
    throw new Error(`Could not install plugin '${name}', it is undefined.`);
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn('Downloaded ' + name);
  }

  Babel.availablePlugins[name] = evaluatedPlugin;
  Babel.availablePlugins[normalizePluginName(name)] = evaluatedPlugin;
  return evaluatedPlugin;
}

async function installPreset(opts, count = 0) {
  // eslint-disable-next-line @typescript-eslint/no-shadow
  const { Babel, BFSRequire, name, currentPath, isV7, loaderContextId } = opts;
  const normalizedPresetName = normalizePresetName(name);
  if (Babel.availablePresets[name]) {
    Babel.availablePresets[normalizedPresetName] = Babel.availablePresets[name];
    return Babel.availablePresets[name];
  }

  if (Babel.availablePresets[normalizedPresetName]) {
    Babel.availablePresets[name] = Babel.availablePresets[normalizedPresetName];
    return Babel.availablePresets[name];
  }

  await waitForFs(loaderContextId);

  const fs = BFSRequire('fs');

  let evaluatedPreset = null;

  const presetName = await resolveDependencyName({
    name,
    isV7,
    isPreset: true,
    loaderContextId,
  });

  try {
    await downloadPath(presetName, {
      childHandler,
      loaderContextId,
    });
    const evaluatedFromPath = evaluateFromPath(
      fs,
      BFSRequire,
      presetName,
      currentPath,
      Babel.availablePlugins,
      Babel.availablePresets
    );
    evaluatedPreset = evaluatedFromPath.default || evaluatedFromPath;
  } catch (err) {
    if (count > 5) {
      console.error('Compiling babel preset ' + name + ' went wrong, got:');
      throw err;
    }

    console.warn('Compiling ' + name + ' went wrong, got:');
    console.warn(err);

    /**
     * We assume that a file is missing in the in-memory file system, and try to download it by
     * parsing the error.
     */
    await downloadFromError({
      error: err,
      childHandler,
      loaderContextId,
    });
    resetCache();
    return installPreset(opts, count + 1);
  }

  if (process.env.NODE_ENV === 'development') {
    console.warn('Downloaded ' + name);
  }

  if (!evaluatedPreset) {
    throw new Error(`Could not install preset '${name}', it is undefined.`);
  }

  Babel.availablePresets[name] = evaluatedPreset;
  Babel.availablePresets[normalizedPresetName] = evaluatedPreset;

  return evaluatedPreset;
}

function stripParams(regexp) {
  return p => {
    if (typeof p === 'string') {
      return p.replace(regexp, '');
    }

    if (Array.isArray(p)) {
      const [name, options] = p;
      return [name.replace(regexp, ''), options];
    }

    return p;
  };
}

const pluginRegExp = new RegExp('@babel/plugin-');
const presetRegExp = new RegExp('@babel/preset-');

/**
 * Remove the @babel/plugin- and @babel/preset- as the standalone version of Babel7 doesn't
 * like that
 * @param {} config
 */
function normalizeV7Config(config) {
  return {
    ...config,
    plugins: (config.plugins || []).map(stripParams(pluginRegExp)),
    presets: (config.presets || []).map(stripParams(presetRegExp)),
  };
}

function getCustomConfig(
  { config, codeSandboxPlugins },
  version: number,
  path: string,
  options: any
) {
  if (
    /^\/node_modules/.test(path) &&
    /\.js$/.test(path) &&
    options.compileNodeModulesWithEnv
  ) {
    if (version === 7) {
      return {
        parserOpts: {
          plugins: ['dynamicImport', 'objectRestSpread'],
        },
        presets: ['env', 'react'],
        plugins: [
          'transform-flow-strip-types',
          'babel-plugin-csb-rename-import',
          'transform-modules-commonjs',
          '@babel/plugin-transform-runtime',
          ...codeSandboxPlugins,
        ],
      };
    }

    return {
      presets: ['es2015', 'react', 'stage-0'],
      plugins: [
        'babel-plugin-csb-rename-import',
        'transform-es2015-modules-commonjs',
        'transform-class-properties',
        [
          'transform-runtime',
          {
            helpers: false,
            polyfill: false,
            regenerator: true,
          },
        ],
        [
          'transform-regenerator',
          {
            // Async functions are converted to generators by babel-preset-env
            async: false,
          },
        ],
        ...codeSandboxPlugins,
      ],
    };
  }

  return {
    ...config,
    plugins: config.plugins
      ? [
          'babel-plugin-csb-rename-import',
          ...config.plugins,
          ...codeSandboxPlugins,
        ]
      : codeSandboxPlugins,
  };
}

async function compile(opts: any) {
  const { code, config, path, isV7, loaderContextId } = opts;

  if (path.includes('node_modules')) {
    const filterRefreshPlugins = p => {
      return typeof p === 'string'
        ? !p.includes('refresh')
        : !p[0].includes('refresh');
    };

    config.plugins = config.plugins.filter(filterRefreshPlugins);
    config.presets = config.presets.filter(filterRefreshPlugins);
  }

  // 🚀 优化: 检查编译缓存
  const cacheKey = compilationCache.generateKey(code, config, path);
  const cachedResult = compilationCache.get(cacheKey);
  
  if (cachedResult) {
    // 🔧 关键: 还原编译结果中的动态 ID
    // 低代码平台会为每个组件生成动态 tid,需要从源代码提取并替换到缓存结果中
    let restoredCode = cachedResult.code;
    
    // 提取源代码中所有的动态 ID (支持所有组件类型)
    // 匹配模式: 组件名(字母) + 十六进制ID(4位以上)
    const sourceIdRegex = /data-dnd="([^"]*:)([a-zA-Z]+)([a-f0-9]{4,})"/gi;
    const cachedIdRegex = /"data-dnd":\s*"([^"]*:)([a-zA-Z]+)([a-f0-9]{4,})"/gi;
    
    // 同时提取 tid 属性
    const sourceTidRegex = /tid="([a-zA-Z]+)([a-f0-9]{4,})"/gi;
    const cachedTidRegex = /"tid":\s*"([a-zA-Z]+)([a-f0-9]{4,})"/gi;
    
    const sourceIdMatches: RegExpExecArray[] = [];
    const cachedIdMatches: RegExpExecArray[] = [];
    const sourceTidMatches: RegExpExecArray[] = [];
    const cachedTidMatches: RegExpExecArray[] = [];
    
    let match;
    while ((match = sourceIdRegex.exec(code)) !== null) {
      sourceIdMatches.push(match);
    }
    while ((match = cachedIdRegex.exec(restoredCode)) !== null) {
      cachedIdMatches.push(match);
    }
    while ((match = sourceTidRegex.exec(code)) !== null) {
      sourceTidMatches.push(match);
    }
    while ((match = cachedTidRegex.exec(restoredCode)) !== null) {
      cachedTidMatches.push(match);
    }
    
    // 按位置一一对应替换动态 ID (data-dnd)
    if (sourceIdMatches.length === cachedIdMatches.length && sourceIdMatches.length > 0) {
      sourceIdMatches.forEach((sourceMatch, index) => {
        const cachedMatch = cachedIdMatches[index];
        const sourceId = sourceMatch[3];      // 源代码中的新 ID (十六进制部分)
        const cachedId = cachedMatch[3];      // 缓存中的旧 ID
        const componentName = sourceMatch[2]; // 组件名 (Page/Block/FFormPlaceholder等)
        const pathPrefix = sourceMatch[1];    // 路径前缀 ("/src/pages/Home.js:")
        
        if (sourceId !== cachedId) {
          // 构建精确的替换模式,避免误替换
          const oldPattern = `"${cachedMatch[1]}${componentName}${cachedId}"`;
          const newPattern = `"${pathPrefix}${componentName}${sourceId}"`;
          restoredCode = restoredCode.replace(oldPattern, newPattern);
        }
      });
    }
    
    // 按位置一一对应替换 tid 属性
    if (sourceTidMatches.length === cachedTidMatches.length && sourceTidMatches.length > 0) {
      sourceTidMatches.forEach((sourceMatch, index) => {
        const cachedMatch = cachedTidMatches[index];
        const sourceId = sourceMatch[2];      // 源代码中的新 ID (十六进制部分)
        const cachedId = cachedMatch[2];      // 缓存中的旧 ID
        const componentName = sourceMatch[1]; // 组件名
        
        if (sourceId !== cachedId) {
          // 构建精确的替换模式
          const oldPattern = `"tid":"${componentName}${cachedId}"`;
          const newPattern = `"tid":"${componentName}${sourceId}"`;
          restoredCode = restoredCode.replace(oldPattern, newPattern);
        }
      });
    }
    
    return {
      code: restoredCode,
      dependencies: cachedResult.dependencies,
    };
  }

  try {
    let result;
    try {
      result = Babel.transform(code, config);
    } catch (err) {
      err.message = err.message.replace('unknown', path);

      if (!isV7) {
        const codeFrame = await import('babel-code-frame').then(x => x.default);

        // Match the line+col
        const lineColRegex = /\((\d+):(\d+)\)/;

        const match = err.message.match(lineColRegex);
        if (match && match[1] && match[2]) {
          const lineNumber = +match[1];
          const colNumber = +match[2];

          const niceMessage =
            err.message + '\n\n' + codeFrame(code, lineNumber, colNumber);

          err.message = niceMessage;
        }
      }

      throw err;
    }

    const dependencies = getDependencies(extractMetadataFromResult(result));
    if (isV7) {
      // Force push this dependency, there are cases where it isn't included out of our control.
      // https://twitter.com/vigs072/status/1103005932886343680
      // TODO: look into this
      dependencies.push({
        path: '@babel/runtime/helpers/interopRequireDefault',
        type: 'direct',
      });
      dependencies.push({
        path: '@babel/runtime/helpers/interopRequireWildcard',
        type: 'direct',
      });
    }

    // 🚀 优化: 将编译结果存入缓存
    compilationCache.set(cacheKey, result.code, dependencies);

    return {
      code: result.code,
      dependencies,
    };
  } catch (err) {
    const isModuleNotFoundError =
      err.code === 'MODULE_NOT_FOUND' ||
      err.message.indexOf('Cannot find module') > -1;
    if (!fsInitialized && (isModuleNotFoundError || err.code === 'EIO')) {
      // BrowserFS was needed but wasn't initialized
      await waitForFs(loaderContextId);
      return compile(opts);
    }

    if (isModuleNotFoundError) {
      // Try to download the file and all dependencies, retry compilation then
      await downloadFromError({
        error: err,
        childHandler,
        loaderContextId,
      });
      resetCache();
      return compile(opts);
    }

    throw err;
  }
}

try {
  // Rollup globals hardcoded in Babel
  // @ts-ignore
  self.path$2 = BrowserFS.BFSRequire('path');
  // @ts-ignore
  self.fs$1 = BrowserFS.BFSRequire('fs');

  self.importScripts(
    process.env.NODE_ENV === 'development'
      ? `${
          process.env.CODESANDBOX_HOST || ''
        }/static/js/babel.${BABEL7_VERSION}.js`
      : `${
          process.env.CODESANDBOX_HOST || ''
        }/static/js/babel.${BABEL7_VERSION}.min.js`
  );

  remapBabelHack();
  registerCodeSandboxPlugins();
} catch (e) {
  console.error(e);
}

async function getBabelContext(opts) {
  const { transpilerOptions } = opts;
  loadCustomTranspiler(
    transpilerOptions && transpilerOptions.babelURL,
    transpilerOptions && transpilerOptions.babelEnvURL
  );
  return {
    version: Babel.version,
    availablePlugins: Object.keys(Babel.availablePlugins),
    availablePresets: Object.keys(Babel.availablePresets),
  };
}

async function initBabel(opts) {
  const {
    path,
    sandboxOptions,
    babelTranspilerOptions,
    config,
    loaderOptions,
    version,
    hasMacros,
    loaderContextId,
  } = opts;

  const { disableCodeSandboxPlugins } = loaderOptions;

  const babelUrl = babelTranspilerOptions && babelTranspilerOptions.babelURL;
  const babelEnvUrl =
    babelTranspilerOptions && babelTranspilerOptions.babelEnvURL;

  if (babelUrl || babelEnvUrl) {
    loadCustomTranspiler(babelUrl, babelEnvUrl);
  } else if (version !== 7) {
    loadCustomTranspiler(
      `${process.env.CODESANDBOX_HOST || ''}/static/js/babel.6.26.min.js`
    );
  }

  const stringifiedConfig = JSON.stringify(babelTranspilerOptions);
  if (stringifiedConfig && lastConfig !== stringifiedConfig) {
    resetCache();
    lastConfig = stringifiedConfig;
  }

  const codeSandboxPlugins = [];

  if (!disableCodeSandboxPlugins) {
    if (loaderOptions.dynamicCSSModules) {
      codeSandboxPlugins.push('dynamic-css-modules');
    }

    if (!sandboxOptions || sandboxOptions.infiniteLoopProtection) {
      codeSandboxPlugins.push('babel-plugin-transform-prevent-infinite-loops');
    }
  }

  codeSandboxPlugins.push([
    'babel-plugin-detective',
    { source: true, nodes: true, generated: true },
  ]);

  const customConfig = getCustomConfig(
    { config, codeSandboxPlugins },
    version,
    path,
    loaderOptions
  );

  const flattenedPresets = flatten(customConfig.presets || []);
  const flattenedPlugins = flatten(customConfig.plugins || []);

  if (!disableCodeSandboxPlugins) {
    if (
      Object.keys(Babel.availablePresets).indexOf('env') === -1 &&
      version !== 7
    ) {
      Babel.registerPreset('env', Babel.availablePresets.latest);
    }

    if (
      (flattenedPlugins.indexOf('transform-vue-jsx') > -1 ||
        flattenedPlugins.indexOf('babel-plugin-transform-vue-jsx') > -1) &&
      Object.keys(Babel.availablePlugins).indexOf('transform-vue-jsx') === -1
    ) {
      const vuePlugin = await import(
        /* webpackChunkName: 'babel-plugin-transform-vue-jsx' */ 'babel-plugin-transform-vue-jsx'
      );
      Babel.registerPlugin('transform-vue-jsx', vuePlugin);
      Babel.registerPlugin('babel-plugin-transform-vue-jsx', vuePlugin);
    }

    if (
      (flattenedPlugins.indexOf('jsx-pragmatic') > -1 ||
        flattenedPlugins.indexOf('babel-plugin-jsx-pragmatic') > -1) &&
      Object.keys(Babel.availablePlugins).indexOf('jsx-pragmatic') === -1
    ) {
      const pragmaticPlugin = await import(
        /* webpackChunkName: 'babel-plugin-jsx-pragmatic' */ 'babel-plugin-jsx-pragmatic'
      );
      Babel.registerPlugin('jsx-pragmatic', pragmaticPlugin);
      Babel.registerPlugin('babel-plugin-jsx-pragmatic', pragmaticPlugin);
    }

    if (
      flattenedPlugins.indexOf('babel-plugin-macros') > -1 &&
      Object.keys(Babel.availablePlugins).indexOf('babel-plugin-macros') === -1
    ) {
      if (hasMacros) {
        await waitForFs(loaderContextId);
      }

      Babel.registerPlugin('babel-plugin-macros', patchedMacrosPlugin);
    }

    if (
      flattenedPlugins.indexOf('react-refresh/babel') > -1 &&
      Object.keys(Babel.availablePlugins).indexOf('react-refresh/babel') === -1
    ) {
      Babel.registerPlugin('react-refresh/babel', refreshBabelPlugin);
    }

    if (
      flattenedPlugins.indexOf('transform-cx-jsx') > -1 &&
      Object.keys(Babel.availablePlugins).indexOf('transform-cx-jsx') === -1
    ) {
      const cxJsxPlugin = await import(
        /* webpackChunkName: 'transform-cx-jsx' */ 'babel-plugin-transform-cx-jsx'
      );
      Babel.registerPlugin('transform-cx-jsx', cxJsxPlugin);
    }
  }

  await Promise.all(
    flattenedPlugins
      .filter(p => typeof p === 'string')
      .map(async p => {
        try {
          await installPlugin({
            Babel,
            BFSRequire: BrowserFS.BFSRequire,
            name: p,
            currentPath: path,
            isV7: !Babel.version.startsWith('6'),
            loaderContextId,
          });
        } catch (err) {
          console.warn(err);
          throw new Error(
            `Could not find/install babel plugin '${p}': ${err.message}`
          );
        }
      })
  );

  await Promise.all(
    flattenedPresets
      .filter(p => typeof p === 'string')
      .map(async p => {
        try {
          await installPreset({
            Babel,
            BFSRequire: BrowserFS.BFSRequire,
            name: p,
            currentPath: path,
            isV7: !Babel.version.startsWith('6'),
            loaderContextId,
          });
        } catch (err) {
          throw new Error(
            `Could not find/install babel preset '${p}': ${err.message}`
          );
        }
      })
  );

  return { customConfig };
}

async function workerCompile(opts) {
  const { customConfig } = await initBabel(opts);
  const { code, path, version, loaderContextId } = opts;
  if (loaderContextId == null) {
    throw new Error(
      'Loader context is required to compile run BabelWorker#compile()'
    );
  }

  return compile({
    code,
    config: version === 7 ? normalizeV7Config(customConfig) : customConfig,
    path,
    isV7: version === 7,
    loaderContextId,
  });
}

childHandler.registerFunction('get-babel-context', getBabelContext);
childHandler.registerFunction('compile', workerCompile);

// 🚀 优化: 注册缓存管理函数
childHandler.registerFunction('clear-compilation-cache', async () => {
  compilationCache.clear();
  return { success: true };
});

childHandler.registerFunction('get-cache-stats', async () => {
  return compilationCache.getStats();
});

childHandler.registerFunction('print-cache-stats', async () => {
  compilationCache.printStats();
  return compilationCache.getStats();
});

// 🚀 优化: 导出缓存数据供主线程持久化
childHandler.registerFunction('export-cache', async () => {
  const entries = compilationCache.exportCache();
  return {
    entries,
    timestamp: Date.now(),
  };
});

// 🚀 优化: 从主线程导入缓存数据
childHandler.registerFunction('import-cache', async (opts) => {
  const { entries } = opts;
  if (!entries || !Array.isArray(entries)) {
    return { success: false, error: 'Invalid cache data' };
  }
  
  const imported = compilationCache.importCache(entries);
  return { success: true, imported };
});

childHandler.emitReady();

async function executeWarmupSequence() {
  const opts = {
    path: 'test.js',
    code: 'const a = "b";',
    config: { presets: ['env'] },
    version: 7,
    loaderOptions: {},
  };
  const { customConfig } = await initBabel(opts);
  const { code } = opts;
  Babel.transform(code, normalizeV7Config(customConfig));
}

// 优化：禁用 Warmup 以加速 Worker 初始化（可节省约 1 秒）
// Warmup 会预编译测试代码来初始化 Babel，但这在实际使用前是不必要的
// executeWarmupSequence().catch(console.error);

export type IBabel = {
  transform: (
    code: string,
    config: Object
  ) => {
    ast: Object;
    code: string;
  };
  availablePlugins: { [key: string]: Function };
  availablePresets: { [key: string]: Function };
  registerPlugin: (name: string, plugin: Function) => void;
  registerPreset: (name: string, preset: Function) => void;
  version: string;
};

let loadedTranspilerURL = null;
let loadedEnvURL = null;

function registerCodeSandboxPlugins() {
  if (!Babel.availablePlugins['babel-plugin-detective']) {
    Babel.registerPlugin('babel-plugin-detective', detective);
  }
  if (!Babel.availablePlugins['dynamic-css-modules']) {
    Babel.registerPlugin('dynamic-css-modules', dynamicCSSModules);
  }
  if (!Babel.availablePlugins['babel-plugin-csb-rename-import']) {
    Babel.registerPlugin('babel-plugin-csb-rename-import', renameImport);
  }
  if (
    !Babel.availablePlugins['babel-plugin-transform-prevent-infinite-loops']
  ) {
    Babel.registerPlugin(
      'babel-plugin-transform-prevent-infinite-loops',
      infiniteLoops
    );
  }

  // Between Babel 7.8 and Babel 7.12 the internal name of some plugins has changed. We need to
  // remap the plugin to make existing sandboxes that rely on Babel v7 work.
  if (
    !Babel.availablePlugins['syntax-dynamic-import'] &&
    Babel.availablePlugins['proposal-dynamic-import']
  ) {
    Babel.registerPlugin(
      'syntax-dynamic-import',
      Babel.availablePlugins['proposal-dynamic-import']
    );
  }
}

function loadCustomTranspiler(babelUrl?: string, babelEnvUrl?: string) {
  if (babelUrl && babelUrl !== loadedTranspilerURL) {
    self.importScripts(babelUrl);
    loadedTranspilerURL = babelUrl;
  }

  if (babelEnvUrl && babelEnvUrl !== loadedEnvURL) {
    self.importScripts(babelEnvUrl);
    loadedEnvURL = babelEnvUrl;
  }
  remapBabelHack();
  registerCodeSandboxPlugins();
}
installErrorMock();
