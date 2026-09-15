import type { CodeContext, FunctionInfo, TestFramework } from '../types/context';
import type { ImportRequest } from '../transformations/importManager';
import { escapeSnippet } from './codeWriter';
import { sampleValueForType } from '../analyzer/typeInference';

export interface TestSyntax {
  framework: TestFramework;
  describe: string;
  it: string;
  beforeEach: string;
  afterEach: string;
  beforeAll: string;
  afterAll: string;
  expectStyle: 'expect' | 'chai' | 'assert';
  /** Imports required to use the globals (empty for frameworks with injected globals). */
  imports: ImportRequest[];
  mockModule(module: string): string;
  spyOn(target: string, method: string): string;
  mockFn(): string;
}

export function testSyntaxFor(fw: TestFramework, quote: string): TestSyntax {
  const q = quote;
  switch (fw) {
    case 'vitest':
      return {
        framework: fw,
        describe: 'describe',
        it: 'it',
        beforeEach: 'beforeEach',
        afterEach: 'afterEach',
        beforeAll: 'beforeAll',
        afterAll: 'afterAll',
        expectStyle: 'expect',
        imports: [{ module: 'vitest', named: ['describe', 'it', 'expect'] }],
        mockModule: (m) => `vi.mock(${q}${m}${q})`,
        spyOn: (t, m) => `vi.spyOn(${t}, ${q}${m}${q})`,
        mockFn: () => 'vi.fn()',
      };
    case 'mocha':
      return {
        framework: fw,
        describe: 'describe',
        it: 'it',
        beforeEach: 'beforeEach',
        afterEach: 'afterEach',
        beforeAll: 'before',
        afterAll: 'after',
        expectStyle: 'chai',
        imports: [{ module: 'chai', named: ['expect'] }],
        mockModule: (m) =>
          `// mocha has no built-in module mocking; consider proxyquire or sinon for ${q}${m}${q}`,
        spyOn: (t, m) => `sinon.spy(${t}, ${q}${m}${q})`,
        mockFn: () => 'sinon.stub()',
      };
    case 'playwright':
      return {
        framework: fw,
        describe: 'test.describe',
        it: 'test',
        beforeEach: 'test.beforeEach',
        afterEach: 'test.afterEach',
        beforeAll: 'test.beforeAll',
        afterAll: 'test.afterAll',
        expectStyle: 'expect',
        imports: [{ module: '@playwright/test', named: ['test', 'expect'] }],
        mockModule: (m) => `// Playwright: use page.route() to mock network requests for ${q}${m}${q}`,
        spyOn: (t, m) => `// Playwright has no spies; assert on ${t}.${m} effects instead`,
        mockFn: () => '() => undefined',
      };
    case 'node':
      return {
        framework: fw,
        describe: 'describe',
        it: 'it',
        beforeEach: 'beforeEach',
        afterEach: 'afterEach',
        beforeAll: 'before',
        afterAll: 'after',
        expectStyle: 'assert',
        imports: [
          { module: 'node:test', named: ['describe', 'it', 'mock'] },
          { module: 'node:assert/strict', defaultName: 'assert' },
        ],
        mockModule: (m) => `mock.module(${q}${m}${q}, { namedExports: {} })`,
        spyOn: (t, m) => `mock.method(${t}, ${q}${m}${q})`,
        mockFn: () => 'mock.fn()',
      };
    case 'jest':
    default:
      return {
        framework: 'jest',
        describe: 'describe',
        it: 'it',
        beforeEach: 'beforeEach',
        afterEach: 'afterEach',
        beforeAll: 'beforeAll',
        afterAll: 'afterAll',
        expectStyle: 'expect',
        imports: [],
        mockModule: (m) => `jest.mock(${q}${m}${q})`,
        spyOn: (t, m) => `jest.spyOn(${t}, ${q}${m}${q})`,
        mockFn: () => 'jest.fn()',
      };
  }
}

export function assertionSnippet(syntax: TestSyntax, actual: string, expected: string, semi: string): string {
  switch (syntax.expectStyle) {
    case 'chai':
      return `expect(${actual}).to.equal(${expected})${semi}`;
    case 'assert':
      return `assert.strictEqual(${actual}, ${expected})${semi}`;
    default:
      return `expect(${actual}).toBe(${expected})${semi}`;
  }
}

function sampleArgs(fn: FunctionInfo, quote: string): string {
  return fn.parameters
    .filter((p) => !p.isRest)
    .map((p) => sampleValueForType(p.typeText, p.name, quote))
    .join(', ');
}

