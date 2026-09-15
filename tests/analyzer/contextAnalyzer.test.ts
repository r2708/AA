import { analyze, assert, buildSnapshot } from '../helpers/harness';
import { ContextAnalyzer } from '../../src/analyzer/contextAnalyzer';
import { detectLanguage } from '../../src/analyzer/languageDetector';
import { CodePilotError } from '../../src/types/command';
import { resolveSnippet } from '../helpers/harness';

describe('language detection', () => {
  it('detects the JS family from language ids', () => {
    assert.strictEqual(detectLanguage('typescript').isTypeScript, true);
    assert.strictEqual(detectLanguage('typescriptreact').isJsx, true);
    assert.strictEqual(detectLanguage('javascript').isTypeScript, false);
    assert.strictEqual(detectLanguage('javascriptreact').isJsx, true);
  });
  it('falls back to the file extension', () => {
    const lang = detectLanguage('plaintext', '/a/b/component.tsx');
    assert.strictEqual(lang.supported, true);
    assert.strictEqual(lang.isJsx, true);
  });
  it('rejects unsupported languages', () => {
    assert.strictEqual(detectLanguage('python', 'x.py').supported, false);
    assert.throws(
      () =>
        new ContextAnalyzer().analyze(buildSnapshot('print(1)', { languageId: 'python', fileName: '/x.py' })),
      (e: unknown) => e instanceof CodePilotError && e.kind === 'unsupportedLanguage',
    );
  });
});

