/* eslint-disable import/default */
/* eslint-disable import/no-named-as-default-member */
/* eslint-disable import/no-named-as-default */
// @ts-ignore
import StylusWorker from 'worker-loader?publicPath=/sandbox&name=stylus-transpiler.[hash:8].worker.js!./stylus-worker';
/* eslint-enable import/default */
import { LoaderContext, TranspilerResult } from 'sandpack-core';

import WorkerTranspiler from '../worker-transpiler/transpiler';

class StylusTranspiler extends WorkerTranspiler {
  worker: Worker;

  constructor() {
    // 优化：使用 1 个 Worker 避免重复加载
    super('stylus-loader', StylusWorker, { 
      maxWorkerCount: 1
    });

    this.cacheable = false;
  }

  async doTranspilation(
    code: string,
    loaderContext: LoaderContext
  ): Promise<TranspilerResult> {
    const { path } = loaderContext;

    const { transpiledCode } = await this.queueCompileFn(
      {
        code,
        path,
      },
      loaderContext
    );
    return { transpiledCode };
  }
}

const transpiler = new StylusTranspiler();

export { StylusTranspiler };

export default transpiler;