/** Test case snippet for a function: describe/it with a call using sample arguments. */
export function testCaseSnippet(
  ctx: CodeContext,
  fn: FunctionInfo,
  syntax: TestSyntax,
  placeholderStart = 1,
): string {
  const q = ctx.style.quote;
  const semi = ctx.style.semicolons ? ';' : '';
  const isTs = ctx.language.isTypeScript;
  const args = sampleArgs(fn, q);
  const callTarget = fn.kind === 'method' ? `instance.${fn.name}` : fn.name;
  const awaitPrefix = fn.isAsync || (fn.returnTypeText ?? '').startsWith('Promise') ? 'await ' : '';
  const asyncFn = awaitPrefix ? 'async ' : '';
  let p = placeholderStart;
  const behaviour = `\${${p++}:returns the expected result}`;
  const expected = `\${${p++}:${escapeSnippet(sampleValueForType(fn.returnTypeText?.replace(/^Promise<(.*)>$/, '$1'), 'result', q))}}`;
  const assertion = assertionSnippet(syntax, 'result', expected, semi);
  const resultDecl = isTs ? 'const result = ' : 'const result = ';
  return `${syntax.it}(${q}${escapeSnippet(fn.name)} ${behaviour}${q}, ${asyncFn}() => {\n\t${resultDecl}${awaitPrefix}${escapeSnippet(callTarget)}(${escapeSnippet(args)})${semi}\n\t${assertion}\n})${semi}`;
}

/** Full test file content for exported functions of the source file. */
export function testFileContent(
  ctx: CodeContext,
  functions: FunctionInfo[],
  importPath: string,
  syntax: TestSyntax,
): string {
  const q = ctx.style.quote;
  const semi = ctx.style.semicolons ? ';' : '';
  const lines: string[] = [];
  for (const imp of syntax.imports) {
    const parts: string[] = [];
    if (imp.defaultName) {
      parts.push(imp.defaultName);
    }
    if (imp.named?.length) {
      parts.push(`{ ${imp.named.join(', ')} }`);
    }
    lines.push(`import ${parts.join(', ')} from ${q}${imp.module}${q}${semi}`);
  }
  const names = functions.map((f) => f.name).filter(Boolean);
  const defaultFn = functions.find((f) => f.isDefaultExport);
  const namedFns = functions.filter((f) => !f.isDefaultExport);
  const importParts: string[] = [];
  if (defaultFn) {
    importParts.push(defaultFn.name);
  }
  if (namedFns.length) {
    importParts.push(`{ ${namedFns.map((f) => f.name).join(', ')} }`);
  }
  if (importParts.length) {
    lines.push(`import ${importParts.join(', ')} from ${q}${importPath}${q}${semi}`);
  }
  lines.push('');
  const suiteName =
    names.length === 1
      ? names[0]
      : (ctx.snapshot.fileName
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.[^.]+$/, '') ?? 'module');
  lines.push(`${syntax.describe}(${q}${suiteName}${q}, () => {`);
  functions.forEach((fn, index) => {
    if (index > 0) {
      lines.push('');
    }
    const args = sampleArgs(fn, q);
    const awaitPrefix = fn.isAsync || (fn.returnTypeText ?? '').startsWith('Promise') ? 'await ' : '';
    const asyncFn = awaitPrefix ? 'async ' : '';
    const expected = sampleValueForType(fn.returnTypeText?.replace(/^Promise<(.*)>$/, '$1'), 'result', q);
    lines.push(`\t${syntax.it}(${q}${fn.name} returns the expected result${q}, ${asyncFn}() => {`);
    lines.push(`\t\tconst result = ${awaitPrefix}${fn.name}(${args})${semi}`);
    lines.push(`\t\t${assertionSnippet(syntax, 'result', expected, semi)}`);
    lines.push(`\t})${semi}`);
  });
  lines.push(`})${semi}`);
  lines.push('');
  return lines.join('\n');
}

/** Sibling test file path: `src/utils/math.ts` → `src/utils/math.test.ts` (`.spec` for mocha). */
export function testFilePathFor(fileName: string, framework: TestFramework): string {
  const suffix = framework === 'mocha' ? 'spec' : 'test';
  return fileName.replace(/(\.[cm]?[jt]sx?)$/, `.${suffix}$1`);
}

/** Relative import path from the test file to the source file (same directory). */
export function importPathForSibling(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return `./${base.replace(/\.[cm]?[jt]sx?$/, '')}`;
}
