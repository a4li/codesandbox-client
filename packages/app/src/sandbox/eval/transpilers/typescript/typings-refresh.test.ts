import fs from 'fs';
import path from 'path';

describe('typescript worker typings refresh', () => {
  it('uses a longer polling interval with change-triggered refresh', () => {
    const tsWorkerPath = path.resolve(
      __dirname,
      '../../../../../../../standalone-packages/monaco-typescript/src/tsWorker.ts'
    );
    const source = fs.readFileSync(tsWorkerPath, 'utf8');

    expect(source).toContain('TYPINGS_POLL_INTERVAL_MS = 30000');
    expect(source).toContain('TYPINGS_DEBOUNCE_MS = 1000');
    expect(source).toContain('watchTypingsChanges');
    expect(source).toContain('fs.watch("/sandbox/package.json"');
    expect(source).toContain('MAX_FETCHED_TYPES = 500');
    expect(source).toContain('rememberFetchedType');
    expect(source).toContain('TYPINGS_FETCH_CONCURRENCY = 4');
    expect(source).toContain('runWithConcurrency');
  });
});
