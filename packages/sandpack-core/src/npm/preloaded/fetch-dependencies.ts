import _debug from '@codesandbox/common/lib/utils/debug';
import { getAbsoluteDependency } from '@codesandbox/common/lib/utils/dependencies';
import { ILambdaResponse } from '../merge-dependency';

import delay from '../../utils/delay';
import { normalizeVersion } from '../dependencies-to-query';

const RETRY_COUNT = 12;
const MAX_RETRY_DELAY = 5_000;
const MAX_RETRY_TOTAL_MS = 60_000;
const debug = _debug('cs:sandbox:packager');

// const VERSION = 2;

// eslint-disable-next-line
const DEV_URLS = {
  packager:
    'https://xi5p9f7czk.execute-api.eu-west-1.amazonaws.com/dev/packages',
  bucket: 'https://dev-packager-packages.codesandbox.io',
};
// eslint-disable-next-line
const PROD_URLS = {
  // bucket: 'https://prod-packager-packages.codesandbox.io',
  bucket: 'https://10.4.5.136/packager2',
};

const URLS = PROD_URLS;
const BUCKET_URL = URLS.bucket;

// 私有化部署模式：禁用 AWS packager 服务
const PRIVATE_DEPLOYMENT = true;

function callApi(url: string, method = 'GET') {
  return fetch(url, {
    method,
  })
    .then(async response => {
      if (!response.ok) {
        const error = new Error(response.statusText || '' + response.status);

        try {
          // @ts-ignore
          error.response = await response.text();
        } catch (err) {
          console.error(err);
        }

        // @ts-ignore
        error.statusCode = response.status;

        throw error;
      }

      return response;
    })
    .then(response => response.json());
}

/**
 * Request the packager, if retries > RETRY_COUNT it will throw if something goes wrong
 * otherwise it will retry again with an incremented retry
 *
 * @param {string} query The dependencies to call
 */
async function requestPackager(
  url: string,
  method: string = 'GET',
  retries: number = 0,
  startedAt: number = Date.now()
): Promise<any> {
  // eslint-disable-next-line no-constant-condition
  debug(`Trying to call packager for ${retries} time`);

  try {
    const manifest = await callApi(url, method);
    return manifest;
  } catch (err: any) {
    console.error({ err });

    // If it's a 403 or network error, we retry the fetch
    if (err.response && err.statusCode !== 403) {
      throw new Error(err.response.error);
    }

    // 403 status code means the bundler is still bundling
    if (Date.now() - startedAt > MAX_RETRY_TOTAL_MS) {
      throw new Error(
        `Packager retry window exceeded (${MAX_RETRY_TOTAL_MS}ms) for ${url}`
      );
    }

    if (retries < RETRY_COUNT) {
      const msDelay = Math.min(
        MAX_RETRY_DELAY,
        1000 * retries + Math.round(Math.random() * 1000)
      );
      console.warn(`Retrying package fetch in ${msDelay}ms`);
      await delay(msDelay);
      return requestPackager(url, method, retries + 1, startedAt);
    }

    throw err;
  }
}

const NECESSARY_DEPENDENCIES = ['react', 'react-dom'];

export async function getDependency(
  depName: string,
  depVersion: string,
  externals: {
    [dependency: string]: string;
  }
): Promise<ILambdaResponse> {
  let version = depVersion;
  try {
    const { version: absoluteVersion } = await getAbsoluteDependency(
      depName,
      depVersion
    );
    version = absoluteVersion;
  } catch (e) {
    /* Ignore this, not critical */
  }

  const normalizedVersion = normalizeVersion(version);
  // const fullUrl = `${BUCKET_URL}/v${VERSION}/packages/${depName}/${normalizedVersion}.json`;
  const fullUrl = `${BUCKET_URL}/${depName}@${normalizedVersion}`;

  if (externals[depName] && !NECESSARY_DEPENDENCIES.includes(depName)) {
    return {
      contents: {},
      dependency: {
        name: depName,
        version: normalizedVersion,
      },
      dependencyDependencies: {},
      peerDependencies: {},
      dependencyAliases: {},
    };
  }

  try {
    const bucketManifest = await callApi(fullUrl);
    return bucketManifest;
  } catch (e: any) {
    if (PRIVATE_DEPLOYMENT) {
      // 私有化部署模式：直接抛出错误，不尝试调用 AWS packager
      const errorMsg = `[私有化部署] 依赖 ${depName}@${normalizedVersion} 在本地 bucket 中不存在，请先打包并上传到 ${BUCKET_URL}`;
      console.error(errorMsg);
      throw new Error(errorMsg);
    }

    // 以下代码仅在非私有化部署时执行（保留用于参考）
    // The dep has not been generated yet...
    // const packagerRequestUrl = `${PACKAGER_URL}/${dependencyUrl}`;
    // await requestPackager(packagerRequestUrl, 'POST');
    // return requestPackager(fullUrl);
    throw e;
  }
}

export const __private__ = {
  requestPackager,
  callApi,
  RETRY_COUNT,
  MAX_RETRY_TOTAL_MS,
};
