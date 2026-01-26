/**
 * 预加载常用依赖，提升低代码平台沙箱加载速度
 * 在应用初始化时提前下载并缓存常用依赖包
 */

import { getDependency as getPrebundledDependency } from './preloaded/fetch-dependencies';
import { resolveDependencyInfo } from './dynamic/resolve-dependency';

// 低代码平台常用依赖列表 - 根据实际 trace 分析优化
// 按照实际加载频率排序（从高到低）
export const COMMON_LOWCODE_DEPENDENCIES = {
  // React 核心（加载最频繁）
  'react-dom': '^17.0.2', // 7702次加载
  react: '^17.0.2', // 1179次加载
  'react-is': '^17.0.2', // 16次加载
  'prop-types': '^15.7.2', // 13次加载

  // 低代码核心库（项目特有）
  '@loview/lowcode-react-boot': '^1.17.0', // 1723次加载
  '@loview/lowcode-react-antd': '^1.25.0', // 1707次加载

  // 流程图库
  '@logicflow/extension': '^2.0.5', // 279次加载
  '@logicflow/core': '^2.0.5', // 90次加载

  // UI 和样式
  'styled-components': '^5.3.11', // 22次加载
  antd: '^5.12.0', // 3次加载（可能通过其他方式加载）

  // 工具库
  moment: '^2.30.1', // 20次加载
  '@babel/runtime': '^7.3.1', // 15次加载
  '@babel/core': '^7.3.3', // 3次加载

  // 代码格式化
  prettier: '^2.6.0', // 2次加载

  // Formily 表单（项目使用）
  '@formily/antd': '^2.0.0', // 3次加载
};

interface PreloadProgress {
  loaded: number;
  total: number;
  current: string;
  errors: Array<{ name: string; error: Error }>;
}

type PreloadCallback = (progress: PreloadProgress) => void;

let preloadCompleted = false;
const preloadedDeps = new Set<string>();
let activePreload: {
  key: string;
  promise: Promise<void>;
  cancelled: boolean;
  refs: number;
} | null = null;

export type PreloadHandle = {
  promise: Promise<void>;
  cancel: () => void;
};

const getDependenciesKey = (dependencies: Record<string, string>) =>
  JSON.stringify(
    Object.entries(dependencies).sort(([a], [b]) => a.localeCompare(b))
  );

const releasePreload = (controller: NonNullable<typeof activePreload>) => {
  if (activePreload !== controller) {
    return;
  }

  controller.refs -= 1;

  if (controller.refs <= 0 && !preloadCompleted) {
    controller.cancelled = true;
  }
};

const createPreloadHandle = (
  controller: NonNullable<typeof activePreload>
): PreloadHandle => ({
  promise: controller.promise,
  cancel: () => releasePreload(controller),
});

export function startPreloadCommonDependencies(
  onProgress?: PreloadCallback,
  customDeps?: Record<string, string>
): PreloadHandle {
  const dependencies = customDeps || COMMON_LOWCODE_DEPENDENCIES;
  const dependenciesKey = getDependenciesKey(dependencies);

  if (preloadCompleted && activePreload?.key === dependenciesKey) {
    return {
      promise: Promise.resolve(),
      cancel: () => {},
    };
  }

  if (
    activePreload &&
    activePreload.key === dependenciesKey &&
    !activePreload.cancelled
  ) {
    activePreload.refs += 1;
    return createPreloadHandle(activePreload);
  }

  const depNames = Object.keys(dependencies);
  const total = depNames.length;
  let loaded = 0;
  const errors: Array<{ name: string; error: Error }> = [];

  const controller = {
    key: dependenciesKey,
    promise: Promise.resolve(),
    cancelled: false,
    refs: 1,
  };

  const updateProgress = (current: string) => {
    if (onProgress) {
      onProgress({
        loaded,
        total,
        current,
        errors,
      });
    }
  };

  controller.promise = (async () => {
    // eslint-disable-next-line no-console
    console.log('[Preload] Starting to preload', total, 'common dependencies');
    const startTime = Date.now();

    // 并发预加载所有依赖，限制并发数为 5
    const concurrencyLimit = 5;
    const chunks: string[][] = [];

    for (let i = 0; i < depNames.length; i += concurrencyLimit) {
      chunks.push(depNames.slice(i, i + concurrencyLimit));
    }

    // eslint-disable-next-line no-await-in-loop
    for (const chunk of chunks) {
      if (controller.cancelled) {
        break;
      }

      // eslint-disable-next-line no-await-in-loop, no-loop-func
      await Promise.all(
        // eslint-disable-next-line no-loop-func
        chunk.map(async depName => {
          if (controller.cancelled) {
            return;
          }

          if (preloadedDeps.has(depName)) {
            loaded++;
            updateProgress(depName);
            return;
          }

          try {
            updateProgress(depName);

            const version = dependencies[depName as keyof typeof dependencies];

            // 优先尝试从预打包源获取
            try {
              await getPrebundledDependency(depName, version, {});
              preloadedDeps.add(depName);
            } catch (err) {
              // 如果预打包失败，尝试动态获取
              await resolveDependencyInfo(depName, version, []);
              preloadedDeps.add(depName);
            }

            loaded++;
            // eslint-disable-next-line no-console
            console.log(`[Preload] ✓ ${depName} (${loaded}/${total})`);
          } catch (error: any) {
            errors.push({ name: depName, error });
            // eslint-disable-next-line no-console
            console.warn(
              `[Preload] ✗ Failed to preload ${depName}:`,
              error.message
            );
            loaded++;
          }

          updateProgress(depName);
        })
      );
    }

    if (controller.cancelled) {
      // eslint-disable-next-line no-console
      console.warn('[Preload] Cancelled');
      activePreload = null;
      return;
    }

    const duration = Date.now() - startTime;
    preloadCompleted = true;

    // eslint-disable-next-line no-console
    console.log(
      `[Preload] Completed in ${(duration / 1000).toFixed(2)}s`,
      `(${preloadedDeps.size}/${total} successful)`
    );

    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`[Preload] ${errors.length} dependencies failed to preload`);
    }
  })();

  activePreload = controller;

  return createPreloadHandle(controller);
}

/**
 * 预加载常用依赖
 * @param onProgress 进度回调
 * @param customDeps 自定义依赖列表（可选）
 */
export async function preloadCommonDependencies(
  onProgress?: PreloadCallback,
  customDeps?: Record<string, string>
): Promise<void> {
  return startPreloadCommonDependencies(onProgress, customDeps).promise;
}

/**
 * 检查依赖是否已预加载
 */
export function isDependencyPreloaded(depName: string): boolean {
  return preloadedDeps.has(depName);
}

/**
 * 获取预加载状态
 */
export function getPreloadStatus() {
  return {
    completed: preloadCompleted,
    preloadedCount: preloadedDeps.size,
    preloadedDeps: Array.from(preloadedDeps),
  };
}

/**
 * 重置预加载状态（用于测试）
 */
export function resetPreloadState() {
  preloadCompleted = false;
  preloadedDeps.clear();
  if (activePreload) {
    activePreload.cancelled = true;
    activePreload = null;
  }
}