describe('context analysis', () => {
  it('collects declarations and imports', () => {
    const ctx = analyze(`
import { useState } from 'react';
import fs from 'node:fs';
export interface User { id: string; name?: string }
type Role = 'admin' | 'user';
enum Status { Active = 'active' }
export const count = 1;
const items = [1, 2];
function greet(name: string) { return name; }
const arrow = async () => {};
export class Repo { private items: User[] = []; find() {} }
<|>`);
    assert.deepStrictEqual(
      ctx.declarations.imports.map((i) => i.moduleSpecifier),
      ['react', 'node:fs'],
    );
    assert.deepStrictEqual(
      ctx.declarations.imports[0].namedImports.map((n) => n.name),
      ['useState'],
    );
    assert.strictEqual(ctx.declarations.imports[1].defaultImport, 'fs');
    assert.strictEqual(ctx.declarations.interfaces[0].name, 'User');
    assert.strictEqual(ctx.declarations.interfaces[0].members[1].optional, true);
    assert.deepStrictEqual(ctx.declarations.types[0].unionLiterals, ['admin', 'user']);
    assert.strictEqual(ctx.declarations.enums[0].members[0].valueText, "'active'");
    assert.deepStrictEqual(
      ctx.declarations.variables.map((v) => v.name),
      ['count', 'items', 'arrow'],
    );
    assert.strictEqual(ctx.declarations.variables[1].initializerKind, 'array');
    const names = ctx.declarations.functions.map((f) => f.name);
    assert.ok(names.includes('greet') && names.includes('arrow'));
    assert.strictEqual(ctx.declarations.functions.find((f) => f.name === 'arrow')?.isAsync, true);
    assert.strictEqual(ctx.declarations.classes[0].properties[0].visibility, 'private');
    assert.ok(ctx.declarations.exports.some((e) => e.name === 'User'));
    assert.ok(ctx.declarations.topLevelNames.has('useState'));
  });

  it('detects scope inside an async function', () => {
    const ctx = analyze(`async function load(id: string) {\n  const user = await getUser(id);\n  <|>\n}`);
    assert.strictEqual(ctx.scope.kind, 'function');
    assert.strictEqual(ctx.scope.isAsync, true);
    assert.strictEqual(ctx.scope.enclosingFunction?.name, 'load');
    assert.strictEqual(ctx.scope.enclosingFunction?.parameters[0].typeText, 'string');
    assert.strictEqual(ctx.scope.statementIndent, '  ');
    assert.ok(ctx.scope.visibleNames.has('user') && ctx.scope.visibleNames.has('id'));
  });

  it('detects class body vs method scope', () => {
    const inBody = analyze(`class A {\n  x = 1;\n  <|>\n  m() {}\n}`);
    assert.strictEqual(inBody.scope.kind, 'class');
    assert.strictEqual(inBody.scope.inClassBody, true);
    assert.strictEqual(inBody.scope.enclosingClass?.name, 'A');
    const inMethod = analyze(`class A {\n  m() {\n    <|>\n  }\n}`);
    assert.strictEqual(inMethod.scope.kind, 'method');
    assert.strictEqual(inMethod.scope.inClassBody, false);
    assert.strictEqual(inMethod.scope.enclosingMethod?.name, 'm');
    assert.strictEqual(inMethod.scope.statementIndent, '    ');
  });

  it('detects object literal, interface, jsx and catch scopes', () => {
    assert.strictEqual(analyze(`const o = {\n  a: 1,\n  <|>\n};`).scope.inObjectLiteral, true);
    assert.strictEqual(analyze(`interface I {\n  a: string;\n  <|>\n}`).scope.inInterfaceBody, true);
    const jsx = analyze(`function App() { return <div>{<|>}</div>; }`, { languageId: 'typescriptreact' });
    assert.strictEqual(jsx.scope.inJsx, true);
    assert.strictEqual(jsx.react.jsxTagName, 'div');
    const c = analyze(`try { x(); } catch (err) {\n  <|>\n}`);
    assert.strictEqual(c.scope.inCatchClause, true);
    assert.strictEqual(c.scope.catchVariableName, 'err');
  });

  it('classifies selections', () => {
    assert.strictEqual(analyze(`const a = [[user.profile.name]];`).selection.kind, 'expression');
    assert.strictEqual(analyze(`const a = [[user]];`).selection.kind, 'identifier');
    const stmts = analyze(`function f() {\n[[  const a = 1;\n  console.log(a);\n]]}`);
    assert.strictEqual(stmts.selection.kind, 'statements');
    assert.strictEqual(stmts.selection.statementCount, 2);
    assert.strictEqual(analyze(`[[interface A { x: 1 }]]`).selection.kind, 'declaration');
    assert.strictEqual(analyze(`const a = [[user.pro]]file.name;`).selection.kind, 'partial');
    assert.strictEqual(analyze(`const a = 1;<|>`).selection.kind, 'none');
  });

  it('trims whitespace around selections and tolerates trailing semicolons', () => {
    const ctx = analyze(`const a = 1;\n[[  console.log(a);  \n]]`);
    assert.strictEqual(ctx.selection.text, 'console.log(a);');
    assert.strictEqual(ctx.selection.kind, 'statements');
    const noSemi = analyze(`[[console.log(1)]];`);
    assert.strictEqual(noSemi.selection.kind, 'statements');
  });

  it('detects code style', () => {
    const dq = analyze(`import a from "a"\nconst b = "x"\nconst c = "y"\n<|>`);
    assert.strictEqual(dq.style.quote, '"');
    assert.strictEqual(dq.style.semicolons, false);
    const sq = analyze(`import a from 'a';\nconst b = 'x';\n<|>`);
    assert.strictEqual(sq.style.quote, "'");
    assert.strictEqual(sq.style.semicolons, true);
  });

  it('detects React context', () => {
    const ctx = analyze(
      `import { useState } from 'react';\nexport function Counter({ initial }: { initial: number }) {\n  const [count, setCount] = useState(initial);\n  <|>\n  return <button>{count}</button>;\n}`,
      { languageId: 'typescriptreact' },
    );
    assert.strictEqual(ctx.react.isReact, true);
    assert.strictEqual(ctx.react.hasReactImport, true);
    assert.strictEqual(ctx.react.components[0].name, 'Counter');
    assert.strictEqual(ctx.react.enclosingComponent?.name, 'Counter');
    assert.deepStrictEqual(ctx.react.enclosingComponent?.destructuredProps, ['initial']);
    assert.deepStrictEqual(ctx.react.enclosingComponent?.hooksUsed, ['useState']);
    assert.strictEqual(analyze(`function add(a: number) { return a; }<|>`).react.isReact, false);
  });

  it('detects test frameworks and test files', () => {
    assert.strictEqual(analyze(`import { describe } from 'vitest';\n<|>`).testFramework, 'vitest');
    assert.strictEqual(analyze(`import { test } from '@playwright/test';\n<|>`).testFramework, 'playwright');
    assert.strictEqual(analyze(`import { expect } from 'chai';\n<|>`).testFramework, 'mocha');
    assert.strictEqual(analyze(`<|>`, { project: { testFramework: 'jest' } }).testFramework, 'jest');
    assert.strictEqual(analyze(`<|>`).testFramework, 'jest');
    assert.strictEqual(analyze(`<|>`, { fileName: '/p/src/a.test.ts' }).isTestFile, true);
    assert.strictEqual(analyze(`describe('x', () => {});<|>`).isTestFile, true);
    assert.strictEqual(analyze(`const a = 1;<|>`).isTestFile, false);
  });

  it('does not throw on malformed source and reports diagnostics', () => {
    const ctx = analyze(`function broken( {\n  const x = ;\n  <|>\n`);
    assert.ok(ctx.diagnostics.length > 0);
    assert.strictEqual(ctx.language.supported, true);
  });

  it('handles empty documents', () => {
    const ctx = analyze(`<|>`);
    assert.strictEqual(ctx.scope.kind, 'module');
    assert.strictEqual(ctx.currentLine.isBlank, true);
  });

  it('honours cursor position details', () => {
    const ctx = analyze(`const a = 1;\n  const b = 2;<|>\n`);
    assert.strictEqual(ctx.currentLine.index, 1);
    assert.strictEqual(ctx.currentLine.indent, '  ');
    assert.strictEqual(ctx.cursor, 27);
  });
});

describe('test harness snippet resolver', () => {
  it('resolves placeholders, choices and transforms', () => {
    assert.strictEqual(
      resolveSnippet('const [${1:count}, set${1/(.*)/${1:/capitalize}/}] = useState(${2:0})$0;'),
      'const [count, setCount] = useState(0);',
    );
    assert.strictEqual(resolveSnippet('${1|const,let|} ${2:x} = \\$\\{y\\}'), 'const x = ${y}');
  });
});
