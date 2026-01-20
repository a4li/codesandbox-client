/* eslint-disable import/no-cycle */
import parseConfigurations from '@codesandbox/common/lib/templates/configuration/parse';
import getDefinition, {
  TemplateType,
} from '@codesandbox/common/lib/templates/index';
import { ParsedConfigurationFiles } from '@codesandbox/common/lib/templates/template';
import _debug from '@codesandbox/common/lib/utils/debug';
import { isBabel7 } from '@codesandbox/common/lib/utils/is-babel-7';
import { absolute } from '@codesandbox/common/lib/utils/path';
import VERSION from '@codesandbox/common/lib/version';
import { clearErrorTransformers, dispatch, reattach } from 'codesandbox-api';
import flatten from 'lodash-es/flatten';
import initializeErrorTransformers from 'sandbox-hooks/errors/transformers';
import { inject, uninject } from 'sandbox-hooks/react-error-overlay/overlay';
import {
  consumeCache,
  deleteAPICache,
  saveCache,
  clearIndexedDBCache,
} from 'sandpack-core/lib/cache';
import { Module } from 'sandpack-core/lib/types/module';
import * as metrics from '@codesandbox/common/lib/utils/metrics';
import { NpmRegistry } from '@codesandbox/common/lib/types';
import { Manager, TranspiledModule } from 'sandpack-core';

import { loadDependencies, NPMDependencies } from 'sandpack-core/lib/npm';
import {
  NpmRegistryFetcher,
  NpmRegistryOpts,
} from 'sandpack-core/lib/npm/dynamic/fetch-protocols/npm-registry';
import {
  getSandpackSecret,
  removeSandpackSecret,
  getProtocolAndHostWithSSE,
} from 'sandpack-core/lib/sandpack-secret';
import {
  evalBoilerplates,
  findBoilerplate,
  getBoilerplates,
} from './boilerplates';
import defaultBoilerplates from './boilerplates/default-boilerplates';
import createCodeSandboxOverlay from './codesandbox-overlay';
import getPreset from './eval';
import handleExternalResources, {
  handleEvaluateScript,
} from './external-resources';
import setScreen, { resetScreen } from './status-screen';
import { showRunOnClick } from './status-screen/run-on-click';
import { SCRIPT_VERSION } from '.';
import babelTranspiler from './eval/transpilers/babel';

let manager: Manager | null = null;
let actionsEnabled = false;

const debug = _debug('cs:compiler');

