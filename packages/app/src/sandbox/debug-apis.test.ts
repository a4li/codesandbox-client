import fs from 'fs';
import path from 'path';

describe('global debug api gating', () => {
  it('gates sandbox debug apis behind dev check and cleanup', () => {
    const compilePath = path.resolve(__dirname, 'compile.ts');
    const source = fs.readFileSync(compilePath, 'utf8');

    expect(source).toContain("process.env.NODE_ENV === 'development'");
    expect(source).toContain('__cleanupSandboxDebugApis');
  });

  it('gates babel debug apis behind dev check and cleanup', () => {
    const babelPath = path.resolve(
      __dirname,
      'eval/transpilers/babel/index.ts'
    );
    const source = fs.readFileSync(babelPath, 'utf8');

    expect(source).toContain("process.env.NODE_ENV === 'development'");
    expect(source).toContain('__cleanupBabelDebugApis');
  });

  it('gates monaco worker debug apis behind dev check and cleanup', () => {
    const monacoPath = path.resolve(
      __dirname,
      '../embed/components/Content/Monaco/index.js'
    );
    const source = fs.readFileSync(monacoPath, 'utf8');

    expect(source).toContain("process.env.NODE_ENV === 'development'");
    expect(source).toContain('__cleanupMonacoDebugApis');
  });
});