// 🚀 优化: 暴露 Babel 缓存 API 到全局
if (typeof window !== 'undefined') {
  setTimeout(() => {
    (window as any).__babelCache = {
      getStats: () => babelTranspiler.getCacheStats(),
      printStats: () => babelTranspiler.printCacheStats(),
      clear: () => babelTranspiler.clearCompilationCache(),
      clearPersisted: () => babelTranspiler.clearPersistedCache(),
      persist: async () => {
        await babelTranspiler.exportAndPersistCache();
        console.log('[Cache] ✅ Manual persist completed (IndexedDB)');
      },
      restore: async () => {
        await babelTranspiler.restorePersistedCache();
        console.log('[Cache] ✅ Manual restore completed (IndexedDB)');
      },
      debugKeys: async (count?: number) => {
        try {
          await (babelTranspiler as any).workerManager.callFn({
            method: 'debug-cache-keys',
            data: { count: count || 5 },
          });
        } catch (e) {
          console.warn('Failed to debug cache keys:', e);
        }
      },
    };
    console.log('[Babel Cache] API: window.__babelCache (IndexedDB persistence)');
    
    // 🔧 调试: 暴露 manager 统计 API
    (window as any).__managerStats = () => {
      if (!manager) {
        console.log('Manager not initialized');
        return null;
      }
      const stats = {
        transpiledModulesCount: Object.keys(manager.transpiledModules).length,
        transpiledModulesByHashCount: Object.keys(manager.transpiledModulesByHash).length,
        cachedPathsCount: Object.keys(manager.cachedPaths).length,
        transpileJobsCount: Object.keys(manager.transpileJobs).length,
        nodeModulesCount: Object.keys(manager.transpiledModules).filter(p => p.startsWith('/node_modules')).length,
        userModulesCount: Object.keys(manager.transpiledModules).filter(p => !p.startsWith('/node_modules')).length,
        resolverCacheSize: manager.resolverCache?.size || 0,
        esmodulesSize: manager.esmodules?.size || 0,
      };
      console.table(stats);
      return stats;
    };
    
    // 🔧 调试: 深度内存分析
    (window as any).__memoryAnalysis = () => {
      if (!manager) {
        console.log('Manager not initialized');
        return null;
      }
      
      // 统计所有模块的代码大小
      let totalCodeSize = 0;
      let totalCompiledSize = 0;
      let moduleWithLargestCode = { path: '', size: 0 };
      
      Object.values(manager.transpiledModulesByHash).forEach((tm: any) => {
        const codeSize = tm.module?.code?.length || 0;
        totalCodeSize += codeSize;
        
        if (codeSize > moduleWithLargestCode.size) {
          moduleWithLargestCode = { path: tm.module?.path, size: codeSize };
        }
        
        // 检查编译结果大小
        if (tm.source?.compiledCode) {
          totalCompiledSize += tm.source.compiledCode.length;
        }
      });
      
      const result = {
        totalCodeSizeMB: (totalCodeSize / 1024 / 1024).toFixed(2),
        totalCompiledSizeMB: (totalCompiledSize / 1024 / 1024).toFixed(2),
        largestModule: moduleWithLargestCode,
        heapUsedMB: ((performance as any).memory?.usedJSHeapSize / 1024 / 1024 || 0).toFixed(2),
      };
      
      console.log('=== Memory Analysis ===');
      console.table(result);
      return result;
    };
    
    // 🔧 调试: 检查全局对象泄漏
    (window as any).__checkGlobalLeaks = () => {
      const suspicious: { name: string; type: string; size?: number }[] = [];
      
      // 检查常见的泄漏模式
      const knownGlobals = new Set(['window', 'document', 'console', 'performance', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'indexedDB', 'crypto', 'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'Blob', 'File', 'FileReader', 'FormData', 'URL', 'URLSearchParams', 'Headers', 'Request', 'Response', 'AbortController', 'CustomEvent', 'Event', 'EventTarget', 'Node', 'Element', 'HTMLElement', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'RegExp', 'Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'JSON', 'Math', 'Reflect', 'Proxy', 'Intl', 'ArrayBuffer', 'SharedArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'alert', 'confirm', 'prompt', 'print', 'open', 'close', 'stop', 'focus', 'blur', 'scroll', 'scrollTo', 'scrollBy', 'moveTo', 'moveBy', 'resizeTo', 'resizeBy', 'getComputedStyle', 'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'atob', 'btoa', 'escape', 'unescape', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent', 'isNaN', 'isFinite', 'parseFloat', 'parseInt', 'eval', 'Function', 'Infinity', 'NaN', 'undefined', 'globalThis', 'self', 'top', 'parent', 'frames', 'length', 'opener', 'closed', 'frameElement', 'name', 'status', 'defaultStatus', 'origin', 'innerWidth', 'innerHeight', 'outerWidth', 'outerHeight', 'pageXOffset', 'pageYOffset', 'scrollX', 'scrollY', 'screenX', 'screenY', 'screenLeft', 'screenTop', 'screen', 'devicePixelRatio', 'visualViewport', 'styleMedia', 'onload', 'onerror', 'onmessage', 'onbeforeunload', 'onunload']);
      
      for (const key in window) {
        if (!knownGlobals.has(key) && !key.startsWith('webkit') && !key.startsWith('on')) {
          try {
            const val = (window as any)[key];
            const type = typeof val;
            if (type === 'object' && val !== null) {
              const size = JSON.stringify(val)?.length || 0;
              if (size > 10000) { // 大于 10KB
                suspicious.push({ name: key, type, size });
              }
            } else if (type === 'function') {
              suspicious.push({ name: key, type });
            }
          } catch (e) {
            // 忽略无法访问的属性
          }
        }
      }
      
      console.log('=== Suspicious Global Objects ===');
      console.table(suspicious.sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 20));
      return suspicious;
    };
    
    // 🔧 调试: 强制清理并测量
    (window as any).__forceCleanup = () => {
      console.log('=== Force Cleanup ===');
      const before = (performance as any).memory?.usedJSHeapSize / 1024 / 1024 || 0;
      
      // 尝试清理 React
      try {
        const reactDOM = (window as any).ReactDOM;
        if (reactDOM && reactDOM.unmountComponentAtNode) {
          document.querySelectorAll('#root, #app, [data-reactroot]').forEach(el => {
            try {
              reactDOM.unmountComponentAtNode(el);
            } catch (e) {}
          });
        }
      } catch (e) {}
      
      // 清理可能的全局引用
      const toClean = ['$model', '__REDUX_STORE__', '__store__', 'store'];
      toClean.forEach(key => {
        if ((window as any)[key]) {
          console.log(`Cleaning window.${key}`);
          try {
            delete (window as any)[key];
          } catch (e) {
            (window as any)[key] = null;
          }
        }
      });
      
      // 触发 GC（如果可用）
      if ((window as any).gc) {
        (window as any).gc();
      }
      
      setTimeout(() => {
        const after = (performance as any).memory?.usedJSHeapSize / 1024 / 1024 || 0;
        console.log(`Memory: ${before.toFixed(2)} MB -> ${after.toFixed(2)} MB (${(before - after).toFixed(2)} MB freed)`);
      }, 1000);
    };
  }, 100);
}

export function areActionsEnabled() {
  return actionsEnabled;
}

export function getCurrentManager(): Manager | null {
  return manager;
}

export function getHTMLParts(html: string) {
  if (html.includes('<body>')) {
    const bodyMatcher = /<body.*>([\s\S]*)<\/body>/m;
    const headMatcher = /<head>([\s\S]*)<\/head>/m;

    const headMatch = html.match(headMatcher);
    const bodyMatch = html.match(bodyMatcher);
    const head = headMatch && headMatch[1] ? headMatch[1] : '';
    const body = bodyMatch && bodyMatch[1] ? bodyMatch[1] : html;

    return { body, head };
  }

  return { head: '', body: html };
}

let testRunner: import('./eval/tests/jest-lite').default | undefined;
function sendTestCount(modules: { [path: string]: Module }) {
  const tests = testRunner.findTests(modules);

  dispatch({
    type: 'test',
    event: 'test_count',
    count: tests.length,
  });
}

let firstLoad = true;
let hadError = false;
let lastHeadHTML = null;
let lastBodyHTML = null;
let lastHeight = 0;
let changedModuleCount = 0;
let usedCache = false;

// TODO make devDependencies lazy loaded by the packager
const WHITELISTED_DEV_DEPENDENCIES = [
  'redux-devtools',
  'redux-devtools-dock-monitor',
  'redux-devtools-log-monitor',
  'redux-logger',
  'enzyme',
  'react-addons-test-utils',
  'react-test-renderer',
  'identity-obj-proxy',
  'react-refresh',
];

const BABEL_DEPENDENCIES = [
  'babel-preset-env',
  'babel-preset-latest',
  'babel-preset-es2015',
  'babel-preset-es2015-loose',
  'babel-preset-es2016',
  'babel-preset-es2017',
  'babel-preset-react',
  'babel-preset-stage-0',
  'babel-preset-stage-1',
  'babel-preset-stage-2',
  'babel-preset-stage-3',
];

// Dependencies that we actually don't need, we will replace this by a dynamic
// system in the future
const PREINSTALLED_DEPENDENCIES = [
  'web-vitals', // Blocked by ad blockers :(
  'react-scripts',
  'react-scripts-ts',
  'parcel-bundler',
  'babel-plugin-check-es2015-constants',
  'babel-plugin-external-helpers',
  'babel-plugin-inline-replace-variables',
  'babel-plugin-syntax-async-functions',
  'babel-plugin-syntax-async-generators',
  'babel-plugin-syntax-class-constructor-call',
  'babel-plugin-syntax-class-properties',
  'babel-plugin-syntax-decorators',
  'babel-plugin-syntax-do-expressions',
  'babel-plugin-syntax-exponentiation-operator',
  'babel-plugin-syntax-export-extensions',
  'babel-plugin-syntax-flow',
  'babel-plugin-syntax-function-bind',
  'babel-plugin-syntax-function-sent',
  'babel-plugin-syntax-jsx',
  'babel-plugin-syntax-object-rest-spread',
  'babel-plugin-syntax-trailing-function-commas',
  'babel-plugin-transform-async-functions',
  'babel-plugin-transform-async-to-generator',
  'babel-plugin-transform-async-to-module-method',
  'babel-plugin-transform-class-constructor-call',
  'babel-plugin-transform-class-properties',
  'babel-plugin-transform-decorators',
  'babel-plugin-transform-decorators-legacy',
  'babel-plugin-transform-do-expressions',
  'babel-plugin-transform-es2015-arrow-functions',
  'babel-plugin-transform-es2015-block-scoped-functions',
  'babel-plugin-transform-es2015-block-scoping',
  'babel-plugin-transform-es2015-classes',
  'babel-plugin-transform-es2015-computed-properties',
  'babel-plugin-transform-es2015-destructuring',
  'babel-plugin-transform-es2015-duplicate-keys',
  'babel-plugin-transform-es2015-for-of',
  'babel-plugin-transform-es2015-function-name',
  'babel-plugin-transform-es2015-instanceof',
  'babel-plugin-transform-es2015-literals',
  'babel-plugin-transform-es2015-modules-amd',
  'babel-plugin-transform-es2015-modules-commonjs',
  'babel-plugin-transform-es2015-modules-systemjs',
  'babel-plugin-transform-es2015-modules-umd',
  'babel-plugin-transform-es2015-object-super',
  'babel-plugin-transform-es2015-parameters',
  'babel-plugin-transform-es2015-shorthand-properties',
  'babel-plugin-transform-es2015-spread',
  'babel-plugin-transform-es2015-sticky-regex',
  'babel-plugin-transform-es2015-template-literals',
  'babel-plugin-transform-es2015-typeof-symbol',
  'babel-plugin-transform-es2015-unicode-regex',
  'babel-plugin-transform-es3-member-expression-literals',
  'babel-plugin-transform-es3-property-literals',
  'babel-plugin-transform-es5-property-mutators',
  'babel-plugin-transform-eval',
  'babel-plugin-transform-exponentiation-operator',
  'babel-plugin-transform-export-extensions',
  'babel-plugin-transform-flow-comments',
  'babel-plugin-transform-flow-strip-types',
  'babel-plugin-transform-function-bind',
  'babel-plugin-transform-jscript',
  'babel-plugin-transform-object-assign',
  'babel-plugin-transform-object-rest-spread',
  'babel-plugin-transform-object-set-prototype-of-to-assign',
  'babel-plugin-transform-proto-to-assign',
  'babel-plugin-transform-react-constant-elements',
  'babel-plugin-transform-react-display-name',
  'babel-plugin-transform-react-inline-elements',
  'babel-plugin-transform-react-jsx',
  'babel-plugin-transform-react-jsx-compat',
  'babel-plugin-transform-react-jsx-self',
  'babel-plugin-transform-react-jsx-source',
  'babel-plugin-transform-regenerator',
  'babel-plugin-transform-runtime',
  'babel-plugin-transform-strict-mode',
  'babel-plugin-undeclared-variables-check',
  'babel-plugin-dynamic-import-node',
  'babel-plugin-detective',
  'babel-plugin-transform-prevent-infinite-loops',
  'babel-plugin-transform-vue-jsx',
  'flow-bin',
  ...BABEL_DEPENDENCIES,
];

function getDependencies(
  parsedPackage,
  templateDefinition,
  configurations
): NPMDependencies {
  const {
    dependencies: d = {},
    peerDependencies = {},
    devDependencies = {},
  } = parsedPackage;

  let returnedDependencies = { ...peerDependencies };

  const foundWhitelistedDevDependencies = [...WHITELISTED_DEV_DEPENDENCIES];

  // Add all babel plugins/presets to whitelisted dependencies
  if (configurations && configurations.babel && configurations.babel.parsed) {
    flatten(configurations.babel.parsed.presets || [])
      .filter(p => typeof p === 'string')
      .forEach((p: string) => {
        const [first, ...parts] = p.split('/');
        const prefixedName = p.startsWith('@')
          ? first + '/babel-preset-' + parts.join('/')
          : `babel-preset-${p}`;

        foundWhitelistedDevDependencies.push(p);
        foundWhitelistedDevDependencies.push(prefixedName);
      });

    flatten(configurations.babel.parsed.plugins || [])
      .filter(p => typeof p === 'string')
      .forEach((p: string) => {
        const [first, ...parts] = p.split('/');
        const prefixedName = p.startsWith('@')
          ? first + '/babel-plugin-' + parts.join('/')
          : `babel-plugin-${p}`;

        foundWhitelistedDevDependencies.push(p);
        foundWhitelistedDevDependencies.push(prefixedName);
      });
  }

  Object.keys(d).forEach(dep => {
    if (dep === 'reason-react') {
      return; // is replaced
    }

    returnedDependencies[dep] = d[dep];
  });

  Object.keys(devDependencies).forEach(dep => {
    if (foundWhitelistedDevDependencies.indexOf(dep) > -1) {
      // Skip @vue/babel-preset-app
      if (dep === '@vue/babel-preset-app') {
        return;
      }

      returnedDependencies[dep] = devDependencies[dep];
    }
  });

  if (d.vue) {
    returnedDependencies['@vue/babel-plugin-jsx'] = '1.0.6';
  }

  const sandpackConfig =
    (configurations.customTemplate &&
      configurations.customTemplate.parsed &&
      configurations.customTemplate.parsed.sandpack) ||
    {};

  const preinstalledDependencies =
    sandpackConfig.preInstalledDependencies == null
      ? PREINSTALLED_DEPENDENCIES
      : sandpackConfig.preInstalledDependencies;

  if (templateDefinition.name === 'reason') {
    returnedDependencies = {
      ...returnedDependencies,
      '@jaredly/bs-core': '3.0.0-alpha.2',
      '@jaredly/reason-react': '0.3.4',
    };
  }

  // Always include this, because most sandboxes need this with babel6 and the
  // packager will only include the package.json for it.
  if (isBabel7(d, devDependencies)) {
    // Don't pin this version, because other dependencies installed by the sandbox might need
    // @babel/runtime as well, multiple versions of @babel/runtime will lead to problems.
    returnedDependencies['@babel/runtime'] =
      returnedDependencies['@babel/runtime'] || '^7.3.1';
  } else {
    returnedDependencies['babel-runtime'] =
      returnedDependencies['babel-runtime'] || '6.26.0';
  }

  returnedDependencies['node-libs-browser'] = '2.2.1';

  preinstalledDependencies.forEach(dep => {
    if (returnedDependencies[dep]) {
      delete returnedDependencies[dep];
    }
  });

  return returnedDependencies;
}

async function initializeManager(
  sandboxId: string,
  template: TemplateType,
  modules: { [path: string]: Module },
  configurations: ParsedConfigurationFiles,
  {
    hasFileResolver = false,
    customNpmRegistries = [],
    reactDevTools,
    teamId,
  }: {
    hasFileResolver?: boolean;
    customNpmRegistries?: NpmRegistry[];
    reactDevTools?: 'legacy' | 'latest';
    teamId?: string;
  } = {}
) {
  const newManager = new Manager(
    sandboxId,
    await getPreset(template, configurations.package.parsed),
    modules,
    {
      hasFileResolver,
      versionIdentifier: SCRIPT_VERSION,
      reactDevTools,
    }
  );

  /**
   * If a team-id is provided, we can mount a registryUrl and proxy
   * dependencies request through CSB proxy
   */
  if (teamId) {
    const sandpackToken = getSandpackSecret();

    if (!sandpackToken) {
      dispatch({
        type: 'action',
        action: 'show-error',
        message: 'NPM_REGISTRY_UNAUTHENTICATED_REQUEST',
      });

      throw new Error('NPM_REGISTRY_UNAUTHENTICATED_REQUEST');
    }

    const domain = getProtocolAndHostWithSSE();

    const responseRegistry = await fetch(`${domain}/api/v1/sandpack/registry`, {
      headers: { Authorization: `Bearer ${sandpackToken}` },
    }).catch(() => {
      removeSandpackSecret();
      throw new Error('NPM_REGISTRY_UNAUTHENTICATED_REQUEST');
    });

    const registry = (await responseRegistry.json()) as {
      auth_type: string;
      enabled_scopes: string[];
      limit_to_scopes: true;
      proxy_enabled: false;
      registry_auth_key: string;
      registry_type: string;
      registry_url: string;
    };

    customNpmRegistries.push({
      enabledScopes: registry.enabled_scopes,
      limitToScopes: registry.limit_to_scopes,
      proxyEnabled: registry.proxy_enabled,
      registryUrl:
        registry.registry_url || `${domain}/api/v1/sandpack/registry/`,
      registryAuthToken: registry.registry_auth_key || sandpackToken,
      registryAuthType: registry.auth_type,
    });
  }

  // Add the custom registered npm registries
  for (const registry of customNpmRegistries) {
    if (!registry.registryUrl) {
      throw new Error(
        'Unable to fetch required dependency: neither a `registryUrl` nor a `codesandboxTeamId` was provided.'
      );
    }

    const cleanUrl = registry.registryUrl.replace(/\/$/, '');

    const options: NpmRegistryOpts = { proxyEnabled: registry.proxyEnabled };

    if (registry.limitToScopes) {
      options.scopeWhitelist = registry.enabledScopes;
    }

    // In case the API is not including the field yet
    if (typeof registry.proxyEnabled === 'undefined') {
      registry.proxyEnabled = true;
    }
    if (registry.proxyEnabled) {
      // With our custom proxy on the server we want to handle downloading
      // the tarball. So we proxy it.
      options.provideTarballUrl = (name: string, version: string) =>
        `${cleanUrl}/${name.replace('/', '%2f')}/${version}`;
    }

    if (registry.registryAuthToken) {
      options.authToken = registry.registryAuthToken;
    }

    const protocol = new NpmRegistryFetcher(cleanUrl, options);

    newManager.prependNpmProtocolDefinition({
      protocol,
      condition: protocol.condition,
    });
  }

  return newManager;
}

async function updateManager(
  managerModules: { [path: string]: Module },
  configurations: ParsedConfigurationFiles
): Promise<TranspiledModule[]> {
  const start = Date.now();
  manager.updateConfigurations(configurations);
  console.log('[updateManager] updateConfigurations:', Date.now() - start, 'ms');
  
  await manager.preset.setup(manager);
  console.log('[updateManager] preset.setup:', Date.now() - start, 'ms');
  
  return manager.updateData(managerModules).then(x => {
    console.log('[updateManager] updateData:', Date.now() - start, 'ms');
    changedModuleCount = x.length;
    return x;
  });
}

function getDocumentHeight() {
  const { body } = document;
  const html = document.documentElement;

  return Math.max(body.scrollHeight, body.offsetHeight, html.offsetHeight);
}

function sendResize() {
  const height = getDocumentHeight();

  if (lastHeight !== height) {
    dispatch({ type: 'resize', height });
  }

  lastHeight = height;
}

function initializeDOMMutationListener() {
  if (
    typeof window === 'undefined' ||
    typeof window.MutationObserver !== 'function'
  ) {
    return;
  }

  // Listen on document body for any change that could trigger a resize of the content
  // When a change is found, the sendResize function will determine if a message is dispatched
  const observer = new MutationObserver(sendResize);

  observer.observe(document, {
    attributes: true,
    childList: true,
    subtree: true,
  });

  window.addEventListener('unload', () => {
    observer.disconnect();
  });
}

let resizePollingTimer;
function resizePolling() {
  clearInterval(resizePollingTimer);
  resizePollingTimer = setInterval(sendResize, 500);

  window.addEventListener('unload', () => {
    clearInterval(resizePollingTimer);
  });
}

function onWindowResize() {
  window.addEventListener('resize', sendResize);

  window.addEventListener('unload', () => {
    window.removeEventListener('resize', sendResize);
  });
}

function overrideDocumentClose() {
  const oldClose = window.document.close;

  window.document.close = function close(...args) {
    try {
      oldClose.call(document, args);
    } finally {
      inject();
      reattach();
    }
  };
}

overrideDocumentClose();

interface CompileOptions {
  sandboxId?: string | null;
  modules: { [path: string]: Module };
  customNpmRegistries?: NpmRegistry[];
  externalResources: string[];
  hasActions?: boolean;
  isModuleView?: boolean;
  template: TemplateType;
  entry: string;
  showOpenInCodeSandbox?: boolean;
  showErrorScreen?: boolean;
  showLoadingScreen?: boolean;
  skipEval?: boolean;
  hasFileResolver?: boolean;
  disableDependencyPreprocessing?: boolean;
  clearConsoleDisabled?: boolean;
  reactDevTools?: 'legacy' | 'latest';
  teamId?: string;
}

async function compile(opts: CompileOptions) {
  const {
    modules,
    externalResources,
    customNpmRegistries = [],
    hasActions,
    isModuleView = false,
    template,
    entry,
    showOpenInCodeSandbox,
    showLoadingScreen = true,
    showErrorScreen = true,
    skipEval = false,
    hasFileResolver = false,
    disableDependencyPreprocessing = false,
    clearConsoleDisabled = false,
    reactDevTools,
    teamId,
  } = opts;

  let { sandboxId } = opts;

  if (firstLoad) {
    // Clear the console on first load, but don't clear the console on HMR updates
    if (!clearConsoleDisabled) {
      // @ts-ignore Chrome behaviour
      console.clear('__internal__'); // eslint-disable-line no-console
      dispatch({ type: 'clear-console' });
    }
  }

  dispatch({ type: 'start', firstLoad });
  metrics.measure('compilation');

  const startTime = Date.now();
  try {
    uninject(manager && manager.webpackHMR ? true : hadError);
    inject(showErrorScreen);
    clearErrorTransformers();
    initializeErrorTransformers();
  } catch (e) {
    console.error(e);
  }

  hadError = false;

  actionsEnabled = hasActions;

  let managerModuleToTranspile = null;
  try {
    const templateDefinition = getDefinition(template);
    const configurations = parseConfigurations(
      template,
      templateDefinition.configurationFiles,
      path => modules[path]
    );

    const errors = Object.keys(configurations)
      .map(c => configurations[c])
      .filter(x => x.error);

    if (errors.length) {
      const e = new Error(
        `We weren't able to parse: '${errors[0].path}': ${errors[0].error.message}`
      );

      // @ts-ignore
      e.fileName = errors[0].path;

      throw e;
    }

    const packageJSON = modules['/package.json'];

    if (!packageJSON) {
      throw new Error('Could not find package.json');
    }

    const parsedPackageJSON = configurations.package.parsed;
    const parsedSandboxJSON = configurations.sandbox.parsed;

    // 🔧 sandboxId 优先级：
    // 1. opts.sandboxId - 从父窗口传入
    // 2. parsedSandboxJSON.sandboxId - 从 sandbox.config.json 读取
    // 3. 自动生成 - 基于文件数量和代码长度
    sandboxId = opts.sandboxId || parsedSandboxJSON.sandboxId;
    if (!sandboxId) {
      // 备用方案：使用文件数量和代码长度生成 ID
      const srcFiles = Object.keys(modules).filter(p => p.startsWith('/src/'));
      const totalCodeLength = srcFiles.reduce((sum, p) => sum + (modules[p]?.code?.length || 0), 0);
      const entryLength = modules[entry]?.code?.length || 0;
      
      const pkgName = parsedPackageJSON.name || 'sandbox';
      sandboxId = `local-${pkgName}-${srcFiles.length}-${totalCodeLength}-${entryLength}`;
      console.log('[Compile] Auto-generated sandboxId:', sandboxId);
    } else {
      console.log('[Compile] Using provided sandboxId:', sandboxId);
    }

    dispatch({ type: 'status', status: 'installing-dependencies' });

    manager =
      manager ||
      (await initializeManager(sandboxId, template, modules, configurations, {
        hasFileResolver,
        customNpmRegistries,
        reactDevTools,
        teamId,
      }));

    let dependencies: NPMDependencies = getDependencies(
      parsedPackageJSON,
      templateDefinition,
      configurations
    );

    dependencies = await manager.preset.processDependencies(dependencies);

    // 🔍 调试: 详细计时
    const timings: { [key: string]: number } = {};
    const markTime = (label: string) => {
      timings[label] = Date.now() - startTime;
      console.log(`[Timing] ${label}: ${timings[label]}ms`);
    };

    metrics.measure('dependencies');
    markTime('before-dependencies');

    if (firstLoad && showLoadingScreen) {
      setScreen({
        type: 'loading',
        showFullScreen: firstLoad,
        text: 'Installing Dependencies',
      });
    }
    const { externals = {} } = parsedSandboxJSON;
    const { manifest, isNewCombination } = await loadDependencies(
      dependencies,
      externals,
      ({ done, total, remainingDependencies }) => {
        if (!showLoadingScreen) {
          return;
        }

        const progress = total - done;
        if (done === total) {
          return;
        }

        if (progress <= 6) {
          setScreen({
            type: 'loading',
            showFullScreen: firstLoad,
            text: `Installing Dependencies ${progress}/${total} (${remainingDependencies.join(
              ','
            )})`,
          });
        } else {
          setScreen({
            type: 'loading',
            showFullScreen: firstLoad,
            text: `Installing Dependencies ${progress}/${total}`,
          });
        }
      },
      {
        disableExternalConnection: disableDependencyPreprocessing,
        resolutions: parsedPackageJSON.resolutions,
      }
    );
    metrics.endMeasure('dependencies', { displayName: 'Dependencies' });
    markTime('after-dependencies');

    const shouldReloadManager =
      (isNewCombination && !firstLoad) || manager.id !== sandboxId;

    if (shouldReloadManager) {
      // Just reset the whole manager if it's a new combination
      manager.dispose();

      manager = await initializeManager(
        sandboxId,
        template,
        modules,
        configurations,
        { hasFileResolver, reactDevTools }
      );
    }
    markTime('after-manager-init');

    if (shouldReloadManager || firstLoad) {
      // Now initialize the data the manager can only use once dependencies are loaded

      manager.setManifest(manifest);
      markTime('after-setManifest');
      
      // We save the state of transpiled modules, and load it here again. Gives
      // faster initial loads.
      usedCache = await consumeCache(manager);
      markTime('after-consumeCache');
    }

    metrics.measure('transpilation');

    const updatedModules = (await updateManager(modules, configurations)) || [];
    markTime('after-updateManager');
    
    // 🔍 调试: 输出缓存状态
    console.log('[Cache Debug]', {
      usedCache,
      changedModuleCount,
      firstLoad,
    });
    
    // 🔧 修复: 禁用 canSkipTranspilation 优化
    // 原因: manifest 中的模块（如 preact.module.js）没有被序列化到缓存中
    // 当 canSkipTranspilation=true 时，这些模块不会被编译，导致 ES6 export 语法错误
    // 之前的逻辑: const canSkipTranspilation = usedCache && changedModuleCount === 0 && firstLoad;
    const canSkipTranspilation = false;

    const possibleEntries = templateDefinition.getEntries(configurations);

    const foundMain = isModuleView
      ? entry
      : possibleEntries.find(p => Boolean(modules[p]));

    if (!foundMain) {
      throw new Error(
        `Could not find entry file: ${possibleEntries[0]}. You can specify one in package.json by defining a \`main\` property.`
      );
    }

    const main = absolute(foundMain);
    managerModuleToTranspile = modules[main];

    // 🚀 优化: 只有在需要编译时才显示 loading 和执行 transpile
    if (!canSkipTranspilation) {
      if (showLoadingScreen) {
        setScreen({
          type: 'loading',
          text: 'Transpiling Modules...',
          showFullScreen: firstLoad,
        });
      }

      dispatch({ type: 'status', status: 'transpiling' });
      manager.setStage('transpilation');

      await manager.transpileModules(managerModuleToTranspile);
      markTime('after-transpileModules');
      
      // 🔧 修复: 确保所有模块都被编译，包括从缓存加载但依赖未编译的模块
      // 原问题: manifest 中的 npm 模块（如 preact.module.js）在缓存恢复后没有被编译
      await manager.verifyTreeTranspiled();
      markTime('after-verifyTreeTranspiled');
      
      metrics.endMeasure('transpilation', { displayName: 'Transpilation' });
    } else {
      // 即使跳过 transpilation，也需要确保 manager 状态正确
      manager.setStage('transpilation');
      // 验证树已编译（从缓存加载的模块）
      await manager.verifyTreeTranspiled();
      markTime('after-verifyTreeTranspiled');
    }

    dispatch({ type: 'status', status: 'evaluating' });
    manager.setStage('evaluation');
    markTime('before-evaluation');

    if (!skipEval) {
      resetScreen();

      try {
        // We set it as a time value for people that run two sandboxes on one computer
        // they execute at the same time and we don't want them to conflict, so we check
        // if the message was set a second ago
        if (
          firstLoad &&
          localStorage.getItem('running') &&
          Date.now() - +localStorage.getItem('running') > 8000 &&
          !process.env.SANDPACK
        ) {
          localStorage.removeItem('running');
          showRunOnClick();
          return;
        }

        localStorage.setItem('running', '' + Date.now());
      } catch (e) {
        /* no */
      }

      await manager.preset.preEvaluate(manager, updatedModules);

      if (!manager.webpackHMR) {
        const htmlEntries = templateDefinition.getHTMLEntries(configurations);
        const htmlModulePath = htmlEntries.find(p => Boolean(modules[p]));
        const htmlModule = modules[htmlModulePath];
        let html =
          template === 'vue-cli'
            ? '<div id="app"></div>'
            : '<div id="root"></div>';
        if (htmlModule && htmlModule.code) {
          html = htmlModule.code;
        }
        const { head, body } = getHTMLParts(html);

        if (lastHeadHTML && lastHeadHTML !== head) {
          document.location.reload();
        }
        if (manager && lastBodyHTML && lastBodyHTML !== body) {
          manager.clearCompiledCache();
        }

        // Whether the server has provided the HTML file. If that isn't the case
        // we have to fall back to setting `document.body.innerHTML`, which isn't
        // preferred.
        const serverProvidedHTML =
          modules[htmlEntries[0]] || manager.preset.htmlDisabled;
        // If it has the loading screen element, it definitely didn't server-render
        const isLoadingScreen = Boolean(
          document.getElementById('csb-loading-screen')
        );
        if (
          !serverProvidedHTML ||
          !firstLoad ||
          isLoadingScreen ||
          process.env.LOCAL_SERVER ||
          process.env.SANDPACK
        ) {
          // 🔧 修复: 在重置 innerHTML 之前，先卸载 React 组件以避免内存泄漏
          if (!firstLoad) {
            try {
              // 0. 首先调用低代码平台的清理函数（如果存在）
              // 这会清理 react-easy-state 的 store，避免对已卸载组件的更新
              if (typeof (window as any).__lowcodeCleanup === 'function') {
                (window as any).__lowcodeCleanup();
              }
              
              // 1. 触发 React 组件的卸载生命周期
              const reactDOM = (window as any).ReactDOM;
              const rootSelectors = ['#root', '#app', '[data-reactroot]'];
              
              rootSelectors.forEach(selector => {
                const el = document.querySelector(selector);
                if (el) {
                  // React 18+ with createRoot
                  if ((el as any)._reactRootContainer?._internalRoot) {
                    try {
                      (el as any)._reactRootContainer.unmount();
                    } catch (e) { /* ignore */ }
                  }
                  // React 17 and below
                  else if (reactDOM?.unmountComponentAtNode) {
                    try {
                      reactDOM.unmountComponentAtNode(el);
                    } catch (e) { /* ignore */ }
                  }
                }
              });
              
              // 2. 等待一个微任务周期让 React 完成卸载
              await new Promise(resolve => setTimeout(resolve, 0));
              
              // 3. 备用清理：如果低代码平台没有提供清理函数，手动清理
              if (typeof (window as any).__lowcodeCleanup !== 'function') {
                const lowcodeGlobals = ['$model', '$variable', '$message', '$modal', '$output', '$urlParams', '$routes', '$item'];
                lowcodeGlobals.forEach(key => {
                  const val = (window as any)[key];
                  if (val && typeof val === 'object') {
                    Object.keys(val).forEach(k => {
                      try { delete val[k]; } catch (e) { /* ignore */ }
                    });
                  }
                });
                
                const lowcode = (window as any).lowcode;
                if (lowcode) {
                  ['stores', 'services', 'refs', 'page'].forEach(prop => {
                    if (lowcode[prop]) {
                      Object.keys(lowcode[prop]).forEach(k => {
                        if (prop !== 'stores' || k !== 'currentPage') {
                          try { delete lowcode[prop][k]; } catch (e) { /* ignore */ }
                        }
                      });
                    }
                  });
                }
              }
              
            } catch (e) {
              console.warn('[Cleanup] Error during cleanup:', e);
            }
          }
          
          // The HTML is loaded from the server as a static file, no need to set the innerHTML of the body
          // on the first run. However, if there's no server to provide the static file (in the case of a local server
          // or sandpack), then do it anyways.
          document.body.innerHTML = body;

          // Add head tags or anything that comes from the template
          // This way, title and other meta tags will overwrite whatever the bundler <head> tag has.
          // At this point, the original head was parsed and the files loaded / preloaded.

          // TODO: figure out a way to fix this without overriding head changes done by the bundler
          // Original issue: https://github.com/codesandbox/sandpack/issues/32
          // if (document.head && head) {
          //   document.head.innerHTML = head;
          // }
        }
        lastBodyHTML = body;
        lastHeadHTML = head;
      }

      metrics.measure('external-resources');

      // 将外部 js 代码添加到 head 中
      if (
        parsedSandboxJSON.evaluateJavaScript &&
        typeof parsedSandboxJSON.evaluateJavaScript === 'string'
      ) {
        handleEvaluateScript(parsedSandboxJSON.evaluateJavaScript);
      }

      if (
        parsedSandboxJSON.externalResources &&
        Array.isArray(parsedSandboxJSON.externalResources)
      ) {
        parsedSandboxJSON.externalResources.forEach(r => {
          if (!externalResources.includes(r)) {
            externalResources.push(r);
          }
        });
      }
      // 等待 js/css 资源完全加载后才会 resolve（通过 window 的 load 事件--页面所有资源包括图片加载完成触发）
      // 详细逻辑请查看 handleExternalResources 函数中的 waitForLoaded
      await handleExternalResources(externalResources);

      metrics.endMeasure('external-resources', {
        displayName: 'External Resources',
      });
      markTime('after-external-resources');

      const oldHTML = document.body.innerHTML;
      metrics.measure('evaluation');
      
      const evalled = manager.evaluateModule(managerModuleToTranspile, {
        force: isModuleView,
      });

      metrics.endMeasure('evaluation', { displayName: 'Evaluation' });
      markTime('after-evaluation');

      const domChanged =
        !manager.preset.htmlDisabled && oldHTML !== document.body.innerHTML;

      if (
        isModuleView &&
        !domChanged &&
        !managerModuleToTranspile.path.endsWith('.html')
      ) {
        const isReact =
          managerModuleToTranspile.code &&
          managerModuleToTranspile.code.includes('React');

        if (isReact && evalled) {
          // initiate boilerplates
          if (getBoilerplates().length === 0) {
            try {
              await evalBoilerplates(defaultBoilerplates);
            } catch (e) {
              // eslint-disable-next-line no-console
              console.log("Couldn't load all boilerplates: " + e.message);
            }
          }

          const boilerplate = findBoilerplate(managerModuleToTranspile);

          if (boilerplate) {
            try {
              boilerplate.module.default(evalled);
            } catch (e) {
              console.error(e);
            }
          }
        }
      }
    }

    await manager.preset.teardown(manager, updatedModules);

    if (firstLoad && showOpenInCodeSandbox) {
      createCodeSandboxOverlay(modules);
    }

    // 🚀 优化: 显示更详细的加载信息
    if (canSkipTranspilation) {
      debug(`Total time: ${Date.now() - startTime}ms (cache hit, transpilation skipped)`);
    } else {
      debug(`Total time: ${Date.now() - startTime}ms`);
    }

    metrics.endMeasure('compilation', { displayName: 'Compilation' });
    metrics.endMeasure('total', { displayName: 'Total', lastTime: 0 });
    
    dispatch({ type: 'status', status: 'idle' });
    dispatch({ type: 'success' });

    saveCache(managerModuleToTranspile, manager, changedModuleCount, firstLoad);
    
    // 🚀 优化: 编译完成后保存 Babel 编译缓存到 IndexedDB
    babelTranspiler.persistCacheIfNeeded();

    setTimeout(async () => {
      try {
        const jestLiteModule = await import('./eval/tests/jest-lite');
        const TestRunner = jestLiteModule.default;
        testRunner = testRunner || new TestRunner(manager);

        sendTestCount(modules);
      } catch (e) {
        if (process.env.NODE_ENV === 'development') {
          console.error('Test error', e);
        }
      }
    }, 600);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.log('Error in sandbox:');
    console.error(e);

    if (manager) {
      manager.clearCache();
      
      // 🔧 修复: 如果是首次加载且使用了缓存导致错误，清除 IndexedDB 缓存
      if (firstLoad && usedCache) {
        console.warn('[Cache] Clearing IndexedDB cache due to error with cached data');
        clearIndexedDBCache().catch(() => {});
      }

      if (firstLoad && changedModuleCount === 0) {
        await deleteAPICache(manager.id, SCRIPT_VERSION);
      }
    }

    const event = new Event('error');
    // @ts-ignore
    event.error = e;

    window.dispatchEvent(event);

    hadError = true;
  } finally {
    setTimeout(() => {
      try {
        // Set a timeout so there's a chance that we also catch runtime errors
        localStorage.removeItem('running');
      } catch (e) {
        /* no */
      }
    }, 600);

    if (manager) {
      // 🚀 优化: 私有化部署不需要发送完整状态到父窗口
      // 这会序列化所有模块代码，导致大量内存分配
      // 如果需要调试状态，可以设置 ENABLE_STATE_SYNC = true
      const ENABLE_STATE_SYNC = false;
      
      if (ENABLE_STATE_SYNC) {
        const managerState = {
          ...(await manager.serialize({ optimizeForSize: false })),
        };
        delete managerState.cachedPaths;
        managerState.entry = managerModuleToTranspile
          ? managerModuleToTranspile.path
          : null;

        dispatch({
          type: 'state',
          state: managerState,
        });
      }

      manager.isFirstLoad = false;
    }

    if (firstLoad) {
      metrics
        .persistMeasurements({
          sandboxId,
          cacheUsed: usedCache,
          browser: navigator.userAgent,
          version: VERSION,
        })
        .catch(() => {
          /* Do nothing with the error */
        });
    }
  }

  if (!hadError && firstLoad) {
    initializeDOMMutationListener();
  }

  onWindowResize();
  resizePolling();

  sendResize();

  firstLoad = false;

  // 注意：status 和 done 已经在 evaluation 完成后立即发送
  // 这里不再重复发送，避免覆盖之前的状态
  if (hadError) {
    dispatch({ type: 'status', status: 'idle' });
    dispatch({ type: 'done', compilatonError: hadError });
  }

  if (typeof (window as any).__puppeteer__ === 'function') {
    setTimeout(() => {
      // Give everything some time to evaluate
      (window as any).__puppeteer__({
        type: 'done',
        compilatonError: hadError,
      });
    }, 100);
  }
}

const tasks: CompileOptions[] = [];
let runningTask = null;

async function executeTaskIfAvailable() {
  if (tasks.length) {
    runningTask = tasks.pop();
    await compile(runningTask).catch(console.error);
    runningTask = null;

    executeTaskIfAvailable();
  }
}

/**
 * We want to ensure that no tasks (commands from the editor) are run in parallel,
 * this could result in state inconsistency. That's why we execute tasks after eachother,
 * and if there are 3 tasks we will remove the second task, this one is unnecessary as it is not the
 * latest version.
 */
export default function queueTask(data: CompileOptions) {
  // If same task is running, ignore it.
  if (runningTask && JSON.stringify(runningTask) === JSON.stringify(data)) {
    return;
  }

  tasks[0] = data;

  if (!runningTask) {
    executeTaskIfAvailable();
  }
}
